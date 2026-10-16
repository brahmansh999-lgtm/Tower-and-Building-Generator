/**
 * generateTower.js
 *
 * The single source of geometry for the configurator. The 3D viewport, the
 * plan and the section all read the object returned by generateTower(); none
 * of them compute form on their own.
 *
 * Coordinate system (data space, metres):
 *   x  → east,  y  → north,  z  → up.
 * The 3D view maps this to three.js by rotating the model group −90° about X.
 *
 * Output shape:
 * {
 *   params,                         normalised input parameters
 *   towers: [{
 *     index, name, character,       per-tower variation (see CHARACTERS)
 *     x, y, sx, sy,                 base position and sway axis
 *     phase, twistDir,              ±1 alternating between neighbours
 *     finCount,
 *     coreRot, coreZones: [{ hx, hy, area, rooms, lifts }],  core per lift zone
 *     mepFloors: [floor index],     mechanical floors at zone boundaries
 *     floors: [{ index, z, t, cx, cy, rot, r, area, nia, zone, mep,
 *                points2D,          Float32Array [x0,y0,x1,y1,…] facade
 *                core2D,            Float32Array 4 core corners
 *                columns2D }],      Float32Array perimeter column centres
 *     fins:   [Float32Array]        polyline3D = [x0,y0,z0,x1,y1,z1,…]
 *   }],
 *   bridges: [{ fromTower, toTower, level, storeys, kind, z, height, span,
 *               ux, uy, attachA, attachB, stations, outline2D, zMin, zMax }],
 *   podium: { outline2D, height, floors, area, basementLevels, basementDepth },
 *   context: { plazaR, ring, street, streets, blocks, trees, people },
 *   bounds: { minX, maxX, minY, maxY, maxZ },     (site only, context excluded)
 *   stats:  { gfa, floors, totalFloors, height, towers, bridges, sway, twist, finCount }
 * }
 */

export const FLOOR_HEIGHT = 3.5;
export const PODIUM_FLOOR_HEIGHT = 5.0;
export const BRIDGE_STATION_STRIDE = 6; // [x, y, zc, halfWidth, halfHeightTop, halfHeightBottom]
export const CONNECTION_MODES = ['adjacent', 'all', 'chain'];

export const PARAM_RANGES = {
  floors: { min: 30, max: 120, step: 1 },
  width: { min: 20, max: 60, step: 1 },
  towers: { min: 1, max: 5, step: 1 },
  sway: { min: 0, max: 30, step: 0.5 },
  twist: { min: 0, max: 360, step: 1 },
  bridges: { min: 0, max: 8, step: 1 },
};

/* ---------------------------------------------------------------------------
 * Typology constants shared by the whole family.
 * ------------------------------------------------------------------------- */
const SUPER_N = 2.8; //         superellipse exponent (2 = ellipse, ∞ = box)
const TAPER = 0.12; //          −12 % linear taper base → top
const CROWN_FRACTION = 0.08; // top 8 % of floors ease in toward the roof
const CROWN_TAPER = 0.12; //    gentle extra radius loss at the roof plate
const ARC_STEP = (30 * Math.PI) / 180; // angular step of the gentle arc
const MIN_TOWER_FLOORS = 24;

/*
 * Per-tower character. The sliders set the family (tallest height, base width,
 * sway and twist amplitude); each tower then reads them through its own
 * multipliers so no two towers share a silhouette:
 *   height    fraction of the Height slider (tower A is always the tallest)
 *   width     fraction of the Width slider
 *   aspect    minor/major axis of its oval plate
 *   twist     fraction of the Twist slider
 *   twistEase exponent on t — >1 twists late (near the top), <1 twists early
 *   swayAmp   fraction of the Sway slider
 *   swayK     half-waves of sway over its height (its rhythm)
 *   swayPhase phase offset (rad) — shifts where along the height it leans
 *   lean      sway axis rotated off the arc tangent (deg)
 *   bulge     mid-height swell, peaking at t = bulgeAt
 */
const CHARACTERS = [
  { name: 'A', height: 1.0, width: 1.0, aspect: 0.78, twist: 1.0, twistEase: 1.0, swayAmp: 1.0, swayK: 1.5, swayPhase: 0, lean: 0, bulge: 0.08, bulgeAt: 0.5 },
  { name: 'B', height: 0.84, width: 0.9, aspect: 0.68, twist: 0.6, twistEase: 1.5, swayAmp: 0.8, swayK: 1.15, swayPhase: 0.3, lean: 22, bulge: 0.13, bulgeAt: 0.35 },
  { name: 'C', height: 0.93, width: 1.06, aspect: 0.86, twist: 1.3, twistEase: 0.7, swayAmp: 1.1, swayK: 1.85, swayPhase: -0.2, lean: -28, bulge: 0.04, bulgeAt: 0.65 },
  { name: 'D', height: 0.76, width: 0.88, aspect: 0.72, twist: 0.85, twistEase: 1.25, swayAmp: 0.9, swayK: 1.3, swayPhase: 0.25, lean: 14, bulge: 0.11, bulgeAt: 0.45 },
  { name: 'E', height: 0.88, width: 0.96, aspect: 0.82, twist: 1.15, twistEase: 0.85, swayAmp: 0.95, swayK: 1.65, swayPhase: -0.12, lean: -12, bulge: 0.07, bulgeAt: 0.55 },
];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Radius multiplier along normalised height t ∈ [0, 1] for one character.
 *   bulge : 1 + B·sin(π·t^p)        p = ln ½ / ln(bulgeAt) puts the peak at bulgeAt
 *   taper : 1 − TAPER·t             gentle linear slimming
 *   roof  : 1 − CROWN_TAPER·u²      u = progress through the top band
 */
function radiusFactor(t, ch) {
  const p = Math.log(0.5) / Math.log(ch.bulgeAt);
  const bulge = 1 + ch.bulge * Math.sin(Math.PI * Math.pow(t, p));
  const taper = 1 - TAPER * t;
  const crownStart = 1 - CROWN_FRACTION;
  let crown = 1;
  if (t > crownStart) {
    const u = (t - crownStart) / CROWN_FRACTION;
    crown = 1 - CROWN_TAPER * u * u;
  }
  return bulge * taper * crown;
}

/** Sway profile in units of the sway amplitude: sin(tπk + φ) − sin φ (0 at base). */
function swayProfile(t, ch) {
  return Math.sin(t * Math.PI * ch.swayK + ch.swayPhase) - Math.sin(ch.swayPhase);
}

/** Sample max over t of a function, used for conservative spacing. */
function sampleMax(fn) {
  let m = 0;
  for (let i = 0; i <= 200; i++) m = Math.max(m, Math.abs(fn(i / 200)));
  return m;
}

/**
 * Unit superellipse sampled at M parametric angles θ_j = 2πj/M:
 *   x = sgn(cos θ)·|cos θ|^(2/n)
 *   y = aspect · sgn(sin θ)·|sin θ|^(2/n)
 * Every floor of a tower uses the same table, so vertex j is the same
 * parametric angle on every plate. Fins are chosen vertex indices, so they
 * twist and sway with the plates by construction.
 */
const unitCache = new Map();
function unitPlate(M, aspect) {
  const key = `${M}|${aspect}`;
  if (unitCache.has(key)) return unitCache.get(key);
  const pts = new Float64Array(M * 2);
  const e = 2 / SUPER_N;
  let maxR = 0;
  for (let j = 0; j < M; j++) {
    const th = (2 * Math.PI * j) / M;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const x = Math.sign(c) * Math.pow(Math.abs(c), e);
    const y = aspect * Math.sign(s) * Math.pow(Math.abs(s), e);
    pts[2 * j] = x;
    pts[2 * j + 1] = y;
    maxR = Math.max(maxR, Math.hypot(x, y));
  }
  const area = Math.abs(shoelace(pts));
  const unit = { pts, maxR, area, M };
  unitCache.set(key, unit);
  return unit;
}

function shoelace(p) {
  const n = p.length / 2;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const k = (i + 1) % n;
    a += p[2 * i] * p[2 * k + 1] - p[2 * k] * p[2 * i + 1];
  }
  return a / 2;
}

/** Fin count grows with plate size: 24 fins at 20 m → 48 fins at 60 m (even). */
function finCountFor(width) {
  return 2 * Math.round((24 + ((clamp(width, 20, 60) - 20) / 40) * 24) / 2);
}

/* ---------------------------------------------------------------------------
 * Core
 * ------------------------------------------------------------------------- */
export const CORE_WALL = 0.45; //   core wall thickness (m)
export const CORE_OVERRUN = 4.5; // lift overrun above the roof (m)
export const PARAPET = 1.4; //     parapet above the roof plate (m)
const ZONE_STEP = [1, 0.82, 0.66]; // core length per lift zone (banks drop off)

/**
 * Lift zones: towers over 80 floors get 3 zones, over 45 get 2, else 1. The
 * floor at each zone boundary is a mechanical (MEP / refuge) floor.
 */
function zoneBoundaries(F) {
  const n = F > 80 ? 3 : F > 45 ? 2 : 1;
  const b = [];
  for (let k = 1; k < n; k++) b.push(Math.round((F * k) / n));
  return b;
}

/**
 * Core interior in core-local coordinates (x along the core's long axis):
 *   stair | lift row (top)    | stair
 *         | lift lobby        |
 *         | lift row (bottom) |
 * Lifts are 2.5 m cars on a 2.7 m pitch; with 3+ cars per row the last cell
 * of each row becomes a service riser. A shorter core (upper zones) simply
 * fits fewer cars — the lift banks that have dropped off.
 */
function coreLayout(hx, hy) {
  const tw = CORE_WALL;
  const rooms = [];
  const stairW = Math.min(3, 2 * hx * 0.22);
  const ix0 = -hx + tw;
  const ix1 = hx - tw;
  const iy0 = -hy + tw;
  const iy1 = hy - tw;
  rooms.push({ type: 'stair', x0: ix0, y0: iy0, x1: ix0 + stairW, y1: iy1 });
  rooms.push({ type: 'stair', x0: ix1 - stairW, y0: iy0, x1: ix1, y1: iy1 });
  const x0 = ix0 + stairW + tw;
  const x1 = ix1 - stairW - tw;
  const lobby = Math.min(1.5, iy1 * 0.32);
  rooms.push({ type: 'lobby', x0, y0: -lobby, x1, y1: lobby });
  const n = Math.max(1, Math.floor((x1 - x0 + 0.2) / 2.7));
  const w = (x1 - x0 - 0.2 * (n - 1)) / n;
  let lifts = 0;
  for (const [ya, yb] of [
    [lobby + tw, iy1],
    [iy0, -lobby - tw],
  ]) {
    for (let k = 0; k < n; k++) {
      const cx0 = x0 + k * (w + 0.2);
      const type = n >= 3 && k === n - 1 ? 'riser' : 'lift';
      if (type === 'lift') lifts++;
      rooms.push({ type, x0: cx0, y0: ya, x1: cx0 + w, y1: yb });
    }
  }
  return { rooms, lifts };
}

/** Place the unit plate: scale by r, rotate by rot, translate to (cx, cy). */
function writePlate(out, unit, cx, cy, rot, r) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const u = unit.pts;
  for (let j = 0; j < unit.M; j++) {
    const lx = u[2 * j] * r;
    const ly = u[2 * j + 1] * r;
    out[2 * j] = cx + lx * c - ly * s;
    out[2 * j + 1] = cy + lx * s + ly * c;
  }
}

/**
 * Tower base positions.
 *  - arc  : towers on a gentle arc (30° per step) whose chord between
 *           neighbours equals `spacing`. Tangent = direction along the arc.
 *  - ring : regular polygon with side = `spacing` (used for all-to-all with
 *           3+ towers so diagonal links clear the intermediate towers).
 */
function layoutTowers(n, spacing, ring) {
  if (n === 1) return [{ x: 0, y: 0, tx: 1, ty: 0 }];
  const out = [];
  if (ring) {
    const R = spacing / (2 * Math.sin(Math.PI / n));
    for (let i = 0; i < n; i++) {
      const a = Math.PI / 2 - (2 * Math.PI * i) / n;
      out.push({ x: R * Math.cos(a), y: R * Math.sin(a), tx: Math.sin(a), ty: -Math.cos(a) });
    }
    return out;
  }
  const R = spacing / (2 * Math.sin(ARC_STEP / 2));
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    const a = (i - (n - 1) / 2) * ARC_STEP;
    const p = { x: R * Math.sin(a), y: R * (1 - Math.cos(a)), tx: Math.cos(a), ty: Math.sin(a) };
    mx += p.x / n;
    my += p.y / n;
    out.push(p);
  }
  out.forEach((p) => {
    p.x -= mx;
    p.y -= my;
  });
  return out;
}

/** Which tower pairs get links. */
function connectionPairs(n, mode) {
  const pairs = [];
  if (n < 2) return pairs;
  if (mode === 'all') {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([i, j]);
  } else if (mode === 'chain') {
    for (let i = 0; i < n - 1; i++) pairs.push([i, i + 1]);
  } else {
    // adjacent pairs = twins: (0,1), (2,3); an odd last tower twins with its neighbour
    for (let i = 0; i + 1 < n; i += 2) pairs.push([i, i + 1]);
    if (n % 2 === 1) pairs.push([n - 2, n - 1]);
  }
  return pairs;
}

/**
 * Link levels for one connection, within the shorter tower of the pair.
 *  - The top slot is a 3-storey SKY LOBBY just below that tower's roof band.
 *  - The remaining N−1 slots are 2-storey LINKS spread down the shaft at
 *    t = 0.16 + (tMax − 0.16)·s^0.6, s = (k+1)/N, so upper links cluster high.
 * Walking down from the lobby, slots keep ≥ 5 floors between them (room for the
 * swept soffits); slots that would land in the podium zone are dropped.
 */
function bridgeSlots(N, floors, minFloor) {
  if (N <= 0) return [];
  const tMax = 1 - CROWN_FRACTION - 0.02;
  const toFloor = (t) => Math.round(t * (floors - 1));
  const lobby = toFloor(tMax) - 2;
  const slots = [{ floor: lobby, storeys: 3, kind: 'lobby' }];
  const links = [];
  for (let k = 0; k < N - 1; k++) {
    const s = (k + 1) / N;
    links.push(toFloor(0.16 + (tMax - 0.16) * Math.pow(s, 0.6)));
  }
  let ceiling = lobby;
  for (let k = links.length - 1; k >= 0; k--) {
    const f = Math.min(links[k], ceiling - 5);
    if (f < minFloor) break;
    slots.unshift({ floor: f, storeys: 2, kind: 'link' });
    ceiling = f;
  }
  return slots;
}

/**
 * Cast a ray from (ox, oy) along (dx, dy) and return the distance to the first
 * crossing of the closed polygon. Solves o + t·d = p + s·e per edge with 2D
 * cross products: t = (w×e)/(d×e), s = (w×d)/(d×e), w = p − o.
 */
function rayHitPolygon(pts, ox, oy, dx, dy) {
  const M = pts.length / 2;
  let best = Infinity;
  for (let j = 0; j < M; j++) {
    const k = (j + 1) % M;
    const px = pts[2 * j];
    const py = pts[2 * j + 1];
    const ex = pts[2 * k] - px;
    const ey = pts[2 * k + 1] - py;
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-12) continue;
    const wx = px - ox;
    const wy = py - oy;
    const t = (wx * ey - wy * ex) / denom;
    const s = (wx * dy - wy * dx) / denom;
    if (t > 0 && s >= 0 && s <= 1 && t < best) best = t;
  }
  return best === Infinity ? 0 : best;
}

/**
 * Build one sculpted link between towers A and B starting at floor `slot.floor`.
 *
 * Attachment: the link reads the *already swayed and twisted* plates of both
 * towers at that floor. The axis u runs between the two swayed plate centres;
 * a ray from each centre along ±u hits that tower's rotated superellipse at
 * the exact facade point (pA, pB), so links re-attach whenever form changes.
 *
 * Body: a rounded-box section (superellipse, n = 4) swept along u and buried
 * deep in both plates. Its size is modulated continuously over the whole span,
 * so there is no straight "pipe" segment — it reads as one fluid surface
 * growing out of one tower and into the other:
 *   x  = distance to the nearer facade (≤ 0 inside a tower)
 *   g  = ½(1 + cos(π·min(x / (span/2), 1)))^1.6    1 at the facades → 0 mid-span
 *   halfWidth  = w0·(1 + 0.60·g)    flares sideways into the facade
 *   halfTop    = h0·(1 + 0.30·g)    roof line lifts slightly at the junction
 *   halfBottom = h0·(1 + 1.50·g)    soffit sweeps down the facade like a fillet,
 *                                   giving an arched underside across the span
 *
 * Output `stations` = (S+1) × BRIDGE_STATION_STRIDE values along u — the single
 * description the 3D loft, the plan footprint and the section profile use.
 */
const BRIDGE_STATIONS = 48;

function buildBridge(A, B, slot, bridgeWidth) {
  const { floor, storeys, kind } = slot;
  const fa = A.floors[floor];
  const fb = B.floors[floor];
  let ux = fb.cx - fa.cx;
  let uy = fb.cy - fa.cy;
  const len = Math.hypot(ux, uy) || 1;
  ux /= len;
  uy /= len;
  const vx = -uy;
  const vy = ux;

  const ta = rayHitPolygon(fa.points2D, fa.cx, fa.cy, ux, uy);
  const tb = rayHitPolygon(fb.points2D, fb.cx, fb.cy, -ux, -uy);
  const ax = fa.cx + ux * ta;
  const ay = fa.cy + uy * ta;
  const bx = fb.cx - ux * tb;
  const by = fb.cy - uy * tb;
  const span = Math.max(1, Math.hypot(bx - ax, by - ay));

  const height = storeys * FLOOR_HEIGHT;
  const zc = fa.z + height / 2;
  const h0 = height / 2 - 0.25;
  const w0 = (bridgeWidth / 2) * (kind === 'lobby' ? 1.25 : 1);
  const embedA = ta * 0.55;
  const embedB = tb * 0.55;
  const total = span + embedA + embedB;

  const S = BRIDGE_STATIONS;
  const K = BRIDGE_STATION_STRIDE;
  const stations = new Float32Array((S + 1) * K);
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let i = 0; i <= S; i++) {
    const d = -embedA + (total * i) / S; // distance from facade A along u
    const x = Math.min(d, span - d);
    const g = x <= 0 ? 1 : Math.pow(0.5 * (1 + Math.cos(Math.PI * Math.min(x / (span / 2), 1))), 1.6);
    const hw = w0 * (1 + 0.6 * g);
    const hTop = h0 * (1 + 0.3 * g);
    const hBot = h0 * (1 + 1.5 * g);
    const o = K * i;
    stations[o] = ax + ux * d;
    stations[o + 1] = ay + uy * d;
    stations[o + 2] = zc;
    stations[o + 3] = hw;
    stations[o + 4] = hTop;
    stations[o + 5] = hBot;
    zMin = Math.min(zMin, zc - hBot);
    zMax = Math.max(zMax, zc + hTop);
  }

  // Plan footprint: left edge forward, right edge back.
  const outline2D = new Float32Array((S + 1) * 4);
  for (let i = 0; i <= S; i++) {
    const o = K * i;
    const r = 2 * (2 * S + 1 - i);
    outline2D[2 * i] = stations[o] + vx * stations[o + 3];
    outline2D[2 * i + 1] = stations[o + 1] + vy * stations[o + 3];
    outline2D[r] = stations[o] - vx * stations[o + 3];
    outline2D[r + 1] = stations[o + 1] - vy * stations[o + 3];
  }

  return {
    fromTower: A.index,
    toTower: B.index,
    level: floor,
    storeys,
    kind,
    z: fa.z,
    height,
    span,
    ux,
    uy,
    attachA: [ax, ay],
    attachB: [bx, by],
    stations,
    outline2D,
    zMin,
    zMax,
  };
}

/** Andrew's monotone-chain convex hull, returns CCW [[x,y],…]. */
function convexHull(input) {
  const p = input.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Chaikin corner cutting on a closed polygon. */
function chaikin(poly, iterations) {
  let pts = poly;
  for (let it = 0; it < iterations; it++) {
    const next = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      next.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      next.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    pts = next;
  }
  return pts;
}

/**
 * Podium: convex hull of every ground-floor plate point, Minkowski-offset by a
 * circle (hull of each hull vertex + 24 points on a circle of radius `offset`),
 * then Chaikin-smoothed. The result is a single convex, rounded base that
 * wraps all towers.
 */
function buildPodium(towers, width, floors) {
  const base = [];
  towers.forEach((T) => {
    const p = T.floors[0].points2D;
    for (let j = 0; j < p.length; j += 2) base.push([p[j], p[j + 1]]);
  });
  const hull = convexHull(base);
  const offset = 6 + width * 0.2;
  const ring = [];
  hull.forEach(([x, y]) => {
    for (let a = 0; a < 24; a++) {
      const th = (a / 24) * Math.PI * 2;
      ring.push([x + Math.cos(th) * offset, y + Math.sin(th) * offset]);
    }
  });
  const smooth = chaikin(convexHull(ring), 2);
  const outline2D = new Float32Array(smooth.length * 2);
  smooth.forEach(([x, y], i) => {
    outline2D[2 * i] = x;
    outline2D[2 * i + 1] = y;
  });
  const podiumFloors = clamp(Math.round(floors / 30) + 1, 2, 4);
  return {
    outline2D,
    floors: podiumFloors,
    height: podiumFloors * PODIUM_FLOOR_HEIGHT,
    area: Math.abs(shoelace(outline2D)),
    // Basement (parking / plant) under the podium footprint.
    basementLevels: 2,
    basementDepth: 2 * 4.0,
  };
}

/* ---------------------------------------------------------------------------
 * Main entry
 * ------------------------------------------------------------------------- */
export function generateTower(params = {}) {
  const floors = Math.round(clamp(params.floors ?? 72, 30, 120));
  const width = clamp(params.width ?? 36, 20, 60);
  const nTowers = Math.round(clamp(params.towers ?? 2, 1, 5));
  const sway = clamp(params.sway ?? 12, 0, 30);
  const twist = clamp(params.twist ?? 90, 0, 360);
  const nBridges = Math.round(clamp(params.bridges ?? 4, 0, 8));
  const mode = CONNECTION_MODES.includes(params.mode) ? params.mode : 'adjacent';
  const twistRad = (twist * Math.PI) / 180;
  const chars = CHARACTERS.slice(0, nTowers);

  /*
   * Spacing so towers never intersect at any level, including peak sway.
   * envelope_i = largest distance any plate point of tower i reaches from its
   *              own swayed centre (its width × plate shape × peak bulge)
   * reach_i    = largest sway offset of tower i (amplitude × its profile)
   *   spacing  = 2·max(envelope) + 2·max(reach) + gap
   */
  let envelope = 0;
  let reach = 0;
  chars.forEach((ch) => {
    const M = finCountFor(width * ch.width) * 2;
    const unit = unitPlate(M, ch.aspect);
    const rf = sampleMax((t) => radiusFactor(t, ch));
    envelope = Math.max(envelope, (width * ch.width) / 2 * unit.maxR * rf);
    reach = Math.max(reach, sway * ch.swayAmp * sampleMax((t) => swayProfile(t, ch)));
  });
  const gap = 8 + width * 0.25;
  const spacing = 2 * envelope + 2 * reach + gap;
  const ring = mode === 'all' && nTowers >= 3;
  const layout = layoutTowers(nTowers, spacing, ring);

  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, maxZ: 0 };
  const grow = (x, y, z) => {
    if (x < bounds.minX) bounds.minX = x;
    if (x > bounds.maxX) bounds.maxX = x;
    if (y < bounds.minY) bounds.minY = y;
    if (y > bounds.maxY) bounds.maxY = y;
    if (z > bounds.maxZ) bounds.maxZ = z;
  };

  let gfa = 0;
  let totalFloors = 0;

  const towers = layout.map((L, i) => {
    const ch = chars[i];
    const tFloors = Math.max(MIN_TOWER_FLOORS, Math.round(floors * ch.height));
    totalFloors += tFloors;
    const tWidth = width * ch.width;
    const finCount = finCountFor(tWidth);
    const M = finCount * 2; // plate resolution: fins sit on every 2nd vertex
    const unit = unitPlate(M, ch.aspect);
    const baseRadius = tWidth / 2;

    // Neighbours alternate: opposite sway phase and opposite twist direction.
    const phase = i % 2 === 0 ? 1 : -1;
    const twistDir = i % 2 === 0 ? 1 : -1;
    // Sway axis: the arc tangent rotated by this tower's lean.
    const lean = (ch.lean * Math.PI) / 180;
    const sx = L.tx * Math.cos(lean) - L.ty * Math.sin(lean);
    const sy = L.tx * Math.sin(lean) + L.ty * Math.cos(lean);
    // Plate long axis starts radial to the arc so broad faces face each other.
    const rot0 = Math.atan2(L.ty, L.tx) + Math.PI / 2;

    /*
     * Plate frame at normalised height t ∈ [0, 1]:
     *   SWAY  offset = (sin(tπk + φ) − sin φ)·sway·amp·phase along the sway
     *         axis — zero at the base; k, φ, amp and the axis are per tower.
     *   TWIST rotation = rot0 + twistDir·twist·twistFactor·t^ease — the ease
     *         exponent makes some towers wind early and others late.
     */
    const frame = (t) => {
      const off = swayProfile(t, ch) * sway * ch.swayAmp * phase;
      return {
        cx: L.x + sx * off,
        cy: L.y + sy * off,
        rot: rot0 + twistDir * twistRad * ch.twist * Math.pow(t, ch.twistEase),
      };
    };

    /*
     * CORE. Its orientation is fixed (rot0) — the plates twist around it — but
     * it follows the sway, so it is an inclined core that stays inside every
     * plate. A rotating superellipse always contains the circle of radius
     * aspect·r (its minor semi-axis), so each zone's core is sized so its
     * half-diagonal ≤ 0.6·aspect·r on the smallest plate of that zone, leaving
     * a lease depth of ≥ 40 % of that radius. Proportion hx = 1.3·hy; upper
     * zones are shorter (ZONE_STEP) as lift banks drop off.
     */
    const boundaries = zoneBoundaries(tFloors);
    const zoneOf = (f) => boundaries.filter((b) => f > b).length;
    const zoneLimit = boundaries.map(() => Infinity).concat([Infinity]);
    for (let f = 0; f < tFloors; f++) {
      const r = baseRadius * radiusFactor(f / (tFloors - 1), ch);
      const z = zoneOf(f);
      zoneLimit[z] = Math.min(zoneLimit[z], 0.6 * ch.aspect * r);
    }
    const hy0 = zoneLimit[0] / Math.hypot(1.3, 1);
    const coreZones = zoneLimit.map((limit, z) => {
      let hx = 1.3 * hy0 * ZONE_STEP[z];
      let hy = hy0;
      const k = Math.min(1, limit / Math.hypot(hx, hy));
      hx *= k;
      hy *= k;
      const layout = coreLayout(hx, hy);
      return { hx, hy, area: 4 * hx * hy, rooms: layout.rooms, lifts: layout.lifts };
    });
    const cc = Math.cos(rot0);
    const cs = Math.sin(rot0);

    // Perimeter columns: n evenly spaced plate vertices, inset 1.2 m.
    const nCols = clamp(Math.round((Math.PI * tWidth) / 9), 8, 20);

    const floorList = new Array(tFloors);
    for (let f = 0; f < tFloors; f++) {
      const t = f / (tFloors - 1);
      const z = f * FLOOR_HEIGHT;
      const fr = frame(t);
      // TAPER: radius = base · bulge(t) · taper(t) · roof ease-in(t)
      const r = baseRadius * radiusFactor(t, ch);
      const points2D = new Float32Array(M * 2);
      writePlate(points2D, unit, fr.cx, fr.cy, fr.rot, r);
      for (let j = 0; j < M; j++) grow(points2D[2 * j], points2D[2 * j + 1], z);
      // Area is invariant to rotation/translation: unit area scaled by r².
      const area = unit.area * r * r;
      gfa += area;

      const zone = zoneOf(f);
      const { hx, hy } = coreZones[zone];
      const core2D = new Float32Array(8);
      [
        [-hx, -hy],
        [hx, -hy],
        [hx, hy],
        [-hx, hy],
      ].forEach(([lx, ly], q) => {
        core2D[2 * q] = fr.cx + lx * cc - ly * cs;
        core2D[2 * q + 1] = fr.cy + lx * cs + ly * cc;
      });

      const columns2D = new Float32Array(nCols * 2);
      for (let k = 0; k < nCols; k++) {
        const j = Math.round((k * M) / nCols) % M;
        const px = points2D[2 * j];
        const py = points2D[2 * j + 1];
        const l = Math.hypot(fr.cx - px, fr.cy - py) || 1;
        columns2D[2 * k] = px + ((fr.cx - px) / l) * 1.2;
        columns2D[2 * k + 1] = py + ((fr.cy - py) / l) * 1.2;
      }

      floorList[f] = {
        index: f,
        z,
        t,
        cx: fr.cx,
        cy: fr.cy,
        rot: fr.rot,
        r,
        area,
        nia: area - coreZones[zone].area,
        zone,
        mep: boundaries.includes(f),
        core2D,
        columns2D,
        points2D,
      };
    }

    // Fins: vertex k·finStride of every plate, so each rib twists and sways
    // with the plates. Ribs stop cleanly at the roof plate.
    const finStride = M / finCount;
    const fins = [];
    for (let k = 0; k < finCount; k++) {
      const j = k * finStride;
      const poly = new Float32Array(tFloors * 3);
      for (let f = 0; f < tFloors; f++) {
        const p = floorList[f].points2D;
        poly[3 * f] = p[2 * j];
        poly[3 * f + 1] = p[2 * j + 1];
        poly[3 * f + 2] = floorList[f].z;
      }
      fins.push(poly);
    }

    return {
      index: i,
      name: ch.name,
      character: ch,
      x: L.x,
      y: L.y,
      sx,
      sy,
      phase,
      twistDir,
      finCount,
      coreRot: rot0,
      coreZones,
      mepFloors: boundaries,
      floors: floorList,
      fins,
    };
  });

  const podium = buildPodium(towers, width, floors);
  for (let i = 0; i < podium.outline2D.length; i += 2) grow(podium.outline2D[i], podium.outline2D[i + 1], podium.height);

  // Links
  const bridgeWidth = clamp(width * 0.32, 8, 17);
  const minFloor = Math.ceil(podium.height / FLOOR_HEIGHT) + 3;
  const pairs = connectionPairs(nTowers, mode);
  const bridges = [];
  pairs.forEach(([a, b], c) => {
    const pairFloors = Math.min(towers[a].floors.length, towers[b].floors.length);
    const slots = bridgeSlots(nBridges, pairFloors, minFloor);
    // In all-to-all, diagonals cross over the ring centre; stepping each
    // connection down by 2·c floors keeps crossing links clear of each other.
    const shift = mode === 'all' ? 2 * c : 0;
    slots.forEach((slot) => {
      const floor = clamp(slot.floor - shift, minFloor, pairFloors - 1 - slot.storeys);
      const br = buildBridge(towers[a], towers[b], { ...slot, floor }, bridgeWidth);
      for (let i = 0; i < br.outline2D.length; i += 2) grow(br.outline2D[i], br.outline2D[i + 1], br.zMax);
      bridges.push(br);
    });
  });

  return {
    params: { floors, width, towers: nTowers, sway, twist, bridges: nBridges, mode },
    towers,
    bridges,
    podium,
    context: buildContext(towers, podium),
    bounds,
    stats: {
      gfa,
      floors,
      totalFloors,
      height: floors * FLOOR_HEIGHT,
      towers: nTowers,
      bridges: bridges.length,
      sway,
      twist,
      finCount: finCountFor(width),
    },
  };
}

/* ---------------------------------------------------------------------------
 * Urban context + people (seeded, so it is stable while sliders move)
 * ------------------------------------------------------------------------- */

/** Small deterministic PRNG (mulberry32). */
function rng32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Even-odd point-in-polygon test on a flat [x,y,…] array. */
export function pointInPolygon(p, x, y) {
  let inside = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const yi = p[i + 1];
    const yj = p[j + 1];
    if (yi > y !== yj > y && x < ((p[j] - p[i]) * (y - yi)) / (yj - yi) + p[i]) inside = !inside;
  }
  return inside;
}

export const CONTEXT = {
  GRID: 84, //    street grid pitch (m)
  STREET: 14, //  street width (m)
  EXTENT: 640, // radius of generated context (m)
  RING: 14, //    ring road width (m)
};

/**
 * Context around the site:
 *  - plaza: paved disc from the podium edge out to `plazaR`
 *  - ring road around the plaza, then an orthogonal street grid beyond it,
 *    with streets clipped where they would enter the ring
 *  - blocks: grid cells inset by sidewalks, split into 1–4 lots of clay
 *    massing; heights fall off with distance (taller "downtown" near the site)
 *    and stay well below the towers; ~12 % of cells are parks
 *  - trees: along every street, around the plaza edge and scattered in parks
 *  - people (1.6–1.9 m): on the plaza, on sidewalks and on the podium roof
 */
let contextCache = { key: '', value: null };

function buildContext(towers, podium) {
  const p = podium.outline2D;
  let rPodExact = 0;
  for (let i = 0; i < p.length; i += 2) rPodExact = Math.max(rPodExact, Math.hypot(p[i], p[i + 1]));
  // Context only depends on the site footprint; cache it (2 m steps) so
  // dragging sway / twist does not regenerate the city every frame.
  const rPod = Math.ceil(rPodExact / 2) * 2;
  const tallestKey = towers.reduce((m, T) => Math.max(m, T.floors.length), 0);
  const key = `${rPod}|${tallestKey}|${podium.height}|${towers.length}|${towers.map((T) => T.floors[0].cx.toFixed(0)).join(',')}`;
  if (contextCache.key === key) return contextCache.value;
  const value = buildContextUncached(towers, podium, rPod);
  contextCache = { key, value };
  return value;
}

function buildContextUncached(towers, podium, rPod) {
  const rnd = rng32(20261016);
  const { GRID, STREET, EXTENT, RING } = CONTEXT;
  const p = podium.outline2D;
  const plazaR = rPod + 22;
  const ringR = plazaR + RING / 2;
  const clearR = ringR + RING / 2 + 8;
  const tallest = towers.reduce((m, T) => Math.max(m, T.floors[T.floors.length - 1].z), 0);
  const hCap = Math.max(24, tallest * 0.28);

  // Streets (clipped by the ring)
  const streets = [];
  const nLines = Math.ceil(EXTENT / GRID);
  for (let k = -nLines; k <= nLines; k++) {
    const c = k * GRID;
    for (const vertical of [true, false]) {
      const spans = [];
      if (Math.abs(c) < ringR) {
        const e = Math.sqrt(ringR * ringR - c * c);
        spans.push([-EXTENT, -e], [e, EXTENT]);
      } else spans.push([-EXTENT, EXTENT]);
      for (const [a, b] of spans) {
        streets.push(vertical ? { x0: c, y0: a, x1: c, y1: b } : { x0: a, y0: c, x1: b, y1: c });
      }
    }
  }

  // Blocks, parks
  const blocks = [];
  const trees = [];
  const inset = STREET / 2 + 3.5;
  for (let i = -nLines; i < nLines; i++) {
    for (let j = -nLines; j < nLines; j++) {
      const x0 = i * GRID + inset;
      const x1 = (i + 1) * GRID - inset;
      const y0 = j * GRID + inset;
      const y1 = (j + 1) * GRID - inset;
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const d = Math.hypot(cx, cy);
      if (d > EXTENT) continue;
      const park = rnd() < 0.12;
      if (park) {
        const n = Math.round((x1 - x0) * (y1 - y0) * 0.006);
        for (let t = 0; t < n; t++) {
          const x = x0 + rnd() * (x1 - x0);
          const y = y0 + rnd() * (y1 - y0);
          if (Math.hypot(x, y) > clearR) trees.push({ x, y, r: 2.4 + rnd() * 1.6, h: 7 + rnd() * 5 });
        }
        continue;
      }
      const sx = rnd() < 0.6 ? 2 : 1;
      const sy = rnd() < 0.6 ? 2 : 1;
      const falloff = clamp(1 - (d - clearR) / 420, 0.15, 1);
      for (let a = 0; a < sx; a++) {
        for (let b = 0; b < sy; b++) {
          const lx0 = x0 + ((x1 - x0) * a) / sx + 2.5;
          const lx1 = x0 + ((x1 - x0) * (a + 1)) / sx - 2.5;
          const ly0 = y0 + ((y1 - y0) * b) / sy + 2.5;
          const ly1 = y0 + ((y1 - y0) * (b + 1)) / sy - 2.5;
          const k = 0.7 + rnd() * 0.3;
          const w = (lx1 - lx0) * k;
          const dd = (ly1 - ly0) * (0.7 + rnd() * 0.3);
          const bx = (lx0 + lx1) / 2;
          const by = (ly0 + ly1) / 2;
          // footprint must stay clear of the plaza / ring
          const near = Math.hypot(Math.max(Math.abs(bx) - w / 2, 0), Math.max(Math.abs(by) - dd / 2, 0));
          if (near < clearR) continue;
          const storeys = Math.max(3, Math.round((10 + Math.pow(rnd(), 1.8) * hCap * falloff) / 3.5));
          blocks.push({ x: bx, y: by, w, d: dd, h: storeys * 3.5 });
        }
      }
    }
  }

  // Street trees, both sides, every 13 m, outside the ring
  for (const s of streets) {
    const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
    const ux = (s.x1 - s.x0) / len;
    const uy = (s.y1 - s.y0) / len;
    for (let t = 6; t < len; t += 13) {
      for (const side of [-1, 1]) {
        const x = s.x0 + ux * t - uy * side * (STREET / 2 + 1.6);
        const y = s.y0 + uy * t + ux * side * (STREET / 2 + 1.6);
        if (Math.hypot(x, y) > clearR - 4 && Math.hypot(x, y) < EXTENT) trees.push({ x, y, r: 2 + rnd() * 1.2, h: 6 + rnd() * 3 });
      }
    }
  }
  // Plaza edge trees
  const nPlaza = Math.round((2 * Math.PI * (plazaR - 4)) / 11);
  for (let k = 0; k < nPlaza; k++) {
    const a = (2 * Math.PI * k) / nPlaza;
    trees.push({ x: Math.cos(a) * (plazaR - 4), y: Math.sin(a) * (plazaR - 4), r: 2.6, h: 8 });
  }

  // People
  const people = [];
  const person = (x, y, z) => people.push({ x, y, z, h: 1.6 + rnd() * 0.3, tone: Math.floor(rnd() * 6) });
  for (let n = 0; n < 160; n++) {
    const a = rnd() * Math.PI * 2;
    const r = rPod + 3 + rnd() * (plazaR - rPod - 9);
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (!pointInPolygon(p, x, y)) person(x, y, 0);
  }
  for (let n = 0; n < 220; n++) {
    const s = streets[Math.floor(rnd() * streets.length)];
    const t = rnd();
    const side = rnd() < 0.5 ? -1 : 1;
    const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
    const ux = (s.x1 - s.x0) / len;
    const uy = (s.y1 - s.y0) / len;
    const off = STREET / 2 + 0.8 + rnd() * 2;
    const x = s.x0 + (s.x1 - s.x0) * t - uy * side * off;
    const y = s.y0 + (s.y1 - s.y0) * t + ux * side * off;
    if (Math.hypot(x, y) > clearR - 4 && Math.hypot(x, y) < EXTENT * 0.8) person(x, y, 0);
  }
  for (let n = 0; n < 80; n++) {
    const a = rnd() * Math.PI * 2;
    const r = rnd() * rPod;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (!pointInPolygon(p, x, y)) continue;
    if (towers.some((T) => pointInPolygon(T.floors[0].points2D, x, y))) continue;
    person(x, y, podium.height);
  }

  return { plazaR, ring: { r: ringR, width: RING }, street: STREET, streets, blocks, trees, people };
}

/* ---------------------------------------------------------------------------
 * Floor fit-out (computed on demand for the plan level)
 * ------------------------------------------------------------------------- */

const CORRIDOR = 1.6; // m of corridor around the core on residential floors

/**
 * Fit out one floor of one tower. Works in the core's frame (origin = plate
 * centre, x along the core's long axis) using polar rays: for any angle θ,
 *   rIn(θ)  = distance to the corridor edge (core rect grown by CORRIDOR)
 *   rOut(θ) = distance to the facade (ray-cast on the twisted plate) − 0.3 m
 * Use follows the floor: podium-height floors = LOBBY, MEP floors = PLANT,
 * the lowest lift zone of a multi-zone tower = OFFICE, everything else =
 * RESIDENTIAL.
 *
 * Returns world-space data the plan draws directly:
 *   { use, walls: [x0,y0,x1,y1,…], rooms: [{x,y,text}],
 *     furniture: [{type, x, y, w, d, rot}], people: [{x, y, rot}] }
 */
export function floorFitout(tower, level, podium) {
  const F = tower.floors[level];
  if (!F) return null;
  const zone = tower.coreZones[F.zone];
  const rot = tower.coreRot;
  const cc = Math.cos(rot);
  const cs = Math.sin(rot);
  const rnd = rng32(tower.index * 7919 + level * 104729 + 1);
  const hxc = zone.hx + CORRIDOR;
  const hyc = zone.hy + CORRIDOR;

  const use = F.mep
    ? 'plant'
    : F.z < podium.height
      ? 'lobby'
      : tower.mepFloors.length && F.zone === 0
        ? 'office'
        : 'residential';

  const W = (lx, ly) => [F.cx + lx * cc - ly * cs, F.cy + lx * cs + ly * cc];
  const rIn = (th) => Math.min(hxc / Math.max(Math.abs(Math.cos(th)), 1e-6), hyc / Math.max(Math.abs(Math.sin(th)), 1e-6));
  const rOut = (th) => {
    const dx = Math.cos(th + rot);
    const dy = Math.sin(th + rot);
    return rayHitPolygon(F.points2D, F.cx, F.cy, dx, dy) - 0.3;
  };
  const polar = (th, r) => W(Math.cos(th) * r, Math.sin(th) * r);

  const walls = [];
  const rooms = [];
  const furniture = [];
  const people = [];
  const wall = (a, b) => walls.push(a[0], a[1], b[0], b[1]);
  const item = (type, th, r, w, d, turn = 0) => {
    const [x, y] = polar(th, r);
    furniture.push({ type, x, y, w, d, rot: th + rot + turn });
  };
  const insideLease = (lx, ly, margin = 0.8) => {
    if (Math.abs(lx) < hxc + margin && Math.abs(ly) < hyc + margin) return false;
    const th = Math.atan2(ly, lx);
    return Math.hypot(lx, ly) < rOut(th) - margin;
  };
  const scatterPeople = (n) => {
    for (let k = 0, tries = 0; k < n && tries < n * 20; tries++) {
      const th = rnd() * Math.PI * 2;
      const r = rIn(th) + 0.8 + rnd() * Math.max(0, rOut(th) - rIn(th) - 1.6);
      const lx = Math.cos(th) * r;
      const ly = Math.sin(th) * r;
      if (!insideLease(lx, ly, 0.5)) continue;
      const [x, y] = W(lx, ly);
      people.push({ x, y, rot: rnd() * Math.PI * 2 });
      k++;
    }
  };
  const corridorWalls = () => {
    const c = [W(-hxc, -hyc), W(hxc, -hyc), W(hxc, hyc), W(-hxc, hyc)];
    for (let q = 0; q < 4; q++) wall(c[q], c[(q + 1) % 4]);
  };

  if (use === 'residential') {
    corridorWalls();
    const perim = 2 * Math.PI * F.r * (1 + tower.character.aspect) * 0.5;
    const n = clamp(Math.round(perim / 14), 4, 10);
    const span = (2 * Math.PI) / n;
    for (let k = 0; k < n; k++) {
      const a = span * k + span / 2;
      wall(polar(a, rIn(a)), polar(a, rOut(a)));
    }
    for (let k = 0; k < n; k++) {
      const a0 = span * k + span / 2;
      const am = a0 + span / 2;
      const ri = rIn(am);
      const depth = rOut(am) - ri;
      const arcMid = (ri + depth * 0.6) * span;
      rooms.push({ ...xy(polar(am, ri + depth * 0.5)), text: `APT ${String(k + 1).padStart(2, '0')}` });
      // bed/living partition, partial from 35 % depth to the facade
      const as = a0 + span * 0.48;
      wall(polar(as, rIn(as) + (rOut(as) - rIn(as)) * 0.35), polar(as, rOut(as)));
      // bathroom pod near the corridor on the bedroom side
      const ab = a0 + span * 0.24;
      item('bathroom', ab, rIn(ab) + 1.5, Math.min(2.6, arcMid * 0.4), 2.4, Math.PI / 2);
      // bedroom: bed with its head against the partition side
      const abd = a0 + span * 0.24;
      item('bed', abd, rIn(abd) + (rOut(abd) - rIn(abd)) * 0.72, 1.6, 2.0);
      if (depth > 6.5 && arcMid > 5.5) {
        const al = a0 + span * 0.74;
        const rl = rIn(al);
        const dl = rOut(al) - rl;
        item('counter', al, rl + 0.6, Math.min(3.2, (rl + 0.6) * span * 0.35), 0.65, Math.PI / 2);
        item('dining', al, rl + dl * 0.4, 1.6, 0.9, Math.PI / 2);
        item('sofa', al, rl + dl * 0.84, 2.2, 0.9, Math.PI / 2);
        item('coffee', al, rl + dl * 0.68, 1.0, 0.55, Math.PI / 2);
      } else {
        const al = a0 + span * 0.74;
        item('sofa', al, rIn(al) + (rOut(al) - rIn(al)) * 0.75, 2.0, 0.85, Math.PI / 2);
      }
      item('plant', a0 + span * 0.92, rOut(a0 + span * 0.92) - 0.6, 0.6, 0.6);
    }
    scatterPeople(Math.round(n * 0.6));
  } else if (use === 'office') {
    // two meeting rooms on the core's long axis, the rest open-plan desks
    const meet = [0, Math.PI];
    const half = 0.32;
    for (const m of meet) {
      for (const e of [m - half, m + half]) wall(polar(e, rIn(e)), polar(e, rOut(e)));
      const r = rIn(m) + (rOut(m) - rIn(m)) * 0.5;
      item('meeting', m, r, Math.min(3.6, (rOut(m) - rIn(m)) * 0.5), 1.4, Math.PI / 2);
      rooms.push({ ...xy(polar(m, rIn(m) + 0.9)), text: 'MEET' });
    }
    const inMeeting = (lx, ly) => {
      const th = Math.atan2(ly, lx);
      return meet.some((m) => Math.abs(Math.atan2(Math.sin(th - m), Math.cos(th - m))) < half + 0.12);
    };
    const R = F.r * 1.1;
    for (let lx = -R; lx <= R; lx += 4.2) {
      for (let ly = -R; ly <= R; ly += 3.8) {
        const ok = [
          [-2, -1.4],
          [2, -1.4],
          [2, 1.4],
          [-2, 1.4],
        ].every(([ox, oy]) => insideLease(lx + ox, ly + oy, 0.4) && !inMeeting(lx + ox, ly + oy));
        if (!ok) continue;
        const [x, y] = W(lx, ly);
        furniture.push({ type: 'desks', x, y, w: 3.2, d: 1.6, rot });
        if (rnd() < 0.45) people.push({ x: x + (rnd() - 0.5) * 2, y: y + (rnd() - 0.5) * 2, rot: rnd() * 6.28 });
      }
    }
    rooms.push({ ...xy(polar(Math.PI / 2, rIn(Math.PI / 2) + 2.2)), text: 'OPEN-PLAN OFFICE' });
    scatterPeople(4);
  } else if (use === 'lobby') {
    const a = -Math.PI / 2;
    item('reception', a, rIn(a) + 2.6, 5.5, 1.1, Math.PI / 2);
    for (const q of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) {
      item('lounge', q, rIn(q) + (rOut(q) - rIn(q)) * 0.55, 3, 2.4, Math.PI / 2);
    }
    for (let k = 0; k < 8; k++) {
      const q = (k / 8) * Math.PI * 2;
      item('plant', q, rOut(q) - 0.8, 0.8, 0.8);
    }
    rooms.push({ ...xy(polar(a, rIn(a) + 5)), text: 'LOBBY' });
    scatterPeople(10);
  } else {
    corridorWalls();
    for (let k = 0; k < 6; k++) {
      const q = (k / 6) * Math.PI * 2 + 0.3;
      item('ahu', q, rIn(q) + (rOut(q) - rIn(q)) * 0.5, 4.2, 2.2, Math.PI / 2);
    }
    rooms.push({ ...xy(polar(Math.PI / 2, rIn(Math.PI / 2) + 2)), text: 'PLANT / REFUGE' });
    scatterPeople(1);
  }

  return { use, walls, rooms, furniture, people };
}

function xy([x, y]) {
  return { x, y };
}

/* ---------------------------------------------------------------------------
 * Helpers the drawing views use to read the data (no form logic).
 * ------------------------------------------------------------------------- */

/**
 * Intersect a closed polygon (flat [x,y,…]) with a section line.
 *   axis 'x' → line y = pos, returns [u0,u1] intervals in x
 *   axis 'y' → line x = pos, returns [u0,u1] intervals in y
 */
export function cutPolygonAtLine(pts, axis, pos) {
  const k = axis === 'x' ? 1 : 0;
  const u = 1 - k;
  const M = pts.length / 2;
  const hits = [];
  for (let j = 0; j < M; j++) {
    const n = (j + 1) % M;
    const a = pts[2 * j + k] - pos;
    const b = pts[2 * n + k] - pos;
    if (a < 0 !== b < 0) {
      const s = a / (a - b);
      hits.push(pts[2 * j + u] + s * (pts[2 * n + u] - pts[2 * j + u]));
    }
  }
  hits.sort((p, q) => p - q);
  const segs = [];
  for (let i = 0; i + 1 < hits.length; i += 2) segs.push([hits[i], hits[i + 1]]);
  return segs;
}

/** Range of the coordinate the section line slides along. */
export function sectionRange(bounds, axis) {
  return axis === 'x' ? [bounds.minY, bounds.maxY] : [bounds.minX, bounds.maxX];
}
