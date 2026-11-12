/**
 * VREnvironment.js
 *
 * The void the building stands in: a glowing ground grid that fades to black
 * with distance, a faint horizon ring at 2 km, a slowly turning starfield and
 * black fog. Plus an abstract city of edge-only boxes around the site.
 *
 * The grid, horizon and stars live in world space (they stay at the real floor
 * in both scale modes). The city lives in model data space, so it scales with
 * the tower on the tabletop and sits at 1:1 around you at human scale.
 *
 * Unlit throughout: Line/Points/MeshBasic materials, additive blending for glow.
 */

import * as THREE from 'three';

const GRID_R = 1000; //    m, far grid radius (fixed at the origin)
const NEAR_R = 140; //     m, near grid radius (follows the viewer)
const GRID_STEP = 10; //   m between lines
const GRID_SEG = 20; //    m per line segment on the far grid
const NEAR_SEG = 5; //     m per line segment on the near grid
const GRID_BASE = [0.05, 0.13, 0.16];
const HORIZON_R = 2000;
const STAR_COUNT = 4000;
const STAR_R = 2600;
const CITY_COUNT = 220;
const CITY_EXTENT = 900;

/** Small deterministic PRNG (mulberry32) so the city is stable between builds. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Ground grid as LineSegments, lines every GRID_STEP m, split into `seg` m
 * pieces so a radial falloff can be baked per vertex. With additive blending on
 * black, darker RGB is the same as lower alpha.
 *
 * Two grids, because of how receding lines alias: lines s metres apart seen
 * from eye height h at distance d are about s*h/d^2 radians apart. Below ~2 px
 * (0.0017 rad on a Quest) they stack into a bright band at the horizon, so the
 * useful radius is d = sqrt(s*h / 0.0017): ~100 m standing (h = 1.6 m), ~900 m
 * at drone height. Hence:
 *   near grid  radius 140 m, re-centred on the viewer (snapped to the grid
 *              step so lines stay world-fixed), falloff baked around the head
 *   far grid   radius 1 km, fixed, falloff (1 - r/R)^3 from the origin
 * and a cross-fade between them by eye height.
 */
function gridGeometry(R, seg, fall) {
  const pos = [];
  const col = [];
  const push = (x, z) => {
    const k = fall ? fall(x, z) : 0;
    pos.push(x, 0, z);
    col.push(GRID_BASE[0] * k, GRID_BASE[1] * k, GRID_BASE[2] * k);
  };
  for (let c = -R; c <= R; c += GRID_STEP) {
    for (let s = -R; s < R; s += seg) {
      // segment along x at z = c, and along z at x = c
      if (Math.hypot(s, c) < R || Math.hypot(s + seg, c) < R) {
        push(s, c);
        push(s + seg, c);
        push(c, s);
        push(c, s + seg);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  return g;
}

const farFalloff = (x, z) => {
  const k = Math.max(0, 1 - Math.hypot(x, z) / GRID_R);
  return k * k * k;
};
const nearFalloff = (r) => {
  const k = Math.max(0, 1 - r / NEAR_R);
  return k * k;
};

/** Open cylinder band at the horizon, bright at the ground and fading upward. */
function horizonGeometry() {
  const g = new THREE.CylinderGeometry(HORIZON_R, HORIZON_R, 60, 160, 1, true);
  g.translate(0, 30, 0);
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const k = 1 - p.getY(i) / 60;
    col[3 * i] = 0.03 * k;
    col[3 * i + 1] = 0.09 * k;
    col[3 * i + 2] = 0.11 * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Stars on the upper hemisphere (plus a little below the horizon line). */
function starGeometry() {
  const r = rng(7);
  const pos = new Float32Array(STAR_COUNT * 3);
  const col = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    const az = r() * Math.PI * 2;
    const el = Math.asin(r() * 1.03 - 0.03); // uniform over the sphere cap
    pos[3 * i] = Math.cos(el) * Math.cos(az) * STAR_R;
    pos[3 * i + 1] = Math.sin(el) * STAR_R;
    pos[3 * i + 2] = Math.cos(el) * Math.sin(az) * STAR_R;
    const b = 0.25 + Math.pow(r(), 3) * 0.75;
    const warm = r() * 0.15;
    col[3 * i] = b;
    col[3 * i + 1] = b * (0.95 - warm * 0.3);
    col[3 * i + 2] = b * (1 - warm);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

export class VREnvironment {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'vr-environment';
    this.fog = new THREE.Fog(0x000000, 150, 2400);

    const lineMat = () =>
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
    this.gridMat = lineMat();
    this.grid = new THREE.LineSegments(gridGeometry(GRID_R, GRID_SEG, farFalloff), this.gridMat);
    this.grid.frustumCulled = false;
    this.grid.renderOrder = -2;
    this.nearMat = lineMat();
    this.nearGrid = new THREE.LineSegments(gridGeometry(NEAR_R, NEAR_SEG, null), this.nearMat);
    this.nearGrid.frustumCulled = false;
    this.nearGrid.renderOrder = -2;
    this.nearAt = new THREE.Vector3(Infinity, 0, Infinity);
    this.gridMix = 0; // 0 = near grid only, 1 = far grid only

    this.horizonMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide,
      fog: false,
    });
    this.horizon = new THREE.Mesh(horizonGeometry(), this.horizonMat);
    this.horizon.frustumCulled = false;

    this.starMat = new THREE.PointsMaterial({
      size: 7,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    this.stars = new THREE.Points(starGeometry(), this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -3;

    this.group.add(this.grid, this.nearGrid, this.horizon, this.stars);

    // City context: two LineSegments in data space (near = inside the tabletop
    // plinth, far = the rest), so the tabletop can show only what fits.
    this.cityMat = new THREE.LineBasicMaterial({ color: 0x34383f, transparent: true, opacity: 1 });
    this.cityNear = new THREE.LineSegments(new THREE.BufferGeometry(), this.cityMat);
    this.cityFar = new THREE.LineSegments(new THREE.BufferGeometry(), this.cityMat);
    this.city = new THREE.Group();
    this.city.name = 'vr-city';
    this.city.add(this.cityNear, this.cityFar);
    this.cityKey = '';
    this.cityBoxes = [];
    this.nearR = Infinity;
    this.tabletop = false;
    this.cityOn = true;
    this.reveal = 0;
  }

  /**
   * Seed 150–300 low boxes in an annulus around the podium (kept 40 m clear of
   * its widest radius), rejecting overlaps. Rebuilt only when the podium radius
   * changes meaningfully.
   */
  buildCity(model) {
    const p = model.podium.outline2D;
    let rPod = 0;
    for (let i = 0; i < p.length; i += 2) rPod = Math.max(rPod, Math.hypot(p[i], p[i + 1]));
    const key = Math.round(rPod / 10).toString();
    if (key === this.cityKey) return;
    this.cityKey = key;
    const r = rng(1913);
    const rMin = rPod + 40;
    const boxes = [];
    let tries = 0;
    while (boxes.length < CITY_COUNT && tries++ < CITY_COUNT * 30) {
      const rad = rMin + (CITY_EXTENT - rMin) * Math.sqrt(r());
      const a = r() * Math.PI * 2;
      const w = 16 + r() * 30;
      const d = 16 + r() * 30;
      const tall = r() < 0.12;
      const h = tall ? 70 + r() * 70 : 12 + Math.pow(r(), 1.6) * 55;
      const x = Math.cos(a) * rad;
      const y = Math.sin(a) * rad;
      const R = Math.hypot(w, d) / 2;
      if (boxes.some((b) => Math.hypot(b.x - x, b.y - y) < b.R + R + 8)) continue;
      boxes.push({ x, y, w, d, h, R, rad });
    }
    this.cityBoxes = boxes;
    this.rebuildCityBuckets();
  }

  /** Split boxes into near/far LineSegments using the EdgesGeometry of a unit box. */
  rebuildCityBuckets() {
    const unit = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    const u = unit.attributes.position.array; // 12 edges × 2 verts, centred on origin
    const near = [];
    const far = [];
    for (const b of this.cityBoxes) {
      const out = b.rad + b.R < this.nearR ? near : far;
      for (let i = 0; i < u.length; i += 3) {
        out.push(b.x + u[i] * b.w, b.y + u[i + 1] * b.d, (u[i + 2] + 0.5) * b.h);
      }
    }
    unit.dispose();
    for (const [obj, arr] of [
      [this.cityNear, near],
      [this.cityFar, far],
    ]) {
      obj.geometry.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      obj.geometry = g;
    }
    this.applyVisibility();
  }

  /** Tabletop shows only the boxes that fit inside the plinth (radius in data metres). */
  setTabletop(on, nearRadius) {
    this.tabletop = on;
    const r = on ? nearRadius : Infinity;
    if (r !== this.nearR) {
      this.nearR = r;
      if (this.cityBoxes.length) this.rebuildCityBuckets();
    }
    // Fog distances are world metres: at tabletop the model is ~1 m away and
    // the void should stay crisp; at 1:1 the city fades into black.
    this.fog.near = on ? 20 : 150;
    this.fog.far = on ? 400 : 2400;
    this.applyVisibility();
  }

  setCityVisible(on) {
    this.cityOn = on;
    this.applyVisibility();
  }

  applyVisibility() {
    this.cityNear.visible = this.cityOn;
    this.cityFar.visible = this.cityOn && !this.tabletop;
  }

  /** 0 = pure darkness, 1 = fully revealed (driven by the intro). */
  setReveal(k) {
    this.reveal = k;
    this.applyGridOpacity();
    this.horizonMat.opacity = k;
    this.starMat.opacity = k;
    this.cityMat.opacity = k;
  }

  applyGridOpacity() {
    this.gridMat.opacity = this.reveal * this.gridMix;
    this.nearMat.opacity = this.reveal * (1 - this.gridMix);
    this.grid.visible = this.gridMat.opacity > 0.002;
    this.nearGrid.visible = this.nearMat.opacity > 0.002;
  }

  /** Re-bake the near grid falloff around the head once it has moved 0.5 m. */
  updateNearGrid(head) {
    if (Math.hypot(head.x - this.nearAt.x, head.z - this.nearAt.z) < 0.5) return;
    this.nearAt.set(head.x, 0, head.z);
    const sx = Math.round(head.x / GRID_STEP) * GRID_STEP;
    const sz = Math.round(head.z / GRID_STEP) * GRID_STEP;
    this.nearGrid.position.set(sx, 0, sz);
    const p = this.nearGrid.geometry.attributes.position.array;
    const c = this.nearGrid.geometry.attributes.color;
    const col = c.array;
    for (let i = 0; i < p.length; i += 3) {
      const k = nearFalloff(Math.hypot(p[i] + sx - head.x, p[i + 2] + sz - head.z));
      col[i] = GRID_BASE[0] * k;
      col[i + 1] = GRID_BASE[1] * k;
      col[i + 2] = GRID_BASE[2] * k;
    }
    c.needsUpdate = true;
  }

  /** Stars centred on the viewer (infinitely far) and turning slowly; grids by eye height. */
  update(dt, headWorld) {
    this.stars.position.set(headWorld.x, 0, headWorld.z);
    this.stars.rotation.y += dt * 0.004;
    this.gridMix = THREE.MathUtils.smoothstep(headWorld.y, 6, 30);
    this.applyGridOpacity();
    if (this.nearGrid.visible) this.updateNearGrid(headWorld);
  }

  dispose() {
    for (const o of [this.grid, this.nearGrid, this.horizon, this.stars, this.cityNear, this.cityFar]) o.geometry.dispose();
    for (const m of [this.gridMat, this.nearMat, this.horizonMat, this.starMat, this.cityMat]) m.dispose();
  }
}
