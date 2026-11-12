/**
 * buildVRMeshes.js
 *
 * Turns the generateTower() data object into the geometry the VR mode draws.
 * Pure: it reads the model and returns new BufferGeometries; it never creates
 * materials, touches a scene or derives form on its own. Everything here is a
 * re-drawing of points the generator already produced.
 *
 * Why VR needs its own geometry: WebXR ignores `linewidth`, so 1 px lines
 * shimmer and vanish in stereo. Every "line" of the desktop drawing becomes a
 * real surface with a physical width:
 *   - floor bands → flat vertical ribbons following each plate outline
 *   - fins        → thin T-section strips (outer face + web) up the facade
 *   - bridges     → TubeGeometry rails along the swept edges of each link
 *   - glow        → a second, wider copy of fins and rails drawn additively
 *
 * All widths are multiplied by `lineScale` (1 at human scale). At tabletop
 * scale the caller passes a larger factor so a band still covers ~1 mm of real
 * space in the headset instead of a sub-pixel 0.16 mm.
 *
 * Reveal tables: every geometry is assembled from "pieces" (one storey, one fin
 * row, one bridge station…) that carry a key — height in metres for towers, or
 * 0..1 along the span for bridges. The index buffer is written in key order and
 * geometry.userData.reveal = { keys, counts } records the cumulative index count
 * after each key, so the intro animation can draw the tower up to any height
 * with a single setDrawRange() and no per-frame geometry work.
 *
 * Data space as generateTower: x east, y north, z up, metres.
 */

import * as THREE from 'three';
import { FLOOR_HEIGHT, BRIDGE_STATION_STRIDE, PARAPET, CORE_OVERRUN } from './generateTower.js';

const lin = (c) => c.map((v) => Math.pow(v, 2.2));

/** Linear vertex colours (display-space values converted once). */
export const VR_COLORS = {
  shellDark: lin([0.03, 0.035, 0.045]),
  shellLit: lin([0.1, 0.115, 0.14]),
  slab: lin([0.13, 0.135, 0.14]),
  core: lin([0.28, 0.27, 0.26]),
  roof: lin([0.06, 0.06, 0.065]),
  band: lin([0.88, 0.9, 0.92]),
  bandMep: lin([0.5, 0.56, 0.62]),
  fin: lin([0.6, 0.63, 0.68]),
  finWeb: lin([0.3, 0.32, 0.36]),
  finGlow: lin([0.45, 0.78, 1.0]),
  bridgeDark: lin([0.035, 0.04, 0.05]),
  bridgeLit: lin([0.12, 0.13, 0.15]),
  rail: lin([1.0, 0.85, 0.62]),
  railGlow: lin([1.0, 0.6, 0.18]),
  podiumDark: lin([0.04, 0.04, 0.045]),
  podiumLit: lin([0.12, 0.12, 0.125]),
  cyan: lin([0.31, 0.89, 1.0]),
  cyanGlow: lin([0.12, 0.45, 0.6]),
};

// Base widths at 1:1 (metres), scaled by lineScale.
const BAND_W = 0.08;
const BAND_OUT = 0.03; //  ribbon stand-off from the facade (avoids z-fighting)
const FIN_W = 0.12;
const FIN_GLOW_W = 0.36;
const RAIL_R = 0.06;
const RAIL_GLOW_R = 0.22;
const BRIDGE_RING = 12;
const BRIDGE_STEP = 2; //  use every 2nd station for bridge bodies and rails (24 segments a span)

// Sun direction (toward the light) for the faint facade shading: from the south, up.
const SUN = new THREE.Vector3(0.15, -0.85, 0.5).normalize();
const shade = (nx, ny, nz) => Math.min(1, Math.max(0, nx * SUN.x + ny * SUN.y + nz * SUN.z) * 0.85 + 0.15);
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

/* ---------------------------------------------------------------------------
 * Piece builder: append vertices freely, group triangles into keyed pieces,
 * then emit one indexed geometry whose index runs in ascending key order.
 * ------------------------------------------------------------------------- */
function makeBuilder(withUV = false) {
  const pos = [];
  const col = [];
  const uv = [];
  const pieces = [];
  let cur = null;
  return {
    /** Index the next vertex will get. */
    next() {
      return pos.length / 3;
    },
    v(x, y, z, c, u = 0, w = 0) {
      pos.push(x, y, z);
      col.push(c[0], c[1], c[2]);
      if (withUV) uv.push(u, w);
      return pos.length / 3 - 1;
    },
    begin(key) {
      cur = { key, idx: [] };
      pieces.push(cur);
    },
    tri(a, b, c) {
      cur.idx.push(a, b, c);
    },
    quad(a, b, c, d) {
      cur.idx.push(a, b, c, a, c, d);
    },
    finish() {
      pieces.sort((p, q) => p.key - q.key); // stable: ties keep build order
      let total = 0;
      for (const p of pieces) total += p.idx.length;
      const index = new Uint32Array(total);
      const keys = new Float32Array(pieces.length);
      const counts = new Uint32Array(pieces.length);
      let o = 0;
      pieces.forEach((p, i) => {
        index.set(p.idx, o);
        o += p.idx.length;
        keys[i] = p.key;
        counts[i] = o;
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      if (withUV) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(new THREE.BufferAttribute(index, 1));
      g.userData.reveal = { keys, counts };
      g.computeBoundingSphere();
      return g;
    },
  };
}

/** Index count to draw so every piece with key ≤ threshold is visible. */
export function revealCount(reveal, threshold) {
  const { keys, counts } = reveal;
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] <= threshold) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? 0 : counts[lo - 1];
}

/**
 * Outward unit normals of a closed CCW ring [x0,y0,x1,y1,…], from the central
 * difference tangent t = p[j+1] − p[j−1]: outward = (t.y, −t.x) / |t|.
 */
function ringNormals(p) {
  const M = p.length / 2;
  const n = new Float32Array(M * 2);
  for (let j = 0; j < M; j++) {
    const jp = (j + 1) % M;
    const jm = (j + M - 1) % M;
    const tx = p[2 * jp] - p[2 * jm];
    const ty = p[2 * jp + 1] - p[2 * jm + 1];
    const l = Math.hypot(tx, ty) || 1;
    n[2 * j] = ty / l;
    n[2 * j + 1] = -tx / l;
  }
  return n;
}

/**
 * Ribbon generation. A flat vertical strip of height `h` that follows a plate
 * outline at height z, pushed `off` metres out along each vertex normal so it
 * sits just proud of the facade surface:
 *
 *     bottom_j = p_j + n_j·off  at z
 *     top_j    = p_j + n_j·off  at z + h
 *
 * Consecutive (bottom_j, bottom_j+1, top_j+1, top_j) form one quad. Because the
 * strip is a surface rather than a GL line, it keeps its physical width in both
 * eyes and never collapses below one pixel at close range.
 */
function ribbonRing(b, p, n, z, off, h, color) {
  const M = p.length / 2;
  const base = b.v(p[0] + n[0] * off, p[1] + n[1] * off, z, color);
  for (let j = 1; j < M; j++) b.v(p[2 * j] + n[2 * j] * off, p[2 * j + 1] + n[2 * j + 1] * off, z, color);
  for (let j = 0; j < M; j++) b.v(p[2 * j] + n[2 * j] * off, p[2 * j + 1] + n[2 * j + 1] * off, z + h, color);
  for (let j = 0; j < M; j++) {
    const j2 = (j + 1) % M;
    b.quad(base + j, base + j2, base + M + j2, base + M + j);
  }
}

/** Lofted wall between two rings (same vertex count) with shaded colours. */
function loftRing(b, pa, za, pb, zb, n, dark, lit) {
  const M = pa.length / 2;
  const base = b.next();
  for (let r = 0; r < 2; r++) {
    const p = r ? pb : pa;
    const z = r ? zb : za;
    for (let j = 0; j < M; j++) b.v(p[2 * j], p[2 * j + 1], z, mix(dark, lit, shade(n[2 * j], n[2 * j + 1], 0)));
  }
  for (let j = 0; j < M; j++) {
    const j2 = (j + 1) % M;
    b.quad(base + j, base + j2, base + M + j2, base + M + j);
  }
}

/** Fan cap over a ring at height z. */
function capRing(b, p, cx, cy, z, color) {
  const M = p.length / 2;
  const c = b.v(cx, cy, z, color);
  for (let j = 0; j < M; j++) b.v(p[2 * j], p[2 * j + 1], z, color);
  for (let j = 0; j < M; j++) b.tri(c, c + 1 + j, c + 1 + ((j + 1) % M));
}

function centroid(p) {
  const M = p.length / 2;
  let x = 0;
  let y = 0;
  for (let j = 0; j < M; j++) {
    x += p[2 * j];
    y += p[2 * j + 1];
  }
  return [x / M, y / M];
}

/* ---------------------------------------------------------------------------
 * Towers + podium
 * ------------------------------------------------------------------------- */

/** Dark occluding body: facade loft, parapet, roof, floor slabs and core. */
function buildShell(model) {
  const b = makeBuilder();
  const C = VR_COLORS;
  for (const T of model.towers) {
    const F = T.floors.length;
    for (let f = 0; f < F; f++) {
      const A = T.floors[f];
      const nA = ringNormals(A.points2D);
      b.begin(A.z);
      if (f < F - 1) {
        const B = T.floors[f + 1];
        loftRing(b, A.points2D, A.z, B.points2D, B.z, nA, C.shellDark, C.shellLit);
        // core box for this storey (seen only when the model is cut)
        const ca = A.core2D;
        const cb = B.core2D;
        for (let q = 0; q < 4; q++) {
          const q2 = (q + 1) % 4;
          const i0 = b.v(ca[2 * q], ca[2 * q + 1], A.z, C.core);
          b.v(ca[2 * q2], ca[2 * q2 + 1], A.z, C.core);
          b.v(cb[2 * q2], cb[2 * q2 + 1], B.z, C.core);
          b.v(cb[2 * q], cb[2 * q + 1], B.z, C.core);
          b.quad(i0, i0 + 1, i0 + 2, i0 + 3);
        }
      }
      if (f > 0) capRing(b, A.points2D, A.cx, A.cy, A.z + 0.25, C.slab);
    }
    // parapet, roof and lift overrun
    const top = T.floors[F - 1];
    const nT = ringNormals(top.points2D);
    b.begin(top.z);
    loftRing(b, top.points2D, top.z, top.points2D, top.z + PARAPET, nT, C.shellDark, C.shellLit);
    capRing(b, top.points2D, top.cx, top.cy, top.z + 0.02, C.roof);
    const c = top.core2D;
    const zO = top.z + PARAPET + CORE_OVERRUN;
    for (let q = 0; q < 4; q++) {
      const q2 = (q + 1) % 4;
      const i0 = b.v(c[2 * q], c[2 * q + 1], top.z, C.core);
      b.v(c[2 * q2], c[2 * q2 + 1], top.z, C.core);
      b.v(c[2 * q2], c[2 * q2 + 1], zO, C.core);
      b.v(c[2 * q], c[2 * q + 1], zO, C.core);
      b.quad(i0, i0 + 1, i0 + 2, i0 + 3);
    }
    const i0 = b.v(c[0], c[1], zO, C.roof);
    b.v(c[2], c[3], zO, C.roof);
    b.v(c[4], c[5], zO, C.roof);
    b.v(c[6], c[7], zO, C.roof);
    b.quad(i0, i0 + 1, i0 + 2, i0 + 3);
  }

  // Podium: one loft per storey so it builds up with the towers, then a roof.
  const P = model.podium;
  const p = P.outline2D;
  const nP = ringNormals(p);
  const storey = P.height / P.floors;
  for (let s = 0; s < P.floors; s++) {
    b.begin(s * storey);
    loftRing(b, p, s * storey, p, (s + 1) * storey, nP, C.podiumDark, C.podiumLit);
  }
  const [cx, cy] = centroid(p);
  b.begin(P.height);
  capRing(b, p, cx, cy, P.height, C.roof);
  return b.finish();
}

/** Floor-band ribbons on every plate, the parapet line and the podium storeys. */
function buildBands(model, ls) {
  const b = makeBuilder();
  const C = VR_COLORS;
  const w = BAND_W * ls;
  const off = BAND_OUT * ls;
  for (const T of model.towers) {
    const F = T.floors.length;
    for (let f = 0; f < F; f++) {
      const P = T.floors[f];
      const n = ringNormals(P.points2D);
      b.begin(P.z);
      // Mechanical floors read as a wider, cooler band (as the louvres do on desktop).
      if (P.mep) ribbonRing(b, P.points2D, n, P.z, off, w * 2.5, C.bandMep);
      else ribbonRing(b, P.points2D, n, P.z, off, w, C.band);
      if (f === F - 1) ribbonRing(b, P.points2D, n, P.z + PARAPET - w, off, w, C.band);
    }
  }
  const P = model.podium;
  const n = ringNormals(P.outline2D);
  const storey = P.height / P.floors;
  for (let s = 0; s <= P.floors; s++) {
    const z = Math.min(s * storey, P.height - w);
    b.begin(z);
    ribbonRing(b, P.outline2D, n, z, off, w * (s === P.floors ? 1.5 : 1), C.band);
  }
  return b.finish();
}

/**
 * Fins as thin T-section strips. For fin k on plate vertex j, at each floor row:
 *   p = facade point,  t = unit tangent,  n = outward normal
 *   outer face: p + n·depth ± t·(w/2)      (faces outward, 12 cm wide)
 *   web:        p  →  p + n·depth          (radial, keeps the fin visible obliquely)
 * Rows are connected floor to floor, so each strip twists and sways with the
 * plates. The glow copy is the outer face only, 3× wider and 2 cm further out.
 */
function buildFins(model, ls) {
  const solid = makeBuilder();
  const glow = makeBuilder();
  const C = VR_COLORS;
  const depth = 0.4 + model.params.width * 0.008; // same fin depth as the desktop blades
  const hw = (FIN_W * ls) / 2;
  const gw = (FIN_GLOW_W * ls) / 2;
  const gOff = depth + 0.02 * ls;
  for (const T of model.towers) {
    const F = T.floors.length;
    const M = T.floors[0].points2D.length / 2;
    const stride = M / T.finCount;
    const rows = F + 1; // every floor plus the parapet top
    for (let k = 0; k < T.finCount; k++) {
      const j = k * stride;
      const jp = (j + 1) % M;
      const jm = (j + M - 1) % M;
      const sBase = [];
      const gBase = [];
      const zs = [];
      for (let r = 0; r < rows; r++) {
        const P = T.floors[Math.min(r, F - 1)];
        const p = P.points2D;
        const z = r < F ? P.z : P.z + PARAPET;
        let tx = p[2 * jp] - p[2 * jm];
        let ty = p[2 * jp + 1] - p[2 * jm + 1];
        const l = Math.hypot(tx, ty) || 1;
        tx /= l;
        ty /= l;
        const nx = ty;
        const ny = -tx;
        const x = p[2 * j];
        const y = p[2 * j + 1];
        const ox = x + nx * depth;
        const oy = y + ny * depth;
        sBase.push(solid.v(ox - tx * hw, oy - ty * hw, z, C.fin));
        solid.v(ox + tx * hw, oy + ty * hw, z, C.fin);
        solid.v(x, y, z, C.finWeb);
        solid.v(ox, oy, z, C.finWeb);
        const gx = x + nx * gOff;
        const gy = y + ny * gOff;
        gBase.push(glow.v(gx - tx * gw, gy - ty * gw, z, C.finGlow));
        glow.v(gx + tx * gw, gy + ty * gw, z, C.finGlow);
        zs.push(z);
      }
      for (let r = 0; r < rows - 1; r++) {
        const a = sBase[r];
        const c = sBase[r + 1];
        solid.begin(zs[r]);
        solid.quad(a, a + 1, c + 1, c);
        solid.quad(a + 2, a + 3, c + 3, c + 2);
        glow.begin(zs[r]);
        glow.quad(gBase[r], gBase[r] + 1, gBase[r + 1] + 1, gBase[r + 1]);
      }
    }
  }
  return { fins: solid.finish(), finGlow: glow.finish() };
}

/* ---------------------------------------------------------------------------
 * Bridges
 * ------------------------------------------------------------------------- */

// Rounded-box section (superellipse, exponent 4) shared by every link body.
const SECTION = (() => {
  const out = [];
  for (let r = 0; r < BRIDGE_RING; r++) {
    const th = (2 * Math.PI * r) / BRIDGE_RING;
    const c = Math.cos(th);
    const s = Math.sin(th);
    out.push({ v: Math.sign(c) * Math.sqrt(Math.abs(c)), w: Math.sign(s) * Math.sqrt(Math.abs(s)) });
  }
  return out;
})();

// Rail positions in the unit section: four swept corners and the keel.
// On |v|^4 + |w|^4 = 1 the 45° corner is v = w = 0.5^(1/4) ≈ 0.841.
const RAILS = [
  [0.86, 0.86],
  [-0.86, 0.86],
  [0.86, -0.86],
  [-0.86, -0.86],
  [0, -1.02],
];
// The glow follows the roof corners and the arched keel only (fewer, wider tubes).
const GLOW_RAILS = [RAILS[0], RAILS[1], RAILS[4]];

/** Station indices used for bridge geometry: every BRIDGE_STEP-th, always ending on the last. */
function bridgeStations(S) {
  const out = [];
  for (let i = 0; i < S - 1; i += BRIDGE_STEP) out.push(i);
  out.push(S - 1);
  return out;
}

/** Point on a bridge's section at station i, unit-section coords (v, w). */
function stationPoint(st, i, vx, vy, v, w) {
  const K = BRIDGE_STATION_STRIDE;
  const hw = st[K * i + 3];
  const hh = w >= 0 ? st[K * i + 4] : st[K * i + 5];
  return new THREE.Vector3(st[K * i] + vx * v * hw, st[K * i + 1] + vy * v * hw, st[K * i + 2] + w * hh);
}

/** Dark lofted body of every link, one piece per station so it sweeps in. */
function buildBridgeBody(bridges) {
  const b = makeBuilder();
  const C = VR_COLORS;
  const K = BRIDGE_STATION_STRIDE;
  const R = BRIDGE_RING;
  for (const br of bridges) {
    const vx = -br.uy;
    const vy = br.ux;
    const st = br.stations;
    const idx = bridgeStations(st.length / K);
    const base = [];
    for (const i of idx) {
      base.push(b.next());
      for (const p of SECTION) {
        const q = stationPoint(st, i, vx, vy, p.v, p.w);
        b.v(q.x, q.y, q.z, mix(C.bridgeDark, C.bridgeLit, shade(vx * p.v, vy * p.v, p.w)));
      }
    }
    const S = idx.length;
    for (let i = 0; i < S - 1; i++) {
      b.begin(i / (S - 1));
      for (let r = 0; r < R; r++) {
        const r2 = (r + 1) % R;
        b.quad(base[i] + r, base[i] + r2, base[i + 1] + r2, base[i + 1] + r);
      }
    }
  }
  return b.finish();
}

/**
 * Rails: one TubeGeometry per (bridge × rail) along a Catmull-Rom curve through
 * the matching section point of every station, so the rails trace the arched
 * soffit and lifted roof line exactly. All tubes share the same tubular and
 * radial segment counts, so their indices are interleaved segment by segment
 * (segment j of every tube, then j+1 …). Drawing the first n segments then
 * sweeps every link in from tower A toward tower B at once.
 *
 * TubeGeometry writes 6·radial indices per tubular segment, contiguous, so
 * segment j of a tube is index block [j·6·radial, (j+1)·6·radial).
 */
function buildRails(bridges, rails, radius, radial, color) {
  if (!bridges.length) return null;
  const K = BRIDGE_STATION_STRIDE;
  const idx = bridgeStations(bridges[0].stations.length / K);
  const T = idx.length - 1; // tubular segments
  const tubes = [];
  for (const br of bridges) {
    const vx = -br.uy;
    const vy = br.ux;
    for (const [v, w] of rails) {
      const pts = idx.map((i) => stationPoint(br.stations, i, vx, vy, v, w));
      tubes.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), T, radius, radial, false));
    }
  }
  const vPer = tubes[0].attributes.position.count;
  const iPer = tubes[0].index.count;
  const block = radial * 6;
  const pos = new Float32Array(tubes.length * vPer * 3);
  const uv = new Float32Array(tubes.length * vPer * 2);
  const col = new Float32Array(tubes.length * vPer * 3);
  const index = new Uint32Array(tubes.length * iPer);
  tubes.forEach((g, k) => {
    pos.set(g.attributes.position.array, k * vPer * 3);
    uv.set(g.attributes.uv.array, k * vPer * 2);
  });
  for (let i = 0; i < col.length; i += 3) col.set(color, i);
  const keys = new Float32Array(T);
  const counts = new Uint32Array(T);
  let o = 0;
  for (let j = 0; j < T; j++) {
    tubes.forEach((g, k) => {
      const src = g.index.array;
      const off = k * vPer;
      for (let q = j * block; q < (j + 1) * block; q++) index[o++] = src[q] + off;
    });
    keys[j] = j / T;
    counts[j] = o;
  }
  tubes.forEach((g) => g.dispose());
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.userData.reveal = { keys, counts };
  g.computeBoundingSphere();
  return g;
}

/* ---------------------------------------------------------------------------
 * Walkable surfaces (teleport targets, never drawn)
 * ------------------------------------------------------------------------- */

/**
 * Bridge walkable surfaces: the roof of each link, as a strip following the
 * station curve. Station i contributes left/right points at ±0.6 of the half
 * width; on the superellipse roof |v|^4 + |w|^4 = 1 that offset sits at
 * w = (1 − 0.6⁴)^¼ ≈ 0.966 of the top half-height, so the strip lies on the
 * curved roof, rising toward the towers where the section swells.
 * Plus: ground, podium roof and every tower roof.
 */
function buildWalk(model) {
  const pos = [];
  const tri = (a, b, c) => pos.push(...a, ...b, ...c);
  const fan = (p, z) => {
    const [cx, cy] = centroid(p);
    const M = p.length / 2;
    for (let j = 0; j < M; j++) {
      const j2 = (j + 1) % M;
      tri([cx, cy, z], [p[2 * j], p[2 * j + 1], z], [p[2 * j2], p[2 * j2 + 1], z]);
    }
  };
  const G = 2500;
  tri([-G, -G, 0], [G, -G, 0], [G, G, 0]);
  tri([-G, -G, 0], [G, G, 0], [-G, G, 0]);
  fan(model.podium.outline2D, model.podium.height);
  for (const T of model.towers) {
    const top = T.floors[T.floors.length - 1];
    fan(top.points2D, top.z);
  }
  const K = BRIDGE_STATION_STRIDE;
  const wRoof = Math.pow(1 - Math.pow(0.6, 4), 0.25);
  for (const br of model.bridges) {
    const vx = -br.uy;
    const vy = br.ux;
    const st = br.stations;
    const S = st.length / K;
    const edge = (i, side) => {
      const hw = st[K * i + 3] * 0.6 * side;
      return [st[K * i] + vx * hw, st[K * i + 1] + vy * hw, st[K * i + 2] + st[K * i + 4] * wRoof];
    };
    for (let i = 0; i < S - 1; i++) {
      const a = edge(i, 1);
      const b = edge(i, -1);
      const c = edge(i + 1, -1);
      const d = edge(i + 1, 1);
      tri(a, b, c);
      tri(a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/* ---------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------- */

/**
 * Build every VR geometry for a model. Returns BufferGeometries the caller owns
 * (and must dispose): shell, bands, fins, finGlow, bridgeBody, rails, railGlow
 * (the last three are null when there are no bridges) and walk.
 */
export function buildVRMeshes(model, { lineScale = 1 } = {}) {
  const ls = Math.max(1, lineScale);
  const { fins, finGlow } = buildFins(model, ls);
  const hasBridges = model.bridges.length > 0;
  return {
    shell: buildShell(model),
    bands: buildBands(model, ls),
    fins,
    finGlow,
    bridgeBody: hasBridges ? buildBridgeBody(model.bridges) : null,
    rails: hasBridges ? buildRails(model.bridges, RAILS, RAIL_R * ls, 4, VR_COLORS.rail) : null,
    railGlow: hasBridges ? buildRails(model.bridges, GLOW_RAILS, RAIL_GLOW_R * ls, 5, VR_COLORS.railGlow) : null,
    walk: buildWalk(model),
    maxZ: model.bounds.maxZ,
    lineScale: ls,
  };
}

/**
 * Cut visuals in data space: a translucent fill for the plan and section
 * planes, glowing frames around both, and a halo ribbon wrapped around every
 * tower plate at the plan level (the "floor-level halo" seen from inside at
 * human scale). Returns { fill, lines, glow } geometries.
 */
export function buildCutGeometry(model, { level, axis, pos, lineScale = 1 }) {
  const ls = Math.max(1, lineScale);
  const { bounds } = model;
  const pad = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * 0.1 + 15;
  const x0 = bounds.minX - pad;
  const x1 = bounds.maxX + pad;
  const y0 = bounds.minY - pad;
  const y1 = bounds.maxY + pad;
  const zTop = bounds.maxZ + 15;
  const zp = level * FLOOR_HEIGHT + 0.05;
  const C = VR_COLORS;

  const plan = [
    [x0, y0, zp],
    [x1, y0, zp],
    [x1, y1, zp],
    [x0, y1, zp],
  ];
  const section =
    axis === 'x'
      ? [
          [x0, pos, 0],
          [x1, pos, 0],
          [x1, pos, zTop],
          [x0, pos, zTop],
        ]
      : [
          [pos, y0, 0],
          [pos, y1, 0],
          [pos, y1, zTop],
          [pos, y0, zTop],
        ];

  const fill = makeBuilder();
  fill.begin(0);
  for (const q of [plan, section]) {
    const i0 = fill.v(...q[0], C.cyan);
    fill.v(...q[1], C.cyan);
    fill.v(...q[2], C.cyan);
    fill.v(...q[3], C.cyan);
    fill.quad(i0, i0 + 1, i0 + 2, i0 + 3);
  }

  // Frame ribbon lying in the plane of a rectangle: each inner corner is the
  // outer corner moved `w` toward the centre along both in-plane edge axes.
  const frame = (b, q, w, color) => {
    const c = [0, 1, 2].map((a) => (q[0][a] + q[2][a]) / 2);
    const inner = q.map((p) => p.map((v, a) => v + Math.sign(c[a] - v) * w));
    for (let i = 0; i < 4; i++) {
      const i2 = (i + 1) % 4;
      const a = b.v(...q[i], color);
      b.v(...q[i2], color);
      b.v(...inner[i2], color);
      b.v(...inner[i], color);
      b.quad(a, a + 1, a + 2, a + 3);
    }
  };

  const lines = makeBuilder();
  const glow = makeBuilder();
  lines.begin(0);
  glow.begin(0);
  frame(lines, plan, 0.35 * ls, C.cyan);
  frame(lines, section, 0.35 * ls, C.cyan);
  frame(glow, plan, 1.4 * ls, C.cyanGlow);
  frame(glow, section, 1.4 * ls, C.cyanGlow);
  for (const T of model.towers) {
    if (level >= T.floors.length) continue;
    const P = T.floors[level];
    const n = ringNormals(P.points2D);
    ribbonRing(lines, P.points2D, n, zp - 0.08 * ls, 0.35 * ls, 0.16 * ls, C.cyan);
    ribbonRing(glow, P.points2D, n, zp - 0.6 * ls, 0.45 * ls, 1.2 * ls, C.cyanGlow);
  }
  return { fill: fill.finish(), lines: lines.finish(), glow: glow.finish() };
}
