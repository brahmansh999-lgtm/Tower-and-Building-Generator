/**
 * RealisticContext.js
 *
 * The city around the site in REALISTIC mode, built from the same
 * model.context the stylized view draws (streets, ring road, plaza, blocks,
 * trees), plus a seeded ring of distant blocks out to 2.2 km so the horizon
 * is a skyline that fades into the haze.
 *
 *   ground     one large disc, projected concrete texture
 *   plaza      paved disc around the podium
 *   ring road  asphalt annulus with lane markings and pavements
 *   streets    asphalt quads (u along the street, so the lane dashes run
 *              continuously), on wider pavement strips
 *   blocks     one InstancedMesh of unit boxes; window grid from data-space
 *              position (see RealisticMaterials.patchCity), varied tones
 *   trees      two InstancedMeshes: smoother trees within NEAR_TREES of the
 *              site (seen at 1:1 in VR and in the HERO view), cheap ones beyond
 *
 * Data space (z up). Draw calls: 7 at most, whatever the block count.
 *
 * Tabletop VR shows only what fits on the plinth: setCrop(R) rebuilds the
 * street strips inside radius R and filters the instances (no new geometry).
 * Quest 2 keeps every other block and tree: setDensity(0.5).
 */

import * as THREE from 'three';
import { seeded, streetTreeGeometry } from '../geometry/buildRealisticMeshes.js';
import { CONTEXT } from '../geometry/generateTower.js';

const PIECE = 21; //        m, street strip length (crop granularity)
const PAVEMENT = 3.5; //    m each side
const FAR_COUNT = 520;
const FAR_R = 2200;
const NEAR_TREES = 250; // m

const TONES = [
  [0.95, 0.93, 0.9],
  [0.82, 0.8, 0.78],
  [1.0, 0.96, 0.88],
  [0.72, 0.74, 0.78],
  [0.9, 0.86, 0.8],
  [0.66, 0.64, 0.62],
].map((c) => new THREE.Color(...c));

function unitBox() {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0, 0.5);
  return g;
}

/** Quad strip accumulator for flat ground pieces (normal +z). */
function flatBuilder() {
  const pos = [];
  const uv = [];
  const idx = [];
  return {
    quad(a, b, c, d, z, ua, ub, uc, ud) {
      const base = pos.length / 3;
      for (const [p, t] of [
        [a, ua],
        [b, ub],
        [c, uc],
        [d, ud],
      ]) {
        pos.push(p[0], p[1], z);
        uv.push(t ? t[0] : 0, t ? t[1] : 0);
      }
      // CCW seen from above (+z) whichever way the inputs run
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (cross >= 0) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    },
    build() {
      if (!idx.length) return new THREE.BufferGeometry();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const n = new Float32Array(pos.length);
      for (let i = 2; i < n.length; i += 3) n[i] = 1;
      g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
      return g;
    },
  };
}

export class RealisticContext {
  constructor(mats, tier) {
    this.mats = mats;
    this.tier = tier;
    this.group = new THREE.Group();
    this.group.name = 'realistic-context';
    this.ctx = null;
    this.crop = Infinity;
    this.density = tier.city;
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.p = new THREE.Vector3();
    this.s = new THREE.Vector3();

    // Unscaled on purpose: the projected texture reads object-space position.
    this.ground = new THREE.Mesh(new THREE.CircleGeometry(3000, 128), mats.ground);
    this.ground.position.z = -0.05;
    this.ground.receiveShadow = true;
    this.plaza = new THREE.Mesh(new THREE.BufferGeometry(), mats.plaza);
    this.plaza.receiveShadow = true;
    this.ringRoad = new THREE.Mesh(new THREE.BufferGeometry(), mats.asphalt);
    this.ringRoad.receiveShadow = true;
    this.ringWalk = new THREE.Mesh(new THREE.BufferGeometry(), mats.pavement);
    this.ringWalk.receiveShadow = true;
    this.streets = new THREE.Mesh(new THREE.BufferGeometry(), mats.asphalt);
    this.streets.receiveShadow = true;
    this.walks = new THREE.Mesh(new THREE.BufferGeometry(), mats.pavement);
    this.walks.receiveShadow = true;
    this.blocks = null;
    this.trees = null;
    this.treesNear = null;
    this.boxGeo = unitBox();
    this.treeGeo = streetTreeGeometry(0);
    this.treeGeoNear = streetTreeGeometry(1);
    for (const o of [this.ground, this.plaza, this.ringRoad, this.ringWalk, this.streets, this.walks]) o.frustumCulled = false;
    this.group.add(this.ground, this.plaza, this.ringWalk, this.ringRoad, this.walks, this.streets);
  }

  /** Build from model.context (cached by identity: it only changes with the footprint). */
  build(model) {
    const ctx = model.context;
    if (ctx === this.ctx) return;
    this.ctx = ctx;

    // Plaza
    this.plaza.geometry.dispose();
    this.plaza.geometry = new THREE.CircleGeometry(ctx.plazaR, 128);
    this.plaza.position.z = 0.03;

    // Ring road: u along the circumference (8 m per tile), v across 14 m.
    const ring = ctx.ring;
    const r0 = ring.r - ring.width / 2;
    const r1 = ring.r + ring.width / 2;
    const road = flatBuilder();
    const walk = flatBuilder();
    const seg = 160;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      const c0 = [Math.cos(a0), Math.sin(a0)];
      const c1 = [Math.cos(a1), Math.sin(a1)];
      const u0 = (a0 * ring.r) / 8;
      const u1 = (a1 * ring.r) / 8;
      const at = (c, r) => [c[0] * r, c[1] * r];
      road.quad(at(c0, r0), at(c1, r0), at(c1, r1), at(c0, r1), 0.06, [u0, 0], [u1, 0], [u1, 1], [u0, 1]);
      walk.quad(at(c0, r0 - PAVEMENT), at(c1, r0 - PAVEMENT), at(c1, r1 + PAVEMENT), at(c0, r1 + PAVEMENT), 0.04);
    }
    this.ringRoad.geometry.dispose();
    this.ringRoad.geometry = road.build();
    this.ringWalk.geometry.dispose();
    this.ringWalk.geometry = walk.build();
    this.ringR = r1 + PAVEMENT;

    // Streets → pieces of ≤ PIECE m with their running distance (for u).
    this.pieces = [];
    for (const s of ctx.streets) {
      const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
      const n = Math.max(1, Math.ceil(len / PIECE));
      for (let i = 0; i < n; i++) {
        const t0 = i / n;
        const t1 = (i + 1) / n;
        this.pieces.push({
          x0: s.x0 + (s.x1 - s.x0) * t0,
          y0: s.y0 + (s.y1 - s.y0) * t0,
          x1: s.x0 + (s.x1 - s.x0) * t1,
          y1: s.y0 + (s.y1 - s.y0) * t1,
          d0: len * t0,
          d1: len * t1,
        });
      }
    }
    this.street = ctx.street;

    // Blocks: the model's own plus a seeded far ring for the skyline.
    const list = ctx.blocks.map((b, i) => ({ ...b, tone: i % TONES.length }));
    const rnd = seeded(90210);
    const r0far = CONTEXT.EXTENT + 60;
    let tries = 0;
    const far = [];
    while (far.length < FAR_COUNT && tries++ < FAR_COUNT * 20) {
      const rad = r0far + (FAR_R - r0far) * Math.sqrt(rnd());
      const a = rnd() * Math.PI * 2;
      const w = 22 + rnd() * 34;
      const d = 22 + rnd() * 34;
      const tall = rnd() < 0.14;
      const h = tall ? 90 + rnd() * 120 : 14 + Math.pow(rnd(), 1.5) * 60;
      const x = Math.cos(a) * rad;
      const y = Math.sin(a) * rad;
      const R = Math.hypot(w, d) / 2;
      if (far.some((b) => Math.hypot(b.x - x, b.y - y) < b.R + R + 10)) continue;
      far.push({ x, y, w, d, h, R, tone: Math.floor(rnd() * TONES.length) });
    }
    this.blockList = list.concat(far);
    this.treeList = ctx.trees;

    if (this.blocks) {
      this.group.remove(this.blocks);
      this.blocks.dispose();
    }
    for (const k of ['trees', 'treesNear']) {
      if (this[k]) {
        this.group.remove(this[k]);
        this[k].dispose();
      }
    }
    this.blocks = new THREE.InstancedMesh(this.boxGeo, this.mats.city, this.blockList.length);
    this.blocks.castShadow = true;
    this.blocks.receiveShadow = true;
    this.trees = new THREE.InstancedMesh(this.treeGeo, this.mats.tree, Math.max(1, this.treeList.length));
    this.treesNear = new THREE.InstancedMesh(this.treeGeoNear, this.mats.tree, Math.max(1, this.treeList.length));
    for (const im of [this.trees, this.treesNear]) {
      im.castShadow = true;
      im.receiveShadow = true;
    }
    for (const im of [this.blocks, this.trees, this.treesNear]) {
      im.frustumCulled = false;
      this.group.add(im);
    }
    this.buildStreets();
    this.applyInstances();
  }

  /** Street and pavement strips, only the pieces inside the crop radius. */
  buildStreets() {
    if (!this.pieces) return;
    const road = flatBuilder();
    const walk = flatBuilder();
    const hw = this.street / 2;
    const R = this.crop;
    for (const s of this.pieces) {
      if (Number.isFinite(R) && Math.hypot((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2) + PIECE / 2 + hw > R) continue;
      const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0) || 1;
      const nx = (-(s.y1 - s.y0) / len) * hw;
      const ny = ((s.x1 - s.x0) / len) * hw;
      const u0 = s.d0 / 8;
      const u1 = s.d1 / 8;
      road.quad([s.x0 + nx, s.y0 + ny], [s.x1 + nx, s.y1 + ny], [s.x1 - nx, s.y1 - ny], [s.x0 - nx, s.y0 - ny], 0.06, [u0, 0], [u1, 0], [u1, 1], [u0, 1]);
      const k = (hw + PAVEMENT) / hw;
      walk.quad([s.x0 + nx * k, s.y0 + ny * k], [s.x1 + nx * k, s.y1 + ny * k], [s.x1 - nx * k, s.y1 - ny * k], [s.x0 - nx * k, s.y0 - ny * k], 0.04);
    }
    this.streets.geometry.dispose();
    this.streets.geometry = road.build();
    this.walks.geometry.dispose();
    this.walks.geometry = walk.build();
  }

  /**
   * Write the instance matrices that pass the crop and density filters and
   * set the draw counts. Density 0.5 keeps every other instance; distant
   * blocks go first because the fog hides them anyway.
   */
  applyInstances() {
    if (!this.blocks) return;
    const R = this.crop;
    const keep = (i) => this.density >= 1 || i % Math.round(1 / this.density) === 0;
    const { m, q, p, s } = this;
    let k = 0;
    this.blockList.forEach((b, i) => {
      if (Number.isFinite(R) && Math.hypot(b.x, b.y) + Math.hypot(b.w, b.d) / 2 > R) return;
      if (!keep(i) && Math.hypot(b.x, b.y) > 260) return;
      this.blocks.setMatrixAt(k, m.compose(p.set(b.x, b.y, 0), q, s.set(b.w, b.d, b.h)));
      this.blocks.setColorAt(k, TONES[b.tone]);
      k++;
    });
    this.blocks.count = k;
    this.blocks.instanceMatrix.needsUpdate = true;
    if (this.blocks.instanceColor) this.blocks.instanceColor.needsUpdate = true;

    let t = 0;
    let tn = 0;
    this.treeList.forEach((tr, i) => {
      const d = Math.hypot(tr.x, tr.y);
      if (Number.isFinite(R) && d + tr.r > R) return;
      if (d > this.tier.treeR || !keep(i)) return;
      m.compose(p.set(tr.x, tr.y, 0), q, s.set(tr.r, tr.r, tr.h));
      if (d < NEAR_TREES) this.treesNear.setMatrixAt(tn++, m);
      else this.trees.setMatrixAt(t++, m);
    });
    this.trees.count = t;
    this.treesNear.count = tn;
    this.trees.instanceMatrix.needsUpdate = true;
    this.treesNear.instanceMatrix.needsUpdate = true;
  }

  /** Tabletop: only what fits on the plinth (radius in data metres). */
  setCrop(R) {
    const r = Number.isFinite(R) ? R : Infinity;
    if (r === this.crop) return;
    this.crop = r;
    this.ground.geometry.dispose();
    this.ground.geometry = new THREE.CircleGeometry(Number.isFinite(r) ? r : 3000, 128);
    const ringFits = !Number.isFinite(r) || this.ringR < r;
    this.ringRoad.visible = ringFits;
    this.ringWalk.visible = ringFits;
    this.buildStreets();
    this.applyInstances();
  }

  setDensity(f) {
    if (f === this.density) return;
    this.density = f;
    this.applyInstances();
  }

  setVisible(v) {
    for (const o of [this.plaza, this.ringRoad, this.ringWalk, this.streets, this.walks, this.blocks, this.trees, this.treesNear]) if (o) o.visible = v && (o !== this.ringRoad && o !== this.ringWalk ? true : !Number.isFinite(this.crop) || this.ringR < this.crop);
  }

  get drawCalls() {
    return this.group.children.filter((o) => o.visible).length;
  }

  dispose() {
    for (const o of [this.ground, this.plaza, this.ringRoad, this.ringWalk, this.streets, this.walks]) o.geometry.dispose();
    if (this.blocks) this.blocks.dispose();
    if (this.trees) this.trees.dispose();
    if (this.treesNear) this.treesNear.dispose();
    this.boxGeo.dispose();
    this.treeGeo.dispose();
    this.treeGeoNear.dispose();
  }
}
