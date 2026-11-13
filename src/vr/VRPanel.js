/**
 * VRPanel.js
 *
 * In-VR control panel built from plain three.js: a canvas drawn with the same
 * visual language as the desktop panel (black translucent card, 1 px white
 * rules, monospace uppercase micro-labels, cyan for cuts, amber accents), shown
 * on a MeshBasicMaterial plane. The canvas is redrawn only when a value or the
 * hover state changes.
 *
 * The card is landscape with three columns, so every control is visible at
 * once (no scrolling): a title and readout strip across the top, then the
 * studio's controls (supplied by the session as a layout description) and the
 * VR options. Its size is S / M / L (0.5 / 0.65 / 0.8 m wide) and it is either
 * docked beside the model or worn on the left wrist.
 *
 * Layout description (from the session's describePanel()):
 *   { title, subtitle, header?: [item], readout: [[label, value, colour?]],
 *     columns: [[item]] }
 * `header` items (the RENDER toggle and LIGHT presets) sit at the top right of
 * the title strip, so they are the first thing on the card.
 * Items: micro · slider · seg · toggle · buttons · chips · grid
 *
 * Pointer input arrives from VRInteraction as panel UV coordinates.
 */

import * as THREE from 'three';

const CW = 2048; //  layout px
const CH = 1120;
const RES = 1.5; //   backing-store px per layout px (3072 × 1680 texture)
const ASPECT = CH / CW;
export const PANEL_SIZES = { S: 0.5, M: 0.65, L: 0.8 }; // card width in metres
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
export const PANEL_COLORS = COL;
const FONT = "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace";
const PAD = 52;
const GAP = 64; //    between columns
const TOP = 250; //   columns start below the title + readout strip
const FOOT = 64;
const HEIGHTS = { micro: 52, slider: 100, seg: 96, toggle: 64, buttons: 96, chips: 96 };
const HEADER_X = 1010; // header items run from here to the right edge
const HEADER_Y = 18;
const HEADER_W = [430, 516]; // RENDER, LIGHT

function setFont(ctx, px, weight = 500) {
  ctx.font = `${weight} ${px}px ${FONT}`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(px * 0.18)}px`;
}

/**
 * The VR options column shared by every studio.
 * views: [[id, label]]; extra: items to put before SHOW (e.g. plan frame).
 */
export function vrColumn(vr, views, extra = []) {
  return [
    { t: 'micro', label: 'VR' },
    {
      t: 'seg', group: 'vr', key: 'scale', label: `SCALE · ${vr.scale === 'tabletop' ? `1:${Math.round(vr.denom)}` : '1:1'}`, value: vr.scale,
      options: [['tabletop', 'TABLETOP'], ['human', 'HUMAN 1:1']],
    },
    // More than five viewpoints wrap onto a grid so the labels stay legible.
    views.length > 5
      ? { t: 'grid', group: 'vr', key: 'view', label: 'VIEWPOINTS', cols: 4, options: views }
      : { t: 'buttons', group: 'vr', key: 'view', label: 'VIEWPOINTS', options: views },
    ...extra,
    {
      t: 'chips', group: 'vr', label: 'SHOW',
      options: [['boards', 'DRAWINGS', vr.boards], ['data', 'DATA', vr.data], ['city', 'CONTEXT', vr.city], ['smooth', 'SMOOTH', vr.smooth]],
    },
    {
      t: 'seg', group: 'vr', key: 'docked', label: 'MENU', value: vr.docked,
      options: [[true, 'DOCKED'], [false, 'ON WRIST']],
    },
    { t: 'seg', group: 'vr', key: 'panelSize', label: 'MENU SIZE', value: vr.panelSize, options: [['S', 'S'], ['M', 'M'], ['L', 'L']] },
    {
      t: 'seg', group: 'vr', key: 'quality', label: `QUALITY · ${vr.device} · ${vr.activeScale.toFixed(1)}×`, value: vr.quality,
      options: [['auto', 'AUTO'], ['1.0', '1.0×'], ['1.2', '1.2×'], ['1.5', '1.5×']],
    },
  ];
}

/** Give every item its rectangle: header items, then three columns under the top strip. */
function layout(desc) {
  const colW = (CW - PAD * 2 - GAP * 2) / 3;
  const items = [];
  let hx = HEADER_X;
  (desc.header || []).forEach((it, i) => {
    it.x = hx;
    it.y = HEADER_Y;
    it.w = HEADER_W[i] || 400;
    it.h = HEIGHTS[it.t];
    hx += it.w + 40;
    items.push(it);
  });
  desc.columns.forEach((col, c) => {
    let y = TOP;
    const x = PAD + c * (colW + GAP);
    for (const it of col) {
      it.x = x;
      it.w = colW;
      it.y = y;
      it.h = it.t === 'grid' ? 56 + Math.ceil(it.options.length / it.cols) * 84 : HEIGHTS[it.t];
      y += it.h;
      items.push(it);
    }
  });
  return items;
}

export class VRPanel {
  /**
   * @param {object} hooks onChange(group, key, value), onHaptic()
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(CW * RES);
    this.canvas.height = Math.round(CH * RES);
    this.ctx = this.canvas.getContext('2d');
    this.ctx.scale(RES, RES); // draw in layout px
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 16; // clamped to the GPU maximum by three.js
    this.texture.generateMipmaps = true;
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false, // UI is drawn over the scene, so it never sinks into a wall
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });
    // Unit-wide plane; the card size is applied as a uniform scale.
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, ASPECT), this.material);
    this.mesh.name = 'vr-panel';
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
    this.desc = null;
    this.items = [];
    this.hover = '';
    this.drag = null;
    this.lastKey = '';
    this.anchored = false; // fallback placement when no left controller is tracked
    this.docked = false; // worn on the left wrist by default
    this.size = 'L';
    this.setSize('L');
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

  setDocked(v) {
    this.docked = v;
    this.anchored = false;
  }

  setSize(s) {
    this.size = PANEL_SIZES[s] ? s : 'M';
    this.mesh.scale.setScalar(PANEL_SIZES[this.size]);
    this.anchored = false;
  }

  /** Card width and height in metres. */
  get widthM() {
    return PANEL_SIZES[this.size];
  }

  get heightM() {
    return PANEL_SIZES[this.size] * ASPECT;
  }

  /** Layout description from the session (see the header comment). */
  setState(desc) {
    this.desc = desc;
  }

  /* ---------------- placement ---------------- */

  /**
   * Wrist placement: the card's lower edge sits 6 cm above the left grip and
   * 6 cm further from the eyes, turned to face them. If that is closer than
   * 0.6 m to the eyes it is pushed out along the eye→card ray to exactly 0.6 m.
   * Without a tracked left grip the card is parked 0.8 m ahead once and stays
   * in the rig until reopened. Docked cards are positioned by the session.
   */
  place(rig, eye, eyeQuat, leftGrip) {
    if (!this.mesh.visible || this.docked) return;
    const p = new THREE.Vector3();
    if (leftGrip && leftGrip.visible) {
      leftGrip.updateWorldMatrix(true, false);
      const g = new THREE.Vector3().setFromMatrixPosition(leftGrip.matrixWorld);
      const away = new THREE.Vector3().subVectors(g, eye).setY(0).normalize();
      p.copy(g).add(new THREE.Vector3(0, 0.06 + this.heightM / 2, 0)).addScaledVector(away, 0.06);
      this.anchored = false;
    } else if (!this.anchored) {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(eyeQuat).setY(0).normalize();
      p.copy(eye).addScaledVector(fwd, 0.8).add(new THREE.Vector3(0, -0.12, 0));
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
   * in panel-local coordinates (the unscaled unit plane): u = x + ½, v = y/A + ½
   * with A = height/width. Returns { u, v, inside, distance, point } or null.
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
    const u = local.x + 0.5;
    const v = local.y / ASPECT + 0.5;
    return { u, v, inside: u >= 0 && u <= 1 && v >= 0 && v <= 1, distance: ray.origin.distanceTo(hit), point: hit };
  }

  /** Canvas px → widget hit {id, item, option?}. */
  widgetAt(u, v) {
    const x = u * CW;
    const y = (1 - v) * CH;
    for (const it of this.items) {
      if (x < it.x || x > it.x + it.w || y < it.y || y >= it.y + it.h) continue;
      if (it.t === 'slider' || it.t === 'toggle') return { id: it.key, item: it };
      const r = it.row;
      if (!r || x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) return null;
      const cols = it.t === 'grid' ? it.cols : it.options.length;
      const i = Math.floor(((x - r.x) / r.w) * cols) + (it.t === 'grid' ? Math.floor((y - r.y) / it.cellH) * cols : 0);
      if (i < 0 || i >= it.options.length) return null;
      return { id: `${it.key ?? it.label}:${i}`, item: it, option: it.options[i] };
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
    } else if (it.t === 'chips') {
      this.hooks.onChange(it.group, w.option[0], !w.option[2]);
      this.hooks.onHaptic();
    } else {
      this.hooks.onChange(it.group, it.key, w.option[0]);
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
    if (!this.mesh.visible || !this.desc) return;
    const key = JSON.stringify([this.desc, this.hover]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    // Keep the live drag item so its value stays in sync while held.
    const dragKey = this.drag && this.drag.key;
    this.items = layout(this.desc);
    if (dragKey) this.drag = this.items.find((it) => it.t === 'slider' && it.key === dragKey) || null;
    this.draw();
    this.texture.needsUpdate = true;
  }

  draw() {
    const ctx = this.ctx;
    const d = this.desc;
    ctx.clearRect(0, 0, CW, CH);
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, CW, CH);
    ctx.strokeStyle = COL.fg;
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, CW - 3, CH - 3);
    ctx.textBaseline = 'middle';

    // Title strip
    setFont(ctx, 36, 700);
    ctx.fillStyle = COL.fg;
    ctx.textAlign = 'left';
    ctx.fillText(d.title, PAD, 56);
    setFont(ctx, 19);
    ctx.fillStyle = COL.dim;
    ctx.fillText(d.subtitle, PAD, 98);
    const where = `${this.docked ? 'DOCKED' : 'WRIST'} · X TO HIDE`;
    if (!d.header || !d.header.length) {
      setFont(ctx, 18);
      ctx.textAlign = 'right';
      ctx.fillStyle = COL.faint;
      ctx.fillText(where, CW - PAD, 56);
    }

    // Readout strip: one row of cells
    const n = d.readout.length;
    const cw = (CW - PAD * 2) / n;
    d.readout.forEach(([label, value, color], i) => {
      const x = PAD + i * cw;
      setFont(ctx, 17);
      ctx.textAlign = 'left';
      ctx.fillStyle = COL.dim;
      ctx.fillText(label, x, 148);
      setFont(ctx, 27, 600);
      ctx.fillStyle = color || COL.fg;
      ctx.fillText(value, x, 188);
    });
    ctx.strokeStyle = COL.rule;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PAD, 222);
    ctx.lineTo(CW - PAD, 222);
    ctx.stroke();

    for (const it of this.items) this.drawItem(it);

    // Footer
    setFont(ctx, 16);
    ctx.textAlign = 'left';
    ctx.fillStyle = COL.faint;
    ctx.fillText(d.header && d.header.length ? `${d.footer || ''} · ${where}` : d.footer || '', PAD, CH - FOOT / 2);
    if (d.note) {
      ctx.textAlign = 'right';
      ctx.fillStyle = COL.amber;
      ctx.fillText(d.note, CW - PAD, CH - FOOT / 2);
    }
  }

  drawItem(it) {
    const ctx = this.ctx;
    const { x, y, w } = it;
    switch (it.t) {
      case 'micro': {
        setFont(ctx, 19, 600);
        ctx.fillStyle = COL.dim;
        ctx.textAlign = 'left';
        ctx.fillText(it.label, x, y + 28);
        const tw = ctx.measureText(it.label).width;
        ctx.strokeStyle = COL.rule;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x + tw + 18, y + 28);
        ctx.lineTo(x + w, y + 28);
        ctx.stroke();
        break;
      }
      case 'slider': {
        const hot = this.hover === it.key || (this.drag && this.drag.key === it.key);
        setFont(ctx, 22, 500);
        ctx.textAlign = 'left';
        ctx.fillStyle = hot ? COL.fg : COL.dim;
        ctx.fillText(it.label, x, y + 26);
        ctx.textAlign = 'right';
        ctx.fillStyle = it.accent || COL.fg;
        ctx.fillText(it.text, x + w, y + 26);
        const tr = { x: x + 14, y: y + 68, w: w - 28 };
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
      case 'chips':
      case 'grid': {
        setFont(ctx, 20, 500);
        ctx.textAlign = 'left';
        ctx.fillStyle = COL.dim;
        ctx.fillText(it.label, x, y + 22);
        const cols = it.t === 'grid' ? it.cols : it.options.length;
        const rows = Math.ceil(it.options.length / cols);
        it.cellH = it.t === 'grid' ? 84 : 46;
        const r = { x, y: y + 42, w, h: rows * it.cellH };
        it.row = r;
        const bw = w / cols;
        ctx.strokeStyle = COL.rule;
        ctx.lineWidth = 2;
        it.options.forEach((o, i) => {
          const bx = r.x + (i % cols) * bw;
          const by = r.y + Math.floor(i / cols) * it.cellH;
          const id = `${it.key ?? it.label}:${i}`;
          const on = it.t === 'chips' ? o[2] : it.t === 'buttons' ? false : o[0] === it.value;
          ctx.strokeRect(bx, by, bw, it.cellH);
          if (on) {
            ctx.fillStyle = COL.fg;
            ctx.fillRect(bx, by, bw, it.cellH);
          } else if (this.hover === id) {
            ctx.fillStyle = 'rgba(255,255,255,0.12)';
            ctx.fillRect(bx, by, bw, it.cellH);
          }
          ctx.textAlign = 'center';
          ctx.fillStyle = on ? '#000' : this.hover === id ? COL.fg : COL.dim;
          if (it.t === 'grid' && o[2]) {
            // two-line cell: number on top, name below
            setFont(ctx, 26, 700);
            ctx.fillText(o[1], bx + bw / 2, by + 28);
            setFont(ctx, 15, 600);
            ctx.fillText(o[2], bx + bw / 2, by + 60);
          } else {
            setFont(ctx, cols > 4 ? 16 : cols > 3 ? 17 : 19, 600);
            ctx.fillText(o[1], bx + bw / 2, by + it.cellH / 2 + 1);
          }
        });
        break;
      }
      case 'toggle': {
        const hot = this.hover === it.key;
        ctx.strokeStyle = it.value ? COL.cyan : COL.faint;
        ctx.lineWidth = 3;
        ctx.strokeRect(x, y + 18, 26, 26);
        if (it.value) {
          ctx.fillStyle = COL.cyan;
          ctx.fillRect(x + 6, y + 24, 14, 14);
        }
        setFont(ctx, 22, 500);
        ctx.textAlign = 'left';
        ctx.fillStyle = hot ? COL.fg : COL.dim;
        ctx.fillText(it.label, x + 46, y + 32);
        ctx.textAlign = 'right';
        ctx.fillStyle = it.value ? COL.cyan : COL.dim;
        ctx.fillText(it.value ? 'ON' : 'OFF', x + w, y + 32);
        break;
      }
      default:
        break;
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
