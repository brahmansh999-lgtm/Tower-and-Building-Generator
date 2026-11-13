/**
 * VRDrawings.js
 *
 * Drawing boards that float around the user in VR (tower studio below; the
 * villa studio has VillaPlanBoard, VillaSectionBoard and VillaDataBoard):
 *
 *   VRPlanBoard     the desktop PlanView (fit-out, rooms, cores, bridges, labels)
 *                   at the current plan level and frame (site or one tower),
 *                   plus a "you are here" marker at human scale
 *   VRSectionBoard  the desktop SectionView at the current cut
 *   VRDataBoard     project data: totals, every tower, every bridge, and the
 *                   current floor of each tower (use, GFA, NIA, core, lifts)
 *
 * The plan and section are not re-drawn for VR: the real React components are
 * rendered off-screen at a fixed size (their `size` prop), the resulting SVG is
 * serialised together with the app's stylesheet and rasterised at 2× onto a
 * canvas texture. So VR shows exactly what the desktop drawings show.
 *
 * Re-rasterising is asynchronous (SVG image decode) and throttled; boards only
 * update when their inputs change.
 */

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import * as THREE from 'three';
import PlanView from '../views/PlanView.jsx';
import SectionView from '../views/SectionView.jsx';
import VillaPlanView from '../views/VillaPlanView.jsx';
import VillaSectionView from '../views/VillaSectionView.jsx';
import { FLOOR_HEIGHT, BRIDGE_STATION_STRIDE, floorFitout } from '../geometry/generateTower.js';

const RASTER = 2; //     layout px per SVG px
const HEAD = 76; //      layout px of header strip above the drawing
// Backing-store pixels per layout pixel. Boards are laid out in layout px and
// the canvas is allocated RES× larger, so text and linework stay crisp in the
// headset instead of being magnified from a low-resolution texture.
const RES = 2;
const THROTTLE = 160; // ms between re-rasterisations while values change
const FONT = "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace";
const COL = {
  fg: '#e9e9e6',
  dim: 'rgba(255, 255, 255, 0.5)',
  faint: 'rgba(255, 255, 255, 0.24)',
  rule: 'rgba(255, 255, 255, 0.16)',
  cyan: '#4fe3ff',
  amber: '#ffb347',
};
const fmt = (v) => Math.round(v).toLocaleString('en-US');

function setFont(ctx, px, weight = 500) {
  ctx.font = `${weight} ${px}px ${FONT}`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(px * 0.18)}px`;
}

/** The app's CSS (same-origin sheets), so the SVG classes render as on desktop. */
let cssCache = null;
function appCss() {
  if (cssCache !== null) return cssCache;
  let out = '';
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin (web font) sheets can't be read
    }
    for (const r of rules) out += `${r.cssText}\n`;
  }
  cssCache = `${out}\nsvg{font-family:var(--mono);}`;
  return cssCache;
}

/** Textured plane with a canvas, shared by every board. */
class Board {
  constructor(name, cw, ch, widthM) {
    this.canvas = document.createElement('canvas');
    this.cw = cw;
    this.ch = ch;
    this.canvas.width = Math.round(cw * RES);
    this.canvas.height = Math.round(ch * RES);
    this.ctx = this.canvas.getContext('2d');
    this.ctx.scale(RES, RES); // draw in layout px
    this.ctx.imageSmoothingQuality = 'high';
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 16; // clamped to the GPU maximum by three.js
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
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
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(widthM, (widthM * ch) / cw), this.material);
    this.mesh.name = name;
    this.mesh.renderOrder = 10;
    this.lastKey = '';
  }

  /** Black card, 1 px white frame, header label left and value right (cyan). */
  frame(left, right) {
    const { ctx } = this;
    const W = this.cw;
    const H = this.ch;
    ctx.fillStyle = 'rgba(0,0,0,0.88)';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = COL.fg;
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, W - 3, H - 3);
    ctx.strokeStyle = COL.rule;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, HEAD);
    ctx.lineTo(W, HEAD);
    ctx.stroke();
    ctx.textBaseline = 'middle';
    setFont(ctx, 24, 600);
    ctx.textAlign = 'left';
    ctx.fillStyle = COL.dim;
    ctx.fillText(left, 32, HEAD / 2);
    if (right) {
      ctx.textAlign = 'right';
      ctx.fillStyle = COL.cyan;
      ctx.fillText(right, W - 32, HEAD / 2);
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

/**
 * A board that shows a React SVG drawing component. render() mounts the
 * component into a detached root with flushSync (synchronous, outside any React
 * render), serialises the <svg>, and decodes it as an image.
 */
class SvgBoard extends Board {
  constructor(name, svgW, svgH, widthM) {
    super(name, svgW * RASTER, svgH * RASTER + HEAD, widthM);
    this.svgW = svgW;
    this.svgH = svgH;
    this.host = document.createElement('div');
    this.root = createRoot(this.host);
    this.image = null;
    this.busy = false;
    this.lastStart = 0;
    this.pending = null;
    this.seq = 0;
  }

  /** Queue a redraw for `key`; the element factory runs only when it is drawn. */
  request(key, makeElement, header) {
    if (key === this.lastKey) {
      this.pending = null; // back to what is already drawn (or being drawn)
      return;
    }
    if (!this.pending || this.pending.key !== key) this.pending = { key, makeElement, header };
    if (this.busy || performance.now() - this.lastStart < THROTTLE) return;
    const job = this.pending;
    this.pending = null;
    this.lastKey = job.key;
    this.lastStart = performance.now();
    this.busy = true;
    const seq = ++this.seq;
    let url = '';
    try {
      flushSync(() => this.root.render(job.makeElement({ w: this.svgW, h: this.svgH })));
      const svg = this.host.querySelector('svg');
      if (!svg) throw new Error('no svg');
      const clone = svg.cloneNode(true);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      // Rasterise at the backing-store size, not the layout size.
      clone.setAttribute('viewBox', `0 0 ${this.svgW} ${this.svgH}`);
      clone.setAttribute('width', String(this.svgW * RASTER * RES));
      clone.setAttribute('height', String(this.svgH * RASTER * RES));
      const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
      style.textContent = appCss();
      clone.insertBefore(style, clone.firstChild);
      const xml = new XMLSerializer().serializeToString(clone);
      url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
    } catch {
      this.busy = false;
      return;
    }
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      this.busy = false;
      if (seq !== this.seq) return;
      this.image = img;
      this.header = job.header;
      this.compose();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      this.busy = false;
    };
    img.src = url;
  }

  /** Frame + rasterised drawing + any overlay. */
  compose() {
    if (!this.image) return;
    const [left, right] = this.header || ['', ''];
    this.frame(left, right);
    this.ctx.drawImage(this.image, 0, HEAD, this.svgW * RASTER, this.svgH * RASTER);
    this.overlay();
    this.texture.needsUpdate = true;
  }

  overlay() {}

  dispose() {
    super.dispose();
    const root = this.root;
    // Unmount outside the current call stack (it may run inside a React commit).
    setTimeout(() => root.unmount(), 0);
  }
}

export class VRPlanBoard extends SvgBoard {
  constructor() {
    super('vr-plan-board', 640, 470, 0.9);
    this.here = null;
    this.hereKey = '';
    this.frameInfo = null;
  }

  /**
   * focus: 'site' or a tower index. here: { x, y, heading } (data space) or null.
   */
  update(model, level, axis, pos, focus, here) {
    if (!this.mesh.visible || !model) return;
    const F = typeof focus === 'number' && focus < model.towers.length ? focus : 'site';
    const lv = Math.min(level, model.params.floors - 1);
    const key = `${model.params.floors}|${model.params.width}|${model.params.sway}|${model.params.twist}|${model.params.towers}|${model.params.bridges}|${model.params.mode}|${lv}|${axis}|${pos.toFixed(2)}|${F}`;
    const frameName = F === 'site' ? 'SITE' : `TOWER ${model.towers[F].name}`;
    this.frameInfo = { model, level: lv, focus: F };
    this.request(
      key,
      (size) => createElement(PlanView, { model, level: lv, sectionAxis: axis, sectionPos: pos, focus: F, size }),
      [`PLAN · ${frameName}`, `L${lv} · +${(lv * FLOOR_HEIGHT).toFixed(1)} M`]
    );
    // The marker moves without re-rasterising the drawing.
    const hk = here ? `${here.x.toFixed(1)},${here.y.toFixed(1)},${here.heading.toFixed(2)}` : '';
    if (hk !== this.hereKey) {
      this.hereKey = hk;
      this.here = here;
      this.compose();
    }
  }

  /** "You are here" with PlanView's framing: site bounds or the focused plate ± 6 m, 38 px margin. */
  overlay() {
    const here = this.here;
    const fi = this.frameInfo;
    if (!here || !fi) return;
    const { model, level, focus } = fi;
    let b = model.bounds;
    if (focus !== 'site') {
      const T = model.towers[focus];
      const p = T.floors[Math.min(level, T.floors.length - 1)].points2D;
      b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      for (let j = 0; j < p.length; j += 2) {
        b.minX = Math.min(b.minX, p[j] - 6);
        b.maxX = Math.max(b.maxX, p[j] + 6);
        b.minY = Math.min(b.minY, p[j + 1] - 6);
        b.maxY = Math.max(b.maxY, p[j + 1] + 6);
      }
    }
    drawHere(this, here, b, 38);
  }
}

/**
 * Draw the "you are here" marker on a plan board using the plan component's own
 * framing: bounds b, pixel margin m, uniform scale s, y flipped:
 *   X = w/2 + (x - mx)*s,   Y = h/2 - (y - my)*s
 */
function drawHere(board, here, b, m) {
  const w = board.svgW;
  const h = board.svgH;
  const s = Math.min((w - m * 2) / Math.max(1, b.maxX - b.minX), (h - m * 2) / Math.max(1, b.maxY - b.minY));
  const mx = (b.minX + b.maxX) / 2;
  const my = (b.minY + b.maxY) / 2;
  let x = (w / 2 + (here.x - mx) * s) * RASTER;
  let y = HEAD + (h / 2 - (here.y - my) * s) * RASTER;
  const off = x < 0 || y < HEAD || x > w * RASTER || y > HEAD + h * RASTER;
  x = Math.min(w * RASTER - 30, Math.max(30, x));
  y = Math.min(HEAD + h * RASTER - 30, Math.max(HEAD + 30, y));
  const ctx = board.ctx;
  ctx.fillStyle = 'rgba(79,227,255,0.28)';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.arc(x, y, 60, -Math.PI / 2 + here.heading - 0.5, -Math.PI / 2 + here.heading + 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = COL.cyan;
  ctx.beginPath();
  ctx.arc(x, y, 11, 0, Math.PI * 2);
  ctx.fill();
  setFont(ctx, 20, 600);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(off ? 'YOU (OFF PLAN)' : 'YOU', x + 18, y - 18);
}

export class VRSectionBoard extends SvgBoard {
  constructor() {
    super('vr-section-board', 640, 470, 0.9);
  }

  update(model, level, axis, pos) {
    if (!this.mesh.visible || !model) return;
    const lv = Math.min(level, model.params.floors - 1);
    const key = `${model.params.floors}|${model.params.width}|${model.params.sway}|${model.params.twist}|${model.params.towers}|${model.params.bridges}|${model.params.mode}|${lv}|${axis}|${pos.toFixed(2)}`;
    this.request(
      key,
      (size) => createElement(SectionView, { model, level: lv, sectionAxis: axis, sectionPos: pos, size }),
      ['SECTION A–A′', `∥ ${axis.toUpperCase()} · ${axis === 'x' ? 'Y' : 'X'} ${pos >= 0 ? '+' : ''}${pos.toFixed(1)} M`]
    );
  }
}

/* ---------------------------------------------------------------------------
 * Data sheet
 * ------------------------------------------------------------------------- */

const DW = 1100;
const DH = 1500;

export class VRDataBoard extends Board {
  constructor() {
    super('vr-data-board', DW, DH, 0.62);
  }

  update(model, level) {
    if (!this.mesh.visible || !model) return;
    const lv = Math.min(level, model.params.floors - 1);
    const key = `${JSON.stringify(model.params)}|${lv}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.draw(model, lv);
    this.texture.needsUpdate = true;
  }

  draw(model, level) {
    const ctx = this.ctx;
    const st = model.stats;
    const pod = model.podium;
    const P = 32;
    this.frame('PROJECT DATA', `${st.towers} TOWERS · ${st.bridges} BRIDGES`);
    let y = HEAD + 40;

    const micro = (label) => {
      setFont(ctx, 20, 600);
      ctx.textAlign = 'left';
      ctx.fillStyle = COL.dim;
      ctx.fillText(label, P, y);
      const tw = ctx.measureText(label).width;
      ctx.strokeStyle = COL.rule;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(P + tw + 16, y);
      ctx.lineTo(DW - P, y);
      ctx.stroke();
      y += 44;
    };
    // Table: columns as [label, x, align]; rows of strings (optional colour per row).
    const table = (cols, rows, rowH = 38) => {
      setFont(ctx, 16, 600);
      ctx.fillStyle = COL.faint;
      for (const [label, x, align] of cols) {
        ctx.textAlign = align || 'left';
        ctx.fillText(label, x, y);
      }
      y += rowH - 4;
      setFont(ctx, 21, 500);
      for (const r of rows) {
        ctx.fillStyle = r.color || COL.fg;
        r.cells.forEach((c, i) => {
          ctx.textAlign = cols[i][2] || 'left';
          ctx.fillText(c, cols[i][1], y);
        });
        y += rowH;
      }
      y += 14;
    };
    const grid = (cells, perRow = 4) => {
      const cw = (DW - P * 2) / perRow;
      cells.forEach(([label, value, color], i) => {
        const x = P + (i % perRow) * cw;
        const yy = y + Math.floor(i / perRow) * 76;
        setFont(ctx, 16);
        ctx.textAlign = 'left';
        ctx.fillStyle = COL.dim;
        ctx.fillText(label, x, yy);
        setFont(ctx, 26, 600);
        ctx.fillStyle = color || COL.fg;
        ctx.fillText(value, x, yy + 34);
      });
      y += Math.ceil(cells.length / perRow) * 76 + 10;
    };

    micro('TOTALS');
    const nia = model.towers.reduce((n, T) => n + T.floors.reduce((m, F) => m + F.nia, 0), 0);
    const towerGfa = model.towers.reduce((n, T) => n + T.floors.reduce((m, F) => m + F.area, 0), 0);
    grid([
      ['GFA', `${fmt(st.gfa)} M²`],
      ['NIA (TOWERS)', `${fmt(nia)} M²`],
      ['EFFICIENCY', `${towerGfa ? Math.round((nia / towerGfa) * 100) : 0} %`],
      ['FLOORS', `${st.totalFloors}`],
      ['HEIGHT', `${st.height.toFixed(1)} M`],
      ['SWAY', `${st.sway.toFixed(1)} M`],
      ['TWIST', `${st.twist}°`],
      ['FINS', `${st.finCount} / TWR`],
    ]);

    micro('PODIUM');
    grid([
      ['FLOORS', `${pod.floors}`],
      ['HEIGHT', `${pod.height.toFixed(1)} M`],
      ['FOOTPRINT', `${fmt(pod.area)} M²`],
      ['BASEMENT', `${pod.basementLevels} LV · ${pod.basementDepth.toFixed(1)} M`],
    ]);

    micro('TOWERS');
    table(
      [
        ['TWR', P],
        ['FLOORS', 200, 'right'],
        ['HEIGHT', 360, 'right'],
        ['GFA M²', 560, 'right'],
        ['LIFT ZONES', 760, 'right'],
        ['MEP FLOORS', 1068, 'right'],
      ],
      model.towers.map((T) => {
        const top = T.floors[T.floors.length - 1];
        return {
          cells: [
            T.name,
            `${T.floors.length}`,
            `${(top.z + FLOOR_HEIGHT).toFixed(1)}`,
            fmt(T.floors.reduce((m, F) => m + F.area, 0)),
            `${T.coreZones.length}`,
            T.mepFloors.length ? T.mepFloors.map((f) => `L${f}`).join(' ') : '—',
          ],
        };
      })
    );

    micro(`FLOOR L${level} · +${(level * FLOOR_HEIGHT).toFixed(1)} M`);
    table(
      [
        ['TWR', P],
        ['USE', 120],
        ['GFA M²', 470, 'right'],
        ['NIA M²', 640, 'right'],
        ['EFF', 760, 'right'],
        ['CORE M', 940, 'right'],
        ['LIFTS', 1068, 'right'],
      ],
      model.towers.map((T) => {
        const F = T.floors[level];
        if (!F) return { cells: [T.name, 'ABOVE ROOF', '—', '—', '—', '—', '—'], color: COL.faint };
        const zone = T.coreZones[F.zone];
        const fit = floorFitout(T, level, pod);
        return {
          cells: [
            T.name,
            (fit ? fit.use : '').toUpperCase(),
            fmt(F.area),
            fmt(F.nia),
            `${Math.round((F.nia / F.area) * 100)}%`,
            `${(zone.hx * 2).toFixed(1)}×${(zone.hy * 2).toFixed(1)}`,
            `${zone.lifts}`,
          ],
          color: F.mep ? COL.cyan : undefined,
        };
      })
    );

    micro('BRIDGES');
    if (!model.bridges.length) {
      setFont(ctx, 21);
      ctx.textAlign = 'left';
      ctx.fillStyle = COL.faint;
      ctx.fillText('NONE', P, y);
      y += 40;
    } else {
      const rows = model.bridges.map((b, i) => {
        const at = level * FLOOR_HEIGHT >= b.z - 0.01 && level * FLOOR_HEIGHT <= b.z + b.height;
        return {
          cells: [
            `${i + 1}`,
            `${model.towers[b.fromTower].name}–${model.towers[b.toTower].name}`,
            `L${b.level}`,
            `${b.storeys}`,
            `${b.span.toFixed(1)}`,
            `${(b.stations[BRIDGE_STATION_STRIDE * Math.floor(b.stations.length / BRIDGE_STATION_STRIDE / 2) + 3] * 2).toFixed(1)}`,
            (b.kind || '').toUpperCase(),
          ],
          color: at ? COL.cyan : COL.amber,
        };
      });
      const room = Math.max(1, Math.floor((DH - y - 60) / 34) - 1);
      const shown = rows.slice(0, room);
      table(
        [
          ['#', P],
          ['LINK', 90],
          ['LEVEL', 290, 'right'],
          ['STOREYS', 450, 'right'],
          ['SPAN M', 620, 'right'],
          ['MID W M', 860, 'right'],
          ['KIND', 900],
        ],
        shown,
        34
      );
      if (rows.length > shown.length) {
        setFont(ctx, 18);
        ctx.textAlign = 'left';
        ctx.fillStyle = COL.faint;
        ctx.fillText(`+ ${rows.length - shown.length} MORE`, P, y);
      }
    }

    setFont(ctx, 16);
    ctx.textAlign = 'left';
    ctx.fillStyle = COL.faint;
    ctx.fillText('CYAN = AT PLAN LEVEL · AMBER = BRIDGE', P, DH - 30);
  }
}

/* ---------------------------------------------------------------------------
 * Villa studio boards
 * ------------------------------------------------------------------------- */

const villaKey = (v) => `${v.option.id}|${Math.round(v.stats.gfa)}`;

export class VillaPlanBoard extends SvgBoard {
  constructor() {
    super('vr-villa-plan-board', 640, 470, 0.9);
    this.here = null;
    this.hereKey = '';
    this.frameInfo = null;
  }

  update(villa, level, frame, axis, pos, here) {
    if (!this.mesh.visible || !villa) return;
    this.frameInfo = { villa, frame };
    this.request(
      `${villaKey(villa)}|${level}|${frame}|${axis}|${pos.toFixed(2)}`,
      (size) => createElement(VillaPlanView, { villa, level, frame, sectionAxis: axis, sectionPos: pos, size }),
      [`PLAN · L${level} · ${frame === 'site' ? 'SITE' : 'HOUSE'}`, level === 0 ? 'GROUND FLOOR' : 'FIRST FLOOR']
    );
    const hk = here ? `${here.x.toFixed(1)},${here.y.toFixed(1)},${here.heading.toFixed(2)}` : '';
    if (hk !== this.hereKey) {
      this.hereKey = hk;
      this.here = here;
      this.compose();
    }
  }

  /** "You are here" with VillaPlanView's framing (house or site bounds, 40 px margin). */
  overlay() {
    const here = this.here;
    const fi = this.frameInfo;
    if (!here || !fi) return;
    const { villa, frame } = fi;
    const { plot } = villa;
    let b;
    if (frame === 'site') {
      b = { minX: -plot.w / 2 - 14, maxX: plot.w / 2 + 14, minY: -plot.d / 2 - 14, maxY: plot.d / 2 + 10 };
    } else {
      b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      for (const p of [villa.levels[0].outline, villa.levels[1].outline, villa.pool, villa.canopy && villa.canopy.outline]) {
        if (!p) continue;
        for (let i = 0; i < p.length; i += 2) {
          b.minX = Math.min(b.minX, p[i] - 3);
          b.maxX = Math.max(b.maxX, p[i] + 3);
          b.minY = Math.min(b.minY, p[i + 1] - 3);
          b.maxY = Math.max(b.maxY, p[i + 1] + 3);
        }
      }
    }
    drawHere(this, here, b, 40);
  }
}

export class VillaSectionBoard extends SvgBoard {
  constructor() {
    super('vr-villa-section-board', 640, 470, 0.9);
  }

  update(villa, level, axis, pos) {
    if (!this.mesh.visible || !villa) return;
    this.request(
      `${villaKey(villa)}|${level}|${axis}|${pos.toFixed(2)}`,
      (size) => createElement(VillaSectionView, { villa, level, sectionAxis: axis, sectionPos: pos, size }),
      ['SECTION A–A′', `∥ ${axis.toUpperCase()} · ${axis === 'x' ? 'Y' : 'X'} ${pos >= 0 ? '+' : ''}${pos.toFixed(1)} M`]
    );
  }
}

export class VillaDataBoard extends Board {
  constructor() {
    super('vr-villa-data-board', DW, DH, 0.62);
  }

  update(villa) {
    if (!this.mesh.visible || !villa) return;
    const key = villaKey(villa);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.draw(villa);
    this.texture.needsUpdate = true;
  }

  draw(villa) {
    const ctx = this.ctx;
    const st = villa.stats;
    const P = 32;
    this.frame(`OPTION ${villa.option.id} · ${villa.option.name}`, st.withinSetbacks ? 'WITHIN SETBACKS' : 'BREACHES SETBACK');
    let y = HEAD + 44;
    setFont(ctx, 19);
    ctx.textAlign = 'left';
    ctx.fillStyle = COL.dim;
    ctx.fillText(villa.option.tagline.toUpperCase().slice(0, 70), P, y);
    y += 50;

    const micro = (label) => {
      setFont(ctx, 20, 600);
      ctx.textAlign = 'left';
      ctx.fillStyle = COL.dim;
      ctx.fillText(label, P, y);
      const tw = ctx.measureText(label).width;
      ctx.strokeStyle = COL.rule;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(P + tw + 16, y);
      ctx.lineTo(DW - P, y);
      ctx.stroke();
      y += 44;
    };
    micro('BRIEF · SAME PLOT · SAME GFA');
    const cells = [
      ['GFA', `${fmt(st.gfa)} M²`],
      ['L0 / L1', `${fmt(st.levelAreas[0])} / ${fmt(st.levelAreas[1])}`],
      ['FOOTPRINT', `${fmt(st.footprint)} M²`],
      ['COVERAGE', `${(st.coverage * 100).toFixed(1)} %`],
      ['PLOT', `${villa.plot.w} × ${villa.plot.d} M`],
      ['PLOT AREA', `${fmt(st.plotArea)} M²`],
      ['BEDROOMS', `${st.bedrooms}`],
      ['BATHROOMS', `${st.bathrooms}`],
      ['HEIGHT', `${st.height.toFixed(1)} M`],
      ['POOL', `${fmt(st.poolArea)} M²`, COL.amber],
      ['SETBACK', `${villa.plot.setback} M`],
      ['LEVELS', `${villa.levels.length}`],
    ];
    const cw = (DW - P * 2) / 4;
    cells.forEach(([label, value, color], i) => {
      const x = P + (i % 4) * cw;
      const yy = y + Math.floor(i / 4) * 76;
      setFont(ctx, 16);
      ctx.textAlign = 'left';
      ctx.fillStyle = COL.dim;
      ctx.fillText(label, x, yy);
      setFont(ctx, 25, 600);
      ctx.fillStyle = color || COL.fg;
      ctx.fillText(value, x, yy + 34);
    });
    y += Math.ceil(cells.length / 4) * 76 + 16;

    // Room schedule, one column per level, largest rooms first.
    micro('ROOM SCHEDULE');
    const colW = (DW - P * 2 - 40) / 2;
    const top = y;
    villa.levels.forEach((L, li) => {
      let yy = top;
      const x0 = P + li * (colW + 40);
      setFont(ctx, 18, 600);
      ctx.textAlign = 'left';
      ctx.fillStyle = COL.cyan;
      ctx.fillText(`L${li} · ${L.name}`, x0, yy);
      ctx.textAlign = 'right';
      ctx.fillText(`${fmt(L.area)} M²`, x0 + colW, yy);
      yy += 40;
      const rooms = [...L.rooms].sort((a, b) => b.area - a.area);
      const fit = Math.floor((DH - yy - 60) / 32);
      setFont(ctx, 19, 500);
      rooms.slice(0, fit).forEach((r) => {
        ctx.textAlign = 'left';
        ctx.fillStyle = COL.fg;
        ctx.fillText(r.name, x0, yy);
        ctx.textAlign = 'right';
        ctx.fillStyle = COL.dim;
        ctx.fillText(`${r.area.toFixed(1)}`, x0 + colW, yy);
        yy += 32;
      });
      if (rooms.length > fit) {
        ctx.textAlign = 'left';
        ctx.fillStyle = COL.faint;
        ctx.fillText(`+ ${rooms.length - fit} MORE`, x0, yy);
      }
    });
    setFont(ctx, 16);
    ctx.textAlign = 'left';
    ctx.fillStyle = COL.faint;
    ctx.fillText('AREAS IN M²', P, DH - 30);
  }
}
