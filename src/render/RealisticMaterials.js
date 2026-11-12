/**
 * RealisticMaterials.js
 *
 * Every material and procedural texture of the REALISTIC mode. Lit materials
 * (MeshStandardMaterial / MeshPhysicalMaterial) exist only here and in the
 * other src/render files; the stylized mode never imports them.
 *
 * No image files: all textures are drawn on canvases from a seeded PRNG, so
 * they are identical on every load and cost nothing to download.
 *
 * Window texture layout (shared by the tower glass and the podium glass):
 *   one tile = TEX_CELLS bays (u) × TEX_CELLS storeys (v)
 *   each cell: bottom 10 % spandrel, then glazing with a mullion on its left
 *   The geometry's v = height / storey height, so each texture row is one floor.
 * Three textures use that layout:
 *   albedo     blue-grey glass, champagne mullions, dark spandrel
 *   rough/met  G = roughness, B = metalness (glass 0.07/0.9, mullion 0.35/0.6)
 *   emissive   lit rooms (warm, a few cool), black elsewhere; redrawn per
 *              lighting preset with that preset's share of lit rooms
 */

import * as THREE from 'three';
import { RM, seeded } from '../geometry/buildRealisticMeshes.js';

const N = RM.TEX_CELLS;
const SPANDREL = 0.1;

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function texture(canvas, { srgb = true, repeat = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** Canvas y of the top of storey row r (row 0 at the bottom, as v = 0). */
const rowTop = (size, r) => size - (r + 1) * (size / N);

/* ---------------------------------------------------------------------------
 * Window textures
 * ------------------------------------------------------------------------- */

function glassAlbedoCanvas(size) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const cell = size / N;
  const mw = Math.max(1, Math.round(cell * 0.06));
  g.fillStyle = '#8796a3';
  g.fillRect(0, 0, size, size);
  for (let r = 0; r < N; r++) {
    const y = rowTop(size, r);
    g.fillStyle = '#3f454c';
    g.fillRect(0, y + cell * (1 - SPANDREL), size, cell * SPANDREL);
    g.fillStyle = '#d9d1c0';
    for (let k = 0; k < N; k++) g.fillRect(k * cell, y, mw, cell * (1 - SPANDREL));
  }
  return c;
}

function glassRMCanvas(size) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const cell = size / N;
  const mw = Math.max(1, Math.round(cell * 0.06));
  g.fillStyle = 'rgb(0, 18, 230)'; //   glass: roughness 0.07, metalness 0.9
  g.fillRect(0, 0, size, size);
  for (let r = 0; r < N; r++) {
    const y = rowTop(size, r);
    g.fillStyle = 'rgb(0, 128, 51)'; // spandrel: 0.5 / 0.2
    g.fillRect(0, y + cell * (1 - SPANDREL), size, cell * SPANDREL);
    g.fillStyle = 'rgb(0, 90, 153)'; // mullion: 0.35 / 0.6
    for (let k = 0; k < N; k++) g.fillRect(k * cell, y, mw, cell * (1 - SPANDREL));
  }
  return c;
}

const WARM = [
  [255, 196, 128],
  [255, 210, 150],
  [255, 224, 176],
  [255, 184, 112],
];
const COOL = [215, 232, 255];

/**
 * Lit rooms: each storey row is split into rooms 1–3 bays wide; a room is lit
 * with probability `lit` (warm mostly, ~12 % cool office light), brighter at
 * the ceiling, sometimes with blinds half down. `podium` uses taller, mostly
 * lit, warmer retail bays.
 */
function windowEmissiveCanvas(size, lit, seed, podium = false) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const rnd = seeded(seed);
  const cell = size / N;
  const mw = Math.max(1, Math.round(cell * 0.06));
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  for (let r = 0; r < N; r++) {
    const y = rowTop(size, r);
    const h = cell * (1 - SPANDREL);
    let k = 0;
    while (k < N) {
      const w = Math.min(N - k, 1 + Math.floor(rnd() * (podium ? 4 : 3)));
      const on = rnd() < (podium ? Math.min(0.95, lit + 0.35) : lit);
      const x0 = k * cell;
      const x1 = (k + w) * cell;
      if (on) {
        const cool = !podium && rnd() < 0.12;
        const col = cool ? COOL : WARM[Math.floor(rnd() * WARM.length)];
        const b = 0.55 + 0.45 * rnd();
        const grad = g.createLinearGradient(0, y, 0, y + h);
        const s = (k2) => `rgb(${Math.round(col[0] * b * k2)}, ${Math.round(col[1] * b * k2)}, ${Math.round(col[2] * b * k2)})`;
        grad.addColorStop(0, s(1));
        grad.addColorStop(1, s(podium ? 0.75 : 0.45));
        g.fillStyle = grad;
        g.fillRect(x0, y, x1 - x0, h);
        if (!podium && rnd() < 0.3) {
          g.fillStyle = 'rgba(0, 0, 0, 0.7)';
          g.fillRect(x0, y, x1 - x0, h * (0.2 + rnd() * 0.4));
        }
      } else if (rnd() < 0.05) {
        g.fillStyle = 'rgb(20, 30, 48)'; // the odd screen glow
        g.fillRect(x0, y + h * 0.4, x1 - x0, h * 0.6);
      }
      k += w;
    }
    g.fillStyle = '#000';
    for (let q = 0; q < N; q++) g.fillRect(q * cell, y, mw, h);
    g.fillRect(0, y + h, size, cell * SPANDREL);
  }
  return c;
}

/* ---------------------------------------------------------------------------
 * Surfaces
 * ------------------------------------------------------------------------- */

/** Tileable concrete: base tone, per-pixel grain and soft blotches (wrapped). */
function noiseCanvas(size, base, spread, seed) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const rnd = seeded(seed);
  const img = g.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const n = (rnd() - 0.5) * spread;
    img.data[4 * i] = base[0] + n;
    img.data[4 * i + 1] = base[1] + n;
    img.data[4 * i + 2] = base[2] + n;
    img.data[4 * i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  for (let i = 0; i < 160; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = 6 + rnd() * size * 0.12;
    const dark = rnd() < 0.5;
    g.fillStyle = dark ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)';
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        g.beginPath();
        g.arc(x + ox, y + oy, r, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
  return c;
}

/** Paving: 8 × 8 stone slabs with joints (one tile = 4 m). */
function pavingCanvas(size, seed) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const rnd = seeded(seed);
  const n = 8;
  const s = size / n;
  g.fillStyle = '#6f6a62';
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const v = 168 + Math.floor((rnd() - 0.5) * 26);
      g.fillStyle = `rgb(${v}, ${v - 4}, ${v - 12})`;
      g.fillRect(i * s + 1.5, j * s + 1.5, s - 3, s - 3);
    }
  }
  return c;
}

/**
 * Asphalt with lane markings. u runs along the street, one tile = 8 m
 * (a 3 m dash + 5 m gap); v runs across a 14 m street: edge lines at
 * 0.6 m from each kerb, dashed centre line.
 */
function asphaltCanvas(seed) {
  const W = 256;
  const H = 512;
  const c = noiseCanvas(W, [46, 47, 50], 26, seed);
  const big = makeCanvas(W, H);
  const g = big.getContext('2d');
  g.drawImage(c, 0, 0, W, H);
  const across = (m) => (m / 14) * H;
  g.fillStyle = 'rgba(235, 232, 220, 0.85)';
  g.fillRect(0, across(0.55), W, across(0.15));
  g.fillRect(0, across(13.3), W, across(0.15));
  g.fillRect(0, across(6.92), (3 / 8) * W, across(0.16));
  return big;
}

/** Timber boards: 16 planks per tile (one tile = 3 m), grain and joints. */
function timberCanvas(seed) {
  const S = 256;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  const rnd = seeded(seed);
  const n = 16;
  const h = S / n;
  for (let i = 0; i < n; i++) {
    const v = 0.85 + rnd() * 0.3;
    g.fillStyle = `rgb(${Math.round(150 * v)}, ${Math.round(104 * v)}, ${Math.round(68 * v)})`;
    g.fillRect(0, i * h, S, h);
    g.fillStyle = 'rgba(60, 36, 20, 0.18)';
    for (let k = 0; k < 6; k++) g.fillRect(0, i * h + rnd() * h, S, 1);
    g.fillStyle = 'rgba(30, 18, 10, 0.6)';
    g.fillRect(0, i * h, S, 1);
    g.fillRect(rnd() * S, i * h, 1.5, h);
  }
  return c;
}

/** Helipad: dark deck, yellow perimeter, white touchdown ring and H. */
function helipadCanvas() {
  const S = 512;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  g.fillStyle = '#3a3f45';
  g.fillRect(0, 0, S, S);
  g.lineWidth = 10;
  g.strokeStyle = '#f2c230';
  g.beginPath();
  g.arc(S / 2, S / 2, S * 0.46, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = '#f4f4f0';
  g.lineWidth = 14;
  g.beginPath();
  g.arc(S / 2, S / 2, S * 0.32, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#f4f4f0';
  const w = S * 0.06;
  const h = S * 0.3;
  g.fillRect(S / 2 - S * 0.11, S / 2 - h / 2, w, h);
  g.fillRect(S / 2 + S * 0.11 - w, S / 2 - h / 2, w, h);
  g.fillRect(S / 2 - S * 0.11, S / 2 - w / 2, S * 0.22, w);
  return c;
}

/**
 * City facades: one tile = 32 m × 28 m (8 bays of 4 m × 8 storeys of 3.5 m).
 * Each storey is a light spandrel band and a dark glazed ribbon with mullions
 * every 1.33 m, the ribbon a little lighter at its top (sky reflection).
 * Lit mask: random runs of the ribbon, warm.
 */
function cityCanvases(seed) {
  const S = 512;
  const n = 8;
  const cell = S / n;
  const a = makeCanvas(S, S);
  const l = makeCanvas(S, S);
  const ga = a.getContext('2d');
  const gl = l.getContext('2d');
  const rnd = seeded(seed);
  ga.fillStyle = '#b7b1a6';
  ga.fillRect(0, 0, S, S);
  gl.fillStyle = '#000';
  gl.fillRect(0, 0, S, S);
  for (let j = 0; j < n; j++) {
    const y = j * cell + cell * 0.32;
    const h = cell * 0.6;
    const grad = ga.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, '#6c7a86');
    grad.addColorStop(1, '#39434c');
    ga.fillStyle = grad;
    ga.fillRect(0, y, S, h);
    ga.fillStyle = 'rgba(220, 214, 200, 0.85)';
    for (let x = 0; x < S; x += cell / 3) ga.fillRect(x, y, 1.5, h);
    let x = 0;
    while (x < S) {
      const w = cell * (0.33 * (1 + Math.floor(rnd() * 6)));
      if (rnd() < 0.4) {
        const col = WARM[Math.floor(rnd() * WARM.length)];
        const b = 0.45 + 0.55 * rnd();
        gl.fillStyle = `rgb(${Math.round(col[0] * b)}, ${Math.round(col[1] * b)}, ${Math.round(col[2] * b)})`;
        gl.fillRect(x, y, w, h);
      }
      x += w;
    }
    gl.fillStyle = '#000';
    for (let q = 0; q < S; q += cell / 3) gl.fillRect(q, y, 1.5, h);
  }
  return { albedo: a, lit: l };
}

/* ---------------------------------------------------------------------------
 * Shader patches
 * ------------------------------------------------------------------------- */

/**
 * Projected UVs for surfaces built without them (concrete, ground, paving):
 * the texture is sampled from data-space position, on the plane facing the
 * dominant axis of the normal (a cheap triplanar without blending). Works on
 * plain and instanced meshes; `scale` is metres per texture tile.
 */
function projectMap(material, scale) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uProjScale = { value: 1 / scale };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vProjPos;\nvarying vec3 vProjN;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec4 projP = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          projP = instanceMatrix * projP;
        #endif
        vProjPos = projP.xyz;
        vProjN = objectNormal;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vProjPos;\nvarying vec3 vProjN;\nuniform float uProjScale;')
      .replace(
        '#include <map_fragment>',
        `vec3 an = abs(vProjN);
        vec2 projUv = an.z > max(an.x, an.y) ? vProjPos.xy : (an.x > an.y ? vProjPos.yz : vProjPos.xz);
        vec4 sampledDiffuseColor = texture2D(map, projUv * uProjScale);
        diffuseColor *= sampledDiffuseColor;`
      );
  };
  material.customProgramCacheKey = () => `proj-${scale}`;
}

/**
 * City blocks: unit boxes scaled per instance, so their own UVs would stretch.
 * Instead the window grid is sampled from data-space position (u along the
 * wall, v = height), offset per instance so neighbours do not repeat; roofs get
 * a flat roof tone. The lit mask is added as emission scaled by uCityLit.
 */
function patchCity(material, albedo, lit) {
  material.userData.uniforms = { uWin: { value: albedo }, uLit: { value: lit }, uCityLit: { value: 0 } };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, material.userData.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCityPos;\nvarying vec3 vCityN;\nvarying vec2 vCityOff;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec4 cityP = vec4(transformed, 1.0);
        vCityOff = vec2(0.0);
        #ifdef USE_INSTANCING
          cityP = instanceMatrix * cityP;
          vCityOff = floor(fract(instanceMatrix[3].xy * 0.0137) * 8.0) / 8.0;
        #endif
        vCityPos = cityP.xyz;
        vCityN = objectNormal;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vCityPos;\nvarying vec3 vCityN;\nvarying vec2 vCityOff;\nuniform sampler2D uWin;\nuniform sampler2D uLit;\nuniform float uCityLit;'
      )
      .replace(
        '#include <map_fragment>',
        `vec3 cn = abs(vCityN);
        float isRoof = step(0.5, cn.z);
        vec2 cityUv = vec2((cn.x > 0.5 ? vCityPos.y : vCityPos.x) / 32.0, vCityPos.z / 28.0) + vCityOff;
        vec4 win = texture2D(uWin, cityUv);
        diffuseColor.rgb *= mix(win.rgb, vec3(0.42, 0.41, 0.4), isRoof);
        vec3 cityGlow = texture2D(uLit, cityUv).rgb * uCityLit * (1.0 - isRoof) * step(3.0, vCityPos.z);`
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += cityGlow;');
  };
  material.customProgramCacheKey = () => 'city-blocks';
}

/* ---------------------------------------------------------------------------
 * Material set
 * ------------------------------------------------------------------------- */

/**
 * @param {object} tier from QualityManager: windowTex (px), surfaceTex (px)
 */
export function createRealisticMaterials(tier) {
  const W = tier.windowTex;
  const S = Math.max(256, W / 2);
  const tex = {
    glassAlbedo: texture(glassAlbedoCanvas(S)),
    glassRM: texture(glassRMCanvas(S), { srgb: false }),
    windows: null,
    podiumWindows: null,
    concrete: texture(noiseCanvas(256, [188, 184, 176], 22, 11)),
    ground: texture(noiseCanvas(256, [132, 128, 120], 30, 12)),
    pavement: texture(noiseCanvas(256, [170, 166, 158], 18, 13)),
    paving: texture(pavingCanvas(512, 14)),
    asphalt: texture(asphaltCanvas(15)),
    helipad: texture(helipadCanvas(), { repeat: false }),
  };
  // Villa surfaces
  tex.lawn = texture(noiseCanvas(512, [92, 124, 68], 14, 17));
  tex.timber = texture(timberCanvas(18));
  tex.stone = texture(noiseCanvas(256, [214, 208, 196], 16, 19));
  const city = cityCanvases(16);
  tex.city = texture(city.albedo);
  tex.cityLit = texture(city.lit);

  const clipped = [];
  const lit = (m) => {
    m.clipShadows = true;
    clipped.push(m);
    return m;
  };

  const glass = lit(
    new THREE.MeshPhysicalMaterial({
      name: 'real-glass',
      color: 0xffffff,
      map: tex.glassAlbedo,
      roughness: 1,
      metalness: 1,
      roughnessMap: tex.glassRM,
      metalnessMap: tex.glassRM,
      emissive: 0xffffff,
      emissiveIntensity: 0.8,
      envMapIntensity: 1.2,
      vertexColors: true,
      // Double-sided so the far wall still shows from inside when the section
      // cuts the tower open. No transmission: too expensive for VR.
      side: THREE.DoubleSide,
    })
  );
  const podiumGlass = lit(
    new THREE.MeshPhysicalMaterial({
      name: 'real-podium-glass',
      color: 0xffffff,
      map: tex.glassAlbedo,
      roughness: 1,
      metalness: 1,
      roughnessMap: tex.glassRM,
      metalnessMap: tex.glassRM,
      emissive: 0xffffff,
      emissiveIntensity: 1,
      envMapIntensity: 1.1,
      vertexColors: true,
      side: THREE.DoubleSide,
    })
  );
  const alu = lit(new THREE.MeshStandardMaterial({ name: 'real-alu', color: 0xebe3d1, metalness: 0.6, roughness: 0.35, vertexColors: true, side: THREE.DoubleSide }));
  const concrete = lit(new THREE.MeshStandardMaterial({ name: 'real-concrete', color: 0xffffff, map: tex.concrete, roughness: 0.85, metalness: 0, vertexColors: true, side: THREE.DoubleSide }));
  projectMap(concrete, 6);
  const foliage = lit(new THREE.MeshStandardMaterial({ name: 'real-foliage', vertexColors: true, roughness: 0.9, metalness: 0, flatShading: true }));
  const palm = lit(new THREE.MeshStandardMaterial({ name: 'real-palm', vertexColors: true, roughness: 0.85, metalness: 0, side: THREE.DoubleSide }));
  const helipad = lit(new THREE.MeshStandardMaterial({ name: 'real-helipad', map: tex.helipad, roughness: 0.7, metalness: 0.1, vertexColors: true }));
  const uplight = lit(new THREE.MeshStandardMaterial({ name: 'real-uplight', color: 0x1a1a1a, emissive: 0xffb070, emissiveIntensity: 0, roughness: 0.6, side: THREE.DoubleSide }));
  // Villa: white GRC ribbons, interiors (vertex-coloured), timber floors and deck.
  const white = lit(new THREE.MeshStandardMaterial({ name: 'real-white', color: 0xf3f1eb, roughness: 0.32, metalness: 0, vertexColors: true, side: THREE.DoubleSide }));
  const interior = lit(new THREE.MeshStandardMaterial({ name: 'real-interior', vertexColors: true, roughness: 0.75, metalness: 0, side: THREE.DoubleSide }));
  const timber = lit(new THREE.MeshStandardMaterial({ name: 'real-timber', map: tex.timber, roughness: 0.7, metalness: 0, vertexColors: true, side: THREE.DoubleSide }));
  projectMap(timber, 3);
  // Site (not cut by the section)
  const lawn = new THREE.MeshStandardMaterial({ name: 'real-lawn', map: tex.lawn, roughness: 0.95, metalness: 0 });
  projectMap(lawn, 14);
  const stone = new THREE.MeshStandardMaterial({ name: 'real-stone', map: tex.stone, roughness: 0.6, metalness: 0, vertexColors: true });
  projectMap(stone, 3);
  const water = new THREE.MeshPhysicalMaterial({
    name: 'real-water',
    color: 0x1f86b5,
    roughness: 0.04,
    metalness: 0.1,
    emissive: 0x0b6a9a,
    emissiveIntensity: 0,
    envMapIntensity: 1.4,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
  });

  // Context (never cut by the section).
  const ground = new THREE.MeshStandardMaterial({ name: 'real-ground', map: tex.ground, roughness: 0.95, metalness: 0 });
  projectMap(ground, 9);
  const pavement = new THREE.MeshStandardMaterial({ name: 'real-pavement', map: tex.pavement, roughness: 0.9, metalness: 0 });
  projectMap(pavement, 5);
  const plaza = new THREE.MeshStandardMaterial({ name: 'real-plaza', map: tex.paving, roughness: 0.8, metalness: 0 });
  projectMap(plaza, 4);
  const asphalt = new THREE.MeshStandardMaterial({ name: 'real-asphalt', map: tex.asphalt, roughness: 0.92, metalness: 0 });
  const cityMat = new THREE.MeshStandardMaterial({ name: 'real-city', color: 0xffffff, roughness: 0.75, metalness: 0.1, emissive: 0x000000 });
  patchCity(cityMat, tex.city, tex.cityLit);
  const tree = new THREE.MeshStandardMaterial({ name: 'real-tree', vertexColors: true, roughness: 0.9, metalness: 0, flatShading: true });
  const floor = new THREE.MeshStandardMaterial({ name: 'real-vr-floor', color: 0x2e2c2a, roughness: 0.85, metalness: 0 });

  const set = {
    tex,
    glass,
    podiumGlass,
    alu,
    concrete,
    foliage,
    palm,
    helipad,
    uplight,
    white,
    interior,
    timber,
    lawn,
    stone,
    water,
    ground,
    pavement,
    plaza,
    asphalt,
    city: cityMat,
    tree,
    floor,
    /** Materials the section cut (and the VR intro reveal) clip. */
    clipped,
    windowSize: W,
    litKey: '',

    /**
     * Apply a lighting preset: redraw the window emission with that preset's
     * share of lit rooms (seeded, so the same rooms stay lit as the share
     * grows), and set every emissive strength.
     */
    applyPreset(p) {
      const key = `${p.lit}`;
      if (key !== this.litKey) {
        this.litKey = key;
        if (tex.windows) tex.windows.dispose();
        if (tex.podiumWindows) tex.podiumWindows.dispose();
        tex.windows = texture(windowEmissiveCanvas(W, p.lit, 4242));
        tex.podiumWindows = texture(windowEmissiveCanvas(Math.max(256, W / 2), p.lit, 4343, true));
        glass.emissiveMap = tex.windows;
        podiumGlass.emissiveMap = tex.podiumWindows;
        glass.needsUpdate = true;
        podiumGlass.needsUpdate = true;
      }
      glass.emissiveIntensity = p.windowI;
      podiumGlass.emissiveIntensity = p.podiumI;
      uplight.emissiveIntensity = p.uplightI;
      water.emissiveIntensity = p.uplightI * 0.35; // lit pool at dusk and night
      cityMat.userData.uniforms.uCityLit.value = p.cityI;
      glass.envMapIntensity = p.envI;
      podiumGlass.envMapIntensity = p.envI * 0.9;
    },

    /** Clipping planes on the building materials (section cut, intro reveal). */
    setClipPlanes(planes) {
      const list = planes && planes.length ? planes : null;
      for (const m of clipped) {
        const before = m.clippingPlanes ? m.clippingPlanes.length : 0;
        m.clippingPlanes = list;
        if (before !== (list ? list.length : 0)) m.needsUpdate = true;
      }
    },

    dispose() {
      for (const t of Object.values(tex)) if (t) t.dispose();
      for (const m of [glass, podiumGlass, alu, concrete, foliage, palm, helipad, uplight, white, interior, timber, lawn, stone, water, ground, pavement, plaza, asphalt, cityMat, tree, floor]) m.dispose();
    },
  };
  return set;
}
