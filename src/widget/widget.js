/**
 * widget.js — ?widget=1
 *
 * A single square, realistic still of a seeded tower and nothing else: no
 * React, no UI, no fonts, no external files. An iPhone widget script loads the
 * page in a hidden web view, waits for window.__WIDGET_READY__ and calls
 * window.getWidgetSnapshot().
 *
 * URL: widget=1, seed=<int>, size=<px> (1024), hour=<0-23> (now), format=png|jpeg (jpeg, q 0.9)
 *
 * Pipeline: seed → paramsFromSeed → generateTower → buildRealisticMeshes
 * (merged, one geometry per material) → physical materials, RoomEnvironment
 * reflections, sun + hemisphere light lit by the hour → camera fitted to the
 * cluster → one frame → loop stopped, GPU memory released except the canvas.
 *
 * Any failure still ends READY, with a plain dark image and ok: false in the
 * snapshot, so the widget script can keep its last good image instead.
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { generateTower, FLOOR_HEIGHT } from '../geometry/generateTower.js';
import { buildRealisticMeshes, palmGeometry, foliageGeometry, RM } from '../geometry/buildRealisticMeshes.js';
import { paramsFromSeed, typeName, mulberry32, parseSeed } from './seedParams.js';

const DATA_TO_WORLD = new THREE.Matrix4().makeRotationX(-Math.PI / 2); // data z-up → three y-up

/* ---------------------------------------------------------------------------
 * Time of day
 * ------------------------------------------------------------------------- */

// Anchors, interpolated by hour (wrapping). elev = sun elevation (deg).
const ANCHORS = [
  { h: 0, elev: 38, sun: 0x8ea4d6, sunI: 0.35, zen: 0x03060f, hor: 0x141b2e, gnd: 0x101216, hemiS: 0x223152, hemiG: 0x0b0c10, hemiI: 0.18, env: 0.12, exp: 1.05, win: 1.6, lit: 0.42 },
  { h: 4.5, elev: 30, sun: 0x8ea4d6, sunI: 0.3, zen: 0x050a18, hor: 0x1a2238, gnd: 0x121418, hemiS: 0x26365a, hemiG: 0x0c0d12, hemiI: 0.2, env: 0.14, exp: 1.05, win: 1.3, lit: 0.3 },
  { h: 6.5, elev: 8, sun: 0xffc9a0, sunI: 2.2, zen: 0x5a82c0, hor: 0xeec4ae, gnd: 0x6e6a64, hemiS: 0xb9c8e6, hemiG: 0x5b5248, hemiI: 0.45, env: 0.5, exp: 0.95, win: 0.35, lit: 0.18 },
  { h: 9, elev: 32, sun: 0xffe7cc, sunI: 3.0, zen: 0x3f78c8, hor: 0xc9d9ea, gnd: 0x7c7d79, hemiS: 0xcfdcf0, hemiG: 0x6d665c, hemiI: 0.5, env: 0.75, exp: 0.9, win: 0, lit: 0 },
  { h: 12.5, elev: 58, sun: 0xfff6ea, sunI: 3.4, zen: 0x2f6cc2, hor: 0xc6d8ea, gnd: 0x80817d, hemiS: 0xd8e6f8, hemiG: 0x70685c, hemiI: 0.55, env: 0.85, exp: 0.85, win: 0, lit: 0 },
  { h: 15.5, elev: 40, sun: 0xfff0dc, sunI: 3.2, zen: 0x3a74c4, hor: 0xcbdae9, gnd: 0x7e7c77, hemiS: 0xd2dff2, hemiG: 0x6e665a, hemiI: 0.5, env: 0.8, exp: 0.88, win: 0, lit: 0 },
  { h: 17.6, elev: 11, sun: 0xffa95c, sunI: 3.0, zen: 0x4a6aa4, hor: 0xf2b47c, gnd: 0x6e6258, hemiS: 0xc4c2d8, hemiG: 0x6a5240, hemiI: 0.4, env: 0.6, exp: 0.95, win: 0.2, lit: 0.12 },
  { h: 19.2, elev: 3, sun: 0xc8a6c8, sunI: 0.7, zen: 0x1c2b58, hor: 0x7f74a0, gnd: 0x2c2c36, hemiS: 0x6274a8, hemiG: 0x221f2a, hemiI: 0.4, env: 0.35, exp: 1.05, win: 1.0, lit: 0.32 },
  { h: 20.6, elev: 34, sun: 0x8ea4d6, sunI: 0.35, zen: 0x07102a, hor: 0x2a3456, gnd: 0x14161c, hemiS: 0x2d3e68, hemiG: 0x0e0f14, hemiI: 0.22, env: 0.16, exp: 1.05, win: 1.5, lit: 0.4 },
];

function lightingFor(hour) {
  const hh = ((hour % 24) + 24) % 24;
  let i = ANCHORS.length - 1;
  while (i > 0 && ANCHORS[i].h > hh) i--;
  const a = ANCHORS[i];
  const b = ANCHORS[(i + 1) % ANCHORS.length];
  const span = (b.h - a.h + 24) % 24 || 24;
  const t = ((hh - a.h + 24) % 24) / span;
  const out = {};
  for (const k of Object.keys(a)) {
    if (k === 'h') continue;
    if (['sun', 'zen', 'hor', 'gnd', 'hemiS', 'hemiG'].includes(k)) {
      out[k] = new THREE.Color(a[k]).lerp(new THREE.Color(b[k]), t);
    } else out[k] = a[k] + (b[k] - a[k]) * t;
  }
  // Sun azimuth from the hour: east at 6, south at 12, west at 18. The moon
  // (night anchors) sits high in the south-west.
  const night = out.win > 0.9;
  const az = night ? 0.6 : ((clamp(hh, 5, 21) - 12) / 6) * (Math.PI / 2);
  out.az = az;
  out.night = night;
  return out;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Unit vector toward the sun in three.js space (x east, y up, z south). */
function sunDir(az, elevDeg) {
  const e = THREE.MathUtils.degToRad(elevDeg);
  return new THREE.Vector3(-Math.sin(az) * Math.cos(e), Math.sin(e), Math.cos(az) * Math.cos(e)).normalize();
}

/* ---------------------------------------------------------------------------
 * Procedural textures (canvas, no files)
 * ------------------------------------------------------------------------- */

const CELL = 8; // px per bay × storey
const N = RM.TEX_CELLS; // 32 × 32 cells per tile, matching the mesh UVs

/** Glass albedo tile: open glass, thin mullions, a darker spandrel per floor. */
function glassMapTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = N * CELL;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  for (let j = 0; j < N; j++) {
    const y = c.height - (j + 1) * CELL; // v = 0 at the bottom of the canvas
    g.fillStyle = '#5c6268'; // spandrel / slab line at the bottom of each storey
    g.fillRect(0, y + CELL - 2, c.width, 2);
  }
  g.fillStyle = '#8a9096';
  for (let i = 0; i < N; i++) g.fillRect(i * CELL, 0, 1, c.height);
  return finishTexture(c);
}

/** Night windows: warm lit cells at fraction `lit`, varied in tone. */
function windowEmissiveTexture(rnd, lit) {
  const c = document.createElement('canvas');
  c.width = c.height = N * CELL;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  const tones = ['#ffd9a0', '#ffcf8a', '#fff1d6', '#ffe2b8', '#f6c27a'];
  for (let j = 0; j < N; j++) {
    // Whole floors tend to be on or off together, like real offices.
    const floorBias = rnd() < 0.25 ? 2.2 : rnd() < 0.3 ? 0.2 : 1;
    for (let i = 0; i < N; i++) {
      if (rnd() > lit * floorBias) continue;
      g.globalAlpha = 0.55 + rnd() * 0.45;
      g.fillStyle = tones[Math.floor(rnd() * tones.length)];
      g.fillRect(i * CELL + 1, c.height - (j + 1) * CELL, CELL - 1, CELL - 2);
    }
  }
  g.globalAlpha = 1;
  return finishTexture(c);
}

function finishTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/* ---------------------------------------------------------------------------
 * Scene parts
 * ------------------------------------------------------------------------- */

function skyDome(L, radius) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { zen: { value: L.zen }, hor: { value: L.hor } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 zen; uniform vec3 hor;
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y, 0.0, 1.0);
        gl_FragColor = vec4(mix(hor, zen, pow(h, 0.55)), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), mat);
  m.frustumCulled = false;
  m.renderOrder = -1;
  return m;
}

/** Surrounding city blocks as one merged geometry (axis-aligned boxes). */
function contextBlocks(blocks, maxR) {
  const pos = [];
  const nrm = [];
  const faces = [
    // [normal, 4 corners as (sx, sy, sz) in −1..1 / 0..1 for z]
    [[1, 0, 0], [[1, -1, 0], [1, 1, 0], [1, 1, 1], [1, -1, 1]]],
    [[-1, 0, 0], [[-1, 1, 0], [-1, -1, 0], [-1, -1, 1], [-1, 1, 1]]],
    [[0, 1, 0], [[1, 1, 0], [-1, 1, 0], [-1, 1, 1], [1, 1, 1]]],
    [[0, -1, 0], [[-1, -1, 0], [1, -1, 0], [1, -1, 1], [-1, -1, 1]]],
    [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
  ];
  for (const b of blocks) {
    if (Math.hypot(b.x, b.y) > maxR) continue;
    for (const [n, q] of faces) {
      const v = q.map(([sx, sy, sz]) => [b.x + (sx * b.w) / 2, b.y + (sy * b.d) / 2, sz * b.h]);
      for (const k of [0, 1, 2, 0, 2, 3]) {
        pos.push(...v[k]);
        nrm.push(...n);
      }
    }
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return g;
}

/** Instanced props (data space) from { x, y, z, s, rot } lists. */
function instanced(geo, mat, list, scaleOf) {
  if (!list.length) return null;
  const mesh = new THREE.InstancedMesh(geo, mat, list.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);
  list.forEach((p, i) => {
    q.setFromAxisAngle(zAxis, p.rot || 0);
    m.compose(new THREE.Vector3(p.x, p.y, p.z || 0), q, scaleOf(p));
    mesh.setMatrixAt(i, m);
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/* ---------------------------------------------------------------------------
 * Camera fit
 * ------------------------------------------------------------------------- */

/**
 * 3/4 aerial view. Starts from the bounding-sphere distance, then refines on
 * the box corners so the projected cluster fills the square with ~8 % padding
 * on its longest side and sits slightly below centre.
 */
function fitCamera(camera, box, viewAz, elevDeg) {
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const half = THREE.MathUtils.degToRad(camera.fov / 2);
  const PAD = 0.84; // usable half-extent in NDC (8 % margin each side)
  const Y_BIAS = -0.05; // cluster centre a little below the frame centre
  const e = THREE.MathUtils.degToRad(elevDeg);
  const dir = new THREE.Vector3(Math.sin(viewAz) * Math.cos(e), Math.sin(e), Math.cos(viewAz) * Math.cos(e));
  const target = sphere.center.clone();
  let dist = sphere.radius / Math.sin(Math.atan(Math.tan(half) * PAD));

  const corners = [];
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));

  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let it = 0; it < 12; it++) {
    camera.position.copy(target).addScaledVector(dir, dist);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const c of corners) {
      p.copy(c).project(camera);
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
    const ext = Math.max((x1 - x0) / 2, (y1 - y0) / 2);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2 - Y_BIAS;
    // Shift the target in camera space so the projected centre lands on (0, Y_BIAS).
    camera.matrixWorld.extractBasis(right, up, p);
    const worldPerNdc = dist * Math.tan(half);
    target.addScaledVector(right, cx * worldPerNdc).addScaledVector(up, cy * worldPerNdc);
    dist *= ext / PAD;
  }
  camera.position.copy(target).addScaledVector(dir, dist);
  camera.lookAt(target);
  camera.near = Math.max(1, dist * 0.02);
  camera.far = dist * 40;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return dist;
}

/** Shadow camera fitted to the building and the shadow it throws on the ground. */
function fitShadow(light, box, dirToSun) {
  const pts = [];
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) {
        const v = new THREE.Vector3(x, y, z);
        pts.push(v);
        // Where this corner's shadow lands on the ground (y = 0), capped.
        const t = Math.min(y / Math.max(dirToSun.y, 0.08), box.max.y * 5);
        pts.push(v.clone().addScaledVector(dirToSun, -t).setY(0));
      }
  const center = box.getCenter(new THREE.Vector3());
  const R = box.getBoundingSphere(new THREE.Sphere()).radius;
  light.position.copy(center).addScaledVector(dirToSun, R * 3);
  light.target.position.copy(center);
  light.updateMatrixWorld();
  light.target.updateMatrixWorld();
  const cam = light.shadow.camera;
  cam.position.copy(light.position);
  cam.lookAt(center);
  cam.updateMatrixWorld();
  const inv = cam.matrixWorldInverse;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of pts) {
    const q = p.clone().applyMatrix4(inv);
    x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x);
    y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
    z0 = Math.min(z0, q.z); z1 = Math.max(z1, q.z);
  }
  const m = 2;
  cam.left = x0 - m; cam.right = x1 + m; cam.bottom = y0 - m; cam.top = y1 + m;
  cam.near = Math.max(0.5, -z1 - m);
  cam.far = -z0 + m;
  cam.updateProjectionMatrix();
  const texel = Math.max(x1 - x0, y1 - y0) / light.shadow.mapSize.x;
  light.shadow.bias = -0.0004;
  light.shadow.normalBias = texel * 1.5;
}

/* ---------------------------------------------------------------------------
 * Render
 * ------------------------------------------------------------------------- */

function renderTower(canvas, opts) {
  const { seed, size, hour } = opts;
  const params = paramsFromSeed(seed);
  const model = generateTower(params);
  const L = lightingFor(hour);
  const rnd = mulberry32(seed ^ 0x5bd1e995);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    preserveDrawingBuffer: true, // widget only: lets toDataURL read the frame
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = L.exp;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();

  // Reflections: RoomEnvironment through PMREM, scaled by the hour.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  pmrem.dispose();
  scene.environment = envRT.texture;
  scene.environmentIntensity = L.env;

  // Building
  const meshes = buildRealisticMeshes(model);
  const root = new THREE.Group();
  root.matrixAutoUpdate = false;
  root.matrix.copy(DATA_TO_WORLD);
  scene.add(root);

  const glassMap = glassMapTexture();
  const emissive = L.win > 0 ? windowEmissiveTexture(rnd, L.lit) : null;
  const warm = new THREE.Color(0xffffff);

  const mats = {
    glass: new THREE.MeshPhysicalMaterial({
      color: 0x8c9aa6, // slight blue-grey tint
      map: glassMap,
      metalness: 0.25,
      roughness: 0.07,
      ior: 1.52,
      reflectivity: 0.6,
      clearcoat: 0.4,
      clearcoatRoughness: 0.05,
      envMapIntensity: 1.25,
      vertexColors: true,
      emissive: emissive ? warm : 0x000000,
      emissiveMap: emissive,
      emissiveIntensity: L.win,
    }),
    podiumGlass: new THREE.MeshPhysicalMaterial({
      color: 0x3a4148,
      metalness: 0.3,
      roughness: 0.12,
      clearcoat: 0.3,
      envMapIntensity: 1.0,
      vertexColors: true,
      emissive: emissive ? warm : 0x000000,
      emissiveMap: emissive,
      emissiveIntensity: L.win * 0.8,
    }),
    alu: new THREE.MeshStandardMaterial({ color: 0xdadcdd, metalness: 0.65, roughness: 0.32, vertexColors: true }),
    concrete: new THREE.MeshStandardMaterial({ color: 0xd6d1c8, metalness: 0, roughness: 0.82, vertexColors: true }),
    helipad: new THREE.MeshStandardMaterial({ color: 0x55585c, roughness: 0.9, vertexColors: true }),
    uplight: new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffc887).multiplyScalar(0.4 + L.win), vertexColors: true }),
  };
  for (const [k, mat] of Object.entries(mats)) {
    const g = meshes[k];
    if (!g) continue;
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = k !== 'uplight';
    mesh.receiveShadow = true;
    root.add(mesh);
  }

  // Planting (instanced, merged geometry)
  const plantMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  const fol = instanced(foliageGeometry(), plantMat, meshes.foliage, (p) => new THREE.Vector3(p.s, p.s, p.s));
  const palms = instanced(palmGeometry(), plantMat, meshes.palms, (p) => new THREE.Vector3(p.s, p.s, p.s));
  if (fol) root.add(fol);
  if (palms) root.add(palms);

  // Bounding box of the building in world space (for camera, shadows, fog).
  const b = meshes.box;
  const box = new THREE.Box3(new THREE.Vector3(b.minX, b.minZ, -b.maxY), new THREE.Vector3(b.maxX, b.maxZ, -b.minY));
  const R = box.getBoundingSphere(new THREE.Sphere()).radius;

  // Context: low clay blocks so the tower reads at city scale.
  const ctx = contextBlocks(model.context.blocks, Math.max(260, R * 1.6));
  if (ctx) {
    const cm = new THREE.Mesh(ctx, new THREE.MeshStandardMaterial({
      color: new THREE.Color(0xa9a59d).lerp(new THREE.Color(0x30323a), clamp(L.win / 1.5, 0, 1)), // darker after dusk
      roughness: 0.9,
      envMapIntensity: 0.35,
    }));
    cm.receiveShadow = true;
    cm.castShadow = true;
    root.add(cm);
  }

  // Ground: receives shadows, fades into the fog.
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(R * 30, 48),
    new THREE.MeshStandardMaterial({ color: L.gnd, roughness: 0.95, metalness: 0, envMapIntensity: 0.3 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.receiveShadow = true;
  scene.add(ground);

  // Lights
  const toSun = sunDir(L.az, L.elev);
  const sun = new THREE.DirectionalLight(L.sun, L.sunI);
  sun.castShadow = true;
  const mapSize = size >= 768 ? 2048 : 1024;
  sun.shadow.mapSize.set(mapSize, mapSize);
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);
  fitShadow(sun, box, toSun);
  scene.add(new THREE.HemisphereLight(L.hemiS, L.hemiG, L.hemiI));

  // Camera: ~40 mm on full frame (34° vertical), side-lit 3/4 aerial.
  const camera = new THREE.PerspectiveCamera(34, 1, 1, 10000);
  const sideways = (rnd() < 0.5 ? -1 : 1) * THREE.MathUtils.degToRad(45 + rnd() * 15);
  const viewAz = L.night ? 0.7 + (rnd() - 0.5) * 0.6 : L.az + sideways;
  const elev = 20 + rnd() * 8;
  const dist = fitCamera(camera, box, viewAz, elev);

  // Atmosphere: tower ~3 % hazed, the far ground fully into the horizon colour.
  scene.fog = new THREE.FogExp2(L.hor, 0.16 / dist);
  scene.add(skyDome(L, dist * 30));
  scene.background = L.hor;

  return { renderer, scene, camera, params, model, dispose: [envRT, glassMap, emissive, ...Object.values(mats), plantMat] };
}

/* ---------------------------------------------------------------------------
 * Fallback + entry
 * ------------------------------------------------------------------------- */

function darkFallback(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, '#10141c');
  grad.addColorStop(1, '#05070a');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

/**
 * One frame, or ~50 ms if frames never come. A hidden web view (the iPhone
 * widget's WKWebView is never on screen) doesn't fire requestAnimationFrame,
 * so a plain rAF wait would hang until the watchdog and return the dark
 * fallback. preserveDrawingBuffer keeps the frame readable either way.
 */
function nextFrame() {
  return new Promise((r) => {
    let done = false;
    const go = () => { if (!done) { done = true; r(); } };
    try { requestAnimationFrame(go); } catch { /* no rAF */ }
    setTimeout(go, 50);
  });
}

export async function startWidget(query) {
  const size = clamp(Number.parseInt(query.get('size'), 10) || 1024, 64, 2048);
  const seedIn = parseSeed(query.get('seed'));
  const seed = seedIn ?? 1;
  const hourQ = Number.parseInt(query.get('hour'), 10);
  const hour = Number.isFinite(hourQ) ? clamp(hourQ, 0, 23) : new Date().getHours();
  const format = query.get('format') === 'png' ? 'png' : 'jpeg';
  const mime = format === 'png' ? 'image/png' : 'image/jpeg';

  // Bare page: no margins, no scroll, just the canvas.
  const html = document.documentElement;
  html.style.cssText = 'margin:0;padding:0;background:#05070a;overflow:hidden';
  document.body.style.cssText = 'margin:0;padding:0;background:#05070a;overflow:hidden';
  document.body.innerHTML = '';

  const params = paramsFromSeed(seed);
  const meta = {
    seed,
    typeName: typeName(params),
    towers: params.towers,
    heightM: Math.round(params.floors * FLOOR_HEIGHT * 10) / 10,
    floors: params.floors,
    twistDeg: params.twist,
  };

  let shown = null; // the canvas that holds the final image
  let image = null;
  let ok = false; // true only for a real render (false = dark fallback)
  const finish = (canvas, real = false) => {
    if (window.__WIDGET_READY__) return;
    shown = canvas;
    try {
      image = canvas.toDataURL(mime, 0.9);
      if (!image || image.length < 100) throw new Error('empty image');
      ok = real;
    } catch {
      ok = false;
      const fb = darkFallback(size);
      image = fb.toDataURL(mime, 0.9);
      if (shown.parentNode) shown.replaceWith(fb);
      else document.body.appendChild(fb);
      shown = fb;
    }
    if (!shown.parentNode) document.body.appendChild(shown);
    window.__WIDGET_READY__ = true;
  };

  window.getWidgetSnapshot = () => {
    if (!image) {
      const fb = darkFallback(size);
      return { image: fb.toDataURL(mime, 0.9), meta, ok: false };
    }
    return { image, meta, ok };
  };

  // Hard stop: whatever happens, READY within 12 s.
  const watchdog = setTimeout(() => {
    if (!window.__WIDGET_READY__) {
      const fb = darkFallback(size);
      if (shown && shown.parentNode) shown.replaceWith(fb);
      shown = null;
      finish(fb);
    }
  }, 12000);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = `display:block;width:${size}px;height:${size}px`;
  canvas.width = canvas.height = size;
  document.body.appendChild(canvas);
  shown = canvas;

  let ctx = null;
  try {
    ctx = renderTower(canvas, { seed, size, hour });
    // Let the browser settle (shader compile, texture upload) before the final frame.
    if (ctx.renderer.compileAsync) await ctx.renderer.compileAsync(ctx.scene, ctx.camera);
    for (let i = 0; i < 2; i++) {
      ctx.renderer.render(ctx.scene, ctx.camera);
      await nextFrame();
    }
    ctx.renderer.render(ctx.scene, ctx.camera);
    await nextFrame();
    ctx.renderer.setAnimationLoop(null);
    finish(canvas, true);
  } catch (err) {
    console.error('[widget] render failed', err);
    const fb = darkFallback(size);
    fb.style.cssText = canvas.style.cssText;
    canvas.replaceWith(fb);
    finish(fb);
  } finally {
    clearTimeout(watchdog);
    // Free GPU memory; the drawing buffer on screen and the data URL stay.
    if (ctx) {
      ctx.scene.traverse((o) => o.geometry && o.geometry.dispose());
      ctx.dispose.forEach((d) => d && d.dispose && d.dispose());
      ctx.renderer.renderLists.dispose();
    }
  }
}
