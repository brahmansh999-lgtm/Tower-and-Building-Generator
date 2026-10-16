import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VILLA_SLAB, VILLA_FLOOR_HEIGHTS, VILLA_POOL_DEPTH, offsetFlat, waveAt } from '../geometry/generateVilla.js';
import { pal, lightAt, writeColor, buildContextGroup, makeQuad, setQuad } from './Viewport3D.jsx';

const CYAN = 0x4fe3ff;

/* Display-space palettes (converted to linear for vertex colours). */
const VP = {
  white: pal([0.3, 0.3, 0.31], [0.95, 0.95, 0.94]),
  roof: pal([0.45, 0.45, 0.45], [0.86, 0.86, 0.85]),
  soffit: pal([0.32, 0.32, 0.33], [0.62, 0.62, 0.63]),
  glass: pal([0.04, 0.05, 0.065], [0.32, 0.4, 0.47]),
  floor: pal([0.3, 0.27, 0.24], [0.58, 0.53, 0.47]),
  wall: pal([0.35, 0.35, 0.35], [0.85, 0.85, 0.84]),
  furn: pal([0.2, 0.19, 0.18], [0.66, 0.62, 0.58]),
  soft: pal([0.18, 0.2, 0.24], [0.42, 0.48, 0.56]),
  water: pal([0.03, 0.14, 0.18], [0.12, 0.42, 0.5]),
  coping: pal([0.45, 0.45, 0.44], [0.9, 0.9, 0.88]),
  deck: pal([0.16, 0.11, 0.07], [0.42, 0.3, 0.2]),
  lawn: pal([0.05, 0.075, 0.05], [0.12, 0.17, 0.11]),
  paving: pal([0.12, 0.12, 0.12], [0.3, 0.3, 0.3]),
  boundary: pal([0.25, 0.25, 0.25], [0.6, 0.6, 0.6]),
};

/** Furniture block heights (m) for the cut-open model. */
const FURN_H = {
  bed: 0.55,
  sofa: 0.8,
  armchair: 0.8,
  coffee: 0.42,
  dining: 0.76,
  island: 0.92,
  counter: 0.92,
  bathroom: 2.3,
  wardrobe: 2.2,
  desk: 0.76,
  tv: 0.6,
  bench: 0.45,
  plant: 1.1,
  car: 1.45,
  lounger: 0.4,
  tub: 0.58,
  wc: 0.42,
  vanity: 0.88,
  shower: 0.12,
  appliance: 0.88,
  rug: 0.015,
};

/**
 * Geometry accumulator: rings, bands, earcut caps and boxes into one
 * vertex-coloured mesh. Shading is baked from analytic normals (lightAt).
 */
class Builder {
  constructor() {
    this.pos = [];
    this.col = [];
    this.idx = [];
  }
  vert(x, y, z, k, p) {
    const o = this.pos.length;
    this.pos.push(x, y, z);
    const c = [0, 0, 0];
    writeColor(c, 0, k, p);
    this.col.push(c[0], c[1], c[2]);
    return o / 3;
  }
  /** One ring (flat [x,y,…]) at height z (number or fn(x,y)); normals from its tangent. */
  ring(r, z, p) {
    const n = r.length / 2;
    const base = this.pos.length / 3;
    for (let j = 0; j < n; j++) {
      const a = (j - 1 + n) % n;
      const b = (j + 1) % n;
      const tx = r[2 * b] - r[2 * a];
      const ty = r[2 * b + 1] - r[2 * a + 1];
      const l = Math.hypot(tx, ty) || 1;
      const x = r[2 * j];
      const y = r[2 * j + 1];
      this.vert(x, y, typeof z === 'function' ? z(x, y) : z, lightAt(ty / l, -tx / l, 0), p);
    }
    return base;
  }
  /** Vertical band between two rings with the same vertex count. */
  band(ra, za, rb, zb, p) {
    const n = ra.length / 2;
    const a = this.ring(ra, za, p);
    const b = this.ring(rb, zb, p);
    for (let j = 0; j < n; j++) {
      const j2 = (j + 1) % n;
      this.idx.push(a + j, a + j2, b + j2, a + j, b + j2, b + j);
    }
  }
  /** Horizontal cap with optional holes, triangulated by earcut. */
  cap(outline, holes, z, p, up = true) {
    const toV = (f) => {
      const v = [];
      for (let i = 0; i < f.length; i += 2) v.push(new THREE.Vector2(f[i], f[i + 1]));
      return v;
    };
    const contour = toV(outline);
    const hs = holes.filter(Boolean).map(toV);
    const faces = THREE.ShapeUtils.triangulateShape(contour, hs);
    const all = contour.concat(...hs);
    const k = lightAt(0, 0, up ? 1 : -1);
    const base = this.pos.length / 3;
    for (const v of all) this.vert(v.x, v.y, typeof z === 'function' ? z(v.x, v.y) : z, k, p);
    for (const f of faces) this.idx.push(base + f[0], base + f[1], base + f[2]);
  }
  /** Oriented box: centre (x, y), base z0, size w × d × h, rotation about z. */
  box(x, y, z0, w, d, h, rot, p) {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const P = (u, v) => [x + u * c - v * s, y + u * s + v * c];
    const hw = w / 2;
    const hd = d / 2;
    const corners = [P(-hw, -hd), P(hw, -hd), P(hw, hd), P(-hw, hd)];
    for (let q = 0; q < 4; q++) {
      const [ax, ay] = corners[q];
      const [bx, by] = corners[(q + 1) % 4];
      const l = Math.hypot(bx - ax, by - ay) || 1;
      const k = lightAt((by - ay) / l, -(bx - ax) / l, 0);
      const i0 = this.vert(ax, ay, z0, k, p);
      this.vert(bx, by, z0, k, p);
      this.vert(bx, by, z0 + h, k, p);
      this.vert(ax, ay, z0 + h, k, p);
      this.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
    }
    const kt = lightAt(0, 0, 1);
    const t0 = this.vert(...corners[0], z0 + h, kt, p);
    for (let q = 1; q < 4; q++) this.vert(...corners[q], z0 + h, kt, p);
    this.idx.push(t0, t0 + 1, t0 + 2, t0, t0 + 2, t0 + 3);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    return g;
  }
}

function circleRing(x, y, r, n = 12) {
  const f = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    f[2 * i] = x + Math.cos(a) * r;
    f[2 * i + 1] = y + Math.sin(a) * r;
  }
  return f;
}

/**
 * Building shell, per level and per contour (outline and courtyard hole):
 *   upper levels: rounded white soffit ribbon under the floor (cantilevers)
 *   glazing recessed 0.35 m, from floor to the underside of the top ribbon
 *   white top ribbon with a rounded nose, then the roof cap
 * The top level's ribbon, glazing head and roof follow the roof wave.
 */
function buildShell(b, villa) {
  const nLevels = villa.levels.length;
  villa.levels.forEach((L, i) => {
    const z0 = L.z;
    const z1 = L.z + L.height;
    const isTop = i === nLevels - 1;
    const w = (x, y) => (isTop ? waveAt(villa.roof?.wave, x, y) : 0);
    const at = (z) => (x, y) => z + w(x, y);
    const contours = [L.outline, L.hole].filter(Boolean);
    for (const C of contours) {
      const off = (d) => offsetFlat(C, d);
      if (i > 0) {
        b.band(off(-0.2), z0 - 0.45, off(0), z0 - 0.3, VP.white);
        b.band(off(0), z0 - 0.3, off(0), z0 + 0.15, VP.white);
        b.band(off(0), z0 + 0.15, off(-0.15), z0 + 0.3, VP.white);
      }
      b.band(off(-0.35), i > 0 ? z0 + 0.3 : z0, off(-0.35), at(z1 - VILLA_SLAB), VP.glass);
      b.band(off(-0.15), at(z1 - VILLA_SLAB), off(0.05), at(z1 - VILLA_SLAB + 0.15), VP.white);
      b.band(off(0.05), at(z1 - VILLA_SLAB + 0.15), off(0.05), at(z1 - 0.15), VP.white);
      b.band(off(0.05), at(z1 - 0.15), off(-0.15), at(z1), VP.white);
    }
    const hole = L.hole ? offsetFlat(L.hole, -0.15) : null;
    b.cap(offsetFlat(L.outline, -0.15), [hole], at(z1), VP.roof, true);
    if (i > 0) b.cap(offsetFlat(L.outline, -0.2), [L.hole && offsetFlat(L.hole, -0.2)], z0 - 0.45, VP.soffit, false);
    // interior floor finish (seen when the model is cut)
    b.cap(offsetFlat(L.outline, -0.35), [L.hole && offsetFlat(L.hole, -0.35)], z0 + (i > 0 ? 0.31 : 0.02), VP.floor, true);
  });

  if (villa.canopy) {
    const c = villa.canopy;
    const zb = (x, y) => c.z + waveAt(c.wave, x, y);
    const zt = (x, y) => zb(x, y) + c.thickness;
    b.cap(c.outline, [], zb, VP.soffit, false);
    b.cap(c.outline, [], zt, VP.roof, true);
    b.band(offsetFlat(c.outline, -0.1), zb, offsetFlat(c.outline, 0.05), (x, y) => zb(x, y) + c.thickness / 2, VP.white);
    b.band(offsetFlat(c.outline, 0.05), (x, y) => zb(x, y) + c.thickness / 2, offsetFlat(c.outline, -0.1), zt, VP.white);
    // tree-like tapered columns
    for (const [x, y] of c.columns) {
      const top = zb(x, y);
      b.band(circleRing(x, y, 0.22), 0, circleRing(x, y, 0.3), top * 0.6, VP.white);
      b.band(circleRing(x, y, 0.3), top * 0.6, circleRing(x, y, 0.9), top, VP.white);
    }
  }
}

/** Interior: partition walls, furniture blocks, stair (visible when cut). */
function buildInterior(b, villa) {
  villa.levels.forEach((L, i) => {
    const floor = L.z + (i > 0 ? 0.31 : 0.02);
    const wallH = L.height - VILLA_SLAB - (i > 0 ? 0.31 : 0.02);
    for (let k = 0; k < L.walls.length; k += 4) {
      const [x0, y0, x1, y1] = [L.walls[k], L.walls[k + 1], L.walls[k + 2], L.walls[k + 3]];
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len < 0.05) continue;
      b.box((x0 + x1) / 2, (y0 + y1) / 2, floor, len, 0.14, wallH, Math.atan2(y1 - y0, x1 - x0), VP.wall);
    }
    for (const f of L.furniture) {
      const h = FURN_H[f.type] || 0.6;
      const p = f.type === 'sofa' || f.type === 'armchair' || f.type === 'bed' ? VP.soft : f.type === 'bathroom' ? VP.wall : VP.furn;
      b.box(f.x, f.y, floor, f.w, f.d, h, f.rot, p);
    }
  });
  // Stair from L0 to L1
  const s = villa.stair;
  const rise = VILLA_FLOOR_HEIGHTS[0];
  const steps = 16;
  if (s.type === 'spiral') {
    for (let k = 0; k < steps; k++) {
      const a = s.rot + (k / steps) * Math.PI * 1.75;
      const r = s.w / 4 + 0.1;
      b.box(s.x + Math.cos(a) * r, s.y + Math.sin(a) * r, (k * rise) / steps, s.w / 2 - 0.15, 0.42, 0.18, a, VP.white);
    }
    b.band(circleRing(s.x, s.y, 0.16, 10), 0, circleRing(s.x, s.y, 0.16, 10), rise + 1, VP.white);
  } else {
    const c = Math.cos(s.rot);
    const sn = Math.sin(s.rot);
    for (let k = 0; k < steps; k++) {
      const v = -s.d / 2 + (s.d * (k + 0.5)) / steps;
      b.box(s.x - v * sn, s.y + v * c, (k * rise) / steps, s.w, s.d / steps + 0.02, 0.2, s.rot, VP.white);
    }
  }
}

/** Site: lawn, drive, deck, pool (water, walls, coping), boundary walls. */
function buildSite(b, villa) {
  const { plot } = villa;
  b.cap(plot.outline2D, [], 0.004, VP.lawn, true);
  b.cap(villa.drive, [], 0.012, VP.paving, true);
  if (villa.deck) b.cap(villa.deck, [], 0.03, VP.deck, true);
  if (villa.pool) {
    const P = villa.pool;
    b.cap(P, [], -0.14, VP.water, true);
    b.band(offsetFlat(P, 0), -VILLA_POOL_DEPTH, offsetFlat(P, 0), 0.06, VP.coping);
    const outer = offsetFlat(P, 0.5);
    const inner = new Float32Array(P.length);
    for (let i = 0; i < P.length; i += 2) {
      inner[P.length - 2 - i] = P[i];
      inner[P.length - 1 - i] = P[i + 1];
    }
    b.cap(outer, [inner], 0.06, VP.coping, true);
    b.band(offsetFlat(P, 0.5), 0.0, offsetFlat(P, 0.5), 0.06, VP.coping);
  }
  for (const f of villa.outdoor) b.box(f.x, f.y, 0.03, f.w, f.d, FURN_H[f.type] || 0.4, f.rot, VP.white);

  // Boundary walls (1.2 m), opening for the drive on the south edge.
  const hw = plot.w / 2;
  const hd = plot.d / 2;
  const t = 0.25;
  const H = 1.2;
  b.box(0, hd, 0, plot.w, t, H, 0, VP.boundary);
  b.box(-hw, 0, 0, t, plot.d, H, 0, VP.boundary);
  b.box(hw, 0, 0, t, plot.d, H, 0, VP.boundary);
  let dx0 = Infinity;
  let dx1 = -Infinity;
  for (let i = 0; i < villa.drive.length; i += 2) {
    dx0 = Math.min(dx0, villa.drive[i]);
    dx1 = Math.max(dx1, villa.drive[i]);
  }
  const westLen = dx0 - 1 + hw;
  const eastLen = hw - (dx1 + 1);
  if (westLen > 0) b.box(-hw + westLen / 2, -hd, 0, westLen, t, H, 0, VP.boundary);
  if (eastLen > 0) b.box(hw - eastLen / 2, -hd, 0, eastLen, t, H, 0, VP.boundary);
}

function rebuild(ctx, villa) {
  for (const m of [ctx.shell, ctx.interior, ctx.site]) {
    m.geometry.dispose();
  }
  const shell = new Builder();
  buildShell(shell, villa);
  ctx.shell.geometry = shell.geometry();
  const interior = new Builder();
  buildInterior(interior, villa);
  ctx.interior.geometry = interior.geometry();
  const site = new Builder();
  buildSite(site, villa);
  ctx.site.geometry = site.geometry();

  // Context + people (neighbours, street trees, garden, and every room).
  const inside = [];
  villa.levels.forEach((L, i) => {
    for (const p of L.people) inside.push({ x: p.x, y: p.y, z: L.z + (i > 0 ? 0.31 : 0.02), h: 1.6 + ((p.x * 13.7) % 0.3), tone: Math.abs(Math.round(p.y * 7)) % 6 });
  });
  buildContextGroup(ctx, { ...villa.context, people: villa.context.people.concat(inside) });

  if (!ctx.fitted) {
    ctx.camera.position.set(64, 40, 74);
    ctx.controls.target.set(0, 3.2, 0);
    ctx.fitted = true;
  }
}

function updateCuts(ctx, villa, planLevel, axis, pos, cut3D) {
  const { plot } = villa;
  const x0 = -plot.w / 2 - 8;
  const x1 = plot.w / 2 + 8;
  const y0 = -plot.d / 2 - 8;
  const y1 = plot.d / 2 + 8;
  const L = villa.levels[planLevel];
  const zp = L.z + 1.2;
  setQuad(ctx.planQuad, [
    [x0, y0, zp],
    [x1, y0, zp],
    [x1, y1, zp],
    [x0, y1, zp],
  ]);
  const zTop = villa.stats.height + 3;
  if (axis === 'x') {
    const y = pos + 0.02;
    setQuad(ctx.sectionQuad, [
      [x0, y, -2],
      [x1, y, -2],
      [x1, y, zTop],
      [x0, y, zTop],
    ]);
    ctx.clipPlane.normal.set(0, 0, -1);
    ctx.clipPlane.constant = -pos;
  } else {
    const x = pos + 0.02;
    setQuad(ctx.sectionQuad, [
      [x, y0, -2],
      [x, y1, -2],
      [x, y1, zTop],
      [x, y0, zTop],
    ]);
    ctx.clipPlane.normal.set(1, 0, 0);
    ctx.clipPlane.constant = -pos;
  }
  ctx.renderer.clippingPlanes = cut3D ? [ctx.clipPlane] : [];
}

export default function VillaViewport3D({ villa, planLevel, sectionAxis, sectionPos, cut3D, active = true }) {
  const mountRef = useRef(null);
  const ctxRef = useRef(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const mount = mountRef.current;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, coarse ? 1.5 : 2));
    renderer.setClearColor(0x000000, 1);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    scene.fog = new THREE.Fog(0x000000, 80, 400);

    const camera = new THREE.PerspectiveCamera(34, 1, 0.3, 3000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.35;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.minDistance = 6;
    controls.maxDistance = 600;
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

    const mats = {
      solid: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
      context: new THREE.MeshBasicMaterial({ vertexColors: true }),
      ground: new THREE.MeshBasicMaterial({ color: 0x0c0c0d }),
      cutFill: new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false, fog: false }),
      cutEdge: new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, fog: false }),
    };
    const root = new THREE.Group();
    root.rotation.x = -Math.PI / 2;
    scene.add(root);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(1500, 96), mats.ground);
    ground.position.z = -0.1;
    root.add(ground);
    const mk = () => {
      const m = new THREE.Mesh(new THREE.BufferGeometry(), mats.solid);
      m.frustumCulled = false;
      root.add(m);
      return m;
    };
    const contextGroup = new THREE.Group();
    root.add(contextGroup);
    const planQuad = makeQuad(mats.cutFill, mats.cutEdge);
    const sectionQuad = makeQuad(mats.cutFill, mats.cutEdge);
    root.add(planQuad.mesh, planQuad.edge, sectionQuad.mesh, sectionQuad.edge);

    const ctx = {
      renderer,
      scene,
      camera,
      controls,
      mats,
      shell: mk(),
      interior: mk(),
      site: mk(),
      contextGroup,
      planQuad,
      sectionQuad,
      clipPlane: new THREE.Plane(new THREE.Vector3(0, 0, -1), 0),
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
      const d = camera.position.distanceTo(controls.target);
      scene.fog.near = Math.max(1, d - 20);
      scene.fog.far = d + 260;
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

  useEffect(() => {
    const ctx = ctxRef.current;
    if (ctx) rebuild(ctx, villa);
  }, [villa]);

  useEffect(() => {
    const ctx = ctxRef.current;
    if (ctx) updateCuts(ctx, villa, planLevel, sectionAxis, sectionPos, cut3D);
  }, [villa, planLevel, sectionAxis, sectionPos, cut3D]);

  return <div className="viewport" ref={mountRef} />;
}
