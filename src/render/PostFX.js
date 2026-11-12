/**
 * PostFX.js
 *
 * Desktop-only post-processing for the REALISTIC mode (never used in VR):
 *
 *   RenderPass       scene → half-float target (linear HDR, no tone mapping)
 *   GTAOPass         ground-truth ambient occlusion (the N8AO-style pass in
 *                    three/examples), on top of the AO baked into the
 *                    vertex colours. Clipped to a box around the site so the
 *                    sky dome never receives AO. Turned off while the section
 *                    cut is on: its normal pass uses an override material that
 *                    ignores per-material clipping planes.
 *   UnrealBloomPass  subtle; the threshold is above lit facades so only the
 *                    window emission and the sun catch it
 *   SMAAPass         edge anti-aliasing (the composer targets are not MSAA)
 *   OutputPass       ACES tone mapping + sRGB, from the renderer's settings
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export class PostFX {
  constructor(renderer, scene, camera, { ao = true } = {}) {
    this.renderer = renderer;
    const size = renderer.getSize(new THREE.Vector2());
    const pr = renderer.getPixelRatio();
    const w = Math.max(1, size.x);
    const h = Math.max(1, size.y);
    this.composer = new EffectComposer(renderer);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);

    this.renderPass = new RenderPass(scene, camera);
    this.ao = new GTAOPass(scene, camera, w * pr, h * pr);
    this.ao.updateGtaoMaterial({ radius: 5, distanceExponent: 1.5, thickness: 4, scale: 1, samples: 12, distanceFallOff: 1, screenSpaceRadius: false });
    this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, radiusExponent: 1, rings: 2, samples: 12 });
    this.ao.blendIntensity = 0.7;
    this.aoWanted = ao;
    this.aoAllowed = true;
    this.ao.enabled = ao;
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.3, 0.5, 1.4);
    this.smaa = new SMAAPass(w * pr, h * pr);
    this.output = new OutputPass();

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.ao);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.smaa);
    this.composer.addPass(this.output);
  }

  setSize(w, h, pr) {
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
  }

  /** AO on/off from the quality guard (wanted) and the section cut (allowed). */
  setAO(wanted = this.aoWanted, allowed = this.aoAllowed) {
    this.aoWanted = wanted;
    this.aoAllowed = allowed;
    this.ao.enabled = wanted && allowed;
  }

  setSceneBox(box) {
    this.ao.setSceneClipBox(box);
  }

  setBloom({ strength, radius, threshold }) {
    this.bloom.strength = strength;
    this.bloom.radius = radius;
    this.bloom.threshold = threshold;
  }

  setBloomEnabled(on) {
    this.bloom.enabled = on;
  }

  render(dt) {
    this.composer.render(dt);
  }

  dispose() {
    this.ao.dispose();
    this.bloom.dispose();
    this.smaa.dispose();
    this.output.dispose();
    this.composer.dispose();
  }
}
