/**
 * VRInteraction.js
 *
 * Every way the user's hands act on the scene:
 *   - controllers (XRControllerModelFactory) and tracked hands (XRHandModelFactory)
 *   - a thin ray + dot cursor for pointing at the panels
 *   - trigger / pinch: press panel controls; off-panel it grabs the model on the
 *     tabletop, or aims a teleport arc at human scale (so hands can move too)
 *   - grip: grab and rotate the tabletop model; both grips: scale it
 *   - right thumbstick: forward = teleport arc, left/right = 30° snap turn
 *   - left thumbstick: optional smooth locomotion (off by default)
 *   - X button: show / hide the wrist menu
 *
 * Nothing here moves the camera on its own: every rig change is the direct
 * result of a stick, trigger or pinch.
 */

import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/examples/jsm/webxr/XRHandModelFactory.js';

const UP = new THREE.Vector3(0, 1, 0);
const SNAP = (30 * Math.PI) / 180;
const ARC_SPEED = 14; //      m/s launch speed of the teleport arc (~30 m range on flat ground)
const ARC_G = 9.8; //         m/s²
const ARC_DT = 0.05; //       s between arc samples
const ARC_MAX = 64; //        samples (3.2 s of flight)
const SMOOTH_SPEED = 3; //    m/s
const MIN_SCALE = 1 / 1000;
const MAX_SCALE = 1 / 200;
const RAY_LEN = 2;

/** Haptic tick: prefer hapticActuators.pulse, fall back to vibrationActuator. */
export function pulse(source, intensity = 0.2, ms = 10) {
  const gp = source && source.gamepad;
  if (!gp) return;
  try {
    const h = gp.hapticActuators && gp.hapticActuators[0];
    if (h && h.pulse) h.pulse(intensity, ms);
    else if (gp.vibrationActuator && gp.vibrationActuator.playEffect) {
      gp.vibrationActuator.playEffect('dual-rumble', { duration: ms, strongMagnitude: intensity, weakMagnitude: intensity });
    }
  } catch {
    /* haptics are optional */
  }
}

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
/** Angle of a world point about a vertical axis through c, CCW seen from above (matches rotation.y). */
const angleAbout = (p, c) => Math.atan2(-(p.z - c.z), p.x - c.x);

function rayMesh() {
  // 2.5 mm square beam from z = 0 to z = −1, bright at the hand, fading out.
  const g = new THREE.BoxGeometry(0.0025, 0.0025, 1);
  g.translate(0, 0, -0.5);
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const k = 1 + p.getZ(i); // 1 at the hand, 0 at the tip
    col[3 * i] = 0.7 * k;
    col[3 * i + 1] = 0.9 * k;
    col[3 * i + 2] = 1.0 * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = 11;
  return mesh;
}

function cursorMesh() {
  const m = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false, transparent: true, fog: false });
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(0.005, 16), m);
  mesh.renderOrder = 12;
  mesh.visible = false;
  return mesh;
}

export class VRInteraction {
  /**
   * @param {object} o
   *   renderer, world (parent of rig; identity transform), rig, camera, panel
   *   hooks: mode() → 'tabletop'|'human', walkables() → Object3D[],
   *          skipIntro() → bool, teleport(pointWorld), togglePanel(),
   *          smooth() → bool, stageCenter() → Vector3, getYaw(), setYaw(y),
   *          getScale(), setScale(s), grabEnd()
   */
  constructor({ renderer, world, rig, camera, panel, hooks }) {
    this.renderer = renderer;
    this.world = world;
    this.rig = rig;
    this.camera = camera;
    this.panel = panel;
    this.hooks = hooks;
    this.raycaster = new THREE.Raycaster();
    this.frame = 0;
    this.vignette = 0;
    this.swapped = new Map();
    this.grab = null;
    this.lastPanelInput = null;

    const controllerFactory = new XRControllerModelFactory();
    const handFactory = new XRHandModelFactory();
    this.inputs = [0, 1].map((i) => this.makeInput(i, controllerFactory, handFactory));

    // Teleport arc: one dynamic ribbon of ARC_MAX points (2 verts each).
    const ag = new THREE.BufferGeometry();
    ag.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ARC_MAX * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    ag.setAttribute('color', new THREE.BufferAttribute(new Float32Array(ARC_MAX * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    for (let i = 0; i < ARC_MAX - 1; i++) {
      const a = 2 * i;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    ag.setIndex(idx);
    this.arc = new THREE.Mesh(
      ag,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })
    );
    this.arc.frustumCulled = false;
    this.arc.visible = false;
    this.arc.renderOrder = 11;
    const rg = new THREE.RingGeometry(0.26, 0.34, 48);
    rg.rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(
      rg,
      new THREE.MeshBasicMaterial({ color: 0x4fe3ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })
    );
    this.ring.visible = false;
    this.ring.renderOrder = 11;
    world.add(this.arc, this.ring);
    this.arcTarget = null;
  }

  makeInput(i, controllerFactory, handFactory) {
    const { renderer, rig } = this;
    const controller = renderer.xr.getController(i);
    const grip = renderer.xr.getControllerGrip(i);
    const hand = renderer.xr.getHand(i);
    grip.add(controllerFactory.createControllerModel(grip));
    // 'spheres' is a primitive model: no network fetch, works offline.
    hand.add(handFactory.createHandModel(hand, 'spheres'));
    rig.add(controller, grip, hand);
    const ray = rayMesh();
    const cursor = cursorMesh();
    rig.add(ray, cursor);
    const s = {
      i,
      controller,
      grip,
      hand,
      ray,
      cursor,
      source: null,
      handedness: 'none',
      isHand: false,
      buttons: [],
      turnArmed: true,
      arcStick: false,
      arcTrigger: false,
      panelDrag: false,
      grabbing: false,
      consumed: false,
      origin: new THREE.Vector3(),
      dir: new THREE.Vector3(0, 0, -1),
      hit: null,
    };
    controller.addEventListener('connected', (e) => {
      s.source = e.data;
      s.handedness = e.data.handedness || 'none';
      s.isHand = !!e.data.hand;
      s.buttons = [];
      if (s.isHand && s.handedness === 'left') this.hooks.handsDetected?.();
    });
    controller.addEventListener('disconnected', () => {
      if (s.grabbing) this.endGrab(s);
      s.source = null;
      s.panelDrag = false;
      s.arcStick = false;
      s.arcTrigger = false;
      ray.visible = false;
      cursor.visible = false;
    });
    controller.addEventListener('selectstart', () => this.onSelectStart(s));
    controller.addEventListener('selectend', () => this.onSelectEnd(s));
    controller.addEventListener('squeezestart', () => this.onSqueezeStart(s));
    controller.addEventListener('squeezeend', () => this.onSqueezeEnd(s));
    return s;
  }

  /* ---------------- events ---------------- */

  onSelectStart(s) {
    s.consumed = false;
    if (this.hooks.skipIntro()) {
      s.consumed = true;
      return;
    }
    this.updateRay(s);
    const hit = this.panel.hitTest(new THREE.Ray(s.origin, s.dir));
    if (hit && hit.inside && this.panel.pointerDown(hit)) {
      s.panelDrag = true;
      this.lastPanelInput = s;
      return;
    }
    if (this.hooks.mode() === 'tabletop') this.beginGrab(s);
    else s.arcTrigger = true;
  }

  onSelectEnd(s) {
    if (s.consumed) {
      s.consumed = false;
      return;
    }
    if (s.panelDrag) {
      s.panelDrag = false;
      this.panel.pointerUp();
    }
    if (s.grabbing) this.endGrab(s);
    if (s.arcTrigger) {
      s.arcTrigger = false;
      this.commitTeleport();
    }
  }

  onSqueezeStart(s) {
    if (this.hooks.skipIntro()) return;
    if (this.hooks.mode() === 'tabletop') this.beginGrab(s);
  }

  onSqueezeEnd(s) {
    if (s.grabbing) this.endGrab(s);
  }

  /* ---------------- grab, rotate, two-hand scale ---------------- */

  handPos(s) {
    const o = s.grip.visible ? s.grip : s.isHand ? s.hand : s.controller;
    return o.getWorldPosition(new THREE.Vector3());
  }

  beginGrab(s) {
    s.grabbing = true;
    this.resetGrab();
  }

  endGrab(s) {
    s.grabbing = false;
    this.resetGrab();
    if (!this.grab) this.hooks.grabEnd();
  }

  /**
   * Record a baseline whenever the number of grabbing hands changes, so going
   * from one hand to two (or back) never makes the model jump.
   *   one hand:  yaw = yaw0 + (θ − θ0), θ = angle of the hand about the plinth axis
   *   two hands: scale = scale0 · d / d0  (d = distance between the hands),
   *              yaw   = yaw0 + (φ − φ0), φ = heading of the hand-to-hand vector
   */
  resetGrab() {
    const g = this.inputs.filter((s) => s.grabbing);
    const yaw0 = this.hooks.getYaw();
    if (g.length === 1) {
      this.grab = { n: 1, s: g[0], a0: angleAbout(this.handPos(g[0]), this.hooks.stageCenter()), yaw0 };
    } else if (g.length === 2) {
      const p0 = this.handPos(g[0]);
      const p1 = this.handPos(g[1]);
      this.grab = {
        n: 2,
        d0: Math.max(0.05, p0.distanceTo(p1)),
        s0: this.hooks.getScale(),
        ang0: Math.atan2(-(p1.z - p0.z), p1.x - p0.x),
        yaw0,
      };
    } else {
      this.grab = null;
    }
  }

  updateGrab() {
    const G = this.grab;
    if (!G) return;
    if (this.hooks.mode() !== 'tabletop') {
      this.inputs.forEach((s) => (s.grabbing = false));
      this.grab = null;
      return;
    }
    if (G.n === 1) {
      const a = angleAbout(this.handPos(G.s), this.hooks.stageCenter());
      this.hooks.setYaw(G.yaw0 + wrap(a - G.a0));
    } else {
      const [a, b] = this.inputs.filter((s) => s.grabbing);
      const p0 = this.handPos(a);
      const p1 = this.handPos(b);
      const scale = THREE.MathUtils.clamp((G.s0 * p0.distanceTo(p1)) / G.d0, MIN_SCALE, MAX_SCALE);
      this.hooks.setScale(scale);
      const ang = Math.atan2(-(p1.z - p0.z), p1.x - p0.x);
      this.hooks.setYaw(G.yaw0 + wrap(ang - G.ang0));
    }
  }

  /* ---------------- rays ---------------- */

  /** Ray origin/direction in world space. Hands aim from the index fingertip. */
  updateRay(s) {
    s.controller.updateWorldMatrix(true, false);
    const tip = s.isHand && s.hand.joints && s.hand.joints['index-finger-tip'];
    if (tip && tip.visible !== false) tip.getWorldPosition(s.origin);
    else s.origin.setFromMatrixPosition(s.controller.matrixWorld);
    s.dir.set(0, 0, -1).transformDirection(s.controller.matrixWorld);
  }

  /** Draw the beam (rig-local) from origin along dir for `len` metres. */
  drawRay(s, len) {
    const rig = this.rig;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), s.dir);
    const rq = rig.getWorldQuaternion(new THREE.Quaternion()).invert();
    s.ray.position.copy(rig.worldToLocal(s.origin.clone()));
    s.ray.quaternion.copy(rq.multiply(q));
    s.ray.scale.set(1, 1, len);
    s.ray.visible = true;
  }

  /* ---------------- locomotion ---------------- */

  /**
   * Snap turn about the head: the rig is rotated by θ about the vertical line
   * through the eyes, so the view turns in place without sliding:
   *   rig.position ← head + R_y(θ)·(rig.position − head),   rig.yaw ← rig.yaw + θ
   */
  snapTurn(theta) {
    const head = this.camera.getWorldPosition(new THREE.Vector3());
    this.rig.position.sub(head).applyAxisAngle(UP, theta).add(head);
    this.rig.rotation.y += theta;
  }

  /**
   * Teleport arc: projectile from the hand,
   *   p(t) = o + v₀·t + ½·g·t²,   v₀ = ARC_SPEED · dir,   g = (0, −9.8, 0)
   * sampled every ARC_DT s. Each chord p(tᵢ) → p(tᵢ₊₁) is raycast against the
   * walkable surfaces (ground, podium roof, tower roofs, bridge roofs); the first
   * hit ends the arc. It is a valid landing if the surface faces up
   * (world normal y > 0.6, i.e. slope under ~53°).
   */
  computeArc(s) {
    const o = s.origin;
    const v = s.dir.clone().multiplyScalar(ARC_SPEED);
    const pts = [o.clone()];
    const targets = this.hooks.walkables();
    let hit = null;
    const prev = o.clone();
    const p = new THREE.Vector3();
    const seg = new THREE.Vector3();
    for (let i = 1; i < ARC_MAX; i++) {
      const t = i * ARC_DT;
      p.set(o.x + v.x * t, o.y + v.y * t - 0.5 * ARC_G * t * t, o.z + v.z * t);
      seg.subVectors(p, prev);
      const len = seg.length();
      this.raycaster.set(prev, seg.divideScalar(len || 1));
      this.raycaster.near = 0;
      this.raycaster.far = len;
      const hits = targets.length ? this.raycaster.intersectObjects(targets, false) : [];
      if (hits.length) {
        const h = hits[0];
        const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : UP.clone();
        if (n.y < 0) n.negate(); // walk surfaces are double-sided
        pts.push(h.point.clone());
        hit = { point: h.point.clone(), valid: n.y > 0.6 };
        break;
      }
      pts.push(p.clone());
      prev.copy(p);
      if (p.y < o.y - 2000) break;
    }
    return { pts, hit };
  }

  /** Write the arc as a flat ribbon: each sample becomes p ± side·w, side ⟂ chord and up. */
  drawArc({ pts, hit }) {
    const pos = this.arc.geometry.attributes.position;
    const col = this.arc.geometry.attributes.color;
    const valid = hit && hit.valid;
    const c = valid ? [0.3, 0.85, 1] : [0.45, 0.45, 0.48];
    const side = new THREE.Vector3();
    const d = new THREE.Vector3();
    let along = 0;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      d.subVectors(b, a);
      side.crossVectors(d, UP);
      if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
      side.normalize();
      if (i > 0) along += pts[i].distanceTo(pts[i - 1]);
      const w = 0.008 + 0.0025 * along; // widen with distance so it stays a few px wide
      const k = 0.35 + 0.65 * (i / Math.max(1, n - 1));
      pos.setXYZ(2 * i, pts[i].x + side.x * w, pts[i].y + side.y * w, pts[i].z + side.z * w);
      pos.setXYZ(2 * i + 1, pts[i].x - side.x * w, pts[i].y - side.y * w, pts[i].z - side.z * w);
      col.setXYZ(2 * i, c[0] * k, c[1] * k, c[2] * k);
      col.setXYZ(2 * i + 1, c[0] * k, c[1] * k, c[2] * k);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.arc.geometry.setDrawRange(0, Math.max(0, n - 1) * 6);
    this.arc.visible = true;
    this.ring.visible = !!valid;
    if (valid) this.ring.position.copy(hit.point).add(new THREE.Vector3(0, 0.02, 0));
    this.arcTarget = valid ? hit.point.clone() : null;
  }

  commitTeleport() {
    if (this.arcTarget) this.hooks.teleport(this.arcTarget.clone());
    this.arcTarget = null;
    this.arc.visible = false;
    this.ring.visible = false;
  }

  /* ---------------- per frame ---------------- */

  update(dt) {
    this.frame++;
    const mode = this.hooks.mode();
    const eye = this.camera.getWorldPosition(new THREE.Vector3());
    let arcInput = null;
    let moveX = 0;
    let moveY = 0;
    let panelHover = null;

    for (const s of this.inputs) {
      if (!s.source) continue;
      this.updateRay(s);
      const ray = new THREE.Ray(s.origin, s.dir);
      const hit = this.panel.hitTest(ray);
      s.hit = hit;
      if (s.panelDrag) this.panel.pointerMove(hit);
      if (hit && hit.inside && (!panelHover || hit.distance < panelHover.distance)) panelHover = hit;

      const gp = s.source.gamepad;
      if (gp) {
        const pressed = gp.buttons.map((b) => b.pressed);
        const rising = (k) => pressed[k] && !s.buttons[k];
        // X (left controller, button 4 in the xr-standard mapping) toggles the menu.
        if (s.handedness === 'left' && rising(4)) this.hooks.togglePanel();
        s.buttons = pressed;

        const x = gp.axes[2] || 0;
        const y = gp.axes[3] || 0;
        if (s.handedness !== 'left') {
          // snap turn with re-arm hysteresis
          if (s.turnArmed && Math.abs(x) > 0.7) {
            if (!this.hooks.skipIntro()) this.snapTurn(x > 0 ? -SNAP : SNAP);
            s.turnArmed = false;
          } else if (Math.abs(x) < 0.3) s.turnArmed = true;
          // stick forward aims the arc; release teleports
          if (mode === 'human' && y < -0.65 && Math.abs(x) < 0.7) s.arcStick = true;
          else if (s.arcStick && y > -0.3) {
            s.arcStick = false;
            this.commitTeleport();
          }
          if (mode !== 'human') s.arcStick = false;
        } else if (Math.hypot(x, y) > 0.15) {
          moveX = x;
          moveY = y;
        }
      }
      if ((s.arcStick || s.arcTrigger) && mode === 'human') arcInput = s;
    }

    // Rays and cursor
    for (const s of this.inputs) {
      if (!s.source) continue;
      const arcing = s === arcInput;
      const onPanel = s.hit && s.hit.inside;
      if (arcing) s.ray.visible = false;
      else this.drawRay(s, onPanel ? s.hit.distance : RAY_LEN);
      s.cursor.visible = !!onPanel && !arcing;
      if (s.cursor.visible) {
        const p = s.hit.point.clone().addScaledVector(s.dir, -0.002);
        s.cursor.position.copy(this.rig.worldToLocal(p));
        s.cursor.lookAt(eye);
      }
    }
    this.panel.pointerHover(panelHover);

    // Teleport arc
    if (arcInput) this.drawArc(this.computeArc(arcInput));
    else if (this.arc.visible) {
      this.arc.visible = false;
      this.ring.visible = false;
      this.arcTarget = null;
    }

    // Smooth locomotion (opt-in, human scale only): head-relative, on the ground plane.
    this.vignette = 0;
    if (this.hooks.smooth() && mode === 'human' && (moveX || moveY)) {
      const q = this.camera.getWorldQuaternion(new THREE.Quaternion());
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q).setY(0).normalize();
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const step = SMOOTH_SPEED * dt;
      this.rig.position.addScaledVector(fwd, -moveY * step).addScaledVector(right, moveX * step);
      this.vignette = Math.min(1, Math.hypot(moveX, moveY));
    }

    this.updateGrab();
    if (this.frame % 30 === 0) this.unlitModels();
  }

  /** The panel's haptic tick goes to whichever input is pressing it. */
  tick() {
    const s = this.lastPanelInput;
    if (s && s.source) pulse(s.source, 0.2, 10);
  }

  /**
   * Controller and hand models load with MeshStandardMaterial, which renders
   * black in this unlit scene. Swap each for a MeshBasicMaterial (keeping any
   * texture) the first time it appears.
   */
  unlitModels() {
    for (const s of this.inputs) {
      for (const root of [s.grip, s.hand]) {
        root.traverse((o) => {
          if (!o.isMesh || !o.material || o.material.isMeshBasicMaterial) return;
          const old = o.material;
          let m = this.swapped.get(old.uuid);
          if (!m) {
            m = new THREE.MeshBasicMaterial({
              color: old.map ? 0xb8bcc4 : root === s.hand ? 0x9fd8e8 : 0x5a5f68,
              map: old.map || null,
              transparent: old.transparent,
              opacity: old.opacity,
              fog: false,
            });
            this.swapped.set(old.uuid, m);
          }
          o.material = m;
        });
      }
    }
  }

  dispose() {
    for (const s of this.inputs) {
      for (const o of [s.controller, s.grip, s.hand, s.ray, s.cursor]) o.parent && o.parent.remove(o);
      s.ray.geometry.dispose();
      s.ray.material.dispose();
      s.cursor.geometry.dispose();
      s.cursor.material.dispose();
    }
    for (const m of this.swapped.values()) m.dispose();
    this.world.remove(this.arc, this.ring);
    this.arc.geometry.dispose();
    this.arc.material.dispose();
    this.ring.geometry.dispose();
    this.ring.material.dispose();
  }
}
