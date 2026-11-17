/**
 * seedParams.js
 *
 * One seed → one tower. Shared by the widget (?widget=1&seed=N) and the normal
 * app (?seed=N presets the sliders), so both show the same building.
 *
 * Every value stays inside a band that reads as a buildable tower:
 *   - slenderness (height / plate width) between about 5 and 10
 *   - strong twist goes with gentle sway (and vice versa), so nothing corkscrews
 *   - 1 tower has no bridges; 3–4 towers link in pairs or a chain, never
 *     all-to-all, so bridges never cross
 *   - bridges per link are capped by height, so the slots keep their spacing
 */

/** mulberry32: small, fast, deterministic. */
export function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Parse ?seed= into a 32-bit integer, or null when absent / not a number. */
export function parseSeed(raw) {
  if (raw == null || raw === '') return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n | 0 : null;
}

/**
 * Parameters for generateTower(). Slider values are rounded to the slider
 * steps so the normal app shows exactly these values on its controls.
 */
export function paramsFromSeed(seed) {
  // Scramble the seed first so neighbouring seeds (41, 42, 43) differ a lot.
  const rnd = mulberry32(Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b));
  rnd();
  const pick = (lo, hi) => lo + (hi - lo) * rnd();

  // Tower count: pairs are the typology's home; singles and clusters less so.
  const r = rnd();
  const towers = r < 0.2 ? 1 : r < 0.6 ? 2 : r < 0.85 ? 3 : 4;

  // Height of the tallest tower. Clusters stay a little lower.
  const floors = Math.round(pick(towers >= 3 ? 50 : 55, towers >= 3 ? 100 : 112));
  const heightM = floors * 3.5;

  // Plate width keeps slenderness between ~5 and ~10.
  const wMin = Math.max(towers === 1 ? 30 : 26, Math.ceil(heightM / 10));
  const wMax = Math.min(towers === 1 ? 54 : 46, Math.floor(heightM / 5));
  const width = Math.round(pick(wMin, Math.max(wMin, wMax)));

  // Twist 0–360°, sway limited by twist: a strongly wound tower sways less.
  const twist = Math.round(Math.pow(rnd(), 0.85) * 360);
  const swayCap = twist > 240 ? 8 : twist > 150 ? 14 : 22;
  const sway = Math.round(pick(0, swayCap) * 2) / 2;

  // Shape extras (no sliders): taper, plate depth, fin density.
  const taper = Math.round(pick(0.04, 0.2) * 100) / 100;
  const depth = Math.round(pick(0.9, 1.1) * 100) / 100;
  const finDensity = Math.round(pick(0.75, 1.3) * 100) / 100;

  // Bridges per link (0 for a single tower), capped by height.
  const maxBridges = clamp(Math.floor(floors / 28), 1, 4);
  const bridges = towers === 1 ? 0 : 1 + Math.floor(rnd() * maxBridges);
  const mode = towers >= 3 && rnd() < 0.5 ? 'chain' : 'adjacent';

  return { floors, width, sway, twist, towers, bridges, mode, taper, depth, finDensity };
}

/** Short label, e.g. "Twin Twist", "Swaying Trio", "Tapered Solo". */
export function typeName(p) {
  const noun = ['Solo', 'Twin', 'Trio', 'Quartet'][p.towers - 1] || 'Cluster';
  if (p.sway >= 14) return `Swaying ${noun}`;
  if (p.twist >= 220) return `${noun} Helix`;
  if (p.twist >= 70) return `${noun} Twist`;
  if (p.taper >= 0.15) return `Tapered ${noun}`;
  if (p.bridges >= 3 && p.towers > 1) return `Linked ${noun}`;
  return `${noun} Spire`;
}
