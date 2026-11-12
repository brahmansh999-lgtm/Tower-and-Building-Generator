/**
 * VRPanel.js
 *
 * In-VR UI built from plain three.js: a canvas drawn with the same visual
 * language as the desktop panel (black translucent card, 1 px white rules,
 * monospace uppercase micro-labels, cyan for cuts, amber for bridges), shown on
 * a MeshBasicMaterial plane. The canvas is redrawn only when a value or the
 * hover state changes.
 *
 *   VRPanel      wrist menu on the left controller: FORM / CLUSTER / CUTS / VR
 *   VRPlanPanel  optional floating plan of the current cut with "you are here"
 *
 * Pointer input arrives from VRInteraction as panel UV coordinates.
 */

import * as THREE from 'three';
import { PARAM_RANGES, FLOOR_HEIGHT } from '../geometry/generateTower.js';

const CW = 1024; //  canvas px
const CH = 1700;
export const PANEL_W = 0.26; // m
export const PANEL_H = (PANEL_W * CH) / CW;
const MIN_EYE_DIST = 0.6; // UI never closer than this to the eyes

const COL = {
  bg: 'rgba(0, 0, 0, 0.84)',
  fg: '#e9e9e6',
  dim: 'rgba(255, 255, 255, 0.5)',
  faint: 'rgba(255, 255, 255, 0.24)',
  rule: 'rgba(255, 255, 255, 0.16)',
  cyan: '#4fe3ff',
  amber: '#ffb347',
};
const FONT = "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace";
const PAD = 52;

const signed = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} M`;
const fmt = (v) => Math.round(v).toLocaleString('en-US');

function setFont(ctx, px, weight = 500) {
  ctx.font = `${weight} ${px}px ${FONT}`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(px * 0.18)}px`;
}

/** Widget list for the current state, laid out top to bottom. */
function describe(s) {
  const R = PARAM_RANGES;
  const { form, cuts, vr } = s;
  const level = Math.min(cuts.planLevel, s.maxLevel);
  const items = [
    { t: 'header', h: 120 },
    { t: 'readout', h: 190 },
    { t: 'micro', label: 'FORM', h: 52 },
    { t: 'slider', group: 'form', key: 'floors', label: 'HEIGHT', ...R.floors, value: form.floors, text: `${form.floors} FL · ${(form.floors * FLOOR_HEIGHT).toFixed(1)} M` },
    { t: 'slider', group: 'form', key: 'width', label: 'WIDTH', ...R.width, value: form.width, text: `${form.width} M` },
    { t: 'slider', group: 'form', key: 'sway', label: 'SWAY', ...R.sway, value: form.sway, text: `${form.sway.toFixed(1)} M` },
    { t: 'slider', group: 'form', key: 'twist', label: 'TWIST', ...R.twist, value: form.twist, text: `${form.twist}°` },
    { t: 'micro', label: 'CLUSTER', h: 52 },
    { t: 'slider', group: 'form', key: 'towers', label: 'TOWERS', ...R.towers, value: form.towers, text: `${form.towers}` },
    { t: 'slider', group: 'form', key: 'bridges', label: 'BRIDGES', ...R.bridges, value: form.bridges, text: `${form.bridges} / LINK`, accent: COL.amber },
    {
      t: 'seg', group: 'form', key: 'mode', label: 'CONNECTION', value: form.mode,
      options: [['adjacent', 'PAIRS'], ['all', 'ALL'], ['chain', 'CHAIN']],
    },
    { t: 'micro', label: 'CUTS', h: 52 },
    { t: 'slider', group: 'cuts', key: 'planLevel', label: 'PLAN LEVEL', min: 0, max: s.maxLevel, step: 1, value: level, text: `L${level} · +${(level * FLOOR_HEIGHT).toFixed(1)} M`, accent: COL.cyan },
    { t: 'slider', group: 'cuts', key: 'sectionPos', label: 'SECTION', min: -100, max: 100, step: 0.5, value: cuts.sectionPos, text: `${cuts.axis === 'x' ? 'Y' : 'X'} ${signed(s.sectionMetres)}`, accent: COL.cyan },
    { t: 'seg', group: 'cuts', key: 'axis', label: 'SECTION AXIS', value: cuts.axis, options: [['x', '∥ X'], ['y', '∥ Y']] },
    { t: 'toggle', group: 'cuts', key: 'cut3D', label: 'CUT 3D MODEL', value: cuts.cut3D },
    { t: 'micro', label: 'VR', h: 52 },
    {
      t: 'seg', group: 'vr', key: 'scale', label: `SCALE · ${vr.scale === 'tabletop' ? `1:${Math.round(vr.denom)}` : '1:1'}`, value: vr.scale,
      options: [['tabletop', 'TABLETOP'], ['human', 'HUMAN 1:1']],
    },
    {
      t: 'buttons', group: 'vr', key: 'view', label: 'VIEWPOINTS',
      options: [['street', 'STREET'], ['podium', 'PODIUM'], ['bridge', 'BRIDGE'], ['crown', 'CROWN'], ['drone', 'DRONE']],
    },
    {
      t: 'chips', group: 'vr', label: 'OPTIONS',
      options: [['city', 'CITY', vr.city], ['smooth', 'SMOOTH MOVE', vr.smooth], ['planPanel', 'PLAN MAP', vr.planPanel]],
    },
    {
      t: 'seg', group: 'vr', key: 'quality', label: `QUALITY · ${vr.device} · ${vr.activeScale.toFixed(1)}×`, value: vr.quality,
      options: [['auto', 'AUTO'], ['1.0', '1.0×'], ['1.2', '1.2×']],
    },
    { t: 'footer', h: 70 },
  ];
  const H = { slider: 100, seg: 96, toggle: 64, buttons: 96, chips: 96 };
  let y = 0;
  for (const it of items) {
    it.y = y;
    it.h = it.h ?? H[it.t];
    y += it.h;
  }
  return items;
}

export class VRPanel {
  /**
   * @param {object} hooks onChange(group, key, value), onHaptic()
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.canvas = document.createElement('canvas');
    this.canvas.width = CW;
    this.canvas.height = CH;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.texture.generateMipmaps = true;
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, PANEL_H), this.material);
    this.mesh.name = 'vr-panel';
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
    this.state = null;
    this.items = [];
    this.hover = '';
    this.drag = null;
    this.lastKey = '';
    this.anchored = false; // fallback placement when no left controller is tracked
  }

  get visible() {
    return this.mesh.visible;
  }

  setVisible(v) {
    this.mesh.visible = v;
    if (!v) {
      this.drag = null;
      this.anchored = false;
    }
  }

  toggle() {
    this.setVisible(!this.mesh.visible);
  }

  setState(s) {
    this.state = s;
  }

  /* ---------------- placement ---------------- */

  /**
   * Wrist placement: 18 cm above and 6 cm ahead of the left grip, turned to face
   * the eyes. If that point is closer than 0.6 m to the eyes, it is pushed out
   * along the eye→panel ray to exactly 0.6 m (the comfort minimum). Without a
   * tracked left grip, the panel is parked 0.75 m ahead of the head once and
   * stays put in the rig until reopened.
   */
  place(rig, eye, eyeQuat, leftGrip) {
    if (!this.mesh.visible) return;
    const p = new THREE.Vector3();
    if (leftGrip && leftGrip.visible) {
      // Offset in world terms (up, and away from the eyes horizontally) so a
      // rolled wrist doesn't tip the panel over.
      leftGrip.updateWorldMatrix(true, false);
      const g = new THREE.Vector3().setFromMatrixPosition(leftGrip.matrixWorld);
      const away = new THREE.Vector3().subVectors(g, eye).setY(0).normalize();
      p.copy(g).add(new THREE.Vector3(0, 0.18, 0)).addScaledVector(away, 0.06);
      this.anchored = false;
    } else if (!this.anchored) {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(eyeQuat).setY(0).normalize();
      p.copy(eye).addScaledVector(fwd, 0.75).add(new THREE.Vector3(0, -0.12, 0));
      this.anchored = true;
    } else {
      this.mesh.getWorldPosition(p);
    }
    const d = p.distanceTo(eye);
    if (d < MIN_EYE_DIST) p.sub(eye).multiplyScalar(MIN_EYE_DIST / Math.max(d, 1e-4)).add(eye);
    rig.updateWorldMatrix(true, false);
    this.mesh.position.copy(rig.worldToLocal(p.clone()));
    this.mesh.lookAt(eye);
  }

  /* ---------------- pointer ---------------- */

  /**
   * Ray → panel UV. Intersect the panel's infinite plane, then express the hit
   * in panel-local coordinates: u = x/W + ½, v = y/H + ½. Returns
   * { u, v, inside, distance } or null when the ray faces away.
   */
  hitTest(ray) {
    if (!this.mesh.visible) return null;
    this.mesh.updateWorldMatrix(true, false);
    const n = new THREE.Vector3(0, 0, 1).transformDirection(this.mesh.matrixWorld);
    const o = new THREE.Vector3().setFromMatrixPosition(this.mesh.matrixWorld);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, o);
    const hit = new THREE.Vector3();
    if (!ray.intersectPlane(plane, hit)) return null;
    const local = this.mesh.worldToLocal(hit.clone());
    const u = local.x / PANEL_W + 0.5;
    const v = local.y / PANEL_H + 0.5;
    return { u, v, inside: u >= 0 && u <= 1 && v >= 0 && v <= 1, distance: ray.origin.distanceTo(hit), point: hit };
  }

  /** Canvas px → widget hit {id, item, option?}. */
  widgetAt(u, v) {
    const x = u * CW;
    const y = (1 - v) * CH;
    for (const it of this.items) {
      if (y < it.y || y >= it.y + it.h) continue;
      if (it.t === 'slider') return { id: `${it.key}`, item: it };
      if (it.t === 'toggle') return { id: it.key, item: it };
      if (it.t === 'seg' || it.t === 'buttons' || it.t === 'chips') {
        const r = it.row;
        if (!r || y < r.y || y > r.y + r.h) return null;
        const i = Math.floor(((x - r.x) / r.w) * it.options.length);
        if (i < 0 || i >= it.options.length) return null;
        return { id: `${it.key ?? it.label}:${i}`, item: it, option: it.options[i] };
      }
      return null;
    }
    return null;
  }

  pointerHover(hit) {
    const w = hit && hit.inside ? this.widgetAt(hit.u, hit.v) : null;
    this.hover = w ? w.id : '';
  }

  pointerDown(hit) {
    if (!hit || !hit.inside) return false;
    const w = this.widgetAt(hit.u, hit.v);
    if (!w) return true; // on the card, but not on a control: still consumed
    const it = w.item;
    if (it.t === 'slider') {
      this.drag = it;
      this.dragTo(hit.u);
    } else if (it.t === 'toggle') {
      this.hooks.onChange(it.group, it.key, !it.value);
      this.hooks.onHaptic();
    } else if (it.t === 'seg' || it.t === 'buttons') {
      this.hooks.onChange(it.group, it.key, w.option[0]);
      this.hooks.onHaptic();
    } else if (it.t === 'chips') {
      this.hooks.onChange(it.group, w.option[0], !w.option[2]);
      this.hooks.onHaptic();
    }
    return true;
  }

  pointerMove(hit) {
    if (this.drag && hit) this.dragTo(hit.u);
  }

  pointerUp() {
    this.drag = null;
  }

  get dragging() {
    return !!this.drag;
  }

  /** Slider value from the horizontal position on its track, snapped to step. */
  dragTo(u) {
    const it = this.drag;
    const tr = it.track;
    const frac = Math.min(1, Math.max(0, (u * CW - tr.x) / tr.w));
    const steps = Math.round((frac * (it.max - it.min)) / it.step);
    const value = Math.min(it.max, it.min + steps * it.step);
    if (Math.abs(value - it.value) > 1e-9) {
      it.value = value;
      this.hooks.onChange(it.group, it.key, value);
      this.hooks.onHaptic(); // one 10 ms tick per slider step
    }
  }

  /* ---------------- drawing ---------------- */

  /** Redraw only if something visible changed. */
  update() {
    if (!this.mesh.visible || !this.state) return;
    const s = this.state;
    const key = JSON.stringify([s.form, s.cuts, s.vr, s.maxLevel, s.sectionMetres.toFixed(1), s.stats, this.hover]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    // Keep the live drag item so its value stays in sync while held.
    const dragKey = this.drag && this.drag.key;
    this.items = describe(s);
    if (dragKey) this.drag = this.items.find((it) => it.key === dragKey) || null;
    this.draw();
    this.texture.needsUpdate = true;
  }

  draw() {
    const ctx = this.ctx;
    const s = this.state;
    ctx.clearRect(0, 0, CW, CH);
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, CW, CH);
    ctx.strokeStyle = COL.fg;
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, CW - 3, CH - 3);
    ctx.textBaseline = 'middle';
    const inner = CW - PAD * 2;

    for (const it of this.items) {
      const y = it.y;
      switch (it.t) {
        case 'header': {
          setFont(ctx, 34, 700);
          ctx.fillStyle = COL.fg;
          ctx.textAlign = 'left';
          ctx.fillText('TWISTED TWIN TOWERS', PAD, y + 54);
          setFont(ctx, 19);
          ctx.fillStyle = COL.dim;
          ctx.fillText('VR · WRIST MENU · X TO HIDE', PAD, y + 92);
          break;
        }
        case 'readout': {
          const st = s.stats;
          const cells = [
            ['FLOORS', `${st.totalFloors}`],
            ['HEIGHT', `${st.height.toFixed(1)} M`],
            ['GFA', `${fmt(st.gfa)} M²`],
            ['TOWERS', `${st.towers}`],
            ['BRIDGES', `${st.bridges}`, COL.amber],
            ['SWAY', `${st.sway.toFixed(1)} M`],
            ['TWIST', `${st.twist}°`],
            ['SCALE', s.vr.scale === 'tabletop' ? `1:${Math.round(s.vr.denom)}` : '1:1'],
          ];
          const cw = inner / 4;
          cells.forEach(([label, value, color], i) => {
            const cx = PAD + (i % 4) * cw;
            const cy = y + 20 + Math.floor(i / 4) * 84;
            setFont(ctx, 17);
            ctx.fillStyle = COL.dim;
            ctx.textAlign = 'left';
            ctx.fillText(label, cx, cy + 14);
            setFont(ctx, 27, 600);
            ctx.fillStyle = color || COL.fg;
            ctx.fillText(value, cx, cy + 50);
          });
          break;
        }
        case 'micro': {
          setFont(ctx, 19, 600);
          ctx.fillStyle = COL.dim;
          ctx.textAlign = 'left';
          ctx.fillText(it.label, PAD, y + 28);
          const tw = ctx.measureText(it.label).width;
          ctx.strokeStyle = COL.rule;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(PAD + tw + 18, y + 28);
          ctx.lineTo(CW - PAD, y + 28);
          ctx.stroke();
          break;
        }
        case 'slider': {
          const hot = this.hover === it.key || (this.drag && this.drag.key === it.key);
          setFont(ctx, 22, 500);
          ctx.textAlign = 'left';
          ctx.fillStyle = hot ? COL.fg : COL.dim;
          ctx.fillText(it.label, PAD, y + 26);
          ctx.textAlign = 'right';
          ctx.fillStyle = it.accent || COL.fg;
          ctx.fillText(it.text, CW - PAD, y + 26);
          const tr = { x: PAD + 14, y: y + 68, w: inner - 28 };
          it.track = tr;
          const frac = (it.value - it.min) / (it.max - it.min || 1);
          ctx.strokeStyle = COL.rule;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(tr.x, tr.y);
          ctx.lineTo(tr.x + tr.w, tr.y);
          ctx.stroke();
          ctx.strokeStyle = it.accent || COL.fg;
          ctx.globalAlpha = 0.7;
          ctx.beginPath();
          ctx.moveTo(tr.x, tr.y);
          ctx.lineTo(tr.x + tr.w * frac, tr.y);
          ctx.stroke();
          ctx.globalAlpha = 1;
          const tx = tr.x + tr.w * frac;
          const ts = hot ? 30 : 24;
          ctx.fillStyle = COL.fg;
          ctx.fillRect(tx - ts / 2, tr.y - ts / 2, ts, ts);
          break;
        }
        case 'seg':
        case 'buttons':
        case 'chips': {
          setFont(ctx, 20, 500);
          ctx.textAlign = 'left';
          ctx.fillStyle = COL.dim;
          ctx.fillText(it.label, PAD, y + 22);
          const r = { x: PAD, y: y + 42, w: inner, h: 46 };
          it.row = r;
          const n = it.options.length;
          const bw = r.w / n;
          ctx.strokeStyle = COL.rule;
          ctx.lineWidth = 2;
          ctx.strokeRect(r.x, r.y, r.w, r.h);
          it.options.forEach((o, i) => {
            const bx = r.x + i * bw;
            const id = `${it.key ?? it.label}:${i}`;
            const on = it.t === 'seg' ? o[0] === it.value : it.t === 'chips' ? o[2] : false;
            if (on) {
              ctx.fillStyle = COL.fg;
              ctx.fillRect(bx, r.y, bw, r.h);
            } else if (this.hover === id) {
              ctx.fillStyle = 'rgba(255,255,255,0.12)';
              ctx.fillRect(bx, r.y, bw, r.h);
            }
            if (i > 0) {
              ctx.beginPath();
              ctx.moveTo(bx, r.y);
              ctx.lineTo(bx, r.y + r.h);
              ctx.stroke();
            }
            setFont(ctx, n > 3 ? 17 : 19, 600);
            ctx.textAlign = 'center';
            ctx.fillStyle = on ? '#000' : this.hover === id ? COL.fg : COL.dim;
            ctx.fillText(o[1], bx + bw / 2, r.y + r.h / 2 + 1);
          });
          break;
        }
        case 'toggle': {
          const hot = this.hover === it.key;
          ctx.strokeStyle = it.value ? COL.cyan : COL.faint;
          ctx.lineWidth = 3;
          ctx.strokeRect(PAD, y + 18, 26, 26);
          if (it.value) {
            ctx.fillStyle = COL.cyan;
            ctx.fillRect(PAD + 6, y + 24, 14, 14);
          }
          setFont(ctx, 22, 500);
          ctx.textAlign = 'left';
          ctx.fillStyle = hot ? COL.fg : COL.dim;
          ctx.fillText(it.label, PAD + 46, y + 32);
          ctx.textAlign = 'right';
          ctx.fillStyle = it.value ? COL.cyan : COL.dim;
          ctx.fillText(it.value ? 'ON' : 'OFF', CW - PAD, y + 32);
          break;
        }
        case 'footer': {
          setFont(ctx, 16);
          ctx.textAlign = 'left';
          ctx.fillStyle = COL.faint;
          const tip = s.vr.scale === 'tabletop' ? 'GRIP ROTATE · BOTH GRIPS SCALE 1:1000–1:200' : 'STICK ↑ TELEPORT · ← → TURN 30°';
          ctx.fillText(tip, PAD, y + 26);
          if (s.vr.note) {
            ctx.fillStyle = COL.amber;
            ctx.fillText(s.vr.note, PAD, y + 52);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

/* ---------------------------------------------------------------------------
 * Floating plan of the current cut
 * ------------------------------------------------------------------------- */

const PW = 768;
const PLAN_SIZE = 0.44; // m

export class VRPlanPanel {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = PW;
    this.canvas.height = PW;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(PLAN_SIZE, PLAN_SIZE), this.material);
    this.mesh.name = 'vr-plan-panel';
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
    // Beside the user, at the right, ~0.95 m from the eyes: always ≥ 0.6 m.
    this.mesh.position.set(0.62, 1.32, -0.72);
    this.mesh.rotation.y = -0.7;
    this.lastKey = '';
  }

  /**
   * Draw plates at the plan level, the podium, bridges cut by the level, the
   * section line and (human scale) a "you are here" marker with view heading.
   * here = { x, y, heading } in data space, or null.
   */
  update(model, level, axis, pos, here) {
    if (!this.mesh.visible || !model) return;
    const hk = here ? `${here.x.toFixed(0)},${here.y.toFixed(0)},${here.heading.toFixed(1)}` : '-';
    const key = `${model.params.floors}|${JSON.stringify(model.params)}|${level}|${axis}|${pos.toFixed(1)}|${hk}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, PW, PW);
    ctx.fillStyle = 'rgba(0,0,0,0.86)';
    ctx.fillRect(0, 0, PW, PW);
    ctx.strokeStyle = COL.fg;
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, PW - 3, PW - 3);

    const b = model.bounds;
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 1.25 + 40;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const k = (PW - 120) / span;
    const X = (x) => PW / 2 + (x - cx) * k;
    const Y = (y) => PW / 2 + 30 - (y - cy) * k;
    const poly = (p) => {
      ctx.beginPath();
      for (let i = 0; i < p.length; i += 2) ctx[i ? 'lineTo' : 'moveTo'](X(p[i]), Y(p[i + 1]));
      ctx.closePath();
    };

    setFont(ctx, 22, 700);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = COL.fg;
    ctx.fillText(`PLAN · L${level}`, 34, 40);
    ctx.textAlign = 'right';
    ctx.fillStyle = COL.cyan;
    ctx.fillText(`+${(level * FLOOR_HEIGHT).toFixed(1)} M`, PW - 34, 40);

    ctx.strokeStyle = COL.faint;
    ctx.lineWidth = 2;
    poly(model.podium.outline2D);
    ctx.stroke();

    const z = level * FLOOR_HEIGHT;
    ctx.fillStyle = 'rgba(255,179,71,0.18)';
    ctx.strokeStyle = COL.amber;
    for (const br of model.bridges) {
      if (z < br.z - 0.01 || z > br.z + br.height) continue;
      poly(br.outline2D);
      ctx.fill();
      ctx.stroke();
    }

    for (const T of model.towers) {
      if (level >= T.floors.length) continue;
      const P = T.floors[level];
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.strokeStyle = COL.fg;
      ctx.lineWidth = 3;
      poly(P.points2D);
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = COL.dim;
      poly(P.core2D);
      ctx.stroke();
    }

    ctx.strokeStyle = COL.cyan;
    ctx.setLineDash([14, 10]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (axis === 'x') {
      ctx.moveTo(20, Y(pos));
      ctx.lineTo(PW - 20, Y(pos));
    } else {
      ctx.moveTo(X(pos), 80);
      ctx.lineTo(X(pos), PW - 20);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    if (here) {
      const hx = Math.min(PW - 24, Math.max(24, X(here.x)));
      const hy = Math.min(PW - 24, Math.max(80, Y(here.y)));
      // view wedge: heading is the compass bearing in data space (0 = +y north)
      ctx.fillStyle = 'rgba(79,227,255,0.25)';
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.arc(hx, hy, 46, -Math.PI / 2 + here.heading - 0.5, -Math.PI / 2 + here.heading + 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = COL.cyan;
      ctx.beginPath();
      ctx.arc(hx, hy, 9, 0, Math.PI * 2);
      ctx.fill();
      setFont(ctx, 16, 600);
      ctx.textAlign = 'left';
      ctx.fillText('YOU', hx + 16, hy - 14);
    }

    setFont(ctx, 15);
    ctx.textAlign = 'left';
    ctx.fillStyle = COL.faint;
    ctx.fillText('N ↑', 34, PW - 30);
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
