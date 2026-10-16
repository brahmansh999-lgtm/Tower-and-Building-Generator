import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { FLOOR_HEIGHT, BRIDGE_STATION_STRIDE, CORE_OVERRUN, PARAPET } from '../geometry/generateTower.js';

const CYAN = 0x4fe3ff;
const BRIDGE_RING = 40; // vertices around each bridge section
const SLAB_EDGE = 0.6; //  m of opaque slab edge at the base of every floor

/*
 * Shading without lights: every surface is MeshBasicMaterial with vertex
 * colours baked from analytic normals against a fixed sun (from the south,
 * 30° up), a weak fill from the north-west and a sky term. Everything is solid
 * geometry — slab edges, glazing, fins, roof, podium, bridges — no line overlays.
 */
const SUN = new THREE.Vector3(0.15, -0.85, 0.5).normalize();
const FILL = new THREE.Vector3(-0.6, 0.55, 0.15).normalize();

// Display-space (sRGB) colours, converted to linear once for vertex colours.
export const toLinear = (c) => c.map((v) => Math.pow(v, 2.2));
export const pal = (dark, lit) => ({ dark: toLinear(dark), lit: toLinear(lit) });
const PALETTE = {
  glass: pal([0.05, 0.06, 0.075], [0.4, 0.46, 0.53]),
  slab: pal([0.07, 0.075, 0.085], [0.52, 0.55, 0.59]),
  fin: pal([0.05, 0.055, 0.065], [0.36, 0.39, 0.43]),
  roof: pal([0.1, 0.1, 0.1], [0.26, 0.26, 0.26]),
  louvre: pal([0.03, 0.03, 0.035], [0.17, 0.17, 0.18]),
  core: pal([0.12, 0.115, 0.11], [0.62, 0.6, 0.57]),
  podiumGlass: pal([0.03, 0.035, 0.04], [0.22, 0.25, 0.28]),
  podiumSlab: pal([0.1, 0.1, 0.1], [0.62, 0.61, 0.59]),
};

/** Light intensity 0..1 for a unit normal. */
export function lightAt(nx, ny, nz) {
  const sun = (nx * SUN.x + ny * SUN.y + nz * SUN.z + 0.12) / 1.12;
  const fill = nx * FILL.x + ny * FILL.y + nz * FILL.z;
  const k = Math.max(0, sun) * 0.9 + Math.max(0, fill) * 0.14 + Math.max(0, nz) * 0.08;
  return k > 1 ? 1 : k;
}

export function writeColor(out, o, k, p) {
  out[o] = p.dark[0] + (p.lit[0] - p.dark[0]) * k;
  out[o + 1] = p.dark[1] + (p.lit[1] - p.dark[1]) * k;
  out[o + 2] = p.dark[2] + (p.lit[2] - p.dark[2]) * k;
}

/*
 * Link material: MeshBasicMaterial whose fragment brightens a SLAB_EDGE-tall
 * band at the base of every 3.5 m storey, by world height. The model group only
 * rotates data z onto world y, so world y = data z and the bands line up
 * exactly with the tower slab edges — link and tower read as one skin.
 */
function linkMaterial() {
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const slabRatio = (SLAB_EDGE / FLOOR_HEIGHT).toFixed(4);
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vWorldY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWorldY = (modelMatrix * vec4(transformed, 1.0)).y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vWorldY;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float storey = fract(vWorldY / ${FLOOR_HEIGHT.toFixed(2)});
        diffuseColor.rgb *= storey < ${slabRatio} ? 1.75 : 1.0;`
      );
  };
  return m;
}

function createMaterials() {
  const solid = () =>
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  return {
    facade: solid(),
    fins: solid(),
    core: solid(),
    podium: solid(),
    bridge: linkMaterial(),
    context: new THREE.MeshBasicMaterial({ vertexColors: true }),
    slab: new THREE.MeshBasicMaterial({
      color: 0x101010,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2,
    }),
    ground: new THREE.MeshBasicMaterial({ color: 0x0c0c0d }),
    cutFill: new THREE.MeshBasicMaterial({
      color: CYAN,
      transparent: true,
      opacity: 0.07,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: false,
    }),
    cutEdge: new THREE.LineBasicMaterial({
      color: CYAN,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
      fog: false,
    }),
  };
}

/**
 * Write position + colour buffers into an object's geometry. If lengths match
 * the current buffers they are updated in place (the hot path while dragging
 * sway or twist); otherwise the geometry is replaced and the index rebuilt.
 */
function writeGeometry(obj, positions, colors, indexLength, makeIndex) {
  const old = obj.geometry;
  const pos = old.getAttribute('position');
  const oldIndexLength = old.index ? old.index.array.length : 0;
  if (pos && pos.array.length === positions.length && oldIndexLength === indexLength) {
    pos.array.set(positions);
    pos.needsUpdate = true;
    const col = old.getAttribute('color');
    col.array.set(colors);
    col.needsUpdate = true;
    return;
  }
  old.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setIndex(new THREE.BufferAttribute(makeIndex(), 1));
  obj.geometry = g;
}

/** Index for `bands` independent ring pairs of M verts, plus an optional fan cap. */
function bandIndex(bands, M, withCap) {
  const idx = new Uint32Array(bands * M * 6 + (withCap ? M * 3 : 0));
  let q = 0;
  for (let b = 0; b < bands; b++) {
    const base = b * 2 * M;
    for (let j = 0; j < M; j++) {
      const a = base + j;
      const c = base + ((j + 1) % M);
      idx[q++] = a;
      idx[q++] = c;
      idx[q++] = c + M;
      idx[q++] = a;
      idx[q++] = c + M;
      idx[q++] = a + M;
    }
  }
  if (withCap) {
    const cap = bands * 2 * M;
    for (let j = 0; j < M; j++) {
      idx[q++] = cap;
      idx[q++] = cap + 1 + j;
      idx[q++] = cap + 1 + ((j + 1) % M);
    }
  }
  return idx;
}

/**
 * Write one ring of M points at height z with outward horizontal normals taken
 * from the ring's own tangent (rings are CCW, so outward = (ty, −tx)).
 * `ring` may be the blend of two plates: a + (b − a)·s.
 */
function writeRing(positions, colors, o, a, b, s, z, palette, M) {
  for (let j = 0; j < M; j++) {
    const jp = (j + 1) % M;
    const jm = (j + M - 1) % M;
    const x = a[2 * j] + (b[2 * j] - a[2 * j]) * s;
    const y = a[2 * j + 1] + (b[2 * j + 1] - a[2 * j + 1]) * s;
    const tx = a[2 * jp] - a[2 * jm];
    const ty = a[2 * jp + 1] - a[2 * jm + 1];
    const l = Math.hypot(tx, ty) || 1;
    const p = o + 3 * j;
    positions[p] = x;
    positions[p + 1] = y;
    positions[p + 2] = z;
    writeColor(colors, p, lightAt(ty / l, -tx / l, 0), palette);
  }
  return o + 3 * M;
}

/**
 * Tower facade: for every storey a light slab-edge band (SLAB_EDGE tall) and a
 * dark glazed band up to the next plate, lofted between the two swayed and
 * twisted plates; then a parapet and a flat roof.
 */
function facadeData(T) {
  const F = T.floors.length;
  const M = T.floors[0].points2D.length / 2;
  const bands = 2 * (F - 1) + 1;
  const positions = new Float32Array((bands * 2 * M + M + 1) * 3);
  const colors = new Float32Array(positions.length);
  const sEdge = SLAB_EDGE / FLOOR_HEIGHT;
  let o = 0;
  for (let f = 0; f < F - 1; f++) {
    const A = T.floors[f];
    const B = T.floors[f + 1];
    const zEdge = A.z + SLAB_EDGE;
    o = writeRing(positions, colors, o, A.points2D, B.points2D, 0, A.z, PALETTE.slab, M);
    o = writeRing(positions, colors, o, A.points2D, B.points2D, sEdge, zEdge, PALETTE.slab, M);
    // Mechanical floors read as a dark louvre band instead of glazing.
    const infill = A.mep ? PALETTE.louvre : PALETTE.glass;
    o = writeRing(positions, colors, o, A.points2D, B.points2D, sEdge, zEdge, infill, M);
    o = writeRing(positions, colors, o, B.points2D, B.points2D, 0, B.z, infill, M);
  }
  const top = T.floors[F - 1];
  const zRoof = top.z + PARAPET;
  o = writeRing(positions, colors, o, top.points2D, top.points2D, 0, top.z, PALETTE.slab, M);
  o = writeRing(positions, colors, o, top.points2D, top.points2D, 0, zRoof, PALETTE.slab, M);
  // roof cap (normal up)
  const kRoof = lightAt(0, 0, 1);
  positions[o] = top.cx;
  positions[o + 1] = top.cy;
  positions[o + 2] = zRoof - 0.3;
  writeColor(colors, o, kRoof, PALETTE.roof);
  o += 3;
  for (let j = 0; j < M; j++, o += 3) {
    positions[o] = top.points2D[2 * j];
    positions[o + 1] = top.points2D[2 * j + 1];
    positions[o + 2] = zRoof - 0.3;
    writeColor(colors, o, kRoof, PALETTE.roof);
  }
  return {
    positions,
    colors,
    indexLength: bands * M * 6 + M * 3,
    makeIndex: () => bandIndex(bands, M, true),
  };
}

/**
 * Fins as real geometry: a thin vertical blade per fin, from the facade point
 * out along the plate normal by `depth`, following the fin polyline up the
 * tower (so it twists and sways with the plates) and up through the parapet.
 */
function finData(T, depth) {
  const F = T.floors.length;
  const M = T.floors[0].points2D.length / 2;
  const stride = M / T.finCount;
  const rows = F + 1;
  const positions = new Float32Array(T.finCount * rows * 2 * 3);
  const colors = new Float32Array(positions.length);
  let o = 0;
  for (let k = 0; k < T.finCount; k++) {
    const j = k * stride;
    const jp = (j + 1) % M;
    const jm = (j + M - 1) % M;
    for (let r = 0; r < rows; r++) {
      const P = T.floors[Math.min(r, F - 1)];
      const p = P.points2D;
      const z = r < F ? P.z : P.z + PARAPET;
      const tx = p[2 * jp] - p[2 * jm];
      const ty = p[2 * jp + 1] - p[2 * jm + 1];
      const l = Math.hypot(tx, ty) || 1;
      const nx = ty / l;
      const ny = -tx / l;
      // blade faces ±tangent; light whichever side faces the sun
      const k1 = Math.max(lightAt(tx / l, ty / l, 0), lightAt(-tx / l, -ty / l, 0)) * 0.85 + 0.1;
      const x = p[2 * j];
      const y = p[2 * j + 1];
      positions[o] = x - nx * 0.2;
      positions[o + 1] = y - ny * 0.2;
      positions[o + 2] = z;
      writeColor(colors, o, k1 * 0.8, PALETTE.fin);
      positions[o + 3] = x + nx * depth;
      positions[o + 4] = y + ny * depth;
      positions[o + 5] = z;
      writeColor(colors, o + 3, k1, PALETTE.fin);
      o += 6;
    }
  }
  const quads = T.finCount * (rows - 1);
  const indexLength = quads * 6;
  const makeIndex = () => {
    const idx = new Uint32Array(indexLength);
    let q = 0;
    for (let k = 0; k < T.finCount; k++) {
      for (let r = 0; r < rows - 1; r++) {
        const a = (k * rows + r) * 2;
        idx[q++] = a;
        idx[q++] = a + 1;
        idx[q++] = a + 3;
        idx[q++] = a;
        idx[q++] = a + 3;
        idx[q++] = a + 2;
      }
    }
    return idx;
  };
  return { positions, colors, indexLength, makeIndex };
}

/**
 * Core: a flat-shaded box per storey between consecutive core rectangles
 * (inclined with the sway, stepping at zone changes), continued up through the
 * roof as the lift overrun and capped. Each face has its own 4 vertices so the
 * concrete reads with crisp edges.
 */
function coreData(T) {
  const F = T.floors.length;
  const top = T.floors[F - 1];
  const levels = T.floors.map((P) => ({ c: P.core2D, z: P.z }));
  levels.push({ c: top.core2D, z: top.z + PARAPET + CORE_OVERRUN });
  const faces = (levels.length - 1) * 4 + 1;
  const positions = new Float32Array(faces * 4 * 3);
  const colors = new Float32Array(positions.length);
  let o = 0;
  const put = (x, y, z, k) => {
    positions[o] = x;
    positions[o + 1] = y;
    positions[o + 2] = z;
    writeColor(colors, o, k, PALETTE.core);
    o += 3;
  };
  for (let l = 0; l < levels.length - 1; l++) {
    const a = levels[l];
    const b = levels[l + 1];
    for (let q = 0; q < 4; q++) {
      const q2 = (q + 1) % 4;
      const ex = a.c[2 * q2] - a.c[2 * q];
      const ey = a.c[2 * q2 + 1] - a.c[2 * q + 1];
      const el = Math.hypot(ex, ey) || 1;
      const k = lightAt(ey / el, -ex / el, 0);
      put(a.c[2 * q], a.c[2 * q + 1], a.z, k);
      put(a.c[2 * q2], a.c[2 * q2 + 1], a.z, k);
      put(b.c[2 * q2], b.c[2 * q2 + 1], b.z, k);
      put(b.c[2 * q], b.c[2 * q + 1], b.z, k);
    }
  }
  const cap = levels[levels.length - 1];
  const kUp = lightAt(0, 0, 1);
  for (let q = 0; q < 4; q++) put(cap.c[2 * q], cap.c[2 * q + 1], cap.z, kUp);
  const indexLength = faces * 6;
  const makeIndex = () => {
    const idx = new Uint32Array(indexLength);
    for (let f = 0; f < faces; f++) {
      const b = f * 4;
      idx.set([b, b + 1, b + 2, b, b + 2, b + 3], f * 6);
    }
    return idx;
  };
  return { positions, colors, indexLength, makeIndex };
}

/** Roof plant screen: a louvred ring at 55 % of the roof plate, 3.2 m tall, capped. */
function plantData(T) {
  const top = T.floors[T.floors.length - 1];
  const M = top.points2D.length / 2;
  const ring = new Float32Array(M * 2);
  for (let j = 0; j < M; j++) {
    ring[2 * j] = top.cx + (top.points2D[2 * j] - top.cx) * 0.55;
    ring[2 * j + 1] = top.cy + (top.points2D[2 * j + 1] - top.cy) * 0.55;
  }
  const z0 = top.z + PARAPET - 0.3;
  const z1 = z0 + 3.2;
  const positions = new Float32Array((2 * M + M + 1) * 3);
  const colors = new Float32Array(positions.length);
  let o = writeRing(positions, colors, 0, ring, ring, 0, z0, PALETTE.louvre, M);
  o = writeRing(positions, colors, o, ring, ring, 0, z1, PALETTE.louvre, M);
  const kUp = lightAt(0, 0, 1);
  positions.set([top.cx, top.cy, z1], o);
  writeColor(colors, o, kUp, PALETTE.roof);
  o += 3;
  for (let j = 0; j < M; j++, o += 3) {
    positions.set([ring[2 * j], ring[2 * j + 1], z1], o);
    writeColor(colors, o, kUp, PALETTE.roof);
  }
  return { positions, colors, indexLength: M * 6 + M * 3, makeIndex: () => bandIndex(1, M, true) };
}

/** Floor slabs (visible only when the model is cut open). */
function slabData(T) {
  const M = T.floors[0].points2D.length / 2;
  const F = T.floors.length;
  const positions = new Float32Array(F * (M + 1) * 3);
  let o = 0;
  for (const P of T.floors) {
    positions[o++] = P.cx;
    positions[o++] = P.cy;
    positions[o++] = P.z + 0.3;
    const p = P.points2D;
    for (let j = 0; j < M; j++) {
      positions[o++] = p[2 * j];
      positions[o++] = p[2 * j + 1];
      positions[o++] = P.z + 0.3;
    }
  }
  const indexLength = F * M * 3;
  const makeIndex = () => {
    const idx = new Uint32Array(indexLength);
    let q = 0;
    for (let f = 0; f < F; f++) {
      const b = f * (M + 1);
      for (let j = 0; j < M; j++) {
        idx[q++] = b;
        idx[q++] = b + 1 + j;
        idx[q++] = b + 1 + ((j + 1) % M);
      }
    }
    return idx;
  };
  return { positions, indexLength, makeIndex };
}

/*
 * Rounded-box section shared by every bridge: superellipse (exponent 4) in the
 * (v, z) plane, sampled at BRIDGE_RING angles. Precomputed unit points and
 * unit-space gradient terms for analytic normals.
 */
const BRIDGE_N = 4;
const BRIDGE_SECTION = (() => {
  const e = 2 / BRIDGE_N;
  const pts = [];
  for (let r = 0; r < BRIDGE_RING; r++) {
    const th = (2 * Math.PI * r) / BRIDGE_RING;
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

/**
 * Loft every link's section along its stations (from the geometry data) into
 * one merged mesh. The section is asymmetric — half-height `hTop` above the
 * centre line and `hBot` below — so the swept soffit and lifted roof line come
 * straight from the data. Shaded with the towers' own glass palette; the floor
 * banding is added in the material (see linkMaterial) so it lines up exactly
 * with the tower floors.
 */
function bridgeData(bridges) {
  const R = BRIDGE_RING;
  const K = BRIDGE_STATION_STRIDE;
  const S = bridges.length ? bridges[0].stations.length / K : 0;
  const vPer = S * R;
  const positions = new Float32Array(bridges.length * vPer * 3);
  const colors = new Float32Array(positions.length);
  let o = 0;
  for (const b of bridges) {
    const vx = -b.uy;
    const vy = b.ux;
    const st = b.stations;
    for (let i = 0; i < S; i++) {
      const sx = st[K * i];
      const sy = st[K * i + 1];
      const sz = st[K * i + 2];
      const hw = st[K * i + 3];
      const hTop = st[K * i + 4];
      const hBot = st[K * i + 5];
      for (const p of BRIDGE_SECTION) {
        const hh = p.w >= 0 ? hTop : hBot;
        positions[o] = sx + vx * p.v * hw;
        positions[o + 1] = sy + vy * p.v * hw;
        positions[o + 2] = sz + p.w * hh;
        // normal ∝ gradient of |v/hw|^n + |w/hh|^n
        let nv = p.gv / hw;
        let nw = p.gw / hh;
        const l = Math.hypot(nv, nw) || 1;
        nv /= l;
        nw /= l;
        writeColor(colors, o, lightAt(vx * nv, vy * nv, nw), PALETTE.glass);
        o += 3;
      }
    }
  }
  const iPer = (S - 1) * R * 6;
  const indexLength = bridges.length * iPer;
  const makeIndex = () => {
    const idx = new Uint32Array(indexLength);
    let q = 0;
    for (let n = 0; n < bridges.length; n++) {
      const base = n * vPer;
      for (let i = 0; i < S - 1; i++) {
        for (let r = 0; r < R; r++) {
          const a = base + i * R + r;
          const c = base + i * R + ((r + 1) % R);
          idx[q++] = a;
          idx[q++] = c;
          idx[q++] = c + R;
          idx[q++] = a;
          idx[q++] = c + R;
          idx[q++] = a + R;
        }
      }
    }
    return idx;
  };
  return { positions, colors, indexLength, makeIndex };
}

/** Podium: per storey a slab band and a glazed band, then a roof cap. */
function podiumData(podium) {
  const p = podium.outline2D;
  const n = p.length / 2;
  const storey = podium.height / podium.floors;
  const bands = podium.floors * 2;
  const positions = new Float32Array((bands * 2 * n + n + 1) * 3);
  const colors = new Float32Array(positions.length);
  let o = 0;
  for (let s = 0; s < podium.floors; s++) {
    const z0 = s * storey;
    const zE = z0 + 1.1;
    const z1 = z0 + storey;
    o = writeRing(positions, colors, o, p, p, 0, z0, PALETTE.podiumSlab, n);
    o = writeRing(positions, colors, o, p, p, 0, zE, PALETTE.podiumSlab, n);
    o = writeRing(positions, colors, o, p, p, 0, zE, PALETTE.podiumGlass, n);
    o = writeRing(positions, colors, o, p, p, 0, z1, PALETTE.podiumGlass, n);
  }
  let cx = 0;
  let cy = 0;
  for (let j = 0; j < n; j++) {
    cx += p[2 * j] / n;
    cy += p[2 * j + 1] / n;
  }
  const kRoof = lightAt(0, 0, 1);
  positions[o] = cx;
  positions[o + 1] = cy;
  positions[o + 2] = podium.height;
  writeColor(colors, o, kRoof, PALETTE.roof);
  o += 3;
  for (let j = 0; j < n; j++, o += 3) {
    positions[o] = p[2 * j];
    positions[o + 1] = p[2 * j + 1];
    positions[o + 2] = podium.height;
    writeColor(colors, o, kRoof, PALETTE.roof);
  }
  return {
    positions,
    colors,
    indexLength: bands * n * 6 + n * 3,
    makeIndex: () => bandIndex(bands, n, true),
  };
}

/* ---------------------------------------------------------------------------
 * Context: roads, plaza, clay massing, trees, people
 * ------------------------------------------------------------------------- */

const CTX_COLORS = {
  asphalt: toLinear([0.075, 0.075, 0.08]),
  plaza: toLinear([0.15, 0.15, 0.155]),
  marking: toLinear([0.36, 0.36, 0.34]),
  clay: pal([0.045, 0.045, 0.05], [0.29, 0.29, 0.3]),
  canopy: pal([0.05, 0.07, 0.05], [0.27, 0.36, 0.26]),
  trunk: pal([0.05, 0.04, 0.03], [0.2, 0.16, 0.12]),
  figure: pal([0.25, 0.25, 0.25], [1, 1, 1]),
};
const PEOPLE_TONES = [
  [0.78, 0.3, 0.24],
  [0.26, 0.4, 0.68],
  [0.86, 0.82, 0.72],
  [0.2, 0.2, 0.22],
  [0.58, 0.64, 0.4],
  [0.9, 0.62, 0.3],
].map((c) => new THREE.Color().setRGB(...toLinear(c)));

/** Flat-coloured ground layer: plaza disc, ring road, street quads, lane dashes. */
function roadsGeometry(context) {
  const pos = [];
  const col = [];
  const tri = (a, b, c, color, z) => {
    for (const p of [a, b, c]) {
      pos.push(p[0], p[1], z);
      col.push(...color);
    }
  };
  const quad = (a, b, c, d, color, z) => {
    tri(a, b, c, color, z);
    tri(a, c, d, color, z);
  };
  const seg = 128;
  // Plaza and ring road are optional (the villa context has neither).
  const { plazaR, ring } = context;
  const r0 = ring ? ring.r - ring.width / 2 : 0;
  const r1 = ring ? ring.r + ring.width / 2 : 0;
  for (let i = 0; ring && i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const c0 = [Math.cos(a0), Math.sin(a0)];
    const c1 = [Math.cos(a1), Math.sin(a1)];
    tri([0, 0], [c0[0] * plazaR, c0[1] * plazaR], [c1[0] * plazaR, c1[1] * plazaR], CTX_COLORS.plaza, 0.01);
    quad([c0[0] * r0, c0[1] * r0], [c0[0] * r1, c0[1] * r1], [c1[0] * r1, c1[1] * r1], [c1[0] * r0, c1[1] * r0], CTX_COLORS.asphalt, 0.02);
    if (i % 2 === 0) {
      const rm0 = ring.r - 0.08;
      const rm1 = ring.r + 0.08;
      quad([c0[0] * rm0, c0[1] * rm0], [c0[0] * rm1, c0[1] * rm1], [c1[0] * rm1, c1[1] * rm1], [c1[0] * rm0, c1[1] * rm0], CTX_COLORS.marking, 0.04);
    }
  }
  const hw = context.street / 2;
  for (const s of context.streets) {
    const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
    const ux = (s.x1 - s.x0) / len;
    const uy = (s.y1 - s.y0) / len;
    const nx = -uy * hw;
    const ny = ux * hw;
    quad([s.x0 + nx, s.y0 + ny], [s.x1 + nx, s.y1 + ny], [s.x1 - nx, s.y1 - ny], [s.x0 - nx, s.y0 - ny], CTX_COLORS.asphalt, 0.02);
    // centre-line dashes: 3 m on, 4 m off
    for (let t = 0; t + 3 < len; t += 7) {
      const ax = s.x0 + ux * t;
      const ay = s.y0 + uy * t;
      const bx = ax + ux * 3;
      const by = ay + uy * 3;
      const mx = -uy * 0.1;
      const my = ux * 0.1;
      quad([ax + mx, ay + my], [bx + mx, by + my], [bx - mx, by - my], [ax - mx, ay - my], CTX_COLORS.marking, 0.04);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/** Bake normal-based shading into a (non-indexed or indexed) geometry's colours. */
function bakeColors(geom, palette) {
  const n = geom.attributes.normal.array;
  const out = new Float32Array(n.length);
  for (let i = 0; i < n.length; i += 3) writeColor(out, i, lightAt(n[i], n[i + 1], n[i + 2]), palette);
  geom.setAttribute('color', new THREE.BufferAttribute(out, 3));
  return geom;
}

/** Unit clay block: 1 × 1 × 1 with its base on z = 0 (data space, z up). */
function blockGeometry() {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0, 0.5);
  return bakeColors(g, CTX_COLORS.clay);
}

/** Unit tree: squashed icosphere canopy on a trunk; scaled by (r, r, h). */
function treeGeometry() {
  const canopy = new THREE.IcosahedronGeometry(1, 1);
  canopy.scale(1, 1, 0.42);
  canopy.translate(0, 0, 0.6);
  bakeColors(canopy, CTX_COLORS.canopy);
  const trunk = new THREE.CylinderGeometry(0.07, 0.09, 0.45, 6);
  trunk.rotateX(Math.PI / 2);
  trunk.translate(0, 0, 0.225);
  bakeColors(trunk, CTX_COLORS.trunk);
  return mergeSimple([flat(canopy), flat(trunk)]);
}

/** Unit person, 1 m tall (scaled by height): legs, torso, shoulders, head. */
function figureGeometry() {
  const parts = [];
  const add = (g, x, z) => {
    g.translate(x, 0, z);
    parts.push(flat(bakeColors(g, CTX_COLORS.figure)));
  };
  const leg = () => {
    const g = new THREE.CylinderGeometry(0.045, 0.04, 0.47, 6);
    g.rotateX(Math.PI / 2);
    return g;
  };
  add(leg(), -0.05, 0.235);
  add(leg(), 0.05, 0.235);
  const torso = new THREE.CylinderGeometry(0.1, 0.085, 0.36, 8);
  torso.rotateX(Math.PI / 2);
  torso.scale(1, 0.62, 1);
  add(torso, 0, 0.65);
  const head = new THREE.SphereGeometry(0.065, 10, 8);
  add(head, 0, 0.9);
  return mergeSimple(parts);
}

const flat = (g) => (g.index ? g.toNonIndexed() : g);

/** Merge non-indexed geometries that all carry position, normal and color. */
function mergeSimple(geoms) {
  const total = geoms.reduce((n, g) => n + g.attributes.position.array.length, 0);
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'color']) {
    const arr = new Float32Array(total);
    let o = 0;
    for (const g of geoms) {
      arr.set(g.attributes[name].array, o);
      o += g.attributes[name].array.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, 3));
  }
  geoms.forEach((g) => g.dispose());
  return out;
}

/** Rebuild the context group (only when the cached context object changes). */
export function buildContextGroup(ctx, context) {
  const group = ctx.contextGroup;
  for (const child of [...group.children]) {
    group.remove(child);
    child.geometry.dispose();
    if (child.dispose) child.dispose();
  }
  const roads = new THREE.Mesh(roadsGeometry(context), ctx.mats.context);
  roads.frustumCulled = false;
  group.add(roads);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();

  const blocks = new THREE.InstancedMesh(blockGeometry(), ctx.mats.context, context.blocks.length);
  context.blocks.forEach((b, i) => blocks.setMatrixAt(i, m.compose(p.set(b.x, b.y, 0), q, s.set(b.w, b.d, b.h))));

  const trees = new THREE.InstancedMesh(treeGeometry(), ctx.mats.context, context.trees.length);
  context.trees.forEach((t, i) => trees.setMatrixAt(i, m.compose(p.set(t.x, t.y, 0), q, s.set(t.r, t.r, t.h))));

  const people = new THREE.InstancedMesh(figureGeometry(), ctx.mats.context, context.people.length);
  context.people.forEach((h, i) => {
    people.setMatrixAt(i, m.compose(p.set(h.x, h.y, h.z), q, s.set(h.h, h.h, h.h)));
    people.setColorAt(i, PEOPLE_TONES[h.tone]);
  });

  for (const im of [blocks, trees, people]) {
    im.frustumCulled = false;
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    group.add(im);
  }
}

export function makeQuad(fillMat, edgeMat) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const mesh = new THREE.Mesh(g, fillMat);
  const eg = new THREE.BufferGeometry();
  eg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
  const edge = new THREE.LineLoop(eg, edgeMat);
  mesh.frustumCulled = false;
  edge.frustumCulled = false;
  mesh.renderOrder = 3;
  edge.renderOrder = 3;
  return { mesh, edge };
}

export function setQuad(quad, corners) {
  for (const obj of [quad.mesh, quad.edge]) {
    const a = obj.geometry.attributes.position;
    corners.forEach((c, i) => a.setXYZ(i, c[0], c[1], c[2]));
    a.needsUpdate = true;
  }
}

function makeMesh(material) {
  const obj = new THREE.Mesh(new THREE.BufferGeometry(), material);
  obj.frustumCulled = false;
  return obj;
}

/** Rebuild all model geometry from the data object (form/cluster changes only). */
function rebuild(ctx, model) {
  const { towers, bridges, podium, bounds, params } = model;
  const { mats, towerGroup } = ctx;

  while (ctx.towerObjs.length > towers.length) {
    const o = ctx.towerObjs.pop();
    for (const m of Object.values(o)) {
      towerGroup.remove(m);
      m.geometry.dispose();
    }
  }
  while (ctx.towerObjs.length < towers.length) {
    const o = {
      facade: makeMesh(mats.facade),
      fins: makeMesh(mats.fins),
      slab: makeMesh(mats.slab),
      core: makeMesh(mats.core),
      plant: makeMesh(mats.facade),
    };
    towerGroup.add(o.facade, o.fins, o.slab, o.core, o.plant);
    ctx.towerObjs.push(o);
  }
  const finDepth = 0.4 + params.width * 0.008;
  towers.forEach((T, i) => {
    const o = ctx.towerObjs[i];
    const fa = facadeData(T);
    writeGeometry(o.facade, fa.positions, fa.colors, fa.indexLength, fa.makeIndex);
    const fi = finData(T, finDepth);
    writeGeometry(o.fins, fi.positions, fi.colors, fi.indexLength, fi.makeIndex);
    const sl = slabData(T);
    writeGeometry(o.slab, sl.positions, new Float32Array(sl.positions.length), sl.indexLength, sl.makeIndex);
    const co = coreData(T);
    writeGeometry(o.core, co.positions, co.colors, co.indexLength, co.makeIndex);
    const pl = plantData(T);
    writeGeometry(o.plant, pl.positions, pl.colors, pl.indexLength, pl.makeIndex);
  });

  ctx.bridgeMesh.visible = bridges.length > 0;
  if (bridges.length) {
    const b = bridgeData(bridges);
    writeGeometry(ctx.bridgeMesh, b.positions, b.colors, b.indexLength, b.makeIndex);
  }

  const pd = podiumData(podium);
  writeGeometry(ctx.podiumMesh, pd.positions, pd.colors, pd.indexLength, pd.makeIndex);

  if (model.context !== ctx.lastContext) {
    buildContextGroup(ctx, model.context);
    ctx.lastContext = model.context;
  }

  // Camera: frame once, then only follow height changes vertically.
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  const H = bounds.maxZ;
  ctx.sceneR = Math.max(H, span);
  const targetY = H * 0.46;
  if (!ctx.fitted) {
    const portrait = ctx.camera.aspect < 0.9;
    const d = Math.max(H * (portrait ? 2.9 : 2.7), span * (portrait ? 3.0 : 2.2));
    ctx.camera.position.set(d * 0.62, targetY + d * 0.22, d * 0.76);
    ctx.controls.target.set(0, targetY, 0);
    ctx.fitted = true;
  } else {
    const dy = targetY - ctx.controls.target.y;
    ctx.controls.target.y += dy;
    ctx.camera.position.y += dy;
  }
}

/** Move cut planes and the clipping plane (no geometry rebuild). */
function updateCuts(ctx, model, planLevel, axis, pos, cut3D) {
  const { bounds } = model;
  const pad = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * 0.1 + 15;
  const x0 = bounds.minX - pad;
  const x1 = bounds.maxX + pad;
  const y0 = bounds.minY - pad;
  const y1 = bounds.maxY + pad;
  const zTop = bounds.maxZ + 15;

  const zp = planLevel * FLOOR_HEIGHT + 0.05;
  setQuad(ctx.planQuad, [
    [x0, y0, zp],
    [x1, y0, zp],
    [x1, y1, zp],
    [x0, y1, zp],
  ]);

  // Data (x, y, z) → world (x, z, −y). The clipping plane keeps n·p + c ≥ 0.
  const eps = 0.05;
  if (axis === 'x') {
    const y = pos + eps;
    setQuad(ctx.sectionQuad, [
      [x0, y, 0],
      [x1, y, 0],
      [x1, y, zTop],
      [x0, y, zTop],
    ]);
    // keep data y ≥ pos  ⇔  world z ≤ −pos
    ctx.clipPlane.normal.set(0, 0, -1);
    ctx.clipPlane.constant = -pos;
  } else {
    const x = pos + eps;
    setQuad(ctx.sectionQuad, [
      [x, y0, 0],
      [x, y1, 0],
      [x, y1, zTop],
      [x, y0, zTop],
    ]);
    // keep data x ≥ pos
    ctx.clipPlane.normal.set(1, 0, 0);
    ctx.clipPlane.constant = -pos;
  }
  ctx.renderer.clippingPlanes = cut3D ? [ctx.clipPlane] : [];
}

export default function Viewport3D({ model, planLevel, sectionAxis, sectionPos, cut3D, active = true }) {
  const mountRef = useRef(null);
  const ctxRef = useRef(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const mount = mountRef.current;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    // Phones: cap pixel ratio to keep fill-rate (and battery) in check.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, coarse ? 1.5 : 2));
    renderer.setClearColor(0x000000, 1);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    scene.fog = new THREE.Fog(0x000000, 400, 1800);

    const camera = new THREE.PerspectiveCamera(32, 1, 1, 12000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.35;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.minDistance = 20;
    controls.maxDistance = 5000;

    // Auto-rotate pauses on interaction and resumes after 4 s idle.
    let resumeTimer = 0;
    const onStart = () => {
      controls.autoRotate = false;
      clearTimeout(resumeTimer);
    };
    const onEnd = () => {
      clearTimeout(resumeTimer);
      resumeTimer = setTimeout(() => {
        controls.autoRotate = true;
      }, 4000);
    };
    controls.addEventListener('start', onStart);
    controls.addEventListener('end', onEnd);

    const mats = createMaterials();
    const root = new THREE.Group();
    root.rotation.x = -Math.PI / 2; // data z-up → three y-up
    scene.add(root);

    const ground = new THREE.Mesh(new THREE.CircleGeometry(3000, 96), mats.ground);
    ground.position.z = -0.1;
    root.add(ground);

    const towerGroup = new THREE.Group();
    root.add(towerGroup);
    const contextGroup = new THREE.Group();
    root.add(contextGroup);

    const bridgeMesh = makeMesh(mats.bridge);
    const podiumMesh = makeMesh(mats.podium);
    const planQuad = makeQuad(mats.cutFill, mats.cutEdge);
    const sectionQuad = makeQuad(mats.cutFill, mats.cutEdge);
    root.add(bridgeMesh, podiumMesh);
    root.add(planQuad.mesh, planQuad.edge, sectionQuad.mesh, sectionQuad.edge);

    const ctx = {
      renderer,
      scene,
      camera,
      controls,
      mats,
      towerGroup,
      towerObjs: [],
      contextGroup,
      lastContext: null,
      bridgeMesh,
      podiumMesh,
      planQuad,
      sectionQuad,
      clipPlane: new THREE.Plane(new THREE.Vector3(0, 0, -1), 0),
      sceneR: 400,
      fitted: false,
    };
    ctxRef.current = ctx;

    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!activeRef.current) return;
      controls.update();
      // Fog tracks the orbit distance so depth fades the same at any zoom.
      const d = camera.position.distanceTo(controls.target);
      scene.fog.near = Math.max(1, d - ctx.sceneR * 0.2);
      scene.fog.far = d + ctx.sceneR * 2.4;
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(resumeTimer);
      ro.disconnect();
      controls.removeEventListener('start', onStart);
      controls.removeEventListener('end', onEnd);
      controls.dispose();
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
      Object.values(mats).forEach((m) => m.dispose());
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      ctxRef.current = null;
    };
  }, []);

  // Form / cluster change → rebuild geometry.
  useEffect(() => {
    const ctx = ctxRef.current;
    if (ctx) rebuild(ctx, model);
  }, [model]);

  // Cut sliders → move planes only.
  useEffect(() => {
    const ctx = ctxRef.current;
    if (ctx) updateCuts(ctx, model, planLevel, sectionAxis, sectionPos, cut3D);
  }, [model, planLevel, sectionAxis, sectionPos, cut3D]);

  return <div className="viewport" ref={mountRef} />;
}
