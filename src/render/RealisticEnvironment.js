/**
 * RealisticEnvironment.js
 *
 * Sky, sun, fill light, haze and reflections for the REALISTIC mode.
 *
 *   sky      three/examples Sky shader on a box that follows the camera
 *   sun      DirectionalLight with one shadow map fitted tightly to the
 *            building (and its ground shadow), updated only on demand
 *   fill     HemisphereLight, warm sky over cool ground
 *   haze     FogExp2 tinted to the preset's horizon colour
 *   env      PMREM generated from a second Sky (regenerated only when the
 *            sun moves), with an optional bundled CC0 HDRI as fallback
 *
 * The sun direction drives everything: the sky shader's sunPosition, the light
 * direction and the shadow fit. At NIGHT the sky's sun is below the horizon
 * and the light becomes a dim cool moon from the opposite side; the sky dome
 * is hidden (its scattering turns brown below the horizon) and the background
 * is a deep navy equal to the haze colour, so the horizon has no seam.
 *
 * World space here is three.js y-up. Azimuth is measured from north (data +y,
 * world −z) clockwise toward east (world +x):
 *   dir = (sin az · cos el,  sin el,  −cos az · cos el)
 */

import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

/**
 * Presets. lit = share of lit rooms; windowI / podiumI / uplightI / cityI =
 * emissive strengths; exposure feeds ACES tone mapping; bloom is used on
 * desktop only.
 */
export const PRESETS = {
  golden: {
    label: 'GOLDEN',
    elev: 5,
    az: 248,
    turbidity: 10,
    rayleigh: 3.2,
    mie: 0.006,
    mieG: 0.86,
    sun: [1.0, 0.64, 0.38],
    sunI: 4.2,
    hemiSky: [0.95, 0.78, 0.68],
    hemiGround: [0.3, 0.24, 0.2],
    hemiI: 0.9,
    exposure: 0.62,
    fog: [0.86, 0.66, 0.52],
    fogD: 0.00034,
    lit: 0.3,
    windowI: 0.55,
    podiumI: 1.2,
    uplightI: 0.6,
    cityI: 0.12,
    envI: 1.2,
    bloom: { strength: 0.3, radius: 0.5, threshold: 1.4 },
  },
  day: {
    label: 'DAY',
    elev: 52,
    az: 200,
    turbidity: 2.5,
    rayleigh: 1.6,
    mie: 0.004,
    mieG: 0.8,
    sun: [1.0, 0.96, 0.9],
    sunI: 3.4,
    hemiSky: [0.78, 0.86, 1.0],
    hemiGround: [0.34, 0.31, 0.28],
    hemiI: 1.1,
    exposure: 0.34,
    fog: [0.6, 0.68, 0.78],
    fogD: 0.00022,
    lit: 0.25,
    windowI: 0.25,
    podiumI: 0.5,
    uplightI: 0,
    cityI: 0,
    envI: 1.2,
    bloom: { strength: 0.15, radius: 0.4, threshold: 3.0 },
  },
  dusk: {
    label: 'DUSK',
    elev: 0.8,
    az: 250,
    turbidity: 10,
    rayleigh: 3.2,
    mie: 0.008,
    mieG: 0.9,
    sun: [1.0, 0.48, 0.3],
    sunI: 1.5,
    hemiSky: [0.62, 0.5, 0.62],
    hemiGround: [0.16, 0.13, 0.14],
    hemiI: 0.8,
    exposure: 0.8,
    fog: [0.48, 0.36, 0.38],
    fogD: 0.00045,
    lit: 0.55,
    windowI: 1.8,
    podiumI: 2.2,
    uplightI: 2.0,
    cityI: 0.9,
    envI: 1.1,
    bloom: { strength: 0.3, radius: 0.3, threshold: 1.2 },
  },
  night: {
    label: 'NIGHT',
    elev: -9,
    az: 260,
    moonElev: 38,
    moonAz: 120,
    turbidity: 2,
    rayleigh: 0.6,
    mie: 0.003,
    mieG: 0.7,
    sun: [0.55, 0.64, 0.9],
    sunI: 0.35,
    hemiSky: [0.18, 0.24, 0.42],
    hemiGround: [0.05, 0.05, 0.06],
    hemiI: 0.55,
    exposure: 1.0,
    fog: [0.028, 0.04, 0.075],
    fogD: 0.0005,
    lit: 0.7,
    windowI: 1.5,
    podiumI: 2.2,
    uplightI: 3.0,
    cityI: 0.8,
    envI: 1.0,
    bloom: { strength: 0.32, radius: 0.25, threshold: 1.1 },
  },
};

export const PRESET_IDS = ['golden', 'day', 'dusk', 'night'];

const rad = (d) => (d * Math.PI) / 180;
const dirFrom = (elev, az) =>
  new THREE.Vector3(Math.sin(rad(az)) * Math.cos(rad(elev)), Math.sin(rad(elev)), -Math.cos(rad(az)) * Math.cos(rad(elev))).normalize();

const lerp = (a, b, t) => a + (b - a) * t;

export class RealisticEnvironment {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {object} tier QualityManager tier (shadow sizes)
   */
  constructor(renderer, tier) {
    this.renderer = renderer;
    this.tier = tier;
    this.group = new THREE.Group();
    this.group.name = 'realistic-environment';

    this.sky = new Sky();
    this.sky.name = 'realistic-sky';
    this.sky.scale.setScalar(9000);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.group.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(tier.shadowDesktop, tier.shadowDesktop);
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.3;
    this.sun.shadow.radius = 3;
    this.group.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    this.group.add(this.hemi);

    this.fog = new THREE.FogExp2(0x000000, 0.0004);
    this.background = new THREE.Color(0x000000); // seen only where the sky is hidden (night)

    // PMREM source: a second Sky inside the cube camera's far plane.
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmremScene = new THREE.Scene();
    this.pmremSky = new Sky();
    this.pmremSky.scale.setScalar(900);
    this.pmremScene.add(this.pmremSky);
    this.envTarget = null;
    this.envMap = null;
    this.hdriTried = false;

    // VR tabletop floor (world space), off everywhere else.
    this.floor = null;

    this.presetId = 'golden';
    this.preset = PRESETS.golden;
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.lightDir = new THREE.Vector3(0, 1, 0);
    this.exposure = 1;
    this.shadowBox = null;
    this.sunrise = 1;
  }

  /** Set the sky dome size to fit inside the active camera's far plane. */
  setSkyScale(s) {
    this.sky.scale.setScalar(s);
  }

  setPreset(id) {
    this.presetId = PRESETS[id] ? id : 'golden';
    this.preset = PRESETS[this.presetId];
    this.sunrise = 1;
    this.apply(1);
    this.regenerateEnv();
  }

  /**
   * Apply the preset, optionally part-way through a sunrise (k = 0 → sun 6°
   * below the horizon and dim, k = 1 → the preset). Used by the VR intro.
   */
  apply(k) {
    const p = this.preset;
    const night = this.presetId === 'night';
    const elev = night ? p.elev : lerp(-6, p.elev, k);
    this.sunDir.copy(dirFrom(elev, p.az));
    // At night the light is the moon, from its own direction.
    this.lightDir.copy(night ? dirFrom(p.moonElev, p.moonAz) : this.sunDir);
    for (const s of [this.sky, this.pmremSky]) {
      const u = s.material.uniforms;
      u.turbidity.value = p.turbidity;
      u.rayleigh.value = p.rayleigh;
      u.mieCoefficient.value = p.mie;
      u.mieDirectionalG.value = p.mieG;
      u.sunPosition.value.copy(this.sunDir);
    }
    this.sky.visible = !night;
    this.background.setRGB(p.fog[0], p.fog[1], p.fog[2]);
    const dark = night ? 1 : THREE.MathUtils.smoothstep(k, 0, 0.6);
    this.sun.color.setRGB(...p.sun);
    this.sun.intensity = p.sunI * dark;
    this.hemi.color.setRGB(...p.hemiSky);
    this.hemi.groundColor.setRGB(...p.hemiGround);
    this.hemi.intensity = p.hemiI * lerp(0.25, 1, dark);
    this.fog.color.setRGB(p.fog[0] * lerp(0.2, 1, dark), p.fog[1] * lerp(0.2, 1, dark), p.fog[2] * lerp(0.25, 1, dark));
    this.fog.density = p.fogD * (this.fogScale || 1);
    this.exposure = lerp(p.exposure * 1.6, p.exposure, k);
    if (this.active) this.renderer.toneMappingExposure = this.exposure;
  }

  /** Sunrise for the VR intro: sweep from dark to the preset. */
  setSunrise(k) {
    this.sunrise = k;
    this.apply(k);
  }

  /**
   * Reflections. PMREM of the sky (regenerated only when the sun preset
   * changes, and a few times during the VR sunrise). If that fails (no float
   * render targets), fall back to /hdri/sky_1k.hdr if it was bundled.
   */
  regenerateEnv() {
    try {
      const rt = this.pmrem.fromScene(this.pmremScene, 0, 0.1, 1000);
      if (this.envTarget) this.envTarget.dispose();
      this.envTarget = rt;
      this.envMap = rt.texture;
    } catch (e) {
      this.loadHdriFallback();
    }
    if (this.onEnv) this.onEnv(this.envMap);
  }

  loadHdriFallback() {
    if (this.hdriTried) return;
    this.hdriTried = true;
    import('three/examples/jsm/loaders/RGBELoader.js')
      .then(({ RGBELoader }) => new RGBELoader().loadAsync(`${import.meta.env.BASE_URL}hdri/sky_1k.hdr`))
      .then((hdr) => {
        const rt = this.pmrem.fromEquirectangular(hdr);
        hdr.dispose();
        if (this.envTarget) this.envTarget.dispose();
        this.envTarget = rt;
        this.envMap = rt.texture;
        if (this.onEnv) this.onEnv(this.envMap);
      })
      .catch(() => {
        /* no HDRI bundled: lit materials fall back to the lights alone */
      });
  }

  /** Shadow map size for the context (desktop or VR tier). */
  setShadowSize(px) {
    const s = this.sun.shadow;
    if (s.mapSize.x === px) return;
    s.mapSize.set(px, px);
    if (s.map) {
      s.map.dispose();
      s.map = null;
    }
  }

  /**
   * Fit the single shadow cascade tightly around the building.
   *
   * `corners` = the 8 world-space corners of the building's box; `groundY` =
   * world height of the ground; `scale` = world metres per data metre (1 at
   * human scale, 1/denom on the tabletop). The fitted set is the box plus the
   * ground projection of its top corners along −lightDir (where the long
   * low-sun shadows land), capped at 2.5 × the building height so the map
   * keeps its resolution.
   *
   * The light sits on the far side of the set looking at its centre; every
   * point goes into light view space and the orthographic frustum is the
   * min/max of the result (plus a margin). Biases are set in texels so they
   * work at 1:1 and on the tabletop alike.
   */
  fitShadow(corners, groundY, height) {
    const L = this.lightDir;
    const pts = corners.slice();
    const up = Math.max(0.05, L.y);
    const cap = height * 2.5;
    for (const c of corners) {
      const h = c.y - groundY;
      if (h <= 0.001) continue;
      // The ray c − L·t reaches the ground at t = h / L.y; its horizontal
      // run is −(L.x, L.z)·t, capped at `cap`.
      const t = h / up;
      let hx = -L.x * t;
      let hz = -L.z * t;
      const hl = Math.hypot(hx, hz);
      if (hl > cap) {
        hx *= cap / hl;
        hz *= cap / hl;
      }
      pts.push(new THREE.Vector3(c.x + hx, groundY, c.z + hz));
    }
    const centre = new THREE.Vector3();
    pts.forEach((p) => centre.add(p));
    centre.divideScalar(pts.length);
    let R = 0;
    pts.forEach((p) => (R = Math.max(R, p.distanceTo(centre))));

    this.sun.position.copy(centre).addScaledVector(L, R * 2 + 1e-3);
    this.sun.target.position.copy(centre);
    this.sun.updateMatrixWorld();
    this.sun.target.updateMatrixWorld();
    const cam = this.sun.shadow.camera;
    cam.position.copy(this.sun.position);
    cam.lookAt(centre);
    cam.updateMatrixWorld();
    const inv = cam.matrixWorldInverse;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minD = Infinity;
    let maxD = -Infinity;
    const q = new THREE.Vector3();
    for (const p of pts) {
      q.copy(p).applyMatrix4(inv);
      minX = Math.min(minX, q.x);
      maxX = Math.max(maxX, q.x);
      minY = Math.min(minY, q.y);
      maxY = Math.max(maxY, q.y);
      minD = Math.min(minD, -q.z);
      maxD = Math.max(maxD, -q.z);
    }
    const m = R * 0.02;
    cam.left = minX - m;
    cam.right = maxX + m;
    cam.bottom = minY - m;
    cam.top = maxY + m;
    cam.near = Math.max(1e-4, minD - m);
    cam.far = maxD + m;
    cam.updateProjectionMatrix();
    const texel = Math.max(maxX - minX, maxY - minY) / this.sun.shadow.mapSize.x;
    this.sun.shadow.normalBias = texel * 1.6;
    this.sun.shadow.bias = -0.0003;
  }

  /** Keep the sky centred on the viewer (it is "infinitely" far). */
  update(cameraWorldPos) {
    this.sky.position.copy(cameraWorldPos);
    if (this.floor && this.floor.visible) {
      this.floor.position.x = cameraWorldPos.x;
      this.floor.position.z = cameraWorldPos.z;
    }
  }

  dispose() {
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.pmremSky.geometry.dispose();
    this.pmremSky.material.dispose();
    if (this.envTarget) this.envTarget.dispose();
    this.pmrem.dispose();
    if (this.sun.shadow.map) this.sun.shadow.map.dispose();
    if (this.floor) this.floor.geometry.dispose();
  }
}
