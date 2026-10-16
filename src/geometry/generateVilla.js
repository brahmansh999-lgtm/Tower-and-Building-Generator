/**
 * generateVilla.js
 *
 * Residential villa studies on one shared brief. Twelve design options, each a
 * different fluid, Zaha-Hadid-inspired form family, all on the SAME plot, with
 * the SAME road, context, programme and gross floor area. Only the
 * architecture changes.
 *
 * Like generateTower, this is the single source of geometry: the villa 3D
 * view, plan and section only read the object returned by generateVilla().
 *
 * Coordinate system (metres): x → east, y → north, z → up. The plot is
 * centred on the origin; the access road runs along its south edge.
 *
 * Output shape:
 * {
 *   option: { id, name, tagline },
 *   plot: { w, d, setback, outline2D, build2D },
 *   levels: [{ index, name, z, height, outline, hole, area,
 *              rooms: [{ name, zone, poly, cx, cy, angle, area, open }],
 *              walls: [x0,y0,x1,y1,…], doors: [{ x, y, angle, w }],
 *              furniture: [{ type, x, y, w, d, rot }], people: [{ x, y, rot }] }],
 *   stair: { type, x, y, rot, w, d },
 *   roof: { wave } | null,          wave = { amp, length, angle, phase }
 *   canopy: { outline, z, thickness, wave, columns } | null,
 *   pool, deck, drive: flat outlines,  outdoor: [furniture], gardenTrees
 *   context: { street, streets, blocks, trees, people, plazaR, ring },
 *   bounds, stats
 * }
 * All 2D outlines are flat Float32Arrays [x0,y0,x1,y1,…]; outer outlines are
 * counter-clockwise, holes clockwise.
 */
import { pointInPolygon } from './generateTower.js';

export const VILLA_FLOOR_HEIGHTS = [3.8, 3.6]; // L0, L1 floor-to-floor (m)
export const VILLA_SLAB = 0.9; //               white ribbon / slab band at the top of each level
export const VILLA_POOL_DEPTH = 1.6;
export const PLOT = { w: 64, d: 44, setback: 5 };
export const GFA_RANGE = { min: 450, max: 900, step: 10, default: 640 };

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------------------------------------------------------------------------
 * 2D curve + polygon toolkit
 * ------------------------------------------------------------------------- */

/** Uniform Catmull-Rom through `pts` ([[x,y],…]); returns [[x,y],…]. */
function catmull(pts, closed, perSeg = 16) {
  const n = pts.length;
  const out = [];
  const at = (i) => (closed ? pts[(i + n) % n] : pts[clamp(i, 0, n - 1)]);
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const last = !closed && i === segs - 1;
    for (let s = 0; s < perSeg + (last ? 1 : 0); s++) {
      const t = s / perSeg;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return out;
}

const flatOf = (pts) => {
  const f = new Float32Array(pts.length * 2);
  pts.forEach(([x, y], i) => {
    f[2 * i] = x;
    f[2 * i + 1] = y;
  });
  return f;
};

function signedArea(p) {
  let a = 0;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) a += p[j] * p[i + 1] - p[i] * p[j + 1];
  return a / 2;
}
export const polyArea = (p) => (p ? Math.abs(signedArea(p)) : 0);

function reverseFlat(p) {
  const r = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 2) {
    r[p.length - 2 - i] = p[i];
    r[p.length - 1 - i] = p[i + 1];
  }
  return r;
}
const ccw = (p) => (signedArea(p) < 0 ? reverseFlat(p) : p);
const cw = (p) => (signedArea(p) > 0 ? reverseFlat(p) : p);

/**
 * Band shape around a spine: offsets the spine ±w/2 along its normals and
 * closes both ends with semicircular caps — the basic "ribbon" of the family.
 * `width` may be a number or a function of the spine parameter t ∈ [0,1].
 */
function spineShape(spine, width) {
  const n = spine.length;
  const wAt = (i) => (typeof width === 'function' ? width(i / (n - 1)) : width) / 2;
  const nrm = spine.map((p, i) => {
    const a = spine[Math.max(0, i - 1)];
    const b = spine[Math.min(n - 1, i + 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
  });
  const out = [];
  for (let i = 0; i < n; i++) out.push([spine[i][0] + nrm[i][0] * wAt(i), spine[i][1] + nrm[i][1] * wAt(i)]);
  const cap = (i) => {
    const r = wAt(i);
    const base = Math.atan2(nrm[i][1], nrm[i][0]);
    for (let k = 1; k < 12; k++) {
      const a = base - (Math.PI * k) / 12;
      out.push([spine[i][0] + Math.cos(a) * r, spine[i][1] + Math.sin(a) * r]);
    }
  };
  cap(n - 1);
  for (let i = n - 1; i >= 0; i--) out.push([spine[i][0] - nrm[i][0] * wAt(i), spine[i][1] - nrm[i][1] * wAt(i)]);
  cap(0);
  return ccw(flatOf(out));
}

/** Superellipse |x/a|^n + |y/b|^n = 1, rotated and centred. */
function superellipse(cx, cy, a, b, n, rot = 0, N = 180) {
  const out = [];
  const e = 2 / n;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  for (let i = 0; i < N; i++) {
    const t = (TAU * i) / N;
    const x = a * Math.sign(Math.cos(t)) * Math.pow(Math.abs(Math.cos(t)), e);
    const y = b * Math.sign(Math.sin(t)) * Math.pow(Math.abs(Math.sin(t)), e);
    out.push([cx + x * c - y * s, cy + x * s + y * c]);
  }
  return ccw(flatOf(out));
}

/** Polar blob r(θ) = R·(1 + Σ aₖ·cos(kθ + φₖ)), optionally stretched and rotated. */
function polarBlob(cx, cy, R, harmonics, { rot = 0, sx = 1, sy = 1, N = 200 } = {}) {
  const out = [];
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  for (let i = 0; i < N; i++) {
    const t = (TAU * i) / N;
    let r = 1;
    for (const [k, amp, ph] of harmonics) r += amp * Math.cos(k * t + ph);
    const x = R * r * Math.cos(t) * sx;
    const y = R * r * Math.sin(t) * sy;
    out.push([cx + x * c - y * s, cy + x * s + y * c]);
  }
  return ccw(flatOf(out));
}

function mapFlat(p, f) {
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 2) {
    const [x, y] = f(p[i], p[i + 1]);
    out[i] = x;
    out[i + 1] = y;
  }
  return out;
}

/** Offset a closed polygon along its vertex normals (d > 0 = away from the solid for CCW outlines / CW holes). */
export function offsetFlat(p, d) {
  const n = p.length / 2;
  const out = new Float32Array(p.length);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n;
    const b = (i + 1) % n;
    const tx = p[2 * b] - p[2 * a];
    const ty = p[2 * b + 1] - p[2 * a + 1];
    const l = Math.hypot(tx, ty) || 1;
    out[2 * i] = p[2 * i] + (ty / l) * d;
    out[2 * i + 1] = p[2 * i + 1] - (tx / l) * d;
  }
  return out;
}

export function centroidFlat(p) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const f = p[j] * p[i + 1] - p[i] * p[j + 1];
    a += f;
    cx += (p[j] + p[i]) * f;
    cy += (p[j + 1] + p[i + 1]) * f;
  }
  if (Math.abs(a) < 1e-9) return [p[0], p[1]];
  return [cx / (3 * a), cy / (3 * a)];
}

/** Principal axis angle of a polygon's vertices (long direction). */
function pcaAngle(p) {
  const [mx, my] = centroidFlat(p);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < p.length; i += 2) {
    const dx = p[i] - mx;
    const dy = p[i + 1] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  return 0.5 * Math.atan2(2 * sxy, sxx - syy);
}

/** Parameter intervals [t0, t1] along the line o + t·d that lie inside polygon p. */
export function lineIntervals(p, ox, oy, dx, dy) {
  const ts = [];
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const ax = p[j];
    const ay = p[j + 1];
    const ex = p[i] - ax;
    const ey = p[i + 1] - ay;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const wx = ax - ox;
    const wy = ay - oy;
    const t = (wx * ey - wy * ex) / den;
    const s = (wx * dy - wy * dx) / den;
    if (s >= 0 && s < 1) ts.push(t);
  }
  ts.sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < ts.length; i += 2) out.push([ts[i], ts[i + 1]]);
  return out;
}

function subtractIntervals(a, b) {
  let out = a.map((x) => x.slice());
  for (const [b0, b1] of b) {
    const next = [];
    for (const [a0, a1] of out) {
      if (b1 <= a0 || b0 >= a1) next.push([a0, a1]);
      else {
        if (b0 > a0) next.push([a0, b0]);
        if (b1 < a1) next.push([b1, a1]);
      }
    }
    out = next;
  }
  return out;
}

const inFlat = (p, x, y) => pointInPolygon(p, x, y);

/** Resample a polyline to roughly `step` spacing. */
function resample(pts, step) {
  const out = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const L = Math.hypot(bx - ax, by - ay);
    let t = step - acc;
    while (t < L) {
      out.push([ax + ((bx - ax) * t) / L, ay + ((by - ay) * t) / L]);
      t += step;
    }
    acc = (acc + L) % step;
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function arcPts(cx, cy, r, a0, a1, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / (n - 1)) * Math.PI) / 180;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

function ellipsePts(cx, cy, a, b, t0, t1, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = ((t0 + ((t1 - t0) * i) / (n - 1)) * Math.PI) / 180;
    out.push([cx + Math.cos(t) * a, cy + Math.sin(t) * b]);
  }
  return out;
}

function spiralPts(cx, cy, r0, r1, a0, a1, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const a = ((a0 + (a1 - a0) * t) * Math.PI) / 180;
    const r = r0 + (r1 - r0) * t;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Options
 *
 * Each level has an outline and a FRAME the plan is laid out in:
 *   { type: 'spine', pts }   arc-length along a drawn spine (bands, arcs, S-curves)
 *   { type: 'pca' }          the plate's long axis (lozenges, beans, lenses)
 *   { type: 'ring', cx, cy, a, b, start, hall }  around a centre (atria, courtyards)
 * Coordinates are drafted near the target size, then every option is scaled
 * uniformly so it hits exactly the same GFA.
 * ------------------------------------------------------------------------- */

const spine = (ctrl) => catmull(ctrl, false, 18);
const band = (ctrl, width) => ({ outline: () => spineShape(spine(ctrl), width), frame: { type: 'spine', pts: ctrl } });

const OPTIONS = [
  {
    id: 1,
    name: 'RIBBON',
    tagline: 'One sinuous band; the upper ribbon slides east into a cantilever.',
    levels: [
      band([[-20, -5], [-8, -1], [4, -5], [16, -1]], (t) => 8.6 + 1.6 * Math.sin(Math.PI * t)),
      band([[-6, 1], [6, -2], [21, 3]], (t) => 8 + 1.2 * Math.sin(Math.PI * t)),
    ],
    stair: { type: 'straight', x: -2, y: -1.6, rot: 0.05 },
    pool: () => spineShape(spine([[-18, 10.5], [-6, 12], [6, 10.5]]), 3.6),
    deck: () => spineShape(spine([[-21, 9.5], [-6, 12.5], [9, 9]]), 9),
  },
  {
    id: 2,
    name: 'PETAL',
    tagline: 'Three lobes radiate from a spiral-stair atrium; two lift above.',
    levels: [
      { outline: () => polarBlob(0, -1, 10.6, [[3, 0.3, Math.PI / 2]]), frame: { type: 'ring', cx: 0, cy: -1, a: 6.4, b: 6.4, start: -60, hall: 2.4 } },
      { outline: () => polarBlob(1.2, 0, 9.6, [[2, 0.28, 0.6]], { rot: 0.4 }), frame: { type: 'ring', cx: 0, cy: -1, a: 6, b: 6, start: 20, hall: 2.4 } },
    ],
    stair: { type: 'spiral', x: 0, y: -1, rot: 0 },
    pool: () => polarBlob(-19, 9.5, 4.2, [[2, 0.32, 0.4]]),
    deck: () => polarBlob(-17, 8, 7.5, [[2, 0.25, 0.8]]),
  },
  {
    id: 3,
    name: 'WAVE',
    tagline: 'A long lozenge under an undulating roof ribbon.',
    levels: [
      { outline: () => superellipse(-1, -2, 14.6, 7.3, 2.6), frame: { type: 'pca' } },
      { outline: () => superellipse(4.5, 0.8, 12.2, 6.4, 2.6, 0.14), frame: { type: 'pca' } },
    ],
    stair: { type: 'straight', x: 1.5, y: -0.6, rot: 0.1 },
    pool: () => superellipse(-7, 11.5, 9.5, 2.2, 4),
    deck: () => superellipse(-5, 11, 13.5, 4.8, 3),
    roof: { wave: { amp: 0.9, length: 14, angle: 0.1, phase: 0.4 } },
  },
  {
    id: 4,
    name: 'DUNES',
    tagline: 'Two bean-shaped plates, the upper rotated 40° into a deep cantilever.',
    levels: [
      { outline: () => polarBlob(-2, -3, 10.4, [[2, 0.34, 0], [3, 0.12, 1]]), frame: { type: 'pca' } },
      { outline: () => polarBlob(5.5, 2.5, 9.2, [[2, 0.34, 0], [3, 0.12, 1]], { rot: 0.7 }), frame: { type: 'pca' } },
    ],
    stair: { type: 'straight', x: 1.6, y: -0.4, rot: 0.6 },
    pool: () => polarBlob(-18, 9.5, 4.6, [[2, 0.3, 0.2]]),
    deck: () => polarBlob(-15.5, 9, 8, [[2, 0.22, 0.5]]),
  },
  {
    id: 5,
    name: 'CRESCENT',
    tagline: 'A crescent wraps the pool garden; the upper arc floats over it.',
    levels: [
      { outline: () => spineShape(spine(arcPts(0, 14, 22, -150, -30, 7)), (t) => 7.4 + 2.2 * Math.sin(Math.PI * t)), frame: { type: 'spine', pts: arcPts(0, 14, 22, -150, -30, 7) } },
      { outline: () => spineShape(spine(arcPts(0, 14, 20.5, -128, -40, 6)), (t) => 7 + 1.6 * Math.sin(Math.PI * t)), frame: { type: 'spine', pts: arcPts(0, 14, 20.5, -128, -40, 6) } },
    ],
    stair: { type: 'straight', x: 1.6, y: -7.2, rot: 0.08 },
    pool: () => polarBlob(0, 4.5, 4.4, [[2, 0.28, 0]], { sx: 1.5 }),
    deck: () => polarBlob(0, 4.8, 8, [[2, 0.18, 0]], { sx: 1.4 }),
  },
  {
    id: 6,
    name: 'LOOP',
    tagline: 'A ring around a courtyard pool; the upper floor is an open C.',
    levels: [
      {
        outline: () => superellipse(0, -2, 13.6, 9.6, 2.4),
        hole: () => superellipse(1, -1.2, 6.4, 3.9, 2.4),
        frame: { type: 'ring', cx: 0.5, cy: -1.6, a: 10.2, b: 6.9, start: -70 },
      },
      { outline: () => spineShape(spine(ellipsePts(0, -2, 10.4, 6.9, 150, 390, 9)), 6.4), frame: { type: 'spine', pts: ellipsePts(0, -2, 10.4, 6.9, 150, 390, 9) } },
    ],
    stair: { type: 'straight', x: 3, y: -9.3, rot: 0 },
    pool: () => superellipse(1, -1.2, 4.4, 2, 3),
  },
  {
    id: 7,
    name: 'SHELL',
    tagline: 'A glass pavilion and a bean study under one flowing canopy.',
    levels: [
      { outline: () => superellipse(0, -3, 14, 7.2, 3.2), frame: { type: 'pca' } },
      { outline: () => polarBlob(-3.2, -2.2, 9.2, [[2, 0.25, 0.3]], { sx: 1.15, sy: 0.82 }), frame: { type: 'pca' } },
    ],
    stair: { type: 'straight', x: -2.5, y: -2.2, rot: 0.06 },
    pool: () => superellipse(5, 11.5, 7.5, 2.4, 3),
    deck: () => superellipse(3, 10.5, 11.5, 4.5, 2.6),
    canopy: {
      outline: () => superellipse(1, -2.5, 21, 11.8, 2.2, -0.05),
      z: 8.4,
      thickness: 0.55,
      wave: { amp: 0.8, length: 22, angle: 0, phase: 0 },
      columns: [
        [-17, -2],
        [17, -3],
        [12, 6],
        [-9, -11],
      ],
    },
  },
  {
    id: 8,
    name: 'TWIN POD',
    tagline: 'Two rounded pods pinched by a glass waist; the upper band bridges east.',
    levels: [
      band([[-17, -3], [0, -2], [17, -3]], (t) => 12.2 - 6.4 * Math.pow(Math.sin(Math.PI * t), 2)),
      band([[-6, 0.5], [7, 1.5], [18, -0.5]], 7.6),
    ],
    stair: { type: 'straight', x: 2, y: -0.8, rot: 0.04 },
    pool: () => spineShape(spine([[-14, 11.5], [0, 13], [14, 11.5]]), 3.2),
    deck: () => spineShape(spine([[-17, 10.5], [0, 12.6], [17, 10.5]]), 7.5),
  },
  {
    id: 9,
    name: 'SWIRL',
    tagline: 'An egg-shaped base crowned by an upper floor that spirals out.',
    levels: [
      { outline: () => polarBlob(0, -2, 10.2, [[1, 0.16, 0.5], [2, 0.12, 1.2]], { sx: 1.25 }), frame: { type: 'pca' } },
      band(spiralPts(0, -2, 4.2, 10, 200, 450, 10), 6.2),
    ],
    stair: { type: 'straight', x: 0.8, y: -8.2, rot: 0 },
    pool: () => polarBlob(15, 10, 4, [[2, 0.3, 0]]),
    deck: () => polarBlob(14, 9, 7, [[2, 0.2, 0.4]]),
  },
  {
    id: 10,
    name: 'CASCADE',
    tagline: 'A long low sweep; a shorter upper wing steps back over the west garden.',
    levels: [
      band([[-21, -6], [-6, -3], [8, -6], [21, -3]], (t) => 7.6 + 1.4 * Math.sin(Math.PI * t)),
      band([[-20, -3], [-9, 0.5], [3, -2]], (t) => 7.4 + 2 * Math.sin(Math.PI * t)),
    ],
    stair: { type: 'straight', x: -5, y: -2.8, rot: 0.15 },
    pool: () => superellipse(8, 10, 10, 2, 4, 0.05),
    deck: () => superellipse(6, 9.5, 14, 4.5, 3),
    roof: { wave: { amp: 0.6, length: 18, angle: 0.2, phase: 1.2 } },
  },
  {
    id: 11,
    name: 'FLUX',
    tagline: 'Two S-curves cross: the upper floor flows against the lower.',
    levels: [
      band([[-19, 4], [-8, -4], [4, 1], [17, -6]], 8.4),
      band([[-14, -8], [-3, -1.5], [9, -2], [19, 4]], 7.6),
    ],
    stair: { type: 'straight', x: -4.5, y: -2.2, rot: 0.3 },
    pool: () => polarBlob(-16, 11.5, 4, [[2, 0.3, 0.6]]),
    deck: () => polarBlob(-14, 10.5, 7, [[2, 0.22, 0.4]]),
  },
  {
    id: 12,
    name: 'LENS',
    tagline: 'A pointed lens below, a second lens turned across it above.',
    levels: [
      { outline: () => superellipse(0, -2.5, 18, 7.4, 1.6), frame: { type: 'pca' } },
      { outline: () => superellipse(1.5, -1.5, 14.5, 6.4, 1.6, 0.5), frame: { type: 'pca' } },
    ],
    stair: { type: 'straight', x: 0.5, y: -2, rot: 0.3 },
    pool: () => superellipse(0, 12, 11, 2, 1.8),
    deck: () => superellipse(0, 11.5, 15, 4.6, 2),
    roof: { wave: { amp: 0.5, length: 20, angle: 0.5, phase: 0 } },
  },
];

export const VILLA_OPTIONS = OPTIONS.map(({ id, name, tagline }) => ({ id, name, tagline }));

/* ---------------------------------------------------------------------------
 * The brief — identical for every option — as a designed layout.
 *
 * Each level is a sequence of SEGMENTS along the frame's u axis (arc length).
 *   suite  full-depth rooms, sub-divided by [name, w0, w1, u0, u1] where w is
 *          the normalised depth (0 = road / service side, 1 = garden side) and
 *          u0/u1 are fractions of the segment length
 *   split  a curved corridor at w ≈ 0.36 with service rooms behind it and
 *          living rooms on the garden side; 'open' rooms have no walls between
 *          them or to the corridor (open-plan living / dining / kitchen)
 * Weights are target areas; every segment and band is cut so its share of the
 * real plate matches its share of the brief.
 * ------------------------------------------------------------------------- */

const LAYOUT = [
  [
    { weight: 48, suite: [['GARAGE', 0, 1, 0, 1]] },
    {
      weight: 206,
      split: {
        back: [['ENTRY', 20], ['POWDER', 6], ['STORE', 7], ['PANTRY', 8], ['UTILITY', 11]],
        front: [['FAMILY', 30], ['LIVING', 62, 'open'], ['DINING', 30, 'open'], ['KITCHEN', 30, 'open']],
      },
    },
    { weight: 36, suite: [['GUEST BED', 0.44, 1, 0, 1], ['GUEST BATH', 0, 0.44, 0, 0.6], ['GUEST WARDROBE', 0, 0.44, 0.6, 1]] },
  ],
  [
    { weight: 66, suite: [['MASTER BED', 0.44, 1, 0, 1], ['MASTER BATH', 0, 0.44, 0, 0.55], ['WALK-IN', 0, 0.44, 0.55, 1]] },
    {
      weight: 108,
      split: {
        back: [['BATH 2', 8], ['STUDY', 18], ['LINEN', 4], ['BATH 3', 8]],
        front: [['BED 2', 22], ['LOUNGE', 28, 'open'], ['BED 3', 22]],
      },
    },
    { weight: 32, suite: [['BED 4', 0.44, 1, 0, 1], ['BATH 4', 0, 0.44, 0, 0.6], ['WARDROBE 4', 0, 0.44, 0.6, 1]] },
  ],
];

const ZONE = (name) => {
  if (/LIVING|DINING|KITCHEN|FAMILY|LOUNGE/.test(name)) return 'public';
  if (/BED|STUDY/.test(name)) return 'private';
  if (/HALL|ENTRY/.test(name)) return 'circulation';
  return 'service';
};

const CORRIDOR_W = 0.36; // corridor centre as a fraction of plate depth
const CORRIDOR_HALF = 0.7; // half-width in metres
const DOOR = 0.95;

/**
 * Plan frame. Samples a spine every 0.5 m and records, for each sample, the
 * plate's extent along the spine normal (vmin..vmax, holes and an optional
 * central hall excluded). Maps (u, w) ↔ (x, y) with u = arc length and
 * w ∈ [0, 1] across the plate from the service side to the garden side.
 */
function makeFrame(spec, outline, hole, k, gardenPoint) {
  let pts;
  let closed = false;
  if (spec.type === 'pca') {
    const a = pcaAngle(outline);
    const [mx, my] = centroidFlat(outline);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < outline.length; i += 2) {
      const u = (outline[i] - mx) * Math.cos(a) + (outline[i + 1] - my) * Math.sin(a);
      lo = Math.min(lo, u);
      hi = Math.max(hi, u);
    }
    pts = [];
    for (let u = lo + 0.25; u <= hi - 0.25; u += 0.5) pts.push([mx + Math.cos(a) * u, my + Math.sin(a) * u]);
  } else if (spec.type === 'spine') {
    pts = resample(catmull(spec.pts.map(([x, y]) => [x * k, y * k]), false, 24), 0.5);
    // extend into the end caps along the end tangents
    const ext = (p, q) => {
      const l = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1;
      const out = [];
      for (let d = 0.5; d <= 5; d += 0.5) out.push([p[0] + ((p[0] - q[0]) / l) * d, p[1] + ((p[1] - q[1]) / l) * d]);
      return out;
    };
    pts = ext(pts[0], pts[1]).reverse().concat(pts, ext(pts[pts.length - 1], pts[pts.length - 2]));
  } else {
    closed = true;
    const per = TAU * Math.sqrt((spec.a * spec.a + spec.b * spec.b) / 2) * k;
    const N = Math.max(24, Math.round(per / 0.5));
    pts = [];
    for (let i = 0; i < N; i++) {
      const t = ((spec.start || 0) * Math.PI) / 180 + (TAU * i) / N;
      pts.push([spec.cx * k + Math.cos(t) * spec.a * k, spec.cy * k + Math.sin(t) * spec.b * k]);
    }
  }

  const n = pts.length;
  const S = [];
  let u = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) u += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const a = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const b = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const tx = (b[0] - a[0]) / l;
    const ty = (b[1] - a[1]) / l;
    const nx = -ty;
    const ny = tx;
    let iv = lineIntervals(outline, pts[i][0], pts[i][1], nx, ny);
    if (hole) iv = subtractIntervals(iv, lineIntervals(hole, pts[i][0], pts[i][1], nx, ny));
    let best = null;
    for (const [t0, t1] of iv) {
      const d = t0 <= 0 && t1 >= 0 ? 0 : Math.min(Math.abs(t0), Math.abs(t1));
      if (!best || d < best.d) best = { t0, t1, d };
    }
    let vmin = best ? best.t0 : 0;
    let vmax = best ? best.t1 : 0;
    if (spec.hall) {
      const r = Math.hypot(pts[i][0] - spec.cx * k, pts[i][1] - spec.cy * k);
      vmax = Math.min(vmax, r - spec.hall * k);
    }
    S.push({ x: pts[i][0], y: pts[i][1], u, tx, ty, nx, ny, vmin, vmax: Math.max(vmin, vmax) });
  }
  const U = closed ? u + Math.hypot(pts[0][0] - pts[n - 1][0], pts[0][1] - pts[n - 1][1]) : u;

  // garden side = the side the pool is on
  let g = 1;
  if (gardenPoint) {
    let bi = 0;
    let bd = Infinity;
    S.forEach((s, i) => {
      const d = Math.hypot(s.x - gardenPoint[0], s.y - gardenPoint[1]);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    });
    g = (gardenPoint[0] - S[bi].x) * S[bi].nx + (gardenPoint[1] - S[bi].y) * S[bi].ny >= 0 ? 1 : -1;
  }

  const at = (uu) => {
    let q = closed ? ((uu % U) + U) % U : clamp(uu, 0, U);
    let i = 0;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (S[mid].u <= q) lo = mid;
      else hi = mid;
    }
    i = lo;
    const A = S[i];
    const B = closed && i === n - 1 ? { ...S[0], u: U } : S[Math.min(n - 1, i + 1)];
    if (closed && q > S[n - 1].u) {
      i = n - 1;
    }
    const span = B.u - A.u || 1;
    const t = clamp((q - A.u) / span, 0, 1);
    const L = (key) => A[key] + (B[key] - A[key]) * t;
    return { x: L('x'), y: L('y'), tx: L('tx'), ty: L('ty'), nx: L('nx'), ny: L('ny'), vmin: L('vmin'), vmax: L('vmax') };
  };
  const map = (uu, w) => {
    const s = at(uu);
    const v = g > 0 ? s.vmin + w * (s.vmax - s.vmin) : s.vmax - w * (s.vmax - s.vmin);
    return [s.x + s.nx * v, s.y + s.ny * v];
  };
  const depth = (uu) => {
    const s = at(uu);
    return s.vmax - s.vmin;
  };
  const angle = (uu) => {
    const s = at(uu);
    const a = Math.atan2(s.ty, s.tx);
    return g > 0 ? a : a + Math.PI;
  };
  return { U, closed, map, depth, angle, g };
}

/** Polygon of the frame strip u0..u1 × lo(u)..hi(u) (lo/hi numbers or functions). */
function strip(F, u0, u1, lo, hi) {
  const L = typeof lo === 'function' ? lo : () => lo;
  const H = typeof hi === 'function' ? hi : () => hi;
  const n = Math.max(2, Math.ceil(Math.abs(u1 - u0) / 0.3));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const u = u0 + ((u1 - u0) * i) / n;
    out.push(F.map(u, L(u)));
  }
  for (let i = n; i >= 0; i--) {
    const u = u0 + ((u1 - u0) * i) / n;
    out.push(F.map(u, H(u)));
  }
  return flatOf(out);
}

/** u at which strip(u0..c) reaches `target` area (bisection). */
function cutAt(F, u0, u1, lo, hi, target) {
  let a = u0;
  let b = u1;
  for (let it = 0; it < 28; it++) {
    const m = (a + b) / 2;
    if (polyArea(strip(F, u0, m, lo, hi)) < target) a = m;
    else b = m;
  }
  return (a + b) / 2;
}

/** Cuts dividing [u0, u1] of a band into parts proportional to `weights`. */
function bandCuts(F, u0, u1, lo, hi, weights) {
  const total = polyArea(strip(F, u0, u1, lo, hi));
  const wsum = weights.reduce((s, w) => s + w, 0);
  const cuts = [u0];
  let acc = 0;
  for (let i = 0; i < weights.length - 1; i++) {
    acc += weights[i] / wsum;
    cuts.push(cutAt(F, u0, u1, lo, hi, acc * total));
  }
  cuts.push(u1);
  return cuts;
}

/**
 * Lay out one level in its frame: rooms (polygons), walls (curved polylines
 * following the frame, split at door gaps) and doors.
 */
function layoutLevel(F, spec, inside, stairRect) {
  const rooms = [];
  const polylines = []; // { pts: [[x,y],…] }
  const doors = [];
  const wLo = (u) => clamp(CORRIDOR_W - CORRIDOR_HALF / Math.max(F.depth(u), 0.1), 0.06, 0.8);
  const wHi = (u) => clamp(CORRIDOR_W + CORRIDOR_HALF / Math.max(F.depth(u), 0.1), 0.12, 0.9);

  const addRoom = (name, poly, u0, u1, open = false) => {
    const area = polyArea(poly);
    if (area < 0.5) return;
    const [cx, cy] = centroidFlat(poly);
    rooms.push({ name, zone: ZONE(name), poly, cx, cy, angle: F.angle((u0 + u1) / 2), area, open });
  };

  /** Wall along w = wf(u) for u ∈ [a, b], with door gaps centred at `gaps` (u values). */
  const isoW = (wf, a, b, gaps = []) => {
    const n = Math.max(2, Math.ceil((b - a) / 0.25));
    let run = [];
    for (let i = 0; i <= n; i++) {
      const u = a + ((b - a) * i) / n;
      const inGap = gaps.some((gu) => Math.abs(u - gu) < DOOR / 2);
      if (inGap) {
        if (run.length > 1) polylines.push(run);
        run = [];
        continue;
      }
      run.push(F.map(u, typeof wf === 'function' ? wf(u) : wf));
    }
    if (run.length > 1) polylines.push(run);
    for (const gu of gaps) {
      const w = typeof wf === 'function' ? wf(gu) : wf;
      const p0 = F.map(gu - DOOR / 2, w);
      const p1 = F.map(gu + DOOR / 2, w);
      doors.push({ x: p0[0], y: p0[1], angle: Math.atan2(p1[1] - p0[1], p1[0] - p0[0]), w: Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) });
    }
  };
  /** Wall along u = const from w0 to w1, optional door centred at w = gap. */
  const isoU = (u, w0, w1, gap = null) => {
    const D = Math.max(F.depth(u), 0.1);
    const n = Math.max(2, Math.ceil(((w1 - w0) * D) / 0.25));
    const half = DOOR / 2 / D;
    let run = [];
    for (let i = 0; i <= n; i++) {
      const w = w0 + ((w1 - w0) * i) / n;
      if (gap !== null && Math.abs(w - gap) < half) {
        if (run.length > 1) polylines.push(run);
        run = [];
        continue;
      }
      run.push(F.map(u, w));
    }
    if (run.length > 1) polylines.push(run);
    if (gap !== null && D > 2.2) {
      const p0 = F.map(u, gap - half);
      const p1 = F.map(u, gap + half);
      doors.push({ x: p0[0], y: p0[1], angle: Math.atan2(p1[1] - p0[1], p1[0] - p0[0]), w: Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) });
    }
  };

  // Segment cuts over the whole depth.
  const segCuts = bandCuts(F, 0, F.U, 0, 1, spec.map((s) => s.weight));
  spec.forEach((seg, j) => {
    const s0 = segCuts[j];
    const s1 = segCuts[j + 1];
    if (j > 0 || F.closed) isoU(s0, 0, 1, CORRIDOR_W);

    if (seg.suite) {
      // Sub-rooms sharing a depth band split it by AREA in proportion to
      // their u-fractions (so a tapered end cap cannot shrink one of them).
      const groups = new Map();
      seg.suite.forEach((sub, i) => {
        const key = `${sub[1]}|${sub[2]}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ sub, i });
      });
      for (const list of groups.values()) {
        list.sort((p, q) => p.sub[3] - q.sub[3]);
        const [, w0, w1] = list[0].sub;
        const cuts = bandCuts(F, s0, s1, w0, w1, list.map(({ sub }) => sub[4] - sub[3]));
        list.forEach(({ sub, i }, n) => {
          const a = cuts[n];
          const b = cuts[n + 1];
          addRoom(sub[0], strip(F, a, b, w0, w1), a, b);
          if (i === 0) return;
          if (w1 < 1) isoW(w1, a, b, [(a + b) / 2]); // door from the main room
          if (n > 0) isoU(a, w0, w1);
        });
      }
      return;
    }

    const { back, front } = seg.split;
    const bc = bandCuts(F, s0, s1, 0, wLo, back.map((r) => r[1]));
    const fc = bandCuts(F, s0, s1, wHi, 1, front.map((r) => r[1]));
    back.forEach(([name], i) => addRoom(name, strip(F, bc[i], bc[i + 1], 0, wLo), bc[i], bc[i + 1]));
    front.forEach(([name, , open], i) => addRoom(name, strip(F, fc[i], fc[i + 1], wHi, 1), fc[i], fc[i + 1], open === 'open'));
    addRoom('HALL', strip(F, s0, s1, wLo, wHi), s0, s1);

    // corridor wall, service side: a door into every back room
    isoW(wLo, s0, s1, back.map((_, i) => (bc[i] + bc[i + 1]) / 2));
    // corridor wall, garden side: only along closed rooms (open-plan rooms flow into the hall)
    front.forEach(([, , open], i) => {
      if (open !== 'open') isoW(wHi, fc[i], fc[i + 1], [(fc[i] + fc[i + 1]) / 2]);
    });
    for (let i = 1; i < bc.length - 1; i++) isoU(bc[i], 0, wLo(bc[i]));
    for (let i = 1; i < fc.length - 1; i++) {
      if (front[i - 1][2] === 'open' && front[i][2] === 'open') continue;
      isoU(fc[i], wHi(fc[i]), 1);
    }
  });

  // Polylines → segments: keep segments inside the plate and clear of the stair.
  const segs = [];
  for (const run of polylines) {
    for (let i = 1; i < run.length; i++) {
      const [ax, ay] = run[i - 1];
      const [bx, by] = run[i];
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      if (!inside(mx, my) || inRect(mx, my, stairRect)) continue;
      segs.push(ax, ay, bx, by);
    }
  }
  return { rooms, walls: new Float32Array(segs), doors: doors.filter((d) => inside(d.x, d.y) && !inRect(d.x, d.y, stairRect)) };
}

/* ---------------------------------------------------------------------------
 * Furniture
 * ------------------------------------------------------------------------- */

/** Recipes in the room frame: x along the room (tangent), y toward the garden. */
const RECIPES = {
  GARAGE: [['car', -1.5, 0, 2.0, 4.8], ['car', 1.5, 0, 2.0, 4.8], ['wardrobe', 0, -3.0, 3.0, 0.5]],
  ENTRY: [['bench', 0, -0.6, 1.6, 0.42], ['plant', 1.2, 0.3, 0.7, 0.7]],
  POWDER: [['wc', 0, 0.2, 0.42, 0.7], ['vanity', 0, -0.45, 0.8, 0.45]],
  STORE: [['wardrobe', 0, 0, 1.6, 0.5]],
  PANTRY: [['counter', 0, -0.3, 1.8, 0.6], ['wardrobe', 0, 0.5, 1.6, 0.45]],
  UTILITY: [['appliance', -0.45, -0.3, 0.65, 0.65], ['appliance', 0.3, -0.3, 0.65, 0.65], ['counter', 0, 0.5, 1.8, 0.6]],
  FAMILY: [['sofa', 0, -1.1, 2.6, 0.95], ['coffee', 0, 0.2, 1.2, 0.65], ['tv', 0, 1.8, 2.0, 0.42]],
  LIVING: [['sofa', 0, 0.9, 3.2, 1.0], ['coffee', 0, -0.4, 1.4, 0.75], ['armchair', -2.2, -1.0, 0.95, 0.95], ['armchair', 2.2, -1.0, 0.95, 0.95], ['plant', 3.0, 1.6, 0.9, 0.9], ['rug', 0, -0.2, 4.0, 3.0]],
  DINING: [['dining', 0, 0.3, 2.8, 1.05], ['plant', 2.2, 1.6, 0.8, 0.8]],
  KITCHEN: [['island', 0, 0.4, 3.0, 1.1], ['counter', 0, -1.3, 3.8, 0.65]],
  HALL: [['plant', 0, 0, 0.6, 0.6]],
  'GUEST BED': [['bed', 0, 0.2, 1.8, 2.1], ['armchair', 1.8, 0.9, 0.85, 0.85]],
  'GUEST BATH': [['shower', 0.7, 0.2, 1.0, 1.0], ['wc', -0.5, 0.4, 0.42, 0.7], ['vanity', -0.4, -0.5, 1.0, 0.5]],
  'GUEST WARDROBE': [['wardrobe', 0, 0, 1.8, 0.6]],
  'MASTER BED': [['bed', 0, -0.2, 2.0, 2.2], ['armchair', 2.0, 1.2, 0.9, 0.9], ['armchair', -2.0, 1.2, 0.9, 0.9], ['rug', 0, 0.2, 3.2, 2.6]],
  'MASTER BATH': [['tub', 0, 0.5, 1.8, 0.85], ['vanity', 0, -0.6, 1.8, 0.55], ['shower', 1.6, 0, 1.1, 1.1], ['wc', -1.5, 0, 0.42, 0.7]],
  'WALK-IN': [['wardrobe', 0, -0.6, 2.4, 0.6], ['wardrobe', 0, 0.6, 2.4, 0.6]],
  'BED 2': [['bed', 0, -0.1, 1.6, 2.0], ['desk', 1.4, 0.9, 1.2, 0.6]],
  'BED 3': [['bed', 0, -0.1, 1.6, 2.0], ['desk', 1.4, 0.9, 1.2, 0.6]],
  'BED 4': [['bed', 0, -0.1, 1.6, 2.0], ['desk', 1.4, 0.9, 1.2, 0.6]],
  'BATH 2': [['shower', 0.5, 0.3, 0.9, 0.9], ['wc', -0.5, 0.4, 0.42, 0.7], ['vanity', 0, -0.5, 0.9, 0.5]],
  'BATH 3': [['shower', 0.5, 0.3, 0.9, 0.9], ['wc', -0.5, 0.4, 0.42, 0.7], ['vanity', 0, -0.5, 0.9, 0.5]],
  'BATH 4': [['shower', 0.6, 0.2, 0.95, 0.95], ['wc', -0.5, 0.4, 0.42, 0.7], ['vanity', -0.3, -0.5, 0.9, 0.5]],
  'WARDROBE 4': [['wardrobe', 0, 0, 1.8, 0.6]],
  LINEN: [['wardrobe', 0, 0, 1.2, 0.45]],
  STUDY: [['desk', 0, 0.4, 1.8, 0.8], ['wardrobe', 0, -0.9, 2.2, 0.4], ['armchair', 1.6, -0.2, 0.85, 0.85]],
  LOUNGE: [['sofa', 0, 0.6, 2.6, 0.95], ['coffee', 0, -0.5, 1.2, 0.65], ['plant', 1.9, 1.2, 0.8, 0.8]],
};

function stairFootprint(stair) {
  if (stair.type === 'spiral') return { ...stair, w: 3.0, d: 3.0 };
  return { ...stair, w: 1.3, d: 4.6 };
}

function rectCorners(x, y, w, d, rot, grow = 0) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const hw = w / 2 + grow;
  const hd = d / 2 + grow;
  return [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ].map(([u, v]) => [x + u * c - v * s, y + u * s + v * c]);
}

function inRect(px, py, r) {
  const c = Math.cos(-r.rot);
  const s = Math.sin(-r.rot);
  const dx = px - r.x;
  const dy = py - r.y;
  const u = dx * c - dy * s;
  const v = dx * s + dy * c;
  return Math.abs(u) <= r.w / 2 && Math.abs(v) <= r.d / 2;
}

/** Place a room's recipe: each item tries its spot, then pulled-in and mirrored variants. */
function fitRoom(room, stairRect, rnd) {
  const recipe = RECIPES[room.name] || [];
  const placed = [];
  const inside = (x, y) => inFlat(room.poly, x, y);
  const c = Math.cos(room.angle);
  const s = Math.sin(room.angle);
  for (const [type, u, v, w, d] of recipe) {
    const flat = type === 'rug';
    const tries = [
      [u, v],
      [u * 0.6, v * 0.6],
      [-u, v],
      [u, -v],
      [u * 0.3, v * 0.3],
      [0, 0],
    ];
    for (const [tu, tv] of tries) {
      const x = room.cx + tu * c - tv * s;
      const y = room.cy + tu * s + tv * c;
      const corners = rectCorners(x, y, w, d, room.angle, 0.1);
      const ok =
        corners.every(([px, py]) => inside(px, py) && !inRect(px, py, stairRect)) &&
        (flat || placed.every((q) => q.type === 'rug' || Math.hypot(q.x - x, q.y - y) > (Math.max(q.w, q.d) + Math.max(w, d)) / 2 - 0.25));
      if (ok) {
        placed.push({ type, x, y, w, d, rot: room.angle });
        break;
      }
    }
  }
  const people = [];
  const want = room.zone === 'public' ? 2 : room.zone === 'service' ? 0 : 1;
  for (let k = 0, tries = 0; k < want && tries < 30; tries++) {
    const x = room.cx + (rnd() - 0.5) * 5;
    const y = room.cy + (rnd() - 0.5) * 5;
    if (!inside(x, y) || inRect(x, y, stairRect)) continue;
    if (placed.some((q) => q.type !== 'rug' && inRect(x, y, { ...q, w: q.w + 0.4, d: q.d + 0.4 }))) continue;
    people.push({ x, y, rot: rnd() * TAU });
    k++;
  }
  // rugs first so they draw underneath
  placed.sort((a, b) => (a.type === 'rug' ? -1 : 0) - (b.type === 'rug' ? -1 : 0));
  return { furniture: placed, people };
}

/* ---------------------------------------------------------------------------
 * Suburban context: same for every option
 * ------------------------------------------------------------------------- */

function rng32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let contextCache = null;

/**
 * Plots of the same size in rows along the roads; each neighbour gets a
 * simple two-storey clay house (sometimes with a wing) and garden trees.
 * Roads: the access road south of our plot, a parallel road north of the back
 * row, and two cross streets. People on the sidewalks and in a few gardens.
 */
function villaContext() {
  if (contextCache) return contextCache;
  const rnd = rng32(7071);
  const { w, d } = PLOT;
  const pitchX = w + 6;
  const roadS = -d / 2 - 6;
  const roadN = d / 2 + 6 + d + 6;
  const rows = [{ y: 0 }, { y: d + 12 }, { y: roadS - 6 - d / 2 }];
  const STREET = 8;
  const E = 340;
  const streets = [
    { x0: -E, y0: roadS, x1: E, y1: roadS },
    { x0: -E, y0: roadN, x1: E, y1: roadN },
    { x0: -4.5 * pitchX, y0: roadS - 120, x1: -4.5 * pitchX, y1: roadN + 120 },
    { x0: 4.5 * pitchX, y0: roadS - 120, x1: 4.5 * pitchX, y1: roadN + 120 },
  ];
  const blocks = [];
  const trees = [];
  const people = [];
  for (const row of rows) {
    for (let i = -4; i <= 4; i++) {
      const px = i * pitchX;
      const py = row.y;
      if (i === 0 && row.y === 0) continue;
      const hw = 8 + rnd() * 4;
      const hd = 5 + rnd() * 2;
      const hx = px + (rnd() - 0.5) * 10;
      const hy = py + (rnd() - 0.5) * 6;
      const h = 6.4 + rnd() * 1.8;
      blocks.push({ x: hx, y: hy, w: 2 * hw, d: 2 * hd, h });
      if (rnd() < 0.5) blocks.push({ x: hx + hw - 3, y: hy + hd + 3, w: 6, d: 6, h: 3.4 });
      const nt = 3 + Math.floor(rnd() * 4);
      for (let t = 0; t < nt; t++) {
        const tx = px + (rnd() - 0.5) * (w - 8);
        const ty = py + (rnd() - 0.5) * (d - 8);
        if (Math.abs(tx - hx) < hw + 3 && Math.abs(ty - hy) < hd + 3) continue;
        trees.push({ x: tx, y: ty, r: 2.4 + rnd() * 1.6, h: 7 + rnd() * 4 });
      }
      if (rnd() < 0.4) people.push({ x: px + (rnd() - 0.5) * 20, y: py + d / 2 - 6, z: 0, h: 1.6 + rnd() * 0.3, tone: Math.floor(rnd() * 6) });
    }
  }
  for (const s of streets) {
    const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
    const ux = (s.x1 - s.x0) / len;
    const uy = (s.y1 - s.y0) / len;
    for (let t = 5; t < len; t += 12) {
      for (const side of [-1, 1]) {
        trees.push({ x: s.x0 + ux * t - uy * side * (STREET / 2 + 1.5), y: s.y0 + uy * t + ux * side * (STREET / 2 + 1.5), r: 1.8 + rnd(), h: 6 + rnd() * 2 });
      }
    }
    for (let n = 0; n < 14; n++) {
      const t = rnd() * len;
      const side = rnd() < 0.5 ? -1 : 1;
      people.push({ x: s.x0 + ux * t - uy * side * (STREET / 2 + 0.8), y: s.y0 + uy * t + ux * side * (STREET / 2 + 0.8), z: 0, h: 1.6 + rnd() * 0.3, tone: Math.floor(rnd() * 6) });
    }
  }
  contextCache = { street: STREET, streets, blocks, trees, people, plazaR: 0, ring: null, roadS };
  return contextCache;
}

/* ---------------------------------------------------------------------------
 * Main entry
 * ------------------------------------------------------------------------- */

/**
 * @param option  1 … 12
 * @param gfa     target gross floor area (m²), identical for every option
 * @param layout  false skips rooms / furniture (fast path for thumbnails)
 */
export function generateVilla({ option = 1, gfa = GFA_RANGE.default, layout = true } = {}) {
  const def = OPTIONS.find((o) => o.id === option) || OPTIONS[0];
  const target = clamp(gfa, GFA_RANGE.min, GFA_RANGE.max);
  const rnd = rng32(option * 977);

  // Draft geometry, then one uniform scale k so Σ level areas = target GFA.
  const raw = def.levels.map((L) => {
    const outline = L.outline();
    const hole = L.hole ? cw(L.hole()) : null;
    return { outline, hole, area: polyArea(outline) - polyArea(hole) };
  });
  const rawGfa = raw.reduce((s, r) => s + r.area, 0);
  const k = Math.sqrt(target / rawGfa);
  const S = (p) => (p ? mapFlat(p, (x, y) => [x * k, y * k]) : null);

  const pool = def.pool ? S(def.pool()) : null;
  const deck = def.deck ? S(def.deck()) : null;
  const gardenPoint = pool ? centroidFlat(pool) : [0, PLOT.d / 2];

  const stair = stairFootprint({ ...def.stair, x: def.stair.x * k, y: def.stair.y * k });
  const stairRect = { ...stair, w: stair.w + 0.5, d: stair.d + 0.5 };

  let z = 0;
  const levels = def.levels.map((L, i) => {
    const outline = S(raw[i].outline);
    const hole = S(raw[i].hole);
    const height = VILLA_FLOOR_HEIGHTS[i];
    let rooms = [];
    let walls = new Float32Array(0);
    let doors = [];
    const furniture = [];
    const people = [];
    if (layout) {
      const grown = offsetFlat(outline, 0.05);
      const shrunkHole = hole && offsetFlat(hole, -0.05);
      const inside = (x, y) => inFlat(grown, x, y) && !(shrunkHole && inFlat(shrunkHole, x, y));
      const F = makeFrame(L.frame, outline, hole, k, gardenPoint);
      ({ rooms, walls, doors } = layoutLevel(F, LAYOUT[i], inside, stairRect));
      for (const room of rooms) {
        const f = fitRoom(room, stairRect, rnd);
        furniture.push(...f.furniture);
        people.push(...f.people);
      }
    }
    const level = {
      index: i,
      name: i === 0 ? 'GROUND FLOOR' : 'FIRST FLOOR',
      z,
      height,
      outline,
      hole,
      area: polyArea(outline) - polyArea(hole),
      rooms,
      walls,
      doors,
      furniture,
      people,
    };
    z += height;
    return level;
  });

  // Driveway: from the access road straight to the garage.
  const garage = levels[0].rooms.find((r) => r.name === 'GARAGE');
  const context = villaContext();
  const driveW = 5.5;
  const gx = clamp(garage ? garage.cx : 0, -PLOT.w / 2 + 4, PLOT.w / 2 - 4);
  const gy = garage ? garage.cy : 0;
  const drive = new Float32Array([gx - driveW / 2, context.roadS + 4, gx + driveW / 2, context.roadS + 4, gx + driveW / 2, gy, gx - driveW / 2, gy]);

  // Outdoor furniture + people around the pool and garden.
  const outdoor = [];
  const gardenPeople = [];
  if (pool) {
    const [px, py] = centroidFlat(pool);
    const a = pcaAngle(pool);
    let along = 0;
    let across = 0;
    for (let i = 0; i < pool.length; i += 2) {
      along = Math.max(along, Math.abs((pool[i] - px) * Math.cos(a) + (pool[i + 1] - py) * Math.sin(a)));
      across = Math.max(across, Math.abs(-(pool[i] - px) * Math.sin(a) + (pool[i + 1] - py) * Math.cos(a)));
    }
    const side = levels[0].hole && inFlat(levels[0].hole, px, py) ? -1 : 1;
    for (let n = 0; n < 4; n++) {
      const u = -along * 0.6 + (n * along * 1.2) / 3;
      const v = side * (across + 1.6);
      const x = px + u * Math.cos(a) - v * Math.sin(a);
      const y = py + u * Math.sin(a) + v * Math.cos(a);
      if (levels.some((L) => inFlat(L.outline, x, y) && !(L.hole && inFlat(L.hole, x, y)))) continue;
      outdoor.push({ type: 'lounger', x, y, w: 0.75, d: 1.9, rot: a });
    }
    gardenPeople.push({ x: px + (along + 1.5) * Math.cos(a), y: py + (along + 1.5) * Math.sin(a), z: 0, h: 1.75, tone: 1 });
  }
  for (let n = 0, tries = 0; n < 7 && tries < 200; tries++) {
    const x = (rnd() - 0.5) * (PLOT.w - 10);
    const y = (rnd() - 0.5) * (PLOT.d - 10);
    if (levels.some((L) => inFlat(L.outline, x, y))) continue;
    if (pool && inFlat(pool, x, y)) continue;
    gardenPeople.push({ x, y, z: 0, h: 1.6 + rnd() * 0.3, tone: Math.floor(rnd() * 6) });
    n++;
  }
  // Garden trees inside the plot, clear of the house, pool and drive.
  const gardenTrees = [];
  for (let tries = 0; gardenTrees.length < 12 && tries < 400; tries++) {
    const x = (rnd() - 0.5) * (PLOT.w - 6);
    const y = (rnd() - 0.5) * (PLOT.d - 6);
    const clear = (p, m) => p && (inFlat(p, x, y) || inFlat(offsetFlat(p, m), x, y));
    if (levels.some((L) => clear(L.outline, 4.5))) continue;
    if (clear(pool, 3) || clear(deck, 1.5) || inFlat(offsetFlat(ccw(drive), 2.5), x, y)) continue;
    if (gardenTrees.some((t) => Math.hypot(t.x - x, t.y - y) < 6)) continue;
    gardenTrees.push({ x, y, r: 2.2 + rnd() * 1.4, h: 6.5 + rnd() * 3 });
  }

  const canopy = def.canopy
    ? {
        outline: S(def.canopy.outline()),
        z: def.canopy.z,
        thickness: def.canopy.thickness,
        wave: def.canopy.wave,
        columns: def.canopy.columns.map(([x, y]) => [x * k, y * k]),
      }
    : null;

  const hw = PLOT.w / 2 - PLOT.setback;
  const hd = PLOT.d / 2 - PLOT.setback;
  const plot = {
    ...PLOT,
    outline2D: new Float32Array([-PLOT.w / 2, -PLOT.d / 2, PLOT.w / 2, -PLOT.d / 2, PLOT.w / 2, PLOT.d / 2, -PLOT.w / 2, PLOT.d / 2]),
    build2D: new Float32Array([-hw, -hd, hw, -hd, hw, hd, -hw, hd]),
  };

  const roof = def.roof || null;
  const top = levels[levels.length - 1];
  const roofTop = top.z + top.height + (roof?.wave?.amp || 0);
  const height = Math.max(roofTop, canopy ? canopy.z + canopy.thickness + canopy.wave.amp : 0);
  const footprint = polyArea(levels[0].outline) - polyArea(levels[0].hole);
  const bounds = { minX: -PLOT.w / 2, maxX: PLOT.w / 2, minY: -PLOT.d / 2, maxY: PLOT.d / 2, maxZ: height };

  let withinSetbacks = true;
  for (const L of levels) {
    for (let i = 0; i < L.outline.length; i += 2) {
      if (Math.abs(L.outline[i]) > hw || Math.abs(L.outline[i + 1]) > hd) withinSetbacks = false;
    }
  }

  return {
    option: { id: def.id, name: def.name, tagline: def.tagline },
    plot,
    levels,
    stair,
    roof,
    canopy,
    pool,
    deck,
    drive,
    outdoor,
    gardenTrees,
    context: { ...context, trees: context.trees.concat(gardenTrees), people: context.people.concat(gardenPeople) },
    bounds,
    stats: {
      gfa: levels.reduce((s, L) => s + L.area, 0),
      levelAreas: levels.map((L) => L.area),
      footprint,
      coverage: footprint / (PLOT.w * PLOT.d),
      plotArea: PLOT.w * PLOT.d,
      bedrooms: 5,
      bathrooms: 5,
      height,
      poolArea: polyArea(pool),
      withinSetbacks,
      scale: k,
    },
  };
}

/** Roof / canopy wave height offset at (x, y). */
export function waveAt(wave, x, y) {
  if (!wave) return 0;
  const u = x * Math.cos(wave.angle) + y * Math.sin(wave.angle);
  return wave.amp * Math.sin((TAU * u) / wave.length + wave.phase);
}
