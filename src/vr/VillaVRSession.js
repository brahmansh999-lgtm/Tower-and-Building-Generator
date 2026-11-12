/**
 * VillaVRSession.js
 *
 * VR for the villa studio. Everything shared with the tower VR (session
 * lifecycle, void environment, hands and controllers, teleport, snap turn,
 * comfort fades, control panel, drawing boards, intro timing) comes from
 * VRSession; this class supplies the villa content:
 *
 *   - geometry: the desktop villa builders (buildVillaGeometry / villaContext),
 *     unchanged — the villa is already solid, vertex-coloured MeshBasic geometry,
 *     so it needs no VR line rebuild
 *   - tabletop at 1:100 (two-hand scale 1:250 – 1:30), context cropped to the plinth
 *   - human scale with walkable ground floor, first floor and roof
 *   - viewpoints: garden, entrance, living, upper floor, pool, roof, aerial
 *   - panel: all twelve design options, target GFA, plan level / frame,
 *     section, axis, cut — the same controls as the desktop villa panel
 *   - boards: the desktop villa plan and section, plus a data sheet with the
 *     brief figures and a room schedule
 *   - intro: the house rises through a horizontal clipping plane
 *   - realistic mode (shared with the desktop villa view): the base class
 *     swaps the stylized group for the RealisticWorld; this class only routes
 *     its own clipping and intro to it
 */

import * as THREE from 'three';
import { VRSession, mesh, toWorld } from './VRSession.js';
import { vrColumn, PANEL_COLORS } from './VRPanel.js';
import { VillaPlanBoard, VillaSectionBoard, VillaDataBoard } from './VRDrawings.js';
import { VR_COLORS } from '../geometry/buildVRMeshes.js';
import { VILLA_OPTIONS, GFA_RANGE, PLOT, waveAt } from '../geometry/generateVilla.js';
import { buildVillaGeometry, villaContext } from '../views/VillaViewport3D.jsx';
import { buildContextGroup } from '../views/Viewport3D.jsx';

const fmt = (v) => Math.round(v).toLocaleString('en-US');

/** Flat outline [x0,y0,…] → Vector2[] for ShapeUtils. */
const vec2 = (p) => {
  const out = [];
  for (let i = 0; i < p.length; i += 2) out.push(new THREE.Vector2(p[i], p[i + 1]));
  return out;
};

function centroid(p) {
  let x = 0;
  let y = 0;
  const n = p.length / 2;
  for (let i = 0; i < p.length; i += 2) {
    x += p[i] / n;
    y += p[i + 1] / n;
  }
  return [x, y];
}

/**
 * Crop the context to the round plinth (radius r) for the tabletop: blocks,
 * trees and people kept when they sit fully inside the circle; street segments
 * clipped with Liang–Barsky against the inscribed square |x|, |y| ≤ r/√2
 * (p = p0 + t·(p1 − p0), keep t ∈ [t0, t1]) so no road overhangs the rim.
 */
function cropContext(ctx, radius) {
  const inside = (o) => Math.hypot(o.x, o.y) + Math.max(o.w || 0, o.d || 0, o.r || 0) / 2 + 1 < radius;
  const r = radius / Math.SQRT2;
  const streets = [];
  for (const s of ctx.streets) {
    const dx = s.x1 - s.x0;
    const dy = s.y1 - s.y0;
    let t0 = 0;
    let t1 = 1;
    const edges = [
      [-dx, s.x0 + r],
      [dx, r - s.x0],
      [-dy, s.y0 + r],
      [dy, r - s.y0],
    ];
    let keep = true;
    for (const [p, q] of edges) {
      if (p === 0) {
        if (q < 0) keep = false;
      } else {
        const t = q / p;
        if (p < 0) t0 = Math.max(t0, t);
        else t1 = Math.min(t1, t);
      }
    }
    if (keep && t1 - t0 > 1e-3) streets.push({ x0: s.x0 + dx * t0, y0: s.y0 + dy * t0, x1: s.x0 + dx * t1, y1: s.y0 + dy * t1 });
  }
  return { ...ctx, streets, blocks: ctx.blocks.filter(inside), trees: ctx.trees.filter(inside), people: ctx.people.filter(inside) };
}

/** Walkable surfaces: ground, the first-floor slab and the roof (z-up data space). */
function villaWalk(villa) {
  const pos = [];
  const G = 600;
  pos.push(-G, -G, 0, G, -G, 0, G, G, 0, -G, -G, 0, G, G, 0, -G, G, 0);
  const slab = (outline, hole, zAt) => {
    const contour = vec2(outline);
    const holes = hole ? [vec2(hole)] : [];
    const all = contour.concat(...holes);
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, holes)) {
      for (const v of [all[a], all[b], all[c]]) pos.push(v.x, v.y, zAt(v.x, v.y));
    }
  };
  const L1 = villa.levels[1];
  slab(L1.outline, L1.hole, () => L1.z);
  const wave = villa.roof && villa.roof.wave;
  slab(L1.outline, L1.hole, (x, y) => L1.z + L1.height + waveAt(wave, x, y));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

export class VillaVRSession extends VRSession {
  /** hooks: onOption(id), onGfa(v), onCuts(k, v), onPresentChange(bool) */
  constructor(o) {
    super(o);
    this.cfg = { defaultDenom: 100, minDenom: 30, maxDenom: 250, defaultView: 'garden' };
    this.denom = this.cfg.defaultDenom;
    this.revealing = false;
    this.revealZ = Infinity;
  }

  /* ---------------- content ---------------- */

  createContent(mats) {
    this.villaMats = {
      solid: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
      context: new THREE.MeshBasicMaterial({ vertexColors: true }),
    };
    this.meshes = {
      shell: mesh(this.villaMats.solid),
      interior: mesh(this.villaMats.solid),
      site: mesh(this.villaMats.solid),
    };
    this.contextGroup = new THREE.Group();
    this.cutMeshes = {
      fill: mesh(mats.cutFill, 3),
      lines: mesh(mats.cutLines, 4),
    };
    // Stylized meshes in one group so realistic mode can hide them in one go.
    this.styleGroup = new THREE.Group();
    this.styleGroup.add(...Object.values(this.meshes), this.contextGroup);
    this.modelGroup.add(this.styleGroup, ...Object.values(this.cutMeshes));
  }

  createBoards() {
    this.planBoard = new VillaPlanBoard();
    this.sectionBoard = new VillaSectionBoard();
    this.dataBoard = new VillaDataBoard();
  }

  /** Cut-frame width: true 6 cm at 1:1, ~1 mm in the headset on the tabletop. */
  targetLineScale() {
    return this.mode === 'tabletop' ? Math.max(1, this.denom * 0.02) : 1;
  }

  buildContent() {
    const villa = this.model;
    const g = buildVillaGeometry(villa);
    for (const k of ['shell', 'interior', 'site']) {
      this.meshes[k].geometry.dispose();
      this.meshes[k].geometry = g[k];
    }
    let context = villaContext(villa);
    if (this.mode === 'tabletop') context = cropContext(context, this.plinthRadius() * this.denom * 0.98);
    buildContextGroup({ contextGroup: this.contextGroup, mats: { context: this.villaMats.context } }, context);
    this.contextGroup.visible = this.city;
    this.walk.geometry.dispose();
    this.walk.geometry = villaWalk(villa);
    return { maxZ: villa.stats.height, lineScale: this.targetLineScale() };
  }

  /** Plan and section planes: translucent fills plus flat glowing frame ribbons. */
  rebuildCuts() {
    const s = this.state;
    const villa = this.model;
    if (!s || !villa) return;
    const { plot } = villa;
    const x0 = -plot.w / 2 - 8;
    const x1 = plot.w / 2 + 8;
    const y0 = -plot.d / 2 - 8;
    const y1 = plot.d / 2 + 8;
    const zp = villa.levels[s.planLevel].z + 1.2;
    const zTop = villa.stats.height + 3;
    const pos = s.sectionPos;
    const plan = [[x0, y0, zp], [x1, y0, zp], [x1, y1, zp], [x0, y1, zp]];
    const section =
      s.sectionAxis === 'x'
        ? [[x0, pos, -2], [x1, pos, -2], [x1, pos, zTop], [x0, pos, zTop]]
        : [[pos, y0, -2], [pos, y1, -2], [pos, y1, zTop], [pos, y0, zTop]];
    const c = VR_COLORS.cyan;
    const build = (quads) => {
      const p = [];
      const col = [];
      for (const q of quads) {
        for (const i of [0, 1, 2, 0, 2, 3]) {
          p.push(...q[i]);
          col.push(...c);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      return g;
    };
    // Frame ribbon in a rectangle's plane: inner corner = outer corner moved w toward the centre.
    const w = 0.06 * (this.builtLineScale || 1);
    const frame = (q) => {
      const ctr = [0, 1, 2].map((a) => (q[0][a] + q[2][a]) / 2);
      const inner = q.map((pt) => pt.map((v, a) => v + Math.sign(ctr[a] - v) * w));
      return [0, 1, 2, 3].map((i) => [q[i], q[(i + 1) % 4], inner[(i + 1) % 4], inner[i]]);
    };
    const geoms = { fill: build([plan, section]), lines: build([...frame(plan), ...frame(section)]) };
    for (const k of Object.keys(this.cutMeshes)) {
      this.cutMeshes[k].geometry.dispose();
      this.cutMeshes[k].geometry = geoms[k];
    }
    this.cutsDirty = false;
  }

  clipMaterials() {
    return [this.villaMats.solid, this.villaMats.context];
  }

  /** Section cut and/or the intro's rising reveal plane. */
  applyClipping() {
    if (!this.clipPlane) this.clipPlane = new THREE.Plane();
    if (!this.revealPlane) this.revealPlane = new THREE.Plane();
    const planes = [];
    if (this.cut3D) planes.push(this.clipPlane);
    if (this.revealing) planes.push(this.revealPlane);
    for (const m of this.clipMaterials()) {
      m.clippingPlanes = planes.length ? planes : null;
      m.needsUpdate = true;
    }
    if (this.realOn) this.real().setCut(this.cut3D ? this.clipPlane : null);
  }

  /** Reveal plane keeps data z ≤ revealZ: normal (0, 0, −1), constant revealZ. */
  updateClipPlane() {
    super.updateClipPlane();
    if (this.revealing) {
      this.modelGroup.updateWorldMatrix(true, false);
      this.revealPlane.set(new THREE.Vector3(0, 0, -1), this.revealZ).applyMatrix4(this.modelGroup.matrixWorld);
    }
  }

  introLayers() {
    // Realistic: the base class's sunrise + storey-by-storey reveal.
    if (this.realOn) return super.introLayers();
    return {
      tower: [],
      fins: [],
      bridges: [],
      // From below the pool floor (−2 m) to above the roof as the build phase runs 0 → 1.
      onReveal: (k) => {
        const on = k < 1;
        this.revealZ = -2 + k * (this.maxZ + 3);
        if (on !== this.revealing) {
          this.revealing = on;
          this.applyClipping();
        }
      },
    };
  }

  updateContent() {}

  /** The plinth fits the plot plus a ring of neighbours. */
  plinthRadius() {
    return THREE.MathUtils.clamp(70 / this.denom, 0.3, 0.8);
  }

  /** Scale changes alter the context crop, so always rebuild on release (it is cheap). */
  onGrabEnd() {
    if (this.mode !== 'tabletop') return;
    this.rebuild();
  }

  onPanel(group, key, value) {
    super.onPanel(group, key, value);
    if (key === 'city' && this.contextGroup) this.contextGroup.visible = value;
  }

  onContentPanel(group, key, value) {
    if (key === 'option') this.hooks.onOption(value);
    else if (key === 'gfa') this.hooks.onGfa(value);
    else if (group === 'cuts') this.hooks.onCuts(key, value);
  }

  /**
   * Viewpoints from the villa data (data space, then → world):
   *   GARDEN    on the lawn near the north boundary, facing the house
   *   ENTRANCE  on the drive by the road (south), facing the house
   *   LIVING    in the living room, facing the garden
   *   UPPER     in the first-floor lounge (or largest room)
   *   POOL      at the pool's edge, facing across the water
   *   ROOF      on the roof above the master bedroom
   *   AERIAL    45 m out to the south-east, eyes 16 m up
   */
  goViewpoint(name) {
    const v = this.model;
    if (!v) return;
    const eye = this.camera.position.y > 0.5 ? this.camera.position.y : 1.6;
    const [L0, L1] = v.levels;
    const room = (L, names) => {
      for (const n of names) {
        const r = L.rooms.find((x) => x.name === n);
        if (r) return r;
      }
      return L.rooms.reduce((a, b) => (b.area > a.area ? b : a));
    };
    this.note = '';
    let p;
    let look;
    switch (name) {
      case 'entrance':
        p = [0, -PLOT.d / 2 + 2, 0];
        look = [0, 0, 3];
        break;
      case 'living': {
        const r = room(L0, ['LIVING', 'FAMILY']);
        p = [r.cx, r.cy, L0.z];
        look = [r.cx, r.cy + 10, L0.z + 1.6];
        break;
      }
      case 'upper': {
        const r = room(L1, ['LOUNGE', 'MASTER BED']);
        p = [r.cx, r.cy, L1.z];
        look = [r.cx, r.cy + 10, L1.z + 1.6];
        break;
      }
      case 'pool': {
        if (!v.pool) {
          this.note = 'NO POOL · GARDEN INSTEAD';
          return this.goViewpoint('garden');
        }
        const [cx, cy] = centroid(v.pool);
        // the pool vertex furthest from the house centre, stepped 1.5 m outward
        let best = 0;
        let bx = cx;
        let by = cy;
        for (let i = 0; i < v.pool.length; i += 2) {
          const d = Math.hypot(v.pool[i], v.pool[i + 1]);
          if (d > best) {
            best = d;
            bx = v.pool[i];
            by = v.pool[i + 1];
          }
        }
        const dx = bx - cx;
        const dy = by - cy;
        const l = Math.hypot(dx, dy) || 1;
        p = [bx + (dx / l) * 1.5, by + (dy / l) * 1.5, 0];
        look = [cx, cy, 0.5];
        break;
      }
      case 'roof': {
        const r = room(L1, ['MASTER BED', 'LOUNGE']);
        const wave = v.roof && v.roof.wave;
        p = [r.cx, r.cy, L1.z + L1.height + waveAt(wave, r.cx, r.cy)];
        look = [0, PLOT.d / 2 + 20, p[2] - 2];
        break;
      }
      case 'aerial': {
        const a = -Math.PI / 4;
        p = [Math.cos(a) * 45, Math.sin(a) * 45, 16 - eye];
        look = [0, 0, 3];
        break;
      }
      case 'garden':
      default:
        p = [0, PLOT.d / 2 - 3, 0];
        look = [0, 0, 3];
        break;
    }
    const P = toWorld(...p);
    const L = toWorld(...look);
    this.placeFeet(P, Math.atan2(-(L.x - P.x), -(L.z - P.z)));
  }

  /** Panel: DESIGN OPTIONS · BRIEF | CUTS · VR | VR options. */
  describePanel() {
    const s = this.state;
    const v = this.model;
    const st = v.stats;
    const vr = this.vrState();
    const C = PANEL_COLORS;
    const { cuts } = s;
    const vrCol = vrColumn(vr, [
      ['garden', 'GARDEN'],
      ['entrance', 'ENTRANCE'],
      ['living', 'LIVING'],
      ['upper', 'UPPER'],
      ['pool', 'POOL'],
      ['roof', 'ROOF'],
      ['aerial', 'AERIAL'],
    ]);
    return {
      title: `OPTION ${v.option.id} · ${v.option.name}`,
      subtitle: `${v.option.tagline.toUpperCase()} · VR`,
      header: this.renderHeader(),
      readout: [
        ['GFA', `${fmt(st.gfa)} M²`],
        ['L0 / L1', `${fmt(st.levelAreas[0])} / ${fmt(st.levelAreas[1])}`],
        ['FOOTPRINT', `${fmt(st.footprint)} M²`],
        ['COVERAGE', `${(st.coverage * 100).toFixed(1)} %`],
        ['PLOT', `${PLOT.w} × ${PLOT.d} M`],
        ['BEDROOMS', `${st.bedrooms}`],
        ['HEIGHT', `${st.height.toFixed(1)} M`],
        ['POOL', `${fmt(st.poolArea)} M²`, C.amber],
        ['SCALE', vr.scale === 'tabletop' ? `1:${Math.round(vr.denom)}` : '1:1'],
      ],
      columns: [
        [
          { t: 'micro', label: 'DESIGN OPTIONS · SAME PLOT · SAME GFA' },
          {
            t: 'grid', group: 'villa', key: 'option', label: 'OPTION', cols: 4, value: s.option,
            options: VILLA_OPTIONS.map((o) => [o.id, `${o.id}`, o.name]),
          },
          { t: 'micro', label: 'BRIEF' },
          { t: 'slider', group: 'villa', key: 'gfa', label: 'TARGET GFA', min: GFA_RANGE.min, max: GFA_RANGE.max, step: GFA_RANGE.step, value: s.gfa, text: `${s.gfa} M²` },
        ],
        [
          { t: 'micro', label: 'CUTS' },
          { t: 'seg', group: 'cuts', key: 'level', label: 'PLAN LEVEL', value: cuts.level, options: [[0, 'L0 GROUND'], [1, 'L1 FIRST']] },
          { t: 'seg', group: 'cuts', key: 'frame', label: 'PLAN FRAME', value: cuts.frame, options: [['house', 'HOUSE'], ['site', 'SITE']] },
          { t: 'slider', group: 'cuts', key: 'sectionPos', label: 'SECTION', min: -100, max: 100, step: 0.5, value: cuts.sectionPos, text: `${cuts.axis === 'x' ? 'Y' : 'X'} ${s.sectionMetres >= 0 ? '+' : ''}${s.sectionMetres.toFixed(1)} M`, accent: C.cyan },
          { t: 'seg', group: 'cuts', key: 'axis', label: 'SECTION AXIS', value: cuts.axis, options: [['x', '∥ X'], ['y', '∥ Y']] },
          { t: 'toggle', group: 'cuts', key: 'cut3D', label: 'CUT 3D MODEL', value: cuts.cut3D },
          ...vrCol.slice(0, 2),
        ],
        vrCol.slice(2),
      ],
      footer: vr.scale === 'tabletop' ? 'GRIP: ROTATE · BOTH GRIPS: SCALE · TRIGGER: PRESS' : 'STICK ↑ TELEPORT · ← → TURN 30° · TRIGGER: PRESS',
      note: this.note || this.qualityNote,
    };
  }

  updateBoards(here) {
    const s = this.state;
    this.planBoard.update(this.model, s.planLevel, s.cuts.frame, s.sectionAxis, s.sectionPos, here);
    this.sectionBoard.update(this.model, s.planLevel, s.sectionAxis, s.sectionPos);
    this.dataBoard.update(this.model);
  }

  dispose() {
    super.dispose();
    if (this.villaMats) Object.values(this.villaMats).forEach((m) => m.dispose());
  }
}
