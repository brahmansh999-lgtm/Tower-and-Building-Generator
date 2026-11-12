/**
 * VRSession.js
 *
 * Session lifecycle and the VR world. Owns:
 *   - requesting the immersive-vr session (local-floor, optional hands),
 *     framebuffer scale per headset, fixed foveation
 *   - the VR world group added to the desktop scene (desktop model hidden while
 *     presenting, restored after)
 *   - VR meshes built from the same generateTower() object as the desktop view,
 *     rebuilt only when form / cluster params or the line scale change
 *   - tabletop (1:500 on a plinth) and human (1:1) scale modes, viewpoints,
 *     comfort fades, cuts and clipping, the intro, the panels
 *   - the UI arc around the user: docked controls on the left, the desktop
 *     plan and section drawings on the right, the data sheet further left
 *
 * World hierarchy (three.js y-up):
 *   world
 *   ├─ environment          grid, horizon, stars (world space, at the real floor)
 *   ├─ plinth               tabletop only
 *   ├─ stage                tabletop: plinth top · yaw · 1/denom ; human: identity
 *   │  └─ model             rotation.x = −90°: data (x, y, z) → world (x, z, −y)
 *   │     ├─ shell, bands, fins, finGlow, bridgeBody, rails, railGlow
 *   │     ├─ cut fill / lines / glow, city, walk (invisible teleport targets)
 *   └─ rig                  moved by teleport / snap turn; holds camera + inputs
 */

import * as THREE from 'three';
import { BRIDGE_STATION_STRIDE } from '../geometry/generateTower.js';
import { buildVRMeshes, buildCutGeometry } from '../geometry/buildVRMeshes.js';
import { VREnvironment } from './VREnvironment.js';
import { VRIntro } from './VRIntro.js';
import { VRInteraction } from './VRInteraction.js';
import { VRPanel } from './VRPanel.js';
import { VRPlanBoard, VRSectionBoard, VRDataBoard } from './VRDrawings.js';

const TABLE_H = 0.86; //  m, plinth top (waist height)
const TABLE_Z = -0.95; // m in front of the starting position
const DEFAULT_DENOM = 500;
const FADE = 0.2; //      s each way for comfort fades
const REBUILD_MS = 120; // minimum gap between VR mesh rebuilds while sliders move
const QUALITY_KEY = 'ttt.vr.quality';
const UI_R = 1.15; // m from the rig origin to the UI arc (always well beyond 0.6 m)
const UP = new THREE.Vector3(0, 1, 0);

/** True when the browser can run an immersive-vr session. */
export async function isVRSupported() {
  try {
    return !!(navigator.xr && (await navigator.xr.isSessionSupported('immersive-vr')));
  } catch {
    return false;
  }
}

/**
 * Framebuffer scale heuristic from the user agent: Quest 3 / Pro (XR2 Gen 2
 * class) can afford 1.2× supersampling at 90 Hz; Quest 2 holds 72 Hz at 1.0×.
 * Vision Pro already renders at a very high native resolution. PC VR gets 1.2×
 * unless the display is already high-DPI.
 */
export function detectQuality() {
  const ua = navigator.userAgent || '';
  if (/Quest 3|Quest Pro/i.test(ua)) return { device: 'QUEST 3', scale: 1.2 };
  if (/Quest|OculusBrowser/i.test(ua)) return { device: 'QUEST 2', scale: 1.0 };
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return { device: 'VISION PRO', scale: 1.0 };
  return { device: 'PC VR', scale: window.devicePixelRatio >= 2 ? 1.0 : 1.2 };
}

function readQuality() {
  try {
    return localStorage.getItem(QUALITY_KEY) || 'auto';
  } catch {
    return 'auto';
  }
}

function writeQuality(q) {
  try {
    localStorage.setItem(QUALITY_KEY, q);
  } catch {
    /* private mode: keep it for this page only */
  }
}

/** Repeating soft pulse used as the map of the bridge glow (scrolled along u). */
function pulseTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 4;
  const ctx = c.getContext('2d');
  for (let x = 0; x < 256; x++) {
    const d = (x - 128) / 22;
    const k = 0.45 + 0.55 * Math.exp(-d * d);
    const v = Math.round(255 * k);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(x, 0, 1, 4);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(2, 1);
  return t;
}

function createMaterials() {
  const pulse = pulseTexture();
  const additive = (opacity, extra = {}) =>
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      ...extra,
    });
  return {
    pulse,
    // polygonOffset pushes the dark body back so the ribbons in front of it
    // never z-fight, even 300 m away with a 5 cm near plane.
    shell: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2 }),
    line: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
    glow: additive(0.12),
    railGlow: additive(0.15, { map: pulse, side: THREE.FrontSide }),
    cutFill: additive(0.06, { fog: false }),
    cutLines: additive(0.9, { fog: false }),
    cutGlow: additive(0.14, { fog: false }),
    walk: new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    plinthTop: new THREE.MeshBasicMaterial({ color: 0x060708 }),
    plinthRing: new THREE.MeshBasicMaterial({ color: 0x4fe3ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    plinthGlow: new THREE.MeshBasicMaterial({ color: 0x1b5f70, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    fade: new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false }),
    vignette: new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, depthTest: false, depthWrite: false, fog: false }),
  };
}

/** Comfort vignette: a head-locked ring, clear in the middle, opaque toward the edge. */
function vignetteGeometry() {
  const inner = 0.22;
  const g = new THREE.RingGeometry(inner, 3, 64, 4);
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 4);
  for (let i = 0; i < p.count; i++) {
    const r = Math.hypot(p.getX(i), p.getY(i));
    const a = THREE.MathUtils.smoothstep(r, inner, inner + 0.7);
    col.set([0, 0, 0, a], 4 * i);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 4)); // rgba → vertex alpha
  return g;
}

const mesh = (material, renderOrder = 0) => {
  const m = new THREE.Mesh(new THREE.BufferGeometry(), material);
  m.renderOrder = renderOrder;
  return m;
};

/** Data (x, y, z) → world (x, z, −y) at human scale (stage = identity). */
const toWorld = (x, y, z) => new THREE.Vector3(x, z, -y);

export class VRSession {
  /**
   * @param {object} o renderer, scene, desktopRoot,
   *   hooks: onForm(k, v), onCuts(k, v), onPresentChange(bool)
   */
  constructor({ renderer, scene, desktopRoot, hooks }) {
    this.renderer = renderer;
    this.scene = scene;
    this.desktopRoot = desktopRoot;
    this.hooks = hooks;
    this.session = null;
    this.world = null;
    this.state = null;
    this.model = null;
    this.dirty = true;
    this.cutsDirty = true;
    this.lastBuild = 0;
    this.mode = 'tabletop';
    this.denom = DEFAULT_DENOM;
    this.yaw = 0;
    this.cut3D = false;
    this.city = true;
    this.smooth = false;
    this.quality = readQuality();
    this.activeScale = 1;
    this.note = '';
    this.fade = null;
    this.vig = 0;
    this.planFocus = 0; // as the desktop: tower A's floor by default
    this.boardsOn = true;
    this.dataOn = true;
    this.uiRevealed = false;
    this.builtLineScale = 0;
    this.maxZ = 1;
    this.onEnd = this.onEnd.bind(this);
  }

  get presenting() {
    return !!this.session;
  }

  /** Latest React state. Geometry rebuilds are deferred to the frame loop. */
  setState(s) {
    const prev = this.state;
    this.state = s;
    if (!prev || prev.model !== s.model) {
      this.model = s.model;
      this.dirty = true;
    }
    if (!prev || prev.model !== s.model || prev.planLevel !== s.planLevel || prev.sectionAxis !== s.sectionAxis || prev.sectionPos !== s.sectionPos) {
      this.cutsDirty = true;
    }
    if (s.cut3D !== this.cut3D) {
      this.cut3D = s.cut3D;
      if (this.world) this.applyClipping();
    }
  }

  /* ---------------- world ---------------- */

  ensureWorld() {
    if (this.world) return;
    const mats = createMaterials();
    this.mats = mats;
    const world = new THREE.Group();
    world.name = 'vr-world';
    world.visible = false;
    this.scene.add(world);
    this.world = world;

    this.env = new VREnvironment();
    world.add(this.env.group);

    this.stage = new THREE.Group();
    this.modelGroup = new THREE.Group();
    this.modelGroup.rotation.x = -Math.PI / 2;
    this.stage.add(this.modelGroup);
    world.add(this.stage);

    this.meshes = {
      shell: mesh(mats.shell),
      bands: mesh(mats.line),
      fins: mesh(mats.line),
      finGlow: mesh(mats.glow, 2),
      bridgeBody: mesh(mats.shell),
      rails: mesh(mats.line),
      railGlow: mesh(mats.railGlow, 2),
    };
    this.walk = mesh(mats.walk);
    this.walk.visible = false;
    this.cutMeshes = {
      fill: mesh(mats.cutFill, 3),
      lines: mesh(mats.cutLines, 4),
      glow: mesh(mats.cutGlow, 3),
    };
    this.modelGroup.add(...Object.values(this.meshes), this.walk, ...Object.values(this.cutMeshes), this.env.city);

    // Plinth: dark disc, a crisp cyan rim and a soft glow ring around it (unit radius, scaled).
    this.plinth = new THREE.Group();
    const top = new THREE.Mesh(new THREE.CylinderGeometry(1, 0.96, 0.04, 96), mats.plinthTop);
    top.position.y = -0.02;
    const rim = new THREE.Mesh(new THREE.RingGeometry(0.985, 1.0, 128).rotateX(-Math.PI / 2), mats.plinthRing);
    rim.position.y = 0.002;
    const halo = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.12, 128).rotateX(-Math.PI / 2), mats.plinthGlow);
    halo.position.y = -0.03;
    this.plinth.add(top, rim, halo);
    this.plinth.position.set(0, TABLE_H, TABLE_Z);
    world.add(this.plinth);

    // Rig + VR camera (separate from the desktop camera, which keeps its orbit).
    this.rig = new THREE.Group();
    this.rig.name = 'vr-rig';
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 5000);
    this.rig.add(this.camera);
    world.add(this.rig);

    this.fadeMesh = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), mats.fade);
    this.fadeMesh.renderOrder = 1000;
    this.fadeMesh.visible = false;
    this.vignette = new THREE.Mesh(vignetteGeometry(), mats.vignette);
    this.vignette.position.z = -0.65;
    this.vignette.renderOrder = 999;
    this.vignette.visible = false;
    this.camera.add(this.fadeMesh, this.vignette);

    this.panel = new VRPanel({
      onChange: (g, k, v) => this.onPanel(g, k, v),
      onHaptic: () => this.interaction && this.interaction.tick(),
    });
    this.planBoard = new VRPlanBoard();
    this.sectionBoard = new VRSectionBoard();
    this.dataBoard = new VRDataBoard();
    this.ui = new THREE.Group();
    this.ui.name = 'vr-ui';
    this.ui.add(this.planBoard.mesh, this.sectionBoard.mesh, this.dataBoard.mesh);
    this.rig.add(this.panel.mesh, this.ui);
    this.layoutUI();

    this.intro = new VRIntro();
    this.interaction = new VRInteraction({
      renderer: this.renderer,
      world,
      rig: this.rig,
      camera: this.camera,
      panel: this.panel,
      hooks: {
        mode: () => this.mode,
        walkables: () => (this.mode === 'human' ? [this.walk] : []),
        skipIntro: () => {
          if (!this.intro.active) return false;
          this.intro.skip();
          return true;
        },
        teleport: (p) => this.comfortMove(() => this.placeFeet(p, null)),
        togglePanel: () => this.panel.toggle(),
        handsDetected: () => this.uiRevealed && this.panel.setVisible(true),
        smooth: () => this.smooth,
        stageCenter: () => this.plinth.getWorldPosition(new THREE.Vector3()),
        getYaw: () => this.yaw,
        setYaw: (y) => {
          this.yaw = y;
          this.stage.rotation.y = y;
        },
        getScale: () => 1 / this.denom,
        setScale: (s) => this.setTabletopScale(1 / s),
        grabEnd: () => this.onGrabEnd(),
      },
    });
  }

  /* ---------------- UI arc ---------------- */

  /**
   * Boards stand on a circle of radius UI_R around the rig origin, each turned
   * to face the centre. Azimuth θ is measured from straight ahead (−Z), positive
   * to the left:  position = (−sin θ·R, y, −cos θ·R),  rotation.y = θ
   * (a plane's +Z normal turned by θ points back at the origin).
   *   controls  +50°   plan  −50°   section  −95°   data  +100°
   * The tabletop model sits straight ahead, between controls and plan.
   */
  layoutUI() {
    const put = (obj, deg, y) => {
      const th = (deg * Math.PI) / 180;
      obj.position.set(-Math.sin(th) * UI_R, y, -Math.cos(th) * UI_R);
      obj.rotation.set(0, th, 0);
    };
    if (this.panel.docked) put(this.panel.mesh, 50, 1.25);
    put(this.planBoard.mesh, -50, 1.45);
    put(this.sectionBoard.mesh, -95, 1.45);
    put(this.dataBoard.mesh, 100, 1.35);
  }

  /* ---------------- building ---------------- */

  targetLineScale() {
    // Tabletop: keep a band ~1.2 mm wide in the headset → 0.0012·denom m in data
    // space, i.e. 0.08 m × (denom · 0.015). Human scale: true 8 cm.
    return this.mode === 'tabletop' ? Math.max(1, this.denom * 0.015) : 1;
  }

  rebuild() {
    const model = this.model;
    if (!model) return;
    const data = buildVRMeshes(model, { lineScale: this.targetLineScale() });
    for (const [k, m] of Object.entries(this.meshes)) {
      m.geometry.dispose();
      m.geometry = data[k] || new THREE.BufferGeometry();
      m.visible = !!data[k];
    }
    this.walk.geometry.dispose();
    this.walk.geometry = data.walk;
    this.maxZ = data.maxZ;
    this.builtLineScale = data.lineScale;
    this.env.buildCity(model);
    this.applyMode(false);
    this.dirty = false;
    this.cutsDirty = true;
    this.lastBuild = performance.now();
  }

  rebuildCuts() {
    const s = this.state;
    if (!s || !this.model) return;
    const g = buildCutGeometry(this.model, {
      level: s.planLevel,
      axis: s.sectionAxis,
      pos: s.sectionPos,
      lineScale: this.builtLineScale || 1,
    });
    for (const k of Object.keys(this.cutMeshes)) {
      this.cutMeshes[k].geometry.dispose();
      this.cutMeshes[k].geometry = g[k];
    }
    this.cutsDirty = false;
  }

  /** Clipping is per material (world-space plane) so the void and city are never cut. */
  applyClipping() {
    const planes = this.cut3D ? [this.clipPlane || (this.clipPlane = new THREE.Plane())] : null;
    for (const m of [this.mats.shell, this.mats.line, this.mats.glow, this.mats.railGlow]) {
      m.clippingPlanes = planes;
      m.needsUpdate = true;
    }
  }

  /**
   * Section plane in data space (keep data y ≥ pos for axis x, data x ≥ pos for
   * axis y, as on desktop), carried into world space through the model's
   * world matrix every frame so it follows tabletop rotation and scale.
   */
  updateClipPlane() {
    if (!this.cut3D || !this.state) return;
    const s = this.state;
    const n = s.sectionAxis === 'x' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    this.modelGroup.updateWorldMatrix(true, false);
    this.clipPlane.set(n, -s.sectionPos).applyMatrix4(this.modelGroup.matrixWorld);
  }

  /* ---------------- scale modes ---------------- */

  plinthRadius() {
    const b = this.model ? this.model.bounds : { minX: -60, maxX: 60, minY: -60, maxY: 60 };
    const siteR = Math.max(Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minY), Math.abs(b.maxY));
    return THREE.MathUtils.clamp(Math.max(siteR * 1.35, 260) / this.denom, 0.3, 0.75);
  }

  /** Put the stage, plinth and environment into the current mode. */
  applyMode(rebuildCity = true) {
    if (this.mode === 'tabletop') {
      const R = this.plinthRadius();
      this.stage.position.set(0, TABLE_H, TABLE_Z);
      this.stage.rotation.set(0, this.yaw, 0);
      this.stage.scale.setScalar(1 / this.denom);
      this.plinth.scale.set(R, 1, R);
      this.plinth.visible = true;
      if (rebuildCity || this.env.nearR === Infinity) this.env.setTabletop(true, R * this.denom);
    } else {
      this.stage.position.set(0, 0, 0);
      this.stage.rotation.set(0, 0, 0);
      this.stage.scale.setScalar(1);
      this.plinth.visible = false;
      this.env.setTabletop(false);
    }
  }

  setMode(mode, moveUser = true) {
    if (mode === this.mode && this.world) return;
    this.mode = mode;
    this.dirty = true; // line widths differ per mode
    this.rebuild();
    if (!moveUser) return;
    if (mode === 'tabletop') this.comfortMove(() => this.resetRig());
    else this.comfortMove(() => this.goViewpoint('street'));
  }

  /** Live two-hand scaling: only the stage transform changes until release. */
  setTabletopScale(denom) {
    this.denom = denom;
    const R = this.plinthRadius();
    this.stage.scale.setScalar(1 / denom);
    this.plinth.scale.set(R, 1, R);
  }

  /** After a grab: rebuild ribbons if their width is now off by > 15 %, refit the city. */
  onGrabEnd() {
    if (this.mode !== 'tabletop') return;
    const target = this.targetLineScale();
    if (Math.abs(target - this.builtLineScale) / this.builtLineScale > 0.15) this.rebuild();
    this.env.setTabletop(true, this.plinthRadius() * this.denom);
  }

  /* ---------------- moving the user ---------------- */

  resetRig() {
    this.rig.position.set(0, 0, 0);
    this.rig.rotation.set(0, 0, 0);
  }

  /** Head yaw relative to the rig (from the XR pose). */
  headYaw() {
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    return e.y;
  }

  /**
   * Place the rig so the user's feet land on `p` (world). The head is offset
   * from the rig origin by its tracked local position c, so
   *   rig.position = p − R_y(rig.yaw)·(c.x, 0, c.z),   rig.y = p.y
   * With `yaw` given, the rig is first turned so the head faces that heading:
   *   rig.yaw = yaw − headYaw
   */
  placeFeet(p, yaw) {
    if (yaw !== null && yaw !== undefined) this.rig.rotation.set(0, yaw - this.headYaw(), 0);
    const c = this.camera.position;
    const off = new THREE.Vector3(c.x, 0, c.z).applyAxisAngle(UP, this.rig.rotation.y);
    this.rig.position.set(p.x - off.x, p.y, p.z - off.z);
  }

  /** Fade to black over 200 ms, run fn, fade back over 200 ms. */
  comfortMove(fn) {
    if (this.fade && !this.fade.ran) this.fade.fn = fn;
    else this.fade = { t: 0, fn, ran: false };
  }

  updateFade(dt) {
    const f = this.fade;
    if (!f) return;
    f.t += dt;
    let o;
    if (f.t < FADE) o = f.t / FADE;
    else {
      if (!f.ran) {
        f.ran = true;
        f.fn();
      }
      o = Math.max(0, 1 - (f.t - FADE) / FADE);
      if (f.t >= 2 * FADE) this.fade = null;
    }
    this.mats.fade.opacity = o;
    this.fadeMesh.visible = o > 0.001;
  }

  /**
   * Preset viewpoints, computed from the model data (data space, then → world):
   *   STREET  ground, 40 m south of the podium edge, facing the towers
   *   PODIUM  on the podium roof, toward its south edge, facing the towers
   *   BRIDGE  on the roof of the lowest bridge at mid-span, facing tower B
   *   CROWN   roof of the tallest tower, at the edge facing the cluster centre
   *   DRONE   300 m out (south-east) with the eyes at mid-height
   */
  goViewpoint(name) {
    const m = this.model;
    if (!m) return;
    const H = m.stats.height;
    const pod = m.podium;
    const out = pod.outline2D;
    let rPod = 0;
    let south = [0, -1];
    let minY = Infinity;
    for (let i = 0; i < out.length; i += 2) {
      rPod = Math.max(rPod, Math.hypot(out[i], out[i + 1]));
      if (out[i + 1] < minY) {
        minY = out[i + 1];
        south = [out[i], out[i + 1]];
      }
    }
    const eye = this.camera.position.y > 0.5 ? this.camera.position.y : 1.6;
    let p;
    let look;
    this.note = '';
    if (name === 'bridge' && !m.bridges.length) {
      name = 'podium';
      this.note = 'NO BRIDGES · PODIUM ROOF INSTEAD';
    }
    switch (name) {
      case 'street':
        p = [0, -(rPod + 40), 0];
        look = [0, 0, H * 0.6];
        break;
      case 'podium':
        p = [south[0] * 0.82, south[1] * 0.82, pod.height];
        look = [0, 0, H * 0.5];
        break;
      case 'bridge': {
        const br = m.bridges.reduce((a, b) => (b.z < a.z ? b : a));
        const K = BRIDGE_STATION_STRIDE;
        const i = Math.floor(br.stations.length / K / 2);
        const s = br.stations;
        p = [s[K * i], s[K * i + 1], s[K * i + 2] + s[K * i + 4] * 0.97];
        look = [p[0] + br.ux * 20, p[1] + br.uy * 20, p[2]];
        break;
      }
      case 'crown': {
        const T = m.towers.reduce((a, b) => (b.floors.length > a.floors.length ? b : a));
        const top = T.floors[T.floors.length - 1];
        let gx = 0;
        let gy = 0;
        m.towers.forEach((t) => {
          gx += t.floors[0].cx / m.towers.length;
          gy += t.floors[0].cy / m.towers.length;
        });
        let dx = gx - top.cx;
        let dy = gy - top.cy;
        const l = Math.hypot(dx, dy);
        if (l < 1) {
          dx = 0;
          dy = -1;
        } else {
          dx /= l;
          dy /= l;
        }
        // plate vertex furthest along the direction to the cluster centre
        let best = 0;
        let bx = top.cx;
        let by = top.cy;
        const q = top.points2D;
        for (let j = 0; j < q.length; j += 2) {
          const d = (q[j] - top.cx) * dx + (q[j + 1] - top.cy) * dy;
          if (d > best) {
            best = d;
            bx = q[j];
            by = q[j + 1];
          }
        }
        p = [top.cx + (bx - top.cx) * 0.8, top.cy + (by - top.cy) * 0.8, top.z];
        look = [p[0] + dx * 30, p[1] + dy * 30, p[2] - 40];
        break;
      }
      case 'drone':
      default: {
        const a = -Math.PI / 4;
        p = [Math.cos(a) * 300, Math.sin(a) * 300, H / 2 - eye];
        look = [0, 0, H / 2];
        break;
      }
    }
    const P = toWorld(...p);
    const L = toWorld(...look);
    const yaw = Math.atan2(-(L.x - P.x), -(L.z - P.z)); // forward (−sinψ, 0, −cosψ) → target
    this.placeFeet(P, yaw);
  }

  /* ---------------- panel ---------------- */

  onPanel(group, key, value) {
    if (group === 'form') this.hooks.onForm(key, value);
    else if (group === 'cuts') this.hooks.onCuts(key, value);
    else if (key === 'scale') this.setMode(value);
    else if (key === 'view') {
      if (this.mode !== 'human') {
        this.mode = 'human';
        this.rebuild();
      }
      this.comfortMove(() => this.goViewpoint(value));
    } else if (key === 'city') {
      this.city = value;
      this.env.setCityVisible(value);
    } else if (key === 'smooth') this.smooth = value;
    else if (key === 'planFocus') this.planFocus = value;
    else if (key === 'boards') {
      this.boardsOn = value;
      this.planBoard.mesh.visible = value;
      this.sectionBoard.mesh.visible = value;
    } else if (key === 'data') {
      this.dataOn = value;
      this.dataBoard.mesh.visible = value;
    } else if (key === 'docked') {
      this.panel.setDocked(value);
      this.layoutUI();
    }
    else if (key === 'quality') {
      this.quality = value;
      writeQuality(value);
      this.note = 'QUALITY APPLIES NEXT TIME YOU ENTER VR';
    }
  }

  panelState() {
    const s = this.state;
    return {
      form: s.form,
      cuts: s.cuts,
      maxLevel: s.maxLevel,
      sectionMetres: s.sectionMetres,
      stats: this.model.stats,
      vr: {
        scale: this.mode,
        denom: this.denom,
        city: this.city,
        smooth: this.smooth,
        planFocus: this.planFocus,
        towerNames: this.model.towers.map((T) => T.name),
        boards: this.boardsOn,
        data: this.dataOn,
        docked: this.panel.docked,
        quality: this.quality,
        device: detectQuality().device,
        activeScale: this.activeScale,
        note: this.note,
      },
    };
  }

  qualityScale() {
    return this.quality === 'auto' ? detectQuality().scale : parseFloat(this.quality) || 1;
  }

  /* ---------------- lifecycle ---------------- */

  /** Must be called from a user gesture (the Enter VR button). */
  async enter() {
    if (this.session || !navigator.xr) return;
    const renderer = this.renderer;
    this.activeScale = this.qualityScale();
    renderer.xr.setReferenceSpaceType('local-floor');
    renderer.xr.setFramebufferScaleFactor(this.activeScale);
    const session = await navigator.xr.requestSession('immersive-vr', {
      requiredFeatures: ['local-floor'],
      optionalFeatures: ['bounded-floor', 'hand-tracking'],
    });
    this.session = session;
    session.addEventListener('end', this.onEnd);

    this.ensureWorld();
    this.saved = {
      clipping: renderer.clippingPlanes,
      local: renderer.localClippingEnabled,
      fog: this.scene.fog,
    };
    renderer.clippingPlanes = [];
    renderer.localClippingEnabled = true;
    this.scene.fog = this.env.fog;
    this.desktopRoot.visible = false;
    this.world.visible = true;

    this.mode = 'tabletop';
    this.denom = DEFAULT_DENOM;
    this.yaw = 0;
    this.note = '';
    this.rebuild();
    this.rebuildCuts();
    this.applyClipping();
    this.resetRig();
    this.panel.setVisible(false);
    this.uiRevealed = false;
    this.ui.visible = false;
    this.env.setReveal(0);
    this.intro.start();
    this.hooks.onPresentChange(true);

    await renderer.xr.setSession(session);
    renderer.xr.setFoveation(0.5);
  }

  exit() {
    if (this.session) this.session.end();
  }

  onEnd() {
    const renderer = this.renderer;
    if (this.session) this.session.removeEventListener('end', this.onEnd);
    this.session = null;
    if (this.saved) {
      renderer.clippingPlanes = this.saved.clipping;
      renderer.localClippingEnabled = this.saved.local;
      this.scene.fog = this.saved.fog;
    }
    this.world.visible = false;
    this.desktopRoot.visible = true;
    this.fade = null;
    this.hooks.onPresentChange(false);
  }

  /** One XR frame: update everything, return the camera to render with. */
  frame(dt) {
    // Pull this frame's head pose into the camera before anything reads it.
    this.renderer.xr.updateCamera(this.camera);

    if (this.dirty && performance.now() - this.lastBuild > REBUILD_MS) this.rebuild();
    if (this.cutsDirty) this.rebuildCuts();

    this.interaction.update(dt);
    this.updateClipPlane();
    this.intro.update(
      dt,
      {
        tower: [this.meshes.shell, this.meshes.bands],
        fins: [this.meshes.fins, this.meshes.finGlow],
        bridges: [this.meshes.bridgeBody, this.meshes.rails, this.meshes.railGlow],
      },
      this.maxZ,
      this.env
    );

    const eye = this.camera.getWorldPosition(new THREE.Vector3());
    const eyeQ = this.camera.getWorldQuaternion(new THREE.Quaternion());
    this.env.update(dt, eye);
    this.mats.pulse.offset.x -= dt * 0.22; // light travelling along every bridge

    this.updateFade(dt);
    // Vignette tightens with smooth-locomotion speed (eased so it never pops).
    this.vig += (this.interaction.vignette - this.vig) * Math.min(1, dt * 8);
    this.vignette.visible = this.vig > 0.01;
    this.mats.vignette.opacity = this.vig;
    this.vignette.scale.setScalar(1.7 - 0.7 * this.vig);

    // Panels
    if (this.state && this.model) {
      const left = this.interaction.inputs.find((s) => s.source && s.handedness === 'left');
      let anchor = null;
      if (left) anchor = left.grip.visible ? left.grip : left.isHand ? left.hand.joints && left.hand.joints.wrist : null;
      // The controls and boards appear once the intro has finished (or was skipped).
      if (!this.intro.active && !this.uiRevealed) {
        this.uiRevealed = true;
        this.panel.setVisible(true);
        this.ui.visible = true;
      }
      this.panel.setState(this.panelState());
      this.panel.place(this.rig, eye, eyeQ, anchor);
      this.panel.update();
      const s = this.state;
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(eyeQ);
      const here = this.mode === 'human' ? { x: eye.x, y: -eye.z, heading: Math.atan2(fwd.x, -fwd.z) } : null;
      this.planBoard.update(this.model, s.planLevel, s.sectionAxis, s.sectionPos, this.planFocus, here);
      this.sectionBoard.update(this.model, s.planLevel, s.sectionAxis, s.sectionPos);
      this.dataBoard.update(this.model, s.planLevel);
    }
    return this.camera;
  }

  dispose() {
    if (this.session) this.session.end();
    if (!this.world) return;
    this.interaction.dispose();
    this.panel.dispose();
    this.planBoard.dispose();
    this.sectionBoard.dispose();
    this.dataBoard.dispose();
    this.env.dispose();
    this.world.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    for (const m of Object.values(this.mats)) m.dispose();
    this.scene.remove(this.world);
    this.world = null;
  }
}
