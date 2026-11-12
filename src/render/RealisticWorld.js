/**
 * RealisticWorld.js
 *
 * The REALISTIC mode as one object, shared by the desktop viewport and the VR
 * session (they use the same renderer and scene):
 *
 *   env         sky, sun, fill, haze, reflections   (scene level, world space)
 *   modelSpace  building + planting + city         (data space; parented to
 *               the desktop root or the VR model group, both of which rotate
 *               data z-up onto three.js y-up)
 *
 * It is created the first time someone switches to REALISTIC, so the stylized
 * mode pays nothing for it. Geometry is rebuilt from generateTower() output only
 * when the model object changes (form / cluster sliders), at most every 150 ms
 * while a slider is dragged; old geometry is disposed on every rebuild.
 *
 * Shadows: shadowMap.autoUpdate is off. The map is re-rendered only when
 * something that casts or receives changes: a rebuild, a preset, a cut, the
 * tabletop transform (throttled to 20 Hz in VR).
 */

import * as THREE from 'three';
import { buildRealisticMeshes, foliageGeometry, palmGeometry, seeded } from '../geometry/buildRealisticMeshes.js';
import { buildRealisticVilla } from '../geometry/buildRealisticVilla.js';
import { FLOOR_HEIGHT } from '../geometry/generateTower.js';
import { createRealisticMaterials } from './RealisticMaterials.js';
import { RealisticEnvironment, PRESETS } from './RealisticEnvironment.js';
import { RealisticContext } from './RealisticContext.js';
import { detectTier } from './QualityManager.js';

const REBUILD_MS = 150;
const VR_SHADOW_MS = 50;
const FOLIAGE_TINTS = [
  [0.85, 1.0, 0.8],
  [1.0, 1.0, 1.0],
  [0.7, 0.9, 0.62],
  [1.05, 1.0, 0.7],
].map((c) => new THREE.Color(...c));
/**
 * What each studio builds: the geometry function, its output keys → material
 * names, the keys that only receive shadows, the context options and the
 * haze strength (the villa is seen from ~50 m, the towers from ~500 m).
 */
const KINDS = {
  tower: {
    build: buildRealisticMeshes,
    meshes: { glass: 'glass', podiumGlass: 'podiumGlass', alu: 'alu', concrete: 'concrete', helipad: 'helipad', uplight: 'uplight' },
    receiveOnly: ['uplight'],
    context: {},
    fogScale: 1,
  },
  villa: {
    build: buildRealisticVilla,
    meshes: { glass: 'glass', white: 'white', interior: 'interior', timber: 'timber', lawn: 'lawn', drive: 'pavement', water: 'water', stone: 'stone' },
    receiveOnly: ['lawn', 'drive', 'water'],
    // A suburb of low houses beyond the street grid, on grass.
    context: { ground: 'lawn', far: { start: 380, r: 1600, count: 700, h: [5, 9], tall: 0.03, tallH: [12, 22], size: [12, 24] } },
    fogScale: 2.2,
  },
};

/** Seeded Fisher–Yates, so halving the planting thins it evenly and stably. */
function shuffled(list, seed) {
  const out = list.slice();
  const rnd = seeded(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export class RealisticWorld {
  /**
   * @param {object} o renderer, scene, kind ('tower' | 'villa'),
   *   skyScale (desktop sky box size; must sit inside the camera far plane)
   */
  constructor({ renderer, scene, kind = 'tower', skyScale = 9000 }) {
    this.renderer = renderer;
    this.scene = scene;
    this.kind = KINDS[kind] ? kind : 'tower';
    this.spec = KINDS[this.kind];
    this.skyScale = skyScale;
    this.tier = detectTier();
    this.mats = createRealisticMaterials(this.tier);

    this.env = new RealisticEnvironment(renderer, this.tier);
    this.env.fogScale = this.spec.fogScale;
    this.env.setSkyScale(skyScale);
    this.env.group.visible = false;
    this.env.onEnv = (tex) => {
      if (this.active) this.scene.environment = tex;
    };
    scene.add(this.env.group);

    // VR tabletop: a stone floor under the user, centred on them.
    const floor = new THREE.Mesh(new THREE.CircleGeometry(80, 64).rotateX(-Math.PI / 2), this.mats.floor);
    floor.visible = false;
    floor.name = 'realistic-vr-floor';
    this.env.floor = floor;
    this.env.group.add(floor);

    this.modelSpace = new THREE.Group();
    this.modelSpace.name = 'realistic-model';
    this.modelSpace.visible = false;
    this.building = new THREE.Group();
    this.meshes = {};
    for (const [k, mat] of Object.entries(this.spec.meshes)) {
      const m = new THREE.Mesh(new THREE.BufferGeometry(), this.mats[mat]);
      m.castShadow = !this.spec.receiveOnly.includes(k);
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.visible = false;
      this.meshes[k] = m;
      this.building.add(m);
    }
    this.foliage = null;
    this.palms = null;
    this.foliageGeo = foliageGeometry();
    this.palmGeo = palmGeometry();
    this.context = new RealisticContext(this.mats, this.tier, this.spec.context);
    this.modelSpace.add(this.building, this.context.group);

    this.model = null;
    this.built = null;
    this.dirty = false;
    this.lastBuild = 0;
    this.active = false;
    this.vr = false;
    this.foliageScale = this.tier.foliage;
    this.cut = null;
    this.revealPlane = new THREE.Plane();
    this.revealOn = false;
    this.shadowsOn = true;
    this.shadowDirty = true;
    this.lastShadow = 0;
    this.envStep = -1;
    this.setPreset('golden');
  }

  get fog() {
    return this.env.fog;
  }

  get preset() {
    return this.env.preset;
  }

  setModel(model) {
    if (model && model !== this.model) {
      this.model = model;
      this.dirty = true;
    }
  }

  /** Parent the data-space group (desktop root or the VR model group). */
  attachTo(parent) {
    if (this.modelSpace.parent !== parent) parent.add(this.modelSpace);
    this.markShadows();
  }

  setActive(on) {
    this.active = on;
    this.env.group.visible = on;
    this.modelSpace.visible = on;
    if (on && this.dirty) this.rebuild();
  }

  /**
   * Renderer state for this mode. Off restores the exact defaults the stylized
   * mode was written against (no tone mapping, exposure 1, no shadow map, no
   * scene environment), so stylized frames are unchanged.
   */
  applyRenderer(on) {
    const r = this.renderer;
    this.env.active = on;
    if (on) {
      r.toneMapping = THREE.ACESFilmicToneMapping;
      r.toneMappingExposure = this.env.exposure;
      r.outputColorSpace = THREE.SRGBColorSpace;
      r.shadowMap.enabled = this.shadowsOn;
      r.shadowMap.type = THREE.PCFSoftShadowMap;
      r.shadowMap.autoUpdate = false;
      r.shadowMap.needsUpdate = true;
      this.scene.environment = this.env.envMap;
      if (this.savedBackground === undefined) this.savedBackground = this.scene.background;
      this.scene.background = this.env.background;
    } else {
      r.toneMapping = THREE.NoToneMapping;
      r.toneMappingExposure = 1;
      r.shadowMap.enabled = false;
      r.shadowMap.autoUpdate = true;
      this.scene.environment = null;
      if (this.savedBackground !== undefined) {
        this.scene.background = this.savedBackground;
        this.savedBackground = undefined;
      }
    }
  }

  /** VR: smaller sky (inside the 5 km far plane) and the VR shadow map size. */
  setVR(on) {
    this.vr = on;
    this.env.setSkyScale(on ? 4000 : this.skyScale);
    this.env.setShadowSize(on ? this.tier.shadowVR : this.tier.shadowDesktop);
    if (!on) {
      this.env.floor.visible = false;
      this.context.setCrop(Infinity);
    }
    this.markShadows();
  }

  /** Tabletop crop (data metres) and the floor under the user. */
  setTabletop(on, cropR) {
    this.env.floor.visible = this.vr && on;
    this.context.setCrop(on ? cropR : Infinity);
    this.markShadows();
  }

  setPreset(id) {
    this.env.setPreset(id);
    this.mats.applyPreset(this.env.preset);
    if (this.active) {
      this.renderer.toneMappingExposure = this.env.exposure;
      this.scene.environment = this.env.envMap;
    }
    this.markShadows();
  }

  /**
   * VR intro sunrise, k 0 → 1. The sky and lights follow every frame; the
   * reflection map is regenerated at three points of the sweep (it costs a
   * few ms) and the shadow map at most at 20 Hz.
   */
  setSunrise(k) {
    this.env.setSunrise(k);
    const step = k >= 1 ? 3 : Math.floor(k * 3);
    if (step !== this.envStep) {
      this.envStep = step;
      this.env.regenerateEnv();
    }
    this.markShadows();
  }

  /**
   * Section cut: a world-space plane (or null). Shared object, so the VR
   * session can move it every frame without calling this again.
   */
  setCut(plane) {
    this.cut = plane || null;
    this.applyClip();
  }

  /**
   * Floor-by-floor reveal for the VR intro, k 0 → 1. Keeps data z ≤ h with
   * h stepped to whole storeys:  h = ⌊k·(N + 1)⌋ · FLOOR_HEIGHT + 0.4,
   * N = storeys to the top of the crown. As a plane: n = (0, 0, −1), c = h,
   * carried into world space through the model group's world matrix.
   */
  setReveal(k) {
    if (k >= 1 || !this.built) {
      if (this.revealOn) {
        this.revealOn = false;
        this.applyClip();
      }
      return;
    }
    const N = Math.ceil(this.built.maxZ / FLOOR_HEIGHT);
    const h = k <= 0 ? -1 : Math.floor(k * (N + 1)) * FLOOR_HEIGHT + 0.4;
    this.modelSpace.updateWorldMatrix(true, false);
    this.revealPlane.set(new THREE.Vector3(0, 0, -1), h).applyMatrix4(this.modelSpace.matrixWorld);
    if (!this.revealOn) {
      this.revealOn = true;
      this.applyClip();
    }
    this.markShadows();
  }

  applyClip() {
    const planes = [];
    if (this.cut) planes.push(this.cut);
    if (this.revealOn) planes.push(this.revealPlane);
    this.mats.setClipPlanes(planes);
    this.markShadows();
  }

  setContextVisible(v) {
    this.context.setVisible(v);
    this.markShadows();
  }

  setFoliageScale(f) {
    this.foliageScale = f;
    this.applyFoliageCount();
    this.markShadows();
  }

  setShadows(on) {
    this.shadowsOn = on;
    this.env.sun.castShadow = on;
    if (this.active) this.renderer.shadowMap.enabled = on;
    this.markShadows();
  }

  markShadows() {
    this.shadowDirty = true;
  }

  applyFoliageCount() {
    if (this.foliage) this.foliage.count = Math.ceil(this.foliage.userData.total * this.foliageScale);
    if (this.palms) this.palms.count = Math.ceil(this.palms.userData.total * this.foliageScale);
  }

  instances(list, geo, mat, seed, tinted) {
    const items = shuffled(list, seed);
    const im = new THREE.InstancedMesh(geo, mat, Math.max(1, items.length));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const Z = new THREE.Vector3(0, 0, 1);
    items.forEach((it, i) => {
      im.setMatrixAt(i, m.compose(p.set(it.x, it.y, it.z), q.setFromAxisAngle(Z, it.rot), s.setScalar(it.s)));
      if (tinted) im.setColorAt(i, FOLIAGE_TINTS[it.tone % FOLIAGE_TINTS.length]);
    });
    im.userData.total = items.length;
    im.count = items.length;
    im.castShadow = true;
    im.receiveShadow = true;
    im.frustumCulled = false;
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    return im;
  }

  rebuild() {
    if (!this.model) return;
    const data = this.spec.build(this.model);
    for (const k of Object.keys(this.meshes)) {
      const mesh = this.meshes[k];
      const old = mesh.geometry;
      mesh.geometry = data[k] || new THREE.BufferGeometry();
      mesh.visible = !!data[k];
      old.dispose();
    }
    for (const key of ['foliage', 'palms']) {
      const old = this[key];
      if (old) {
        this.building.remove(old);
        old.dispose();
      }
    }
    this.foliage = this.instances(data.foliage, this.foliageGeo, this.mats.foliage, 77, true);
    this.palms = this.instances(data.palms, this.palmGeo, this.mats.palm, 78, false);
    this.building.add(this.foliage, this.palms);
    this.applyFoliageCount();
    this.context.build(this.model);
    this.built = data;
    this.dirty = false;
    this.lastBuild = performance.now();
    this.markShadows();
  }

  /** World-space corners of the building box (crown included). */
  worldCorners() {
    const b = this.built.box;
    this.modelSpace.updateWorldMatrix(true, false);
    const mw = this.modelSpace.matrixWorld;
    const out = [];
    for (const x of [b.minX, b.maxX]) for (const y of [b.minY, b.maxY]) for (const z of [b.minZ, b.maxZ]) out.push(new THREE.Vector3(x, y, z).applyMatrix4(mw));
    return out;
  }

  /** World-space box around the building, its shadow and the near city (for AO clipping). */
  sceneBox() {
    if (!this.built) return null;
    const box = new THREE.Box3().setFromPoints(this.worldCorners());
    box.expandByScalar(box.getSize(new THREE.Vector3()).length());
    return box;
  }

  fitShadow() {
    if (!this.built) return;
    const corners = this.worldCorners();
    const mw = this.modelSpace.matrixWorld;
    const g0 = new THREE.Vector3(0, 0, 0).applyMatrix4(mw);
    const g1 = new THREE.Vector3(0, 0, this.built.maxZ).applyMatrix4(mw);
    this.env.fitShadow(corners, g0.y, g1.distanceTo(g0));
  }

  /** Per frame: deferred rebuild, sky follow, on-demand shadow refresh. */
  update(dt, cameraWorldPos) {
    if (!this.active) return;
    const now = performance.now();
    if (this.dirty && now - this.lastBuild > REBUILD_MS) this.rebuild();
    this.env.update(cameraWorldPos);
    if (this.shadowDirty && this.shadowsOn && this.built && (!this.vr || now - this.lastShadow > VR_SHADOW_MS)) {
      this.fitShadow();
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowDirty = false;
      this.lastShadow = now;
    }
  }

  /** Triangles and draw calls of the realistic content (for the docs / HUD). */
  stats() {
    let tris = 0;
    let calls = 0;
    const count = (m) => {
      if (!m || !m.visible || !m.geometry.attributes.position) return;
      const n = m.geometry.index ? m.geometry.index.count / 3 : m.geometry.attributes.position.count / 3;
      tris += n * (m.isInstancedMesh ? m.count : 1);
      calls += 1;
    };
    this.building.children.forEach(count);
    this.context.group.children.forEach(count);
    return { tris: Math.round(tris), calls, foliage: this.foliage ? this.foliage.count : 0, palms: this.palms ? this.palms.count : 0 };
  }

  dispose() {
    for (const m of Object.values(this.meshes)) m.geometry.dispose();
    if (this.foliage) this.foliage.dispose();
    if (this.palms) this.palms.dispose();
    this.foliageGeo.dispose();
    this.palmGeo.dispose();
    this.context.dispose();
    this.env.dispose();
    this.mats.dispose();
    if (this.modelSpace.parent) this.modelSpace.parent.remove(this.modelSpace);
    this.scene.remove(this.env.group);
    if (this.scene.environment) this.scene.environment = null;
  }
}

export { PRESETS };
