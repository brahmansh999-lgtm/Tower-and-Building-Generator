/**
 * generateVilla.js
 *
 * Residential villa studies on one shared brief. Seven design options, each a
 * different fluid, Zaha-Hadid-inspired form family, all on the SAME plot,
 * with the SAME road, context, programme and gross floor area. Only the
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
 *              rooms: [{ name, polys, holePolys, cx, cy, angle, area }],
 *              walls: [x0,y0,x1,y1,…], doors: [{ x, y, angle, w }],
 *              furniture: [{ type, x, y, w, d, rot }], people: [{ x, y, rot }] }],
 *   stair: { type, x, y, rot, w, d },
 *   roof: { wave } | null,          wave = { amp, length, angle, phase }
 *   canopy: { outline, z, thickness, wave, columns } | null,
 *   pool, deck, drive: flat outlines,  outdoor: [furniture]
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

/** The brief: identical for every option. Weights are target areas (m²). */
export const PROGRAMME = [
  [
    ['GARAGE', 46],
    ['ENTRY', 26],
    ['KITCHEN', 36],
    ['DINING', 40],
    ['LIVING', 88],
    ['FAMILY', 38],
    ['GUEST SUITE', 34],
  ],
  [
    ['MASTER SUITE', 62],
    ['BED 2', 28],
    ['BED 3', 28],
    ['STUDY', 22],
    ['LOUNGE', 32],
    ['BED 4', 28],
  ],
];

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
function spineShape(ctrl, width, perSeg = 18) {
  const spine = catmull(ctrl, false, perSeg);
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
  const cap = (i, from) => {
    const r = wAt(i);
    const base = Math.atan2(nrm[i][1], nrm[i][0]);
    for (let k = 1; k < 12; k++) {
      const a = base + from * (Math.PI * k) / 12;
      out.push([spine[i][0] + Math.cos(a) * r, spine[i][1] + Math.sin(a) * r]);
    }
  };
  cap(n - 1, -1);
  for (let i = n - 1; i >= 0; i--) out.push([spine[i][0] - nrm[i][0] * wAt(i), spine[i][1] - nrm[i][1] * wAt(i)]);
  cap(0, -1);
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

/** Offset a closed CCW polygon along its vertex normals (d > 0 = outward). */
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

/** Sutherland–Hodgman: keep the part of polygon p with nx·x + ny·y ≤ c. */
function clipHalf(p, nx, ny, c) {
  const out = [];
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = p[2 * i];
    const ay = p[2 * i + 1];
    const bx = p[2 * j];
    const by = p[2 * j + 1];
    const da = nx * ax + ny * ay - c;
    const db = nx * bx + ny * by - c;
    if (da <= 0) out.push(ax, ay);
    if (da <= 0 !== db <= 0) {
      const t = da / (da - db);
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
  }
  return out.length >= 6 ? new Float32Array(out) : null;
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

/**
 * Parameter intervals [t0, t1] along the line o + t·d that lie inside polygon
 * p (d need not be unit; t is in units of |d|).
 */
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

/** Subtract interval list `b` from `a` (both sorted, non-overlapping). */
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

/* ---------------------------------------------------------------------------
 * Seven options. Coordinates are drafted near the target size and then scaled
 * uniformly so every option hits exactly the same GFA.
 * ------------------------------------------------------------------------- */

const OPTIONS = [
  {
    id: 1,
    name: 'RIBBON',
    tagline: 'One sinuous band; the upper ribbon slides east into a cantilever.',
    levels: [
      { outline: () => spineShape([[-20, -5], [-8, -1], [4, -5], [16, -1]], (t) => 8.6 + 1.6 * Math.sin(Math.PI * t)), partition: 'linear' },
      { outline: () => spineShape([[-6, 1], [6, -2], [21, 3]], (t) => 8 + 1.2 * Math.sin(Math.PI * t)), partition: 'linear' },
    ],
    stair: { type: 'straight', x: -2, y: -1.6, rot: 0.05 },
    pool: () => spineShape([[-18, 10.5], [-6, 12], [6, 10.5]], 3.6),
    deck: () => spineShape([[-21, 9.5], [-6, 12.5], [9, 9]], 9),
    roof: null,
  },
  {
    id: 2,
    name: 'PETAL',
    tagline: 'Three lobes radiate from a spiral-stair atrium; two lift above.',
    levels: [
      { outline: () => polarBlob(0, -1, 10.6, [[3, 0.3, Math.PI / 2]]), partition: 'radial', centre: [0, -1], hall: 3.2, start: -Math.PI / 2 },
      { outline: () => polarBlob(1.2, 0, 9.6, [[2, 0.28, 0.6]], { rot: 0.4 }), partition: 'radial', centre: [0, -1], hall: 3.2, start: 0.3 },
    ],
    stair: { type: 'spiral', x: 0, y: -1, rot: 0 },
    pool: () => polarBlob(-19, 9.5, 4.2, [[2, 0.32, 0.4]]),
    deck: () => polarBlob(-17, 8, 7.5, [[2, 0.25, 0.8]]),
    roof: null,
  },
  {
    id: 3,
    name: 'WAVE',
    tagline: 'A long lozenge under an undulating roof ribbon.',
    levels: [
      { outline: () => superellipse(-1, -2, 14.6, 7.3, 2.6), partition: 'linear' },
      { outline: () => superellipse(4.5, 0.8, 12.2, 6.4, 2.6, 0.14), partition: 'linear' },
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
      { outline: () => polarBlob(-2, -3, 10.4, [[2, 0.34, 0], [3, 0.12, 1]]), partition: 'linear' },
      { outline: () => polarBlob(5.5, 2.5, 9.2, [[2, 0.34, 0], [3, 0.12, 1]], { rot: 0.7 }), partition: 'linear' },
    ],
    stair: { type: 'straight', x: 1.6, y: -0.4, rot: 0.6 },
    pool: () => polarBlob(-18, 9.5, 4.6, [[2, 0.3, 0.2]]),
    deck: () => polarBlob(-15.5, 9, 8, [[2, 0.22, 0.5]]),
    roof: null,
  },
  {
    id: 5,
    name: 'CRESCENT',
    tagline: 'A crescent wraps the pool garden; the upper arc floats over it.',
    levels: [
      {
        outline: () => spineShape(arcPts(0, 14, 22, -150, -30, 7), (t) => 7.4 + 2.2 * Math.sin(Math.PI * t)),
        partition: 'radial',
        centre: [0, 14],
        hall: 0,
        start: (-152 * Math.PI) / 180,
      },
      {
        outline: () => spineShape(arcPts(0, 14, 20.5, -128, -40, 6), (t) => 7 + 1.6 * Math.sin(Math.PI * t)),
        partition: 'radial',
        centre: [0, 14],
        hall: 0,
        start: (-130 * Math.PI) / 180,
      },
    ],
    stair: { type: 'straight', x: 1.6, y: -7.2, rot: 0.08 },
    pool: () => polarBlob(0, 4.5, 4.4, [[2, 0.28, 0]], { sx: 1.5 }),
    deck: () => polarBlob(0, 4.8, 8, [[2, 0.18, 0]], { sx: 1.4 }),
    roof: null,
  },
  {
    id: 6,
    name: 'LOOP',
    tagline: 'A ring around a courtyard pool; the upper floor is an open C.',
    levels: [
      {
        outline: () => superellipse(0, -2, 13.6, 9.6, 2.4),
        hole: () => superellipse(1, -1.2, 6.4, 3.9, 2.4),
        partition: 'radial',
        centre: [1, -1.2],
        hall: 0,
        start: -Math.PI / 2 + 0.25,
      },
      {
        outline: () => spineShape(ellipsePts(0, -2, 10.4, 6.9, 150, 390, 9), 6.4),
        partition: 'radial',
        centre: [1, -1.2],
        hall: 0,
        start: (150 * Math.PI) / 180,
      },
    ],
    stair: { type: 'straight', x: 3, y: -9.3, rot: 0 },
    pool: () => superellipse(1, -1.2, 4.4, 2, 3),
    deck: null,
    roof: null,
  },
  {
    id: 7,
    name: 'SHELL',
    tagline: 'A glass pavilion and a bean study under one flowing canopy.',
    levels: [
      { outline: () => superellipse(0, -3, 14, 7.2, 3.2), partition: 'linear' },
      { outline: () => polarBlob(-3.2, -2.2, 9.2, [[2, 0.25, 0.3]], { sx: 1.15, sy: 0.82 }), partition: 'linear' },
    ],
    stair: { type: 'straight', x: -2.5, y: -2.2, rot: 0.06 },
    pool: () => superellipse(5, 11.5, 7.5, 2.4, 3),
    deck: () => superellipse(3, 10.5, 11.5, 4.5, 2.6),
    roof: null,
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
];

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

export const VILLA_OPTIONS = OPTIONS.map(({ id, name, tagline }) => ({ id, name, tagline }));

/* ---------------------------------------------------------------------------
 * Room partitioning
 * ------------------------------------------------------------------------- */

/**
 * LINEAR: cuts perpendicular to the plate's principal axis. Cut positions are
 * found by bisection so each room's share of the plate equals its share of
 * the programme. Walls are the cut lines clipped to the plate.
 */
function partitionLinear(outline, hole, programme) {
  const a = pcaAngle(outline);
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  let uMin = Infinity;
  let uMax = -Infinity;
  for (let i = 0; i < outline.length; i += 2) {
    const u = outline[i] * ca + outline[i + 1] * sa;
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
  }
  const areaBelow = (c) => polyArea(clipHalf(outline, ca, sa, c)) - (hole ? polyArea(clipHalf(hole, ca, sa, c)) : 0);
  const total = areaBelow(uMax + 1);
  const wsum = programme.reduce((s, [, w]) => s + w, 0);
  const cuts = [uMin - 1];
  let acc = 0;
  for (let k = 0; k < programme.length - 1; k++) {
    acc += programme[k][1] / wsum;
    let lo = uMin;
    let hi = uMax;
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      if (areaBelow(mid) < acc * total) lo = mid;
      else hi = mid;
    }
    cuts.push((lo + hi) / 2);
  }
  cuts.push(uMax + 1);

  const rooms = programme.map(([name], k) => {
    const band = (p) => {
      const lo = clipHalf(p, -ca, -sa, -cuts[k]);
      return lo ? clipHalf(lo, ca, sa, cuts[k + 1]) : null;
    };
    const poly = band(outline);
    const hp = hole ? band(hole) : null;
    return makeRoom(name, poly ? [poly] : [], hp ? [hp] : [], a + Math.PI / 2);
  });

  const walls = [];
  for (let k = 1; k < cuts.length - 1; k++) {
    const ox = cuts[k] * ca;
    const oy = cuts[k] * sa;
    let iv = lineIntervals(outline, ox, oy, -sa, ca);
    if (hole) iv = subtractIntervals(iv, lineIntervals(hole, ox, oy, -sa, ca));
    for (const [t0, t1] of iv) walls.push({ x0: ox - sa * t0, y0: oy + ca * t0, x1: ox - sa * t1, y1: oy + ca * t1, door: 'axis' });
  }
  return { rooms, walls, axis: a };
}

/**
 * RADIAL: rays from a centre (an atrium, a courtyard, or the centre of a
 * crescent's arc). The angular cumulative-area function is built from the fan
 * triangles (centre, pᵢ, pᵢ₊₁) of the outline (and, negatively, the hole), and
 * ray angles are placed where each room's share of the programme is reached.
 */
function partitionRadial(outline, hole, programme, centre, hall, start) {
  const [cx, cy] = centre;
  const fan = [];
  const addFan = (p) => {
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      const ax = p[j] - cx;
      const ay = p[j + 1] - cy;
      const bx = p[i] - cx;
      const by = p[i + 1] - cy;
      const area = (ax * by - ay * bx) / 2;
      const mid = Math.atan2(ay + by, ax + bx);
      fan.push([(((mid - start) % TAU) + TAU) % TAU, area]);
    }
  };
  addFan(outline);
  if (hole) addFan(hole);
  fan.sort((p, q) => p[0] - q[0]);
  const total = fan.reduce((s, [, a]) => s + a, 0);
  const wsum = programme.reduce((s, [, w]) => s + w, 0);
  const angles = [0];
  let acc = 0;
  let k = 0;
  let target = programme[0][1] / wsum;
  for (const [ang, area] of fan) {
    acc += area / total;
    while (k < programme.length - 1 && acc >= target) {
      angles.push(ang);
      k++;
      target += programme[k][1] / wsum;
    }
  }
  while (angles.length < programme.length) angles.push(TAU * (angles.length / programme.length));
  angles.push(TAU);

  const wedge = (p, a0, a1) => {
    // split wide wedges so every clip is convex (< π)
    const parts = [];
    const n = Math.ceil((a1 - a0) / (Math.PI * 0.9));
    for (let s = 0; s < n; s++) {
      const b0 = start + a0 + ((a1 - a0) * s) / n;
      const b1 = start + a0 + ((a1 - a0) * (s + 1)) / n;
      const d0 = [Math.cos(b0), Math.sin(b0)];
      const d1 = [Math.cos(b1), Math.sin(b1)];
      let q = clipHalf(p, d0[1], -d0[0], d0[1] * cx - d0[0] * cy);
      if (q) q = clipHalf(q, -d1[1], d1[0], -d1[1] * cx + d1[0] * cy);
      if (q) parts.push(q);
    }
    return parts;
  };

  const rooms = programme.map(([name], i) => {
    const polys = wedge(outline, angles[i], angles[i + 1]);
    const holes = hole ? wedge(hole, angles[i], angles[i + 1]) : [];
    const mid = start + (angles[i] + angles[i + 1]) / 2;
    return makeRoom(name, polys, holes, mid + Math.PI / 2);
  });

  const walls = [];
  for (let i = 1; i < programme.length; i++) {
    const a = start + angles[i];
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let iv = lineIntervals(outline, cx, cy, dx, dy).filter(([, t1]) => t1 > 0);
    if (hole) iv = subtractIntervals(iv, lineIntervals(hole, cx, cy, dx, dy));
    iv = subtractIntervals(iv, [[-1e9, hall]]);
    for (const [t0, t1] of iv) walls.push({ x0: cx + dx * t0, y0: cy + dy * t0, x1: cx + dx * t1, y1: cy + dy * t1, door: 'inner' });
  }
  return { rooms, walls, axis: start };
}

function makeRoom(name, polys, holePolys, angle) {
  let area = 0;
  let sx = 0;
  let sy = 0;
  for (const p of polys) {
    const a = polyArea(p);
    const [x, y] = centroidFlat(p);
    area += a;
    sx += x * a;
    sy += y * a;
  }
  for (const p of holePolys) area -= polyArea(p);
  const cx = area > 0 ? sx / Math.max(1e-6, polys.reduce((s, p) => s + polyArea(p), 0)) : 0;
  const cy = area > 0 ? sy / Math.max(1e-6, polys.reduce((s, p) => s + polyArea(p), 0)) : 0;
  return { name, polys, holePolys, cx, cy, angle, area };
}

/* ---------------------------------------------------------------------------
 * Fit-out: doors, furniture, people
 * ------------------------------------------------------------------------- */

/** Furniture recipe per room, in the room frame (u across the room, v along). */
const RECIPES = {
  GARAGE: [
    ['car', -1.5, 0, 2.0, 4.8],
    ['car', 1.5, 0, 2.0, 4.8],
  ],
  ENTRY: [
    ['bench', 0, -1.4, 1.8, 0.45],
    ['plant', 1.6, 1.2, 0.8, 0.8],
    ['plant', -1.6, 1.2, 0.8, 0.8],
  ],
  KITCHEN: [
    ['island', 0, 0.5, 3.0, 1.1],
    ['counter', 0, -1.7, 3.8, 0.65],
    ['plant', 2.2, 1.8, 0.6, 0.6],
  ],
  DINING: [
    ['dining', 0, 0, 2.8, 1.05],
    ['plant', 2.3, 1.6, 0.8, 0.8],
  ],
  LIVING: [
    ['sofa', 0, -1.7, 3.2, 1.0],
    ['coffee', 0, -0.2, 1.4, 0.75],
    ['armchair', -2.2, 0.9, 0.95, 0.95],
    ['armchair', 2.2, 0.9, 0.95, 0.95],
    ['tv', 0, 2.6, 2.4, 0.45],
    ['plant', 3.0, -1.8, 0.9, 0.9],
  ],
  FAMILY: [
    ['sofa', 0, -1.1, 2.6, 0.95],
    ['coffee', 0, 0.2, 1.2, 0.65],
    ['tv', 0, 1.9, 2.0, 0.45],
  ],
  'GUEST SUITE': [
    ['bed', 0, 0.6, 1.8, 2.1],
    ['bathroom', 1.7, -1.8, 2.6, 2.2],
    ['wardrobe', -1.6, -2.0, 1.8, 0.6],
  ],
  'MASTER SUITE': [
    ['bed', 0, 0.7, 2.0, 2.2],
    ['bathroom', 2.4, -2.0, 3.4, 2.6],
    ['wardrobe', -2.3, -2.4, 2.6, 0.6],
    ['armchair', 2.7, 2.0, 0.9, 0.9],
    ['plant', -2.8, 2.2, 0.7, 0.7],
  ],
  BED: [
    ['bed', 0, 0.5, 1.6, 2.0],
    ['bathroom', 1.5, -1.7, 2.4, 2.1],
    ['wardrobe', -1.5, -1.9, 1.6, 0.6],
  ],
  STUDY: [
    ['desk', 0, 0.6, 1.8, 0.8],
    ['wardrobe', 0, -1.6, 2.4, 0.4],
    ['armchair', 1.8, -0.4, 0.85, 0.85],
  ],
  LOUNGE: [
    ['sofa', 0, -0.9, 2.6, 0.95],
    ['coffee', 0, 0.4, 1.2, 0.65],
    ['plant', 1.9, 1.4, 0.8, 0.8],
  ],
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

function fitRoom(room, stairRect, rnd) {
  const key = room.name.startsWith('BED ') ? 'BED' : room.name;
  const recipe = RECIPES[key] || [];
  const placed = [];
  const inside = (x, y) =>
    room.polys.some((p) => inFlat(p, x, y)) && !room.holePolys.some((p) => inFlat(p, x, y));
  const free = (corners, cx, cy, r) =>
    corners.every(([x, y]) => inside(x, y) && !inRect(x, y, stairRect)) &&
    !inRect(cx, cy, stairRect) &&
    placed.every((q) => Math.hypot(q.x - cx, q.y - cy) > (Math.max(q.w, q.d) + r) / 2 - 0.15);
  const c = Math.cos(room.angle);
  const s = Math.sin(room.angle);
  for (const [type, u, v, w, d] of recipe) {
    const tries = [
      [u, v],
      [u * 0.6, v * 0.6],
      [-u, v],
      [u, -v],
      [u * 0.3, v * 0.3],
      [-u * 0.6, -v * 0.6],
    ];
    for (const [tu, tv] of tries) {
      const x = room.cx + tu * c - tv * s;
      const y = room.cy + tu * s + tv * c;
      const corners = rectCorners(x, y, w, d, room.angle, 0.12);
      if (free(corners, x, y, Math.max(w, d))) {
        placed.push({ type, x, y, w, d, rot: room.angle });
        break;
      }
    }
  }
  const people = [];
  for (let k = 0, tries = 0; k < 1 + Math.floor(rnd() * 2) && tries < 30; tries++) {
    const x = room.cx + (rnd() - 0.5) * 6;
    const y = room.cy + (rnd() - 0.5) * 6;
    if (!inside(x, y) || inRect(x, y, stairRect)) continue;
    if (placed.some((q) => inRect(x, y, { ...q, w: q.w + 0.4, d: q.d + 0.4 }))) continue;
    people.push({ x, y, rot: rnd() * TAU });
    k++;
  }
  return { furniture: placed, people };
}

/**
 * Door gaps (0.95 m) in partition walls. Linear plans put doors near the
 * plate's long axis (a circulation spine); radial plans near the inner end
 * (the atrium / courtyard side).
 */
function wallsWithDoors(walls, axisPoint, axisAngle) {
  const segs = [];
  const doors = [];
  const DOOR = 0.95;
  for (const w of walls) {
    const L = Math.hypot(w.x1 - w.x0, w.y1 - w.y0);
    const ux = (w.x1 - w.x0) / L;
    const uy = (w.y1 - w.y0) / L;
    if (L < DOOR + 1.4) {
      segs.push(w.x0, w.y0, w.x1, w.y1);
      continue;
    }
    let t;
    if (w.door === 'inner') t = 0.6;
    else {
      // closest point on the wall to the axis line through axisPoint
      const nx = -Math.sin(axisAngle);
      const ny = Math.cos(axisAngle);
      const d0 = (w.x0 - axisPoint[0]) * nx + (w.y0 - axisPoint[1]) * ny;
      const d1 = (w.x1 - axisPoint[0]) * nx + (w.y1 - axisPoint[1]) * ny;
      t = Math.abs(d1 - d0) > 1e-6 ? (-d0 / (d1 - d0)) * L : L / 2;
    }
    t = clamp(t, 0.6, L - DOOR - 0.6);
    segs.push(w.x0, w.y0, w.x0 + ux * t, w.y0 + uy * t);
    segs.push(w.x0 + ux * (t + DOOR), w.y0 + uy * (t + DOOR), w.x1, w.y1);
    doors.push({ x: w.x0 + ux * t, y: w.y0 + uy * t, angle: Math.atan2(uy, ux), w: DOOR });
  }
  return { segs: new Float32Array(segs), doors };
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
 * simple two-storey clay house (sometimes an L of two boxes) and garden trees.
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
  const rows = [
    { y: 0, south: roadS },
    { y: d + 12, south: null },
    { y: roadS - 6 - d / 2, south: null },
  ];
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

export function generateVilla({ option = 1, gfa = GFA_RANGE.default } = {}) {
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
  const SP = ([x, y]) => [x * k, y * k];

  const stair = stairFootprint({ ...def.stair, x: def.stair.x * k, y: def.stair.y * k });
  const stairRect = { ...stair, w: stair.w + 0.8, d: stair.d + 0.8 };

  let z = 0;
  const levels = def.levels.map((L, i) => {
    const outline = S(raw[i].outline);
    const hole = S(raw[i].hole);
    const height = VILLA_FLOOR_HEIGHTS[i];
    const part =
      L.partition === 'radial'
        ? partitionRadial(outline, hole, PROGRAMME[i], SP(L.centre), L.hall * k, L.start)
        : partitionLinear(outline, hole, PROGRAMME[i]);
    const [mx, my] = centroidFlat(outline);
    const { segs, doors } = wallsWithDoors(part.walls, [mx, my], part.axis);
    const furniture = [];
    const people = [];
    for (const room of part.rooms) {
      const f = fitRoom(room, stairRect, rnd);
      furniture.push(...f.furniture);
      people.push(...f.people);
    }
    const level = {
      index: i,
      name: i === 0 ? 'GROUND FLOOR' : 'FIRST FLOOR',
      z,
      height,
      outline,
      hole,
      area: polyArea(outline) - polyArea(hole),
      rooms: part.rooms,
      walls: segs,
      doors,
      furniture,
      people,
    };
    z += height;
    return level;
  });

  const pool = def.pool ? S(def.pool()) : null;
  const deck = def.deck ? S(def.deck()) : null;

  // Driveway: from the access road straight to the garage.
  const garage = levels[0].rooms.find((r) => r.name === 'GARAGE');
  const context = villaContext();
  const driveW = 5.5;
  const gx = clamp(garage.cx, -PLOT.w / 2 + 4, PLOT.w / 2 - 4);
  const drive = new Float32Array([
    gx - driveW / 2, context.roadS + 4,
    gx + driveW / 2, context.roadS + 4,
    gx + driveW / 2, garage.cy,
    gx - driveW / 2, garage.cy,
  ]);

  // Outdoor furniture + people around the pool and terrace.
  const outdoor = [];
  const gardenPeople = [];
  if (pool) {
    const [px, py] = centroidFlat(pool);
    const a = pcaAngle(pool);
    let along = 0;
    for (let i = 0; i < pool.length; i += 2) along = Math.max(along, Math.abs((pool[i] - px) * Math.cos(a) + (pool[i + 1] - py) * Math.sin(a)));
    let across = 0;
    for (let i = 0; i < pool.length; i += 2) across = Math.max(across, Math.abs(-(pool[i] - px) * Math.sin(a) + (pool[i + 1] - py) * Math.cos(a)));
    for (let n = 0; n < 4; n++) {
      const u = -along * 0.6 + (n * along * 1.2) / 3;
      const v = across + 1.8;
      outdoor.push({ type: 'lounger', x: px + u * Math.cos(a) - v * Math.sin(a), y: py + u * Math.sin(a) + v * Math.cos(a), w: 0.75, d: 1.9, rot: a });
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
        columns: def.canopy.columns.map(SP),
      }
    : null;

  const plot = {
    ...PLOT,
    outline2D: new Float32Array([-PLOT.w / 2, -PLOT.d / 2, PLOT.w / 2, -PLOT.d / 2, PLOT.w / 2, PLOT.d / 2, -PLOT.w / 2, PLOT.d / 2]),
    build2D: (() => {
      const hw = PLOT.w / 2 - PLOT.setback;
      const hd = PLOT.d / 2 - PLOT.setback;
      return new Float32Array([-hw, -hd, hw, -hd, hw, hd, -hw, hd]);
    })(),
  };

  const roofTop = levels[levels.length - 1].z + levels[levels.length - 1].height + (def.roof?.wave?.amp || 0);
  const height = Math.max(roofTop, canopy ? canopy.z + canopy.thickness + canopy.wave.amp : 0);
  const footprint = polyArea(levels[0].outline) - polyArea(levels[0].hole);
  const bounds = { minX: -PLOT.w / 2, maxX: PLOT.w / 2, minY: -PLOT.d / 2, maxY: PLOT.d / 2, maxZ: height };

  // keep within the build zone? report it rather than hide it
  const hw = PLOT.w / 2 - PLOT.setback;
  const hd = PLOT.d / 2 - PLOT.setback;
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
    roof: def.roof,
    canopy,
    pool,
    deck,
    drive,
    outdoor,
    gardenTrees,
    context: {
      ...context,
      trees: context.trees.concat(gardenTrees),
      people: context.people.concat(gardenPeople),
    },
    bounds,
    stats: {
      gfa: levels.reduce((s, L) => s + L.area, 0),
      levelAreas: levels.map((L) => L.area),
      footprint,
      coverage: footprint / (PLOT.w * PLOT.d),
      plotArea: PLOT.w * PLOT.d,
      bedrooms: 5,
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
