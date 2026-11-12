/**
 * desktopRender.js
 *
 * The desktop side of the STYLIZED / REALISTIC switch, shared by the tower
 * and villa viewports. Each viewport keeps its own context object (`ctx`)
 * with its renderer, scene, camera, controls and stylized objects; these
 * helpers only read and write the fields listed in initDesktopRender().
 *
 * STYLIZED is each viewport's original pipeline, and its renderer state is
 * left exactly as it was (no tone mapping, no shadow map, global clipping
 * planes). REALISTIC is a RealisticWorld that shares the renderer and scene.
 * It is created the first time it is needed and also serves that studio's VR
 * session.
 */

import { RealisticWorld } from './RealisticWorld.js';
import { PostFX } from './PostFX.js';
import { FrameMonitor } from './QualityManager.js';

const FADE_MS = 300; // each way: fade to black, swap, fade back (~600 ms)

export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Add the render-mode fields to a viewport context.
 * @param {object} o kind ('tower' | 'villa'), fadeEl, stylizedObjs, cutQuads,
 *   stylizedMaxPolar (the viewport's own orbit limit), minCamY (m),
 *   skyScale (sky box size, inside the camera far plane), onQualityNote(text)
 */
export function initDesktopRender(ctx, o) {
  Object.assign(ctx, {
    kind: o.kind,
    fadeEl: o.fadeEl,
    fadeTimer: 0,
    fog: ctx.scene.fog,
    stylizedObjs: o.stylizedObjs,
    cutQuads: o.cutQuads,
    stylizedMaxPolar: o.stylizedMaxPolar,
    minCamY: o.minCamY,
    skyScale: o.skyScale,
    renderMode: 'stylized',
    preset: 'golden',
    model: null,
    realistic: null,
    postfx: null,
    postRatio: 1.5,
    aoWanted: true,
    bloomWanted: true,
    cut3D: false,
    cutPlanes: [],
    hero: null,
  });
  // Desktop frame-rate guard for the realistic mode: 60 fps target; steps
  // down AO, then resolution, then bloom, then the shadow map size.
  ctx.monitor = new FrameMonitor({
    target: 60,
    steps: [
      {
        label: 'AO OFF',
        run: () => {
          ctx.aoWanted = false;
          if (ctx.postfx) ctx.postfx.setAO(false);
        },
      },
      {
        label: 'RESOLUTION 1X',
        run: () => {
          ctx.postRatio = 1;
          resizePost(ctx);
        },
      },
      {
        label: 'BLOOM OFF',
        run: () => {
          ctx.bloomWanted = false;
          if (ctx.postfx) ctx.postfx.setBloomEnabled(false);
        },
      },
      {
        label: 'SHADOWS 2048',
        run: () => {
          if (!ctx.realistic) return;
          ctx.realistic.env.setShadowSize(2048);
          ctx.realistic.markShadows();
        },
      },
    ],
    onStep: (step) => o.onQualityNote && o.onQualityNote(`QUALITY AUTO-ADJUSTED · ${step.label}`),
  });
}

export function getRealistic(ctx) {
  if (!ctx.realistic) {
    const R = new RealisticWorld({ renderer: ctx.renderer, scene: ctx.scene, kind: ctx.kind, skyScale: ctx.skyScale });
    R.setPreset(ctx.preset);
    R.setModel(ctx.model);
    R.attachTo(ctx.root);
    ctx.realistic = R;
  }
  return ctx.realistic;
}

/** Desktop cut: global planes when stylized, building materials when realistic. */
export function applyDesktopClipping(ctx) {
  const real = ctx.renderMode === 'realistic' && ctx.realistic;
  if (real) {
    ctx.renderer.clippingPlanes = [];
    ctx.realistic.setCut(ctx.cutPlanes[0] || null);
    if (ctx.postfx) ctx.postfx.setAO(undefined, !ctx.cut3D);
  } else {
    ctx.renderer.clippingPlanes = ctx.cutPlanes;
  }
}

/** Cut planes from the viewport's updateCuts (parked while VR owns the scene). */
export function setDesktopCut(ctx, cut3D) {
  ctx.cut3D = cut3D;
  ctx.cutPlanes = cut3D ? [ctx.clipPlane] : [];
  // In VR the session clips per material; park the desktop planes until it ends.
  if (ctx.vr && ctx.vr.presenting && ctx.vr.saved) ctx.vr.saved.clipping = ctx.cutPlanes;
  else applyDesktopClipping(ctx);
}

/** Put the desktop scene into ctx.renderMode (not while VR owns the scene). */
export function applyDesktopRender(ctx) {
  if (ctx.vr && ctx.vr.presenting) return;
  const on = ctx.renderMode === 'realistic';
  const { renderer, scene, controls } = ctx;
  for (const o of ctx.stylizedObjs) o.visible = !on;
  // The cyan cut indicators are a drawing device: realistic hides them (the
  // plan and section panels still show the cuts, and CUT 3D still cuts).
  for (const q of ctx.cutQuads) {
    q.mesh.visible = !on;
    q.edge.visible = !on;
  }
  if (on) {
    const R = getRealistic(ctx);
    R.setModel(ctx.model);
    R.attachTo(ctx.root);
    R.setVR(false);
    R.setActive(true);
    R.applyRenderer(true);
    scene.fog = R.fog;
    renderer.localClippingEnabled = true;
    // Low hero views look up at the building: allow the camera below the target.
    controls.maxPolarAngle = Math.PI * 0.66;
    if (!ctx.postfx) ctx.postfx = new PostFX(renderer, scene, ctx.camera, { ao: R.tier.ao });
    ctx.postfx.setBloom(R.preset.bloom);
    ctx.postfx.setAO(ctx.aoWanted && R.tier.ao, !ctx.cut3D);
    ctx.postfx.setBloomEnabled(ctx.bloomWanted);
    resizePost(ctx);
    ctx.monitor.reset();
  } else {
    if (ctx.realistic) {
      ctx.realistic.setActive(false);
      ctx.realistic.applyRenderer(false);
    }
    scene.fog = ctx.fog;
    renderer.localClippingEnabled = false;
    // Keep the current view: only widen the limit if the camera is already below it.
    controls.maxPolarAngle = Math.max(ctx.stylizedMaxPolar, controls.getPolarAngle());
  }
  applyDesktopClipping(ctx);
}

/** Composer size: the viewport size at up to 1.5x pixel ratio. */
export function resizePost(ctx) {
  if (!ctx.postfx) return;
  const w = ctx.mount.clientWidth;
  const h = ctx.mount.clientHeight;
  if (w && h) ctx.postfx.setSize(w, h, Math.min(ctx.renderer.getPixelRatio(), ctx.postRatio));
}

export function switchRender(ctx, mode) {
  if (mode === ctx.renderMode) return;
  ctx.renderMode = mode;
  // In VR the session fades in the headset; the desktop is re-applied on exit.
  if (ctx.vr.presenting) return;
  const el = ctx.fadeEl;
  clearTimeout(ctx.fadeTimer);
  el.style.opacity = '1';
  ctx.fadeTimer = setTimeout(() => {
    applyDesktopRender(ctx);
    // Compile the new materials under black, then fade back in.
    try {
      ctx.renderer.compile(ctx.scene, ctx.camera);
    } catch {
      /* compile is an optimisation only */
    }
    requestAnimationFrame(() => {
      el.style.opacity = '0';
    });
  }, FADE_MS);
}

/** Lighting preset (the same RealisticWorld serves desktop and VR). */
export function setDesktopPreset(ctx, preset) {
  ctx.preset = preset;
  if (ctx.realistic) {
    ctx.realistic.setPreset(preset);
    if (ctx.postfx) ctx.postfx.setBloom(ctx.realistic.preset.bloom);
  }
}

/** Start an eased camera move to `pose` = { pos, target } (HERO). */
export function startHero(ctx, pose) {
  ctx.controls.autoRotate = false;
  ctx.hero = {
    t: 0,
    fromPos: ctx.camera.position.clone(),
    fromTarget: ctx.controls.target.clone(),
    toPos: pose.pos,
    toTarget: pose.target,
  };
}

/** Advance the HERO move: eased over 1.6 s, then auto-rotate carries on. */
export function stepHero(ctx, dt) {
  const hm = ctx.hero;
  if (!hm) return;
  hm.t = Math.min(1, hm.t + dt / 1.6);
  const k = easeInOut(hm.t);
  ctx.camera.position.lerpVectors(hm.fromPos, hm.toPos, k);
  ctx.controls.target.lerpVectors(hm.fromTarget, hm.toTarget, k);
  if (hm.t >= 1) {
    ctx.hero = null;
    ctx.controls.autoRotate = true;
  }
}

/** One realistic desktop frame; returns false when the stylized path should render. */
export function renderRealistic(ctx, dt) {
  if (ctx.renderMode !== 'realistic' || !ctx.realistic) return false;
  const { camera, controls } = ctx;
  controls.update();
  if (camera.position.y < ctx.minCamY) camera.position.y = ctx.minCamY; // stay above the ground
  ctx.realistic.update(dt, camera.position);
  if (ctx.postfx) {
    ctx.postfx.setSceneBox(ctx.realistic.sceneBox());
    ctx.postfx.render(dt);
  } else ctx.renderer.render(ctx.scene, camera);
  ctx.monitor.sample(dt);
  return true;
}

/** Dispose the realistic parts of a viewport context. */
export function disposeDesktopRender(ctx) {
  clearTimeout(ctx.fadeTimer);
  if (ctx.postfx) ctx.postfx.dispose();
  if (ctx.realistic) ctx.realistic.dispose();
}

