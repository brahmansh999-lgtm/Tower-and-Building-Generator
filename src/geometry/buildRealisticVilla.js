/**
 * buildRealisticVilla.js
 *
 * Geometry for the villa studio's REALISTIC mode, derived only from the
 * object generateVilla() returns (level outlines and courtyard holes, roof and
 * canopy waves, rooms, walls, furniture, stair, pool, deck, drive). It follows
 * the same section as the stylized villa view (buildVillaGeometry), so both
 * modes show the same building, but splits it by material:
 *
 *   white     GRC ribbons: rounded soffit noses, slab bands, roof, canopy, columns
 *   glass     recessed full-height glazing (window texture, lit rooms at night)
 *   interior  partition walls and furniture, vertex-coloured by type
 *   timber    interior floors and the pool deck
 *   lawn      the plot      drive   the driveway      water   the pool surface
 *   stone     pool coping, boundary walls, garden loungers
 *
 * Pure, data space (x east, y north, z up), one merged geometry per material.
 * Vertex colours carry baked ambient occlusion (soffits and glass heads
 * darker, as in the tower builder) and, for the interior, the furniture tone.
 *
 * Output: { glass, white, interior, timber, lawn, drive, water, stone,
 *           foliage: [...], palms: [...], box, maxZ }
 */

import * as THREE from 'three';
import { Geo, ringNormals, seeded, RM } from './buildRealisticMeshes.js';
import { VILLA_SLAB, VILLA_FLOOR_HEIGHTS, VILLA_FURN_H, offsetFlat, waveAt } from './generateVilla.js';
import { pointInPolygon } from './generateTower.js';

const Z = (z, x, y) => (typeof z === 'function' ? z(x, y) : z);

/**
 * Band between two closed rings with the same vertex count (an offset pair of
 * one contour). Normals are horizontal, from the first ring's tangent: out of
 * the building for a CCW outline, into the courtyard for a CW hole.
 *
 * With `row` set the band is glazing: the seam vertex is duplicated and
 *   u = arc length / BAY / TEX_CELLS          (a mullion every 1.6 m)
 *   v = (row + 0.1 + 0.9·t) / TEX_CELLS       t = 0 at the sill, 1 at the head
 * so each level's glazing fills exactly one storey row of the window texture
 * above its spandrel strip, whatever the level height or the roof wave.
 */
function band(G, ra, za, rb, zb, aoA, aoB, row = null) {
  const n = ra.length / 2;
  const N = ringNormals(ra);
  const base = G.count;
  const glazing = row !== null;
  let arc = 0;
  const count = glazing ? n + 1 : n;
  for (let j = 0; j < count; j++) {
    const jj = j % n;
    if (glazing && j > 0) {
      const p = (j - 1) % n;
      arc += Math.hypot(ra[2 * jj] - ra[2 * p], ra[2 * jj + 1] - ra[2 * p + 1]);
    }
    const nx = N[2 * jj];
    const ny = N[2 * jj + 1];
    const xa = ra[2 * jj];
    const ya = ra[2 * jj + 1];
    const xb = rb[2 * jj];
    const yb = rb[2 * jj + 1];
    const u = glazing ? arc / RM.BAY / RM.TEX_CELLS : 0;
    G.v(xa, ya, Z(za, xa, ya), nx, ny, 0, u, glazing ? (row + 0.1) / RM.TEX_CELLS : 0, aoA);
    G.v(xb, yb, Z(zb, xb, yb), nx, ny, 0, u, glazing ? (row + 1) / RM.TEX_CELLS : 0, aoB);
  }
  for (let j = 0; j < n; j++) {
    const a = base + 2 * j;
    const b = glazing ? base + 2 * (j + 1) : base + 2 * ((j + 1) % n);
    G.quad(a, b, b + 1, a + 1);
  }
}

/** Horizontal cap with holes (earcut), at height z (number or fn(x, y)). */
function cap(G, outline, holes, z, up, ao) {
  const toV = (f) => {
    const v = [];
    for (let i = 0; i < f.length; i += 2) v.push(new THREE.Vector2(f[i], f[i + 1]));
    return v;
  };
  const contour = toV(outline);
  const hs = holes.filter(Boolean).map(toV);
  const faces = THREE.ShapeUtils.triangulateShape(contour, hs);
  const all = contour.concat(...hs);
  const base = G.count;
  for (const v of all) G.v(v.x, v.y, Z(z, v.x, v.y), 0, 0, up ? 1 : -1, 0, 0, ao);
  for (const f of faces) G.tri(base + f[0], base + f[1], base + f[2]);
}

/**
 * Oriented box (centre x, y; base z0; w × d × h; rotation about z). `col` is a
 * grey AO value or an [r, g, b] tone; vertical faces darken toward the floor.
 */
function box(G, x, y, z0, w, d, h, rot, col) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const P = (u, v) => [x + u * c - v * s, y + u * s + v * c];
  const hw = w / 2;
  const hd = d / 2;
  const k = Array.isArray(col) ? col : [col, col, col];
  const put = (px, py, pz, nx, ny, nz, ao) => G.vc(px, py, pz, nx, ny, nz, k[0] * ao, k[1] * ao, k[2] * ao);
  const corners = [P(-hw, -hd), P(hw, -hd), P(hw, hd), P(-hw, hd)];
  for (let q = 0; q < 4; q++) {
    const [ax, ay] = corners[q];
    const [bx, by] = corners[(q + 1) % 4];
    const l = Math.hypot(bx - ax, by - ay) || 1;
    const nx = (by - ay) / l;
    const ny = -(bx - ax) / l;
    const i0 = put(ax, ay, z0, nx, ny, 0, 0.7);
    put(bx, by, z0, nx, ny, 0, 0.7);
    put(bx, by, z0 + h, nx, ny, 0, 1);
    put(ax, ay, z0 + h, nx, ny, 0, 1);
    G.quad(i0, i0 + 1, i0 + 2, i0 + 3);
  }
  const t = corners.map(([px, py]) => put(px, py, z0 + h, 0, 0, 1, 1));
  G.quad(t[0], t[1], t[2], t[3]);
}

function circleRing(x, y, r, n = 14) {
  const f = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    f[2 * i] = x + Math.cos(a) * r;
    f[2 * i + 1] = y + Math.sin(a) * r;
  }
  return f;
}

/** Furniture tones (linear RGB) by type. */
const TONE = {
  soft: [0.42, 0.45, 0.5],
  bed: [0.82, 0.8, 0.76],
  wood: [0.36, 0.23, 0.14],
  white: [0.9, 0.9, 0.88],
  car: [0.12, 0.13, 0.16],
  plant: [0.18, 0.36, 0.14],
  rug: [0.55, 0.47, 0.38],
  steel: [0.62, 0.63, 0.65],
};
const toneOf = (type) =>
  ({
    sofa: TONE.soft,
    armchair: TONE.soft,
    bed: TONE.bed,
    bathroom: TONE.white,
    vanity: TONE.white,
    wc: TONE.white,
    tub: TONE.white,
    shower: TONE.white,
    car: TONE.car,
    plant: TONE.plant,
    rug: TONE.rug,
    appliance: TONE.steel,
  })[type] || TONE.wood;

/* ---------------------------------------------------------------------------
 * Shell: the same section as the stylized villa, per level and per contour
 *   upper levels: rounded white soffit ribbon under the floor (cantilever)
 *   glazing recessed 0.35 m, from the floor to the underside of the top ribbon
 *   white top ribbon with a rounded nose, then the roof
 * The top level's ribbon, glazing head and roof follow the roof wave.
 * ------------------------------------------------------------------------- */

function buildShell(G, villa) {
  const nLevels = villa.levels.length;
  const rowBase = (villa.option.id * 5) % (RM.TEX_CELLS - 2);
  villa.levels.forEach((L, i) => {
    const z0 = L.z;
    const z1 = L.z + L.height;
    const isTop = i === nLevels - 1;
    const w = (x, y) => (isTop ? waveAt(villa.roof?.wave, x, y) : 0);
    const at = (z) => (x, y) => z + w(x, y);
    for (const C of [L.outline, L.hole].filter(Boolean)) {
      const off = (d) => offsetFlat(C, d);
      if (i > 0) {
        band(G.white, off(-0.2), z0 - 0.45, off(0), z0 - 0.3, 0.5, 0.75);
        band(G.white, off(0), z0 - 0.3, off(0), z0 + 0.15, 0.8, 1);
        band(G.white, off(0), z0 + 0.15, off(-0.15), z0 + 0.3, 1, 0.85);
      }
      band(G.glass, off(-0.35), i > 0 ? z0 + 0.3 : z0, off(-0.35), at(z1 - VILLA_SLAB), 0.92, 0.7, rowBase + i);
      band(G.white, off(-0.15), at(z1 - VILLA_SLAB), off(0.05), at(z1 - VILLA_SLAB + 0.15), 0.55, 0.8);
      band(G.white, off(0.05), at(z1 - VILLA_SLAB + 0.15), off(0.05), at(z1 - 0.15), 0.85, 1);
      band(G.white, off(0.05), at(z1 - 0.15), off(-0.15), at(z1), 1, 1);
    }
    const hole = L.hole ? offsetFlat(L.hole, -0.15) : null;
    cap(G.white, offsetFlat(L.outline, -0.15), [hole], at(z1), true, 0.95);
    if (i > 0) cap(G.white, offsetFlat(L.outline, -0.2), [L.hole && offsetFlat(L.hole, -0.2)], z0 - 0.45, false, 0.6);
    // interior floor finish (seen through the glass and when cut)
    cap(G.timber, offsetFlat(L.outline, -0.35), [L.hole && offsetFlat(L.hole, -0.35)], z0 + (i > 0 ? 0.31 : 0.02), true, 0.8);
  });

  if (villa.canopy) {
    const c = villa.canopy;
    const zb = (x, y) => c.z + waveAt(c.wave, x, y);
    const zt = (x, y) => zb(x, y) + c.thickness;
    cap(G.white, c.outline, [], zb, false, 0.6);
    cap(G.white, c.outline, [], zt, true, 1);
    band(G.white, offsetFlat(c.outline, -0.1), zb, offsetFlat(c.outline, 0.05), (x, y) => zb(x, y) + c.thickness / 2, 0.6, 0.9);
    band(G.white, offsetFlat(c.outline, 0.05), (x, y) => zb(x, y) + c.thickness / 2, offsetFlat(c.outline, -0.1), zt, 0.9, 1);
    // tree-like tapered columns
    for (const [x, y] of c.columns) {
      const top = zb(x, y);
      band(G.white, circleRing(x, y, 0.22), 0, circleRing(x, y, 0.3), top * 0.6, 0.65, 0.85);
      band(G.white, circleRing(x, y, 0.3), top * 0.6, circleRing(x, y, 0.9), top, 0.85, 0.7);
    }
  }
}

/** Interior: partition walls, furniture, stair (seen through the glass and when cut). */
function buildInterior(G, villa) {
  villa.levels.forEach((L, i) => {
    const floor = L.z + (i > 0 ? 0.31 : 0.02);
    const wallH = L.height - VILLA_SLAB - (i > 0 ? 0.31 : 0.02);
    for (let k = 0; k < L.walls.length; k += 4) {
      const [x0, y0, x1, y1] = [L.walls[k], L.walls[k + 1], L.walls[k + 2], L.walls[k + 3]];
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len < 0.05) continue;
      box(G.interior, (x0 + x1) / 2, (y0 + y1) / 2, floor, len, 0.14, wallH, Math.atan2(y1 - y0, x1 - x0), [0.86, 0.85, 0.82]);
    }
    for (const f of L.furniture) box(G.interior, f.x, f.y, floor, f.w, f.d, VILLA_FURN_H[f.type] || 0.6, f.rot, toneOf(f.type));
  });
  const s = villa.stair;
  const rise = VILLA_FLOOR_HEIGHTS[0];
  const steps = 16;
  if (s.type === 'spiral') {
    for (let k = 0; k < steps; k++) {
      const a = s.rot + (k / steps) * Math.PI * 1.75;
      const r = s.w / 4 + 0.1;
      box(G.interior, s.x + Math.cos(a) * r, s.y + Math.sin(a) * r, (k * rise) / steps, s.w / 2 - 0.15, 0.42, 0.18, a, TONE.white);
    }
    band(G.white, circleRing(s.x, s.y, 0.16, 10), 0, circleRing(s.x, s.y, 0.16, 10), rise + 1, 0.8, 1);
  } else {
    const c = Math.cos(s.rot);
    const sn = Math.sin(s.rot);
    for (let k = 0; k < steps; k++) {
      const v = -s.d / 2 + (s.d * (k + 0.5)) / steps;
      box(G.interior, s.x - v * sn, s.y + v * c, (k * rise) / steps, s.w, s.d / steps + 0.02, 0.2, s.rot, TONE.white);
    }
  }
}

/** Site: lawn, drive, deck, pool (water, coping), loungers, boundary walls. */
function buildSite(G, villa) {
  const { plot } = villa;
  cap(G.lawn, plot.outline2D, [], 0.004, true, 1);
  cap(G.drive, villa.drive, [], 0.012, true, 1);
  if (villa.deck) cap(G.timber, villa.deck, [], 0.03, true, 0.95);
  if (villa.pool) {
    const P = villa.pool;
    cap(G.water, P, [], 0.045, true, 1);
    const outer = offsetFlat(P, 0.5);
    const inner = new Float32Array(P.length);
    for (let i = 0; i < P.length; i += 2) {
      inner[P.length - 2 - i] = P[i];
      inner[P.length - 1 - i] = P[i + 1];
    }
    cap(G.stone, outer, [inner], 0.06, true, 1);
    band(G.stone, outer, 0, outer, 0.06, 0.8, 1);
  }
  for (const f of villa.outdoor) box(G.stone, f.x, f.y, 0.03, f.w, f.d, VILLA_FURN_H[f.type] || 0.4, f.rot, [0.95, 0.94, 0.92]);

  // Boundary walls (1.2 m), opening for the drive on the south edge.
  const hw = plot.w / 2;
  const hd = plot.d / 2;
  const t = 0.25;
  const H = 1.2;
  const wall = [0.82, 0.8, 0.76];
  box(G.stone, 0, hd, 0, plot.w, t, H, 0, wall);
  box(G.stone, -hw, 0, 0, t, plot.d, H, 0, wall);
  box(G.stone, hw, 0, 0, t, plot.d, H, 0, wall);
  let dx0 = Infinity;
  let dx1 = -Infinity;
  for (let i = 0; i < villa.drive.length; i += 2) {
    dx0 = Math.min(dx0, villa.drive[i]);
    dx1 = Math.max(dx1, villa.drive[i]);
  }
  const westLen = dx0 - 1 + hw;
  const eastLen = hw - (dx1 + 1);
  if (westLen > 0) box(G.stone, -hw + westLen / 2, -hd, 0, westLen, t, H, 0, wall);
  if (eastLen > 0) box(G.stone, hw - eastLen / 2, -hd, 0, eastLen, t, H, 0, wall);
}

/**
 * Planting, seeded by the option so it stays put while the GFA slider moves:
 *   planters  a blob every 2.6 m along the ground-floor outline, 1.4 m out
 *   palms     up to four round the pool, 2.4 m beyond the coping, ≥ 6 m apart
 * Both skip the pool, deck, drive, the house itself and the plot edge.
 */
function buildPlanting(villa) {
  const rnd = seeded(5003 + villa.option.id * 131);
  const { plot } = villa;
  const foliage = [];
  const palms = [];
  const L0 = villa.levels[0];
  const grown = (p, d) => (p ? offsetFlat(p, d) : null);
  const blockers = [grown(villa.pool, 1), grown(villa.deck, 0.5), villa.drive && offsetFlat(villa.drive, 1.2)].filter(Boolean);
  // The house is its outline grown 0.4 m minus its courtyard shrunk 0.4 m
  // (offsetFlat on a clockwise hole moves into the hole for d > 0).
  const houseOuter = offsetFlat(L0.outline, 0.4);
  const courtyard = L0.hole ? offsetFlat(L0.hole, 0.4) : null;
  const inHouse = (x, y) => pointInPolygon(houseOuter, x, y) && !(courtyard && pointInPolygon(courtyard, x, y));
  const clear = (x, y) => Math.abs(x) < plot.w / 2 - 1.2 && Math.abs(y) < plot.d / 2 - 1.2 && !inHouse(x, y) && !blockers.some((q) => pointInPolygon(q, x, y));
  for (const C of [L0.outline, L0.hole].filter(Boolean)) {
    const N = ringNormals(C);
    const n = C.length / 2;
    let acc = 0;
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n;
      acc += Math.hypot(C[2 * k] - C[2 * j], C[2 * k + 1] - C[2 * j + 1]);
      if (acc < 2.6) continue;
      acc = 0;
      const x = C[2 * j] + N[2 * j] * 1.4;
      const y = C[2 * j + 1] + N[2 * j + 1] * 1.4;
      if (clear(x, y)) foliage.push({ x, y, z: 0, s: 0.7 + rnd() * 0.5, rot: rnd() * 6.28, tone: Math.floor(rnd() * 4) });
    }
  }
  if (villa.pool) {
    const P = villa.pool;
    const N = ringNormals(P);
    const n = P.length / 2;
    const step = Math.max(1, Math.floor(n / 9));
    for (let j = 0; j < n && palms.length < 4; j += step) {
      const x = P[2 * j] + N[2 * j] * 2.4;
      const y = P[2 * j + 1] + N[2 * j + 1] * 2.4;
      if (!clear(x, y)) continue;
      if (palms.some((p) => Math.hypot(p.x - x, p.y - y) < 6)) continue;
      palms.push({ x, y, z: 0, s: 5 + rnd() * 1.6, rot: rnd() * 6.28 });
      foliage.push({ x: x + 0.9, y: y - 0.6, z: 0, s: 0.8, rot: rnd() * 6.28, tone: Math.floor(rnd() * 4) });
    }
  }
  return { foliage, palms };
}

export function buildRealisticVilla(villa) {
  const G = {
    glass: new Geo(),
    white: new Geo(),
    interior: new Geo(),
    timber: new Geo(),
    lawn: new Geo(),
    drive: new Geo(),
    water: new Geo(),
    stone: new Geo(),
  };
  buildShell(G, villa);
  buildInterior(G, villa);
  buildSite(G, villa);
  const { foliage, palms } = buildPlanting(villa);
  const { plot } = villa;
  const maxZ = villa.stats.height;
  const out = {
    foliage,
    palms,
    maxZ,
    box: { minX: -plot.w / 2 - 2, maxX: plot.w / 2 + 2, minY: -plot.d / 2 - 2, maxY: plot.d / 2 + 2, minZ: 0, maxZ },
  };
  for (const [k, g] of Object.entries(G)) out[k] = g.build();
  return out;
}
