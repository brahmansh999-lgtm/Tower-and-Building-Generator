/**
 * buildRealisticMeshes.js
 *
 * Geometry for the REALISTIC render mode, derived only from the object that
 * generateTower() returns (plates, fin polylines, bridge stations, podium
 * outline). No form logic is repeated here: every surface is lofted, offset or
 * extruded from those data, so it follows every slider exactly like the
 * stylized view does.
 *
 * Pure: no scene, renderer or material access. Returns BufferGeometries grouped
 * by the material they will be drawn with (one merged geometry per material, so
 * the whole building is a handful of draw calls), plus instance lists for the
 * planting.
 *
 * Data space throughout (metres, x east, y north, z up), like generateTower.
 * The caller puts the result under a group rotated −90° about X.
 *
 * Every vertex carries a grey vertex colour that is baked ambient occlusion
 * (see "AO baking" below). The realistic materials have vertexColors on, so
 * this multiplies the albedo. In VR, where there is no screen-space AO pass,
 * it is the only occlusion. On desktop the GTAO pass adds to it.
 *
 * Output:
 * {
 *   glass, podiumGlass, alu, concrete, helipad, uplight   BufferGeometry | null
 *   foliage: [{ x, y, z, s, rot, tone }]   blob clusters (planters, gardens)
 *   palms:   [{ x, y, z, s, rot }]         palms on podium, bridges, roofs
 *   box:     { minX, maxX, minY, maxY, minZ, maxZ }   building bounds incl. crown
 *   maxZ
 * }
 */

import * as THREE from 'three';
import { FLOOR_HEIGHT, PARAPET, BRIDGE_STATION_STRIDE, PODIUM_FLOOR_HEIGHT, pointInPolygon } from './generateTower.js';

export const RM = {
  SLAB_H: 0.35, //       slab edge band height (m)
  SLAB_OUT: 0.2, //      slab edge protrusion beyond the glass line (m)
  FIN_DEPTH: 0.45, //    fin depth from the glass line: 0.25 m beyond the slab edge
  FIN_ROOT: 0.1, //      fin width at the facade (m)
  FIN_TIP: 0.05, //      fin width at the tip (m)
  FIN_EMBED: 0.05, //    fin root sunk into the facade so no seam shows
  POCKET_DEPTH: 3.2, //  terrace recess depth (m)
  CROWN_FLOORS: 6, //    storeys the fins continue above the roof as a lattice
  TEX_CELLS: 32, //      window texture: 32 bays × 32 floors per tile
  BAY: 1.6, //           target mullion spacing (m)
  RIB_STEP: 3.0, //      bridge rib spacing (m)
  RIB_OUT: 0.18, //      rib depth outside the bridge glass (m)
  RIB_W: 0.28, //        rib width along the span (m)
  PODIUM_BAY: 3.0, //    podium mullion spacing (m)
  BRIDGE_RING: 20, //    vertices around each bridge section
};

/** Small deterministic PRNG (mulberry32): same seed, same planting and pockets. */
export function seeded(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------------------------------------------------
 * Geometry accumulator
 * ------------------------------------------------------------------------- */

class Geo {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.col = [];
    this.idx = [];
  }

  get count() {
    return this.pos.length / 3;
  }

  /** Add one vertex; `ao` is the baked occlusion (1 = open sky, 0 = black). */
  v(x, y, z, nx, ny, nz, u = 0, w = 0, ao = 1) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, w);
    this.col.push(ao, ao, ao);
    return this.count - 1;
  }

  /**
   * Quad a-b-c-d as two triangles. The winding is chosen from the geometry:
   * if the face normal (b−a)×(c−a) disagrees with the vertex normals the
   * triangles are flipped, so front faces always face where the normals point.
   */
  quad(a, b, c, d) {
    const P = this.pos;
    const N = this.nrm;
    const ex = P[3 * b] - P[3 * a];
    const ey = P[3 * b + 1] - P[3 * a + 1];
    const ez = P[3 * b + 2] - P[3 * a + 2];
    const fx = P[3 * c] - P[3 * a];
    const fy = P[3 * c + 1] - P[3 * a + 1];
    const fz = P[3 * c + 2] - P[3 * a + 2];
    const cx = ey * fz - ez * fy;
    const cy = ez * fx - ex * fz;
    const cz = ex * fy - ey * fx;
    const dot = cx * (N[3 * a] + N[3 * c]) + cy * (N[3 * a + 1] + N[3 * c + 1]) + cz * (N[3 * a + 2] + N[3 * c + 2]);
    if (dot >= 0) this.idx.push(a, b, c, a, c, d);
    else this.idx.push(a, c, b, a, d, c);
  }

  tri(a, b, c) {
    const P = this.pos;
    const N = this.nrm;
    const ex = P[3 * b] - P[3 * a];
    const ey = P[3 * b + 1] - P[3 * a + 1];
    const ez = P[3 * b + 2] - P[3 * a + 2];
    const fx = P[3 * c] - P[3 * a];
    const fy = P[3 * c + 1] - P[3 * a + 1];
    const fz = P[3 * c + 2] - P[3 * a + 2];
    const dot = (ey * fz - ez * fy) * N[3 * a] + (ez * fx - ex * fz) * N[3 * a + 1] + (ex * fy - ey * fx) * N[3 * a + 2];
    if (dot >= 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }

  build() {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

/* ---------------------------------------------------------------------------
 * Plate helpers
 * ------------------------------------------------------------------------- */

/**
 * Outward horizontal unit normal per vertex of a closed CCW ring. The central
 * difference t = p[j+1] − p[j−1] is the tangent; outward is (t.y, −t.x)
 * (a CCW ring turned clockwise by 90°).
 */
function ringNormals(p) {
  const M = p.length / 2;
  const n = new Float32Array(M * 2);
  for (let j = 0; j < M; j++) {
    const a = (j + M - 1) % M;
    const b = (j + 1) % M;
    const tx = p[2 * b] - p[2 * a];
    const ty = p[2 * b + 1] - p[2 * a + 1];
    const l = Math.hypot(tx, ty) || 1;
    n[2 * j] = ty / l;
    n[2 * j + 1] = -tx / l;
  }
  return n;
}

function perimeter(p) {
  let L = 0;
  const M = p.length / 2;
  for (let j = 0; j < M; j++) {
    const k = (j + 1) % M;
    L += Math.hypot(p[2 * k] - p[2 * j], p[2 * k + 1] - p[2 * j + 1]);
  }
  return L;
}

const lerp = (a, b, s) => a + (b - a) * s;

/* ---------------------------------------------------------------------------
 * Terrace pockets
 *
 * Each tower gets 3–5 recessed terraces that spiral up the facade. A pocket is
 * a rectangle on the facade "grid" of floors × plate vertices:
 *   floors  [f0, f1)        3–5 storeys tall
 *   vertices [j0, j1]       6–10 vertex intervals wide, j0 even so the pocket
 *                           edges land on fins (fins sit on every 2nd vertex)
 * Placement, for pocket k of K:
 *   height  t_k = (k + ½ + jitter) / K of the usable shaft (above the podium,
 *           below the crown), so the pockets are spread evenly up the tower
 *   angle   j0_k = j_base + k·round(0.29·M)  — each pocket is ~105° further
 *           round the plate than the one below it, which is what makes the
 *           set read as a spiral
 * The random numbers come from a PRNG seeded only by the tower index, so the
 * pockets keep their place on the facade while sliders move. Pockets that would
 * collide with a bridge attachment (±2 floors) slide up, then down, or are
 * dropped.
 * ------------------------------------------------------------------------- */

function towerPockets(T, model, fMin) {
  const F = T.floors.length;
  const M = T.floors[0].points2D.length / 2;
  const rnd = seeded(7919 * (T.index + 1) + 101);
  const K = 3 + Math.floor(rnd() * 3);
  const lo = fMin + 3;
  const hi = F - 4;
  if (hi - lo < 12) return [];
  const blocked = [];
  for (const b of model.bridges) {
    if (b.fromTower === T.index || b.toTower === T.index) blocked.push([b.level - 2, b.level + b.storeys + 2]);
  }
  const clash = (f0, f1) => blocked.some(([a, b]) => f0 < b && f1 > a);
  const step = Math.max(2, Math.round((M * 0.29) / 2) * 2);
  const jBase = 2 * Math.floor((rnd() * M) / 2);
  const pockets = [];
  for (let k = 0; k < K; k++) {
    const h = 3 + Math.floor(rnd() * 3);
    const w = 2 * (3 + Math.floor(rnd() * 3));
    const t = (k + 0.5 + (rnd() - 0.5) * 0.4) / K;
    let f0 = Math.round(lo + t * (hi - lo) - h / 2);
    f0 = Math.max(lo, Math.min(hi - h, f0));
    let placed = -1;
    for (const d of [0, 2, -2, 4, -4, 6, -6]) {
      const c = f0 + d;
      if (c < lo || c + h > hi) continue;
      if (clash(c, c + h)) continue;
      if (pockets.some((p) => c < p.f1 + 1 && c + h > p.f0 - 1)) continue;
      placed = c;
      break;
    }
    if (placed < 0) continue;
    let j0 = (jBase + k * step) % M;
    if (j0 + w > M) j0 = M - w;
    pockets.push({ f0: placed, f1: placed + h, j0, j1: j0 + w });
  }
  return pockets;
}

/* ---------------------------------------------------------------------------
 * Tower
 * ------------------------------------------------------------------------- */

/**
 * One tower into the shared accumulators.
 *
 * LOFTING. The glass skin is lofted storey by storey between consecutive plate
 * outlines. Vertex j is the same parametric angle on every plate (see
 * generateTower's unitPlate), so joining vertex j of plate f to vertex j of
 * plate f+1 gives quads that follow the twist and sway exactly. For storey f:
 *   lower ring  P_f + (P_{f+1} − P_f)·s at z_f + SLAB_H,  s = SLAB_H / FLOOR_HEIGHT
 *               (starts on top of the slab edge band, on the leaning line)
 *   upper ring  P_{f+1} at z_{f+1}  (meets the next slab's soffit)
 * Normals are analytic: n = t × u, with t the ring tangent at j (central
 * difference) and u = P_{f+1}[j] − P_f[j] the rise of that vertex over the
 * storey (twist and sway make it lean). For a CCW ring t × u points out.
 *
 * UVs. The seam vertex is duplicated (j = 0…M) so u runs continuously round
 * the plate:
 *   u = j · baysPerVertex / TEX_CELLS            (+ a whole-bay offset per tower)
 *   v = z / FLOOR_HEIGHT / TEX_CELLS             (+ a whole-floor offset per tower)
 * baysPerVertex = round(perimeter / BAY / M) is an integer, so a mullion lands
 * on every plate vertex (and therefore behind every fin), and v = height means
 * each texture row is exactly one storey: the mullion grid and the lit rooms in
 * the window texture line up with the real floors and slab edges.
 */
function buildTower(T, model, G, foliage, palms, isHelipad) {
  const F = T.floors.length;
  const M = T.floors[0].points2D.length / 2;
  const podH = model.podium.height;
  const rnd = seeded(31337 + T.index * 977);

  // First storey that shows above the podium roof.
  let fMin = 0;
  while (fMin < F - 1 && T.floors[fMin + 1].z <= podH) fMin++;

  const normals = T.floors.map((P) => ringNormals(P.points2D));
  const baysPerVertex = Math.max(1, Math.round(perimeter(T.floors[fMin].points2D) / RM.BAY / M));
  const uScale = baysPerVertex / RM.TEX_CELLS;
  const uOff = (T.index * 11) / RM.TEX_CELLS;
  const vOff = (T.index * 7) / RM.TEX_CELLS;
  const vOf = (z) => z / FLOOR_HEIGHT / RM.TEX_CELLS + vOff;

  const pockets = towerPockets(T, model, fMin);
  const pocketAt = (f, j) => pockets.find((p) => f >= p.f0 && f < p.f1 && j >= p.j0 && j < p.j1);

  /* ---- glass skin ---- */
  const glass = G.glass;
  for (let f = fMin; f < F - 1; f++) {
    const A = T.floors[f];
    const B = T.floors[f + 1];
    let z0 = A.z + RM.SLAB_H;
    let s = RM.SLAB_H / FLOOR_HEIGHT;
    if (z0 < podH) {
      z0 = podH;
      s = (podH - A.z) / FLOOR_HEIGHT;
    }
    const z1 = B.z;
    const a = A.points2D;
    const b = B.points2D;
    const base = glass.count;
    for (let j = 0; j <= M; j++) {
      const jj = j % M;
      const jp = (jj + 1) % M;
      const jm = (jj + M - 1) % M;
      const tx = a[2 * jp] - a[2 * jm];
      const ty = a[2 * jp + 1] - a[2 * jm + 1];
      const ux = b[2 * jj] - a[2 * jj];
      const uy = b[2 * jj + 1] - a[2 * jj + 1];
      const uz = FLOOR_HEIGHT;
      // n = t × u with t = (tx, ty, 0)
      let nx = ty * uz;
      let ny = -tx * uz;
      let nz = tx * uy - ty * ux;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      const u = j * uScale + uOff;
      glass.v(lerp(a[2 * jj], b[2 * jj], s), lerp(a[2 * jj + 1], b[2 * jj + 1], s), z0, nx, ny, nz, u, vOf(z0), 0.92);
      glass.v(b[2 * jj], b[2 * jj + 1], z1, nx, ny, nz, u, vOf(z1), 0.74);
    }
    for (let j = 0; j < M; j++) {
      if (pocketAt(f, j)) continue;
      const i0 = base + 2 * j;
      const i1 = base + 2 * (j + 1);
      glass.quad(i0, i1, i1 + 1, i0 + 1);
    }
  }

  /* ---- terrace pockets ---- */
  const D = RM.POCKET_DEPTH;
  const inset = (x, y, cx, cy) => {
    const r = Math.hypot(x - cx, y - cy) || 1;
    const k = Math.max(0.2, 1 - D / r);
    return [cx + (x - cx) * k, cy + (y - cy) * k];
  };
  for (const pk of pockets) {
    for (let f = pk.f0; f < pk.f1; f++) {
      const A = T.floors[f];
      const B = T.floors[f + 1];
      const s = RM.SLAB_H / FLOOR_HEIGHT;
      const z0 = A.z + RM.SLAB_H;
      const z1 = B.z;
      const a = A.points2D;
      const b = B.points2D;
      const lcx = lerp(A.cx, B.cx, s);
      const lcy = lerp(A.cy, B.cy, s);
      const outerLo = [];
      const innerLo = [];
      const outerHi = [];
      const innerHi = [];
      for (let j = pk.j0; j <= pk.j1; j++) {
        const jj = j % M;
        const ox = lerp(a[2 * jj], b[2 * jj], s);
        const oy = lerp(a[2 * jj + 1], b[2 * jj + 1], s);
        outerLo.push([ox, oy]);
        innerLo.push(inset(ox, oy, lcx, lcy));
        outerHi.push([b[2 * jj], b[2 * jj + 1]]);
        innerHi.push(inset(b[2 * jj], b[2 * jj + 1], B.cx, B.cy));
      }
      const n = normals[f];
      const W = pk.j1 - pk.j0;
      // back wall: glass, recessed, more occluded
      const gb = glass.count;
      for (let i = 0; i <= W; i++) {
        const jj = (pk.j0 + i) % M;
        const u = (pk.j0 + i) * uScale + uOff;
        glass.v(innerLo[i][0], innerLo[i][1], z0, n[2 * jj], n[2 * jj + 1], 0, u, vOf(z0), 0.6);
        glass.v(innerHi[i][0], innerHi[i][1], z1, n[2 * jj], n[2 * jj + 1], 0, u, vOf(z1), 0.42);
      }
      for (let i = 0; i < W; i++) glass.quad(gb + 2 * i, gb + 2 * i + 2, gb + 2 * i + 3, gb + 2 * i + 1);
      // terrace floor (up) and ceiling (down)
      const c = G.concrete;
      const fb = c.count;
      for (let i = 0; i <= W; i++) {
        c.v(outerLo[i][0], outerLo[i][1], z0, 0, 0, 1, 0, 0, 0.92);
        c.v(innerLo[i][0], innerLo[i][1], z0, 0, 0, 1, 0, 0, 0.55);
      }
      for (let i = 0; i < W; i++) c.quad(fb + 2 * i, fb + 2 * i + 2, fb + 2 * i + 3, fb + 2 * i + 1);
      const cb = c.count;
      for (let i = 0; i <= W; i++) {
        c.v(outerHi[i][0], outerHi[i][1], z1, 0, 0, -1, 0, 0, 0.55);
        c.v(innerHi[i][0], innerHi[i][1], z1, 0, 0, -1, 0, 0, 0.3);
      }
      for (let i = 0; i < W; i++) c.quad(cb + 2 * i, cb + 2 * i + 2, cb + 2 * i + 3, cb + 2 * i + 1);
      // side walls: facing into the pocket (+tangent at j0, −tangent at j1)
      for (const [i, sign] of [
        [0, 1],
        [W, -1],
      ]) {
        const jj = (pk.j0 + i) % M;
        const tx = -n[2 * jj + 1] * sign;
        const ty = n[2 * jj] * sign;
        const w0 = c.v(outerLo[i][0], outerLo[i][1], z0, tx, ty, 0, 0, 0, 0.75);
        const w1 = c.v(innerLo[i][0], innerLo[i][1], z0, tx, ty, 0, 0, 0, 0.45);
        const w2 = c.v(innerHi[i][0], innerHi[i][1], z1, tx, ty, 0, 0, 0, 0.35);
        const w3 = c.v(outerHi[i][0], outerHi[i][1], z1, tx, ty, 0, 0, 0, 0.6);
        c.quad(w0, w1, w2, w3);
      }
      // planters along the terrace edge, one small tree per terrace
      for (let i = 0; i < W; i++) {
        const mx = (outerLo[i][0] + outerLo[i + 1][0]) / 2;
        const my = (outerLo[i][1] + outerLo[i + 1][1]) / 2;
        const ix = (innerLo[i][0] + innerLo[i + 1][0]) / 2;
        const iy = (innerLo[i][1] + innerLo[i + 1][1]) / 2;
        const k = 0.22 + rnd() * 0.12;
        foliage.push({ x: lerp(mx, ix, k), y: lerp(my, iy, k), z: z0, s: 0.55 + rnd() * 0.4, rot: rnd() * 6.28, tone: Math.floor(rnd() * 4) });
      }
      const mid = Math.floor(W / 2);
      palms.push({ x: lerp(outerLo[mid][0], innerLo[mid][0], 0.55), y: lerp(outerLo[mid][1], innerLo[mid][1], 0.55), z: z0, s: 2.3 + rnd() * 0.4, rot: rnd() * 6.28 });
    }
  }

  /* ---- floor plates (seen only when the section cuts the tower open) ---- */
  {
    const c = G.concrete;
    for (let f = fMin + 1; f < F - 1; f++) {
      const P = T.floors[f];
      if (P.z < podH) continue;
      const z = P.z + RM.SLAB_H;
      const ce = c.v(P.cx, P.cy, z, 0, 0, 1, 0, 0, 0.8);
      const rb = c.count;
      for (let j = 0; j < M; j++) c.v(P.points2D[2 * j], P.points2D[2 * j + 1], z, 0, 0, 1, 0, 0, 0.6);
      for (let j = 0; j < M; j++) c.tri(ce, rb + j, rb + ((j + 1) % M));
    }
  }

  /* ---- slab edges (and the roof parapet) ---- */
  const alu = G.alu;
  for (let f = fMin; f < F; f++) {
    const P = T.floors[f];
    if (P.z < podH - 0.01) continue;
    const p = P.points2D;
    const n = normals[f];
    const roof = f === F - 1;
    const H = roof ? PARAPET : RM.SLAB_H;
    const o = RM.SLAB_OUT;
    const z0 = P.z;
    const z1 = P.z + H;
    const base = alu.count;
    const per = roof ? 8 : 6;
    for (let j = 0; j < M; j++) {
      const x = p[2 * j];
      const y = p[2 * j + 1];
      const nx = n[2 * j];
      const ny = n[2 * j + 1];
      const X = x + nx * o;
      const Y = y + ny * o;
      // soffit (down), outer face, top (up) — own vertices for crisp edges
      alu.v(x, y, z0, 0, 0, -1, 0, 0, 0.38);
      alu.v(X, Y, z0, 0, 0, -1, 0, 0, 0.62);
      alu.v(X, Y, z0, nx, ny, 0, 0, 0, 0.82);
      alu.v(X, Y, z1, nx, ny, 0, 0, 0, 1);
      alu.v(X, Y, z1, 0, 0, 1, 0, 0, 1);
      alu.v(x, y, z1, 0, 0, 1, 0, 0, 0.72);
      if (roof) {
        // parapet inner face, down to the roof deck
        alu.v(x, y, z1, -nx, -ny, 0, 0, 0, 0.95);
        alu.v(x, y, z0 + 0.3, -nx, -ny, 0, 0, 0, 0.6);
      }
    }
    for (let j = 0; j < M; j++) {
      const a = base + j * per;
      const b = base + ((j + 1) % M) * per;
      alu.quad(a, b, b + 1, a + 1);
      alu.quad(a + 2, b + 2, b + 3, a + 3);
      alu.quad(a + 4, b + 4, b + 5, a + 5);
      if (roof) alu.quad(a + 6, b + 6, b + 7, a + 7);
    }
  }

  /* ---- fins and the crown lattice ---- */
  const top = T.floors[F - 1];
  const prev = T.floors[Math.max(0, F - 2)];
  const dRot = top.rot - prev.rot;
  const crownRow = (c, j) => {
    // Continue the plate's own twist above the roof and draw the fins in:
    //   angle  += dRot · c        (same twist per storey as the top floor)
    //   radius ×= 1 − 0.18·(c/C)^1.5   (the lattice gathers toward its top)
    const ang = dRot * c;
    const k = 1 - 0.18 * Math.pow(c / RM.CROWN_FLOORS, 1.5);
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const p = top.points2D;
    const n = normals[F - 1];
    const dx = p[2 * j] - top.cx;
    const dy = p[2 * j + 1] - top.cy;
    return {
      x: top.cx + (dx * ca - dy * sa) * k,
      y: top.cy + (dx * sa + dy * ca) * k,
      z: top.z + c * FLOOR_HEIGHT,
      nx: n[2 * j] * ca - n[2 * j + 1] * sa,
      ny: n[2 * j] * sa + n[2 * j + 1] * ca,
    };
  };
  const stride = M / T.finCount;
  let fFin = fMin;
  while (fFin < F - 1 && T.floors[fFin].z < podH - 0.01) fFin++;
  const tips = []; // per crown row c → fin tip points (for the lattice rings)
  for (let k = 0; k < T.finCount; k++) {
    const j = k * stride;
    const rows = [];
    for (let f = fFin; f < F; f++) {
      const P = T.floors[f];
      rows.push({ x: P.points2D[2 * j], y: P.points2D[2 * j + 1], z: P.z, nx: normals[f][2 * j], ny: normals[f][2 * j + 1], ao: 0.5 });
    }
    for (let c = 1; c <= RM.CROWN_FLOORS; c++) {
      const r = crownRow(c, j);
      r.ao = 0.9;
      rows.push(r);
      if (!tips[c]) tips[c] = [];
      tips[c].push({ x: r.x + r.nx * RM.FIN_DEPTH, y: r.y + r.ny * RM.FIN_DEPTH, z: r.z, nx: r.nx, ny: r.ny });
    }
    const base = alu.count;
    // Tapered profile in the plate's local frame (n out of the facade, t
    // along it): root RM.FIN_ROOT wide sunk FIN_EMBED into the glass, tip
    // RM.FIN_TIP wide at FIN_DEPTH. Returns [rootL, tipL, tipR, rootR].
    const profile = (r) => {
      const tx = -r.ny;
      const ty = r.nx;
      const w0 = RM.FIN_ROOT / 2;
      const w1 = RM.FIN_TIP / 2;
      const rx = r.x - r.nx * RM.FIN_EMBED;
      const ry = r.y - r.ny * RM.FIN_EMBED;
      const ex = r.x + r.nx * RM.FIN_DEPTH;
      const ey = r.y + r.ny * RM.FIN_DEPTH;
      return [
        [rx - tx * w0, ry - ty * w0],
        [ex - tx * w1, ey - ty * w1],
        [ex + tx * w1, ey + ty * w1],
        [rx + tx * w0, ry + ty * w0],
      ];
    };
    for (const r of rows) {
      const tx = -r.ny;
      const ty = r.nx;
      const [L0, L1, R1, R0] = profile(r);
      // left side (−t), tip (n), right side (+t); AO darkens the fin roots
      alu.v(L0[0], L0[1], r.z, -tx, -ty, 0, 0, 0, r.ao);
      alu.v(L1[0], L1[1], r.z, -tx, -ty, 0, 0, 0, 1);
      alu.v(L1[0], L1[1], r.z, r.nx, r.ny, 0, 0, 0, 1);
      alu.v(R1[0], R1[1], r.z, r.nx, r.ny, 0, 0, 0, 1);
      alu.v(R1[0], R1[1], r.z, tx, ty, 0, 0, 0, 1);
      alu.v(R0[0], R0[1], r.z, tx, ty, 0, 0, 0, r.ao);
    }
    for (let i = 0; i < rows.length - 1; i++) {
      const a = base + i * 6;
      const b = a + 6;
      alu.quad(a, a + 1, b + 1, b);
      alu.quad(a + 2, a + 3, b + 3, b + 2);
      alu.quad(a + 4, a + 5, b + 5, b + 4);
    }
    // cap the top of the fin
    const last = rows[rows.length - 1];
    const cap = profile(last).map(([x, y]) => alu.v(x, y, last.z, 0, 0, 1, 0, 0, 1));
    alu.quad(cap[0], cap[1], cap[2], cap[3]);
  }
  // Lattice rings through the fin tips every second crown storey.
  for (let c = 2; c <= RM.CROWN_FLOORS; c += 2) {
    const ring = tips[c];
    if (!ring || ring.length < 3) continue;
    const N = ring.length;
    const base = alu.count;
    for (const p of ring) {
      const ix = p.x - p.nx * 0.3;
      const iy = p.y - p.ny * 0.3;
      alu.v(p.x, p.y, p.z - 0.25, p.nx, p.ny, 0, 0, 0, 0.9);
      alu.v(p.x, p.y, p.z + 0.25, p.nx, p.ny, 0, 0, 0, 1);
      alu.v(ix, iy, p.z - 0.25, -p.nx, -p.ny, 0, 0, 0, 0.75);
      alu.v(ix, iy, p.z + 0.25, -p.nx, -p.ny, 0, 0, 0, 0.9);
      alu.v(p.x, p.y, p.z - 0.25, 0, 0, -1, 0, 0, 0.7);
      alu.v(ix, iy, p.z - 0.25, 0, 0, -1, 0, 0, 0.6);
      alu.v(p.x, p.y, p.z + 0.25, 0, 0, 1, 0, 0, 1);
      alu.v(ix, iy, p.z + 0.25, 0, 0, 1, 0, 0, 1);
    }
    for (let i = 0; i < N; i++) {
      const a = base + i * 8;
      const b = base + ((i + 1) % N) * 8;
      alu.quad(a, b, b + 1, a + 1);
      alu.quad(a + 2, b + 2, b + 3, a + 3);
      alu.quad(a + 4, b + 4, b + 5, a + 5);
      alu.quad(a + 6, b + 6, b + 7, a + 7);
    }
  }

  /* ---- roof deck and roof garden ---- */
  const c = G.concrete;
  const zr = top.z + 0.3;
  const tp = top.points2D;
  const centre = c.v(top.cx, top.cy, zr, 0, 0, 1, 0, 0, 0.95);
  const rb = c.count;
  for (let j = 0; j < M; j++) c.v(tp[2 * j], tp[2 * j + 1], zr, 0, 0, 1, 0, 0, 0.7);
  for (let j = 0; j < M; j++) c.tri(centre, rb + j, rb + ((j + 1) % M));
  const nGarden = Math.round(M * 0.7);
  for (let i = 0; i < nGarden; i++) {
    const j = Math.floor(rnd() * M);
    const k = 0.5 + rnd() * 0.36;
    const x = top.cx + (tp[2 * j] - top.cx) * k;
    const y = top.cy + (tp[2 * j + 1] - top.cy) * k;
    if (pointInPolygon(top.core2D, x, y)) continue;
    foliage.push({ x, y, z: zr, s: 0.7 + rnd() * 0.6, rot: rnd() * 6.28, tone: Math.floor(rnd() * 4) });
  }
  for (let i = 0; i < 4; i++) {
    const j = Math.floor(rnd() * M);
    const k = 0.55 + rnd() * 0.25;
    const x = top.cx + (tp[2 * j] - top.cx) * k;
    const y = top.cy + (tp[2 * j + 1] - top.cy) * k;
    if (!pointInPolygon(top.core2D, x, y)) palms.push({ x, y, z: zr, s: 4 + rnd() * 2.5, rot: rnd() * 6.28 });
  }

  /* ---- helipad on top of the crown lattice ---- */
  let maxZ = top.z + RM.CROWN_FLOORS * FLOOR_HEIGHT + 0.25;
  if (isHelipad) {
    const zc = top.z + RM.CROWN_FLOORS * FLOOR_HEIGHT;
    const zd = zc + 0.6;
    const rH = Math.min(12, top.r * 0.62);
    const seg = 48;
    const h = G.helipad;
    const hc = h.v(top.cx, top.cy, zd, 0, 0, 1, 0.5, 0.5, 1);
    const hb = h.count;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      h.v(top.cx + Math.cos(a) * rH, top.cy + Math.sin(a) * rH, zd, 0, 0, 1, 0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5, 0.95);
    }
    for (let i = 0; i < seg; i++) h.tri(hc, hb + i, hb + i + 1);
    // rim (outer face) and underside
    const ab = alu.count;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      alu.v(top.cx + ca * rH, top.cy + sa * rH, zd, ca, sa, 0, 0, 0, 1);
      alu.v(top.cx + ca * rH, top.cy + sa * rH, zd - 0.9, ca, sa, 0, 0, 0, 0.85);
      alu.v(top.cx + ca * rH, top.cy + sa * rH, zd - 0.9, 0, 0, -1, 0, 0, 0.7);
      alu.v(top.cx + ca * rH * 0.4, top.cy + sa * rH * 0.4, zd - 0.9, 0, 0, -1, 0, 0, 0.45);
    }
    for (let i = 0; i < seg; i++) {
      const a = ab + i * 4;
      const b = a + 4;
      alu.quad(a, b, b + 1, a + 1);
      alu.quad(a + 2, b + 2, b + 3, a + 3);
    }
    // central mast from the roof deck to the pad
    const mb = c.count;
    const rm = Math.min(2.2, top.r * 0.12);
    for (let i = 0; i <= 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      c.v(top.cx + ca * rm, top.cy + sa * rm, zr, ca, sa, 0, 0, 0, 0.55);
      c.v(top.cx + ca * rm, top.cy + sa * rm, zd - 0.9, ca, sa, 0, 0, 0, 0.7);
    }
    for (let i = 0; i < 12; i++) c.quad(mb + 2 * i, mb + 2 * i + 2, mb + 2 * i + 3, mb + 2 * i + 1);
    maxZ = Math.max(maxZ, zd);
  }
  return maxZ;
}

/* ---------------------------------------------------------------------------
 * Sky bridges: glass tube, rib cage, deck, planting, underlighting
 * ------------------------------------------------------------------------- */

/** Superellipse (n = 4) section, the same shape the stylized loft uses. */
const SECTION = (() => {
  const R = RM.BRIDGE_RING;
  const e = 0.5;
  const pts = [];
  for (let r = 0; r <= R; r++) {
    const th = (2 * Math.PI * r) / R;
    const c = Math.cos(th);
    const s = Math.sin(th);
    pts.push({
      v: Math.sign(c) * Math.pow(Math.abs(c), e),
      w: Math.sign(s) * Math.pow(Math.abs(s), e),
      gv: Math.sign(c) * Math.pow(Math.abs(c), 2 - e),
      gw: Math.sign(s) * Math.pow(Math.abs(s), 2 - e),
    });
  }
  return pts;
})();

function buildBridge(br, model, G, foliage, palms) {
  const K = BRIDGE_STATION_STRIDE;
  const st = br.stations;
  const S = st.length / K;
  const vx = -br.uy;
  const vy = br.ux;
  const rnd = seeded(4049 + Math.round(br.z * 10) + br.fromTower * 131 + br.toTower * 17);
  const plateA = model.towers[br.fromTower].floors[Math.min(br.level, model.towers[br.fromTower].floors.length - 1)].points2D;
  const plateB = model.towers[br.toTower].floors[Math.min(br.level, model.towers[br.toTower].floors.length - 1)].points2D;
  const outside = (x, y) => !pointInPolygon(plateA, x, y) && !pointInPolygon(plateB, x, y);

  // distance along the span per station
  const dist = [0];
  for (let i = 1; i < S; i++) dist.push(dist[i - 1] + Math.hypot(st[K * i] - st[K * (i - 1)], st[K * i + 1] - st[K * (i - 1) + 1]));
  const total = dist[S - 1];
  const at = (d) => {
    let i = 0;
    while (i < S - 2 && dist[i + 1] < d) i++;
    const s = (d - dist[i]) / (dist[i + 1] - dist[i] || 1);
    const o = K * i;
    const out = [];
    for (let k = 0; k < K; k++) out.push(lerp(st[o + k], st[o + K + k], s));
    return out;
  };
  const ringPoint = (s, p, grow) => {
    const hw = s[3] + grow;
    const hh = (p.w >= 0 ? s[4] : s[5]) + grow;
    let nv = p.gv / hw;
    let nw = p.gw / hh;
    const l = Math.hypot(nv, nw) || 1;
    nv /= l;
    nw /= l;
    return {
      x: s[0] + vx * p.v * hw,
      y: s[1] + vy * p.v * hw,
      z: s[2] + p.w * hh,
      nx: vx * nv,
      ny: vy * nv,
      nz: nw,
    };
  };

  // Glass tube: u around the section (12 bays), v along the span in storeys,
  // so the window texture's floor rows become glazing bars across the tube.
  const R = RM.BRIDGE_RING;
  const glass = G.glass;
  const gb = glass.count;
  for (let i = 0; i < S; i++) {
    const s = st.slice(K * i, K * i + K);
    SECTION.forEach((p, r) => {
      const q = ringPoint(s, p, 0);
      const ao = 0.78 + 0.22 * (0.5 + 0.5 * p.w);
      glass.v(q.x, q.y, q.z, q.nx, q.ny, q.nz, (r / R) * (12 / RM.TEX_CELLS), dist[i] / FLOOR_HEIGHT / RM.TEX_CELLS, ao);
    });
  }
  for (let i = 0; i < S - 1; i++) {
    for (let r = 0; r < R; r++) {
      const a = gb + i * (R + 1) + r;
      const b = a + R + 1;
      glass.quad(a, a + 1, b + 1, b);
    }
  }

  // White rib cage: a band ring every RIB_STEP along the span, outside the glass.
  const alu = G.alu;
  for (let d = RM.RIB_STEP / 2; d < total; d += RM.RIB_STEP) {
    const mid = at(d);
    if (!outside(mid[0], mid[1])) continue;
    for (const side of [-1, 1]) {
      const s = at(d + (side * RM.RIB_W) / 2);
      const base = alu.count;
      for (let r = 0; r < R; r++) {
        const p = SECTION[r];
        const q0 = ringPoint(s, p, 0);
        const q1 = ringPoint(s, p, RM.RIB_OUT);
        alu.v(q0.x, q0.y, q0.z, br.ux * side, br.uy * side, 0, 0, 0, 0.8);
        alu.v(q1.x, q1.y, q1.z, br.ux * side, br.uy * side, 0, 0, 0, 1);
      }
      for (let r = 0; r < R; r++) {
        const a = base + 2 * r;
        const b = base + 2 * ((r + 1) % R);
        alu.quad(a, b, b + 1, a + 1);
      }
    }
    const s0 = at(d - RM.RIB_W / 2);
    const s1 = at(d + RM.RIB_W / 2);
    const base = alu.count;
    for (let r = 0; r < R; r++) {
      const p = SECTION[r];
      const a = ringPoint(s0, p, RM.RIB_OUT);
      const b = ringPoint(s1, p, RM.RIB_OUT);
      const ao = 0.82 + 0.18 * (0.5 + 0.5 * p.w);
      alu.v(a.x, a.y, a.z, a.nx, a.ny, a.nz, 0, 0, ao);
      alu.v(b.x, b.y, b.z, b.nx, b.ny, b.nz, 0, 0, ao);
    }
    for (let r = 0; r < R; r++) {
      const a = base + 2 * r;
      const b = base + 2 * ((r + 1) % R);
      alu.quad(a, b, b + 1, a + 1);
    }
  }

  // Walkable deck inside the tube, at the bridge's floor level.
  const c = G.concrete;
  const zDeck = br.z + 0.25;
  const db = c.count;
  for (let i = 0; i < S; i++) {
    const o = K * i;
    const hw = st[o + 3] * 0.72;
    c.v(st[o] + vx * hw, st[o + 1] + vy * hw, zDeck, 0, 0, 1, 0, 0, 0.7);
    c.v(st[o] - vx * hw, st[o + 1] - vy * hw, zDeck, 0, 0, 1, 0, 0, 0.7);
  }
  for (let i = 0; i < S - 1; i++) c.quad(db + 2 * i, db + 2 * i + 2, db + 2 * i + 3, db + 2 * i + 1);

  // Planting along both deck edges, palms every ~8 m on alternating sides.
  let side = 1;
  for (let d = 1; d < total; d += 2.2) {
    const s = at(d);
    if (!outside(s[0], s[1])) continue;
    for (const k of [-1, 1]) {
      const off = s[3] * 0.58 * k;
      foliage.push({ x: s[0] + vx * off, y: s[1] + vy * off, z: zDeck, s: 0.45 + rnd() * 0.3, rot: rnd() * 6.28, tone: Math.floor(rnd() * 4) });
    }
  }
  for (let d = 4; d < total; d += 8) {
    const s = at(d);
    if (!outside(s[0], s[1])) continue;
    const off = s[3] * 0.45 * side;
    side = -side;
    palms.push({ x: s[0] + vx * off, y: s[1] + vy * off, z: zDeck, s: Math.min(br.height * 0.72, 5.5), rot: rnd() * 6.28 });
  }

  // Underlighting: a warm strip along the soffit (emissive at dusk and night).
  const u = G.uplight;
  let prevIdx = -1;
  for (let i = 0; i < S; i++) {
    const o = K * i;
    const inside = !outside(st[o], st[o + 1]);
    if (inside) {
      prevIdx = -1;
      continue;
    }
    const z = st[o + 2] - st[o + 5] - 0.06;
    const a = u.v(st[o] + vx * 0.5, st[o + 1] + vy * 0.5, z, 0, 0, -1, 0, 0, 1);
    u.v(st[o] - vx * 0.5, st[o + 1] - vy * 0.5, z, 0, 0, -1, 0, 0, 1);
    if (prevIdx >= 0) u.quad(prevIdx, a, a + 1, prevIdx + 1);
    prevIdx = a;
  }
  return Math.max(...[0].concat(Array.from({ length: S }, (_, i) => st[K * i + 2] + st[K * i + 4])));
}

/* ---------------------------------------------------------------------------
 * Podium: curved glazed base, white sweeping canopy, roof garden
 * ------------------------------------------------------------------------- */

function buildPodium(model, G, foliage, palms) {
  const pod = model.podium;
  const p = pod.outline2D;
  const n = p.length / 2;
  const nr = ringNormals(p);
  const storey = pod.height / pod.floors;
  const rnd = seeded(2718);
  let cx = 0;
  let cy = 0;
  for (let j = 0; j < n; j++) {
    cx += p[2 * j] / n;
    cy += p[2 * j + 1] / n;
  }
  // arc length per vertex for the podium glass u coordinate
  const arc = [0];
  for (let j = 1; j <= n; j++) {
    const a = j - 1;
    const b = j % n;
    arc.push(arc[a] + Math.hypot(p[2 * b] - p[2 * a], p[2 * b + 1] - p[2 * a + 1]));
  }
  const alu = G.alu;
  const pg = G.podiumGlass;
  const band = (z0, z1, out, withSoffit, withTop, innerFace, aoTop = 1) => {
    const base = alu.count;
    for (let j = 0; j < n; j++) {
      const x = p[2 * j];
      const y = p[2 * j + 1];
      const nx = nr[2 * j];
      const ny = nr[2 * j + 1];
      const o = typeof out === 'function' ? out(j) : out;
      const X = x + nx * o;
      const Y = y + ny * o;
      alu.v(x, y, z0, 0, 0, -1, 0, 0, 0.45);
      alu.v(X, Y, z0, 0, 0, -1, 0, 0, 0.7);
      alu.v(X, Y, z0, nx, ny, 0, 0, 0, 0.85);
      alu.v(X, Y, z1, nx, ny, 0, 0, 0, aoTop);
      alu.v(X, Y, z1, 0, 0, 1, 0, 0, 1);
      alu.v(x, y, z1, 0, 0, 1, 0, 0, 0.8);
      alu.v(x, y, z1, -nx, -ny, 0, 0, 0, 0.9);
      alu.v(x, y, z0, -nx, -ny, 0, 0, 0, 0.6);
    }
    for (let j = 0; j < n; j++) {
      const a = base + j * 8;
      const b = base + ((j + 1) % n) * 8;
      if (withSoffit) alu.quad(a, b, b + 1, a + 1);
      alu.quad(a + 2, b + 2, b + 3, a + 3);
      if (withTop) alu.quad(a + 4, b + 4, b + 5, a + 5);
      if (innerFace) alu.quad(a + 6, b + 6, b + 7, a + 7);
    }
  };

  for (let s = 0; s < pod.floors; s++) {
    const z0 = s * storey;
    const zE = z0 + 0.6;
    const z1 = z0 + storey;
    band(z0, zE, 0.3, s > 0, true, false);
    const base = pg.count;
    for (let j = 0; j <= n; j++) {
      const jj = j % n;
      const u = arc[j] / RM.PODIUM_BAY / RM.TEX_CELLS;
      pg.v(p[2 * jj], p[2 * jj + 1], zE, nr[2 * jj], nr[2 * jj + 1], 0, u, zE / PODIUM_FLOOR_HEIGHT / RM.TEX_CELLS, 0.9);
      pg.v(p[2 * jj], p[2 * jj + 1], z1, nr[2 * jj], nr[2 * jj + 1], 0, u, z1 / PODIUM_FLOOR_HEIGHT / RM.TEX_CELLS, 0.72);
    }
    for (let j = 0; j < n; j++) pg.quad(base + 2 * j, base + 2 * j + 2, base + 2 * j + 3, base + 2 * j + 1);
  }

  // Sweeping canopy over the ground floor: its reach swings between 2.8 and
  // 5.0 m around the base (two full waves), so the white band reads as one
  // continuous sweep rather than a constant offset.
  const canopyOut = (j) => {
    const th = Math.atan2(p[2 * j + 1] - cy, p[2 * j] - cx);
    return 2.8 + 2.2 * (0.5 + 0.5 * Math.sin(2 * th + 0.7));
  };
  band(storey - 0.45, storey + 0.45, canopyOut, true, true, false);
  // Parapet at the podium roof.
  band(pod.height, pod.height + 1.1, 0.3, false, true, true);

  // Roof deck
  const c = G.concrete;
  const zr = pod.height + 0.05;
  const ce = c.v(cx, cy, zr, 0, 0, 1, 0, 0, 0.95);
  const rb = c.count;
  for (let j = 0; j < n; j++) c.v(p[2 * j], p[2 * j + 1], zr, 0, 0, 1, 0, 0, 0.75);
  for (let j = 0; j < n; j++) c.tri(ce, rb + j, rb + ((j + 1) % n));

  // Roof garden: a planted edge and palms scattered clear of the towers.
  const towerPlates = model.towers.map((T) => {
    let f = 0;
    while (f < T.floors.length - 1 && T.floors[f].z < pod.height) f++;
    return T.floors[f].points2D;
  });
  const clear = (x, y, m) =>
    pointInPolygon(p, x, y) &&
    !towerPlates.some((q) => pointInPolygon(q, x, y) || pointInPolygon(q, x + m, y) || pointInPolygon(q, x - m, y) || pointInPolygon(q, x, y + m) || pointInPolygon(q, x, y - m));
  for (let j = 0; j < n; j++) {
    const a = j;
    const b = (j + 1) % n;
    const L = Math.hypot(p[2 * b] - p[2 * a], p[2 * b + 1] - p[2 * a + 1]);
    for (let t = 0; t < L; t += 3.2) {
      const s = t / L;
      const x = lerp(p[2 * a], p[2 * b], s) - nr[2 * a] * 2.2;
      const y = lerp(p[2 * a + 1], p[2 * b + 1], s) - nr[2 * a + 1] * 2.2;
      if (clear(x, y, 1.5)) foliage.push({ x, y, z: zr, s: 0.8 + rnd() * 0.5, rot: rnd() * 6.28, tone: Math.floor(rnd() * 4) });
    }
  }
  const b = model.bounds;
  for (let x = b.minX; x < b.maxX; x += 13) {
    for (let y = b.minY; y < b.maxY; y += 13) {
      const px = x + (rnd() - 0.5) * 8;
      const py = y + (rnd() - 0.5) * 8;
      if (clear(px, py, 4)) {
        palms.push({ x: px, y: py, z: zr, s: 5 + rnd() * 2.5, rot: rnd() * 6.28 });
        foliage.push({ x: px + 1.2, y: py + 0.8, z: zr, s: 0.9 + rnd() * 0.5, rot: rnd() * 6.28, tone: Math.floor(rnd() * 4) });
      }
    }
  }
}

/* ---------------------------------------------------------------------------
 * Entry
 * ------------------------------------------------------------------------- */

export function buildRealisticMeshes(model) {
  const G = {
    glass: new Geo(),
    podiumGlass: new Geo(),
    alu: new Geo(),
    concrete: new Geo(),
    helipad: new Geo(),
    uplight: new Geo(),
  };
  const foliage = [];
  const palms = [];
  let maxZ = model.bounds.maxZ;
  // The helipad goes on the tallest tower (tower A by construction).
  let tallest = 0;
  model.towers.forEach((T, i) => {
    if (T.floors.length > model.towers[tallest].floors.length) tallest = i;
  });
  model.towers.forEach((T, i) => {
    maxZ = Math.max(maxZ, buildTower(T, model, G, foliage, palms, i === tallest));
  });
  for (const br of model.bridges) maxZ = Math.max(maxZ, buildBridge(br, model, G, foliage, palms));
  buildPodium(model, G, foliage, palms);

  const b = model.bounds;
  const out = { foliage, palms, maxZ, box: { minX: b.minX - 6, maxX: b.maxX + 6, minY: b.minY - 6, maxY: b.maxY + 6, minZ: 0, maxZ } };
  for (const [k, g] of Object.entries(G)) out[k] = g.build();
  return out;
}

/* ---------------------------------------------------------------------------
 * Planting props (unit size, base at z = 0, data space). Vertex colours carry
 * the tone and a baked top-to-bottom occlusion; instances multiply a tint.
 * ------------------------------------------------------------------------- */

function paint(g, fn) {
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) col.set(fn(p.getX(i), p.getY(i), p.getZ(i)), 3 * i);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function merge(geoms) {
  const parts = geoms.map((g) => (g.index ? g.toNonIndexed() : g));
  const total = parts.reduce((s, g) => s + g.attributes.position.count, 0);
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'color']) {
    if (!parts.every((g) => g.attributes[name])) continue;
    const arr = new Float32Array(total * 3);
    let o = 0;
    for (const g of parts) {
      arr.set(g.attributes[name].array, o);
      o += g.attributes[name].array.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, 3));
  }
  parts.forEach((g) => g.dispose());
  geoms.forEach((g) => g.dispose());
  return out;
}

/**
 * Foliage blob cluster: four merged low-poly icosahedra, ~1.2 m across. AO is
 * baked by height: darker at the base where the blobs meet the planter.
 */
export function foliageGeometry() {
  const blobs = [
    [0, 0, 0.42, 0.5],
    [0.38, 0.12, 0.3, 0.36],
    [-0.3, 0.22, 0.34, 0.38],
    [0.05, -0.34, 0.3, 0.34],
  ].map(([x, y, z, r]) => {
    const g = new THREE.IcosahedronGeometry(r, 0);
    g.scale(1, 1, 0.85);
    g.translate(x, y, z);
    return g;
  });
  const g = merge(blobs);
  g.computeVertexNormals();
  return paint(g, (x, y, z) => {
    const k = 0.5 + 0.5 * Math.min(1, Math.max(0, z / 0.8));
    return [0.32 * k, 0.5 * k, 0.24 * k];
  });
}

/** Palm, 1 m tall: a slightly leaning trunk and seven drooping fronds. */
export function palmGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.022, 0.035, 0.92, 6, 4, true);
  trunk.rotateX(Math.PI / 2);
  trunk.translate(0, 0, 0.46);
  const tp = trunk.attributes.position;
  for (let i = 0; i < tp.count; i++) tp.setX(i, tp.getX(i) + 0.06 * Math.pow(tp.getZ(i), 2));
  paint(trunk, (x, y, z) => [0.36 + 0.1 * z, 0.29 + 0.08 * z, 0.21 + 0.05 * z]);
  parts.push(trunk);
  const pos = [];
  const fronds = 7;
  const segs = 4;
  const topX = 0.06;
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const px = -dy;
    const py = dx;
    const pts = [];
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const r = 0.42 * t;
      const z = 0.93 + 0.12 * t - 0.3 * t * t;
      const w = 0.085 * Math.sin(Math.PI * Math.min(1, t * 1.15 + 0.08));
      pts.push([topX + dx * r, dy * r, z, w]);
    }
    for (let s = 0; s < segs; s++) {
      const [x0, y0, z0, w0] = pts[s];
      const [x1, y1, z1, w1] = pts[s + 1];
      const A = [x0 - px * w0, y0 - py * w0, z0];
      const B = [x0 + px * w0, y0 + py * w0, z0];
      const C = [x1 + px * w1, y1 + py * w1, z1];
      const D = [x1 - px * w1, y1 - py * w1, z1];
      pos.push(...A, ...B, ...C, ...A, ...C, ...D);
    }
  }
  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  fg.computeVertexNormals();
  paint(fg, (x, y, z) => {
    const k = 0.55 + 0.45 * Math.min(1, Math.max(0, (z - 0.65) / 0.4));
    return [0.26 * k, 0.46 * k, 0.18 * k];
  });
  parts.push(fg);
  return merge(parts);
}

/**
 * Street tree, scaled by (r, r, h): trunk plus a three-blob canopy.
 * `detail` 1 (≈200 triangles) for trees near the site, 0 (≈70) for the
 * thousands further out.
 */
export function streetTreeGeometry(detail = 0) {
  const trunk = new THREE.CylinderGeometry(0.06, 0.09, 0.5, detail ? 7 : 5, 1, true);
  trunk.rotateX(Math.PI / 2);
  trunk.translate(0, 0, 0.25);
  paint(trunk, () => [0.3, 0.24, 0.18]);
  const canopy = [
    [0, 0, 0.66, 0.82],
    [0.45, 0.2, 0.58, 0.55],
    [-0.38, -0.3, 0.6, 0.58],
  ].map(([x, y, z, r]) => {
    const g = new THREE.IcosahedronGeometry(r, detail);
    g.scale(1, 1, 0.55);
    g.translate(x, y, z);
    return g;
  });
  const cg = merge(canopy);
  cg.computeVertexNormals();
  paint(cg, (x, y, z) => {
    const k = 0.5 + 0.5 * Math.min(1, Math.max(0, (z - 0.35) / 0.6));
    return [0.3 * k, 0.45 * k, 0.22 * k];
  });
  return merge([trunk, cg]);
}
