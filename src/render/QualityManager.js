/**
 * QualityManager.js
 *
 * Device tiers for the REALISTIC mode and the automatic step-down that keeps
 * VR (and desktop) at frame rate.
 *
 * Tiers (from the user agent, as the VR framebuffer heuristic does):
 *   desktop  shadow 4096, full planting and city, 2048 px window texture
 *   pcvr     desktop assets, 2048 shadow map in VR
 *   quest3   2048 shadow map, full planting and city, 2048 px windows
 *   quest2   1024 shadow map, half planting and half the city, 1024 px windows
 * Headsets also only draw street trees within treeR (320 m) of the site.
 *
 * FrameMonitor keeps a rolling 2 s average of frame time. When the average
 * frame rate stays below 90 % of the target it fires the next step, then waits
 * another full window before judging again (so one step is measured before the
 * next one is taken). It ignores the first 3 s after start (intro, shader
 * compiles).
 */

import { detectQuality } from '../vr/VRSession.js';

export function detectTier() {
  const d = detectQuality().device;
  if (d === 'QUEST 2') {
    return { id: 'quest2', device: d, shadowDesktop: 2048, shadowVR: 1024, foliage: 0.5, city: 0.5, treeR: 320, windowTex: 1024, vrFps: 72, ao: false };
  }
  if (d === 'QUEST 3') {
    return { id: 'quest3', device: d, shadowDesktop: 2048, shadowVR: 2048, foliage: 1, city: 1, treeR: 320, windowTex: 2048, vrFps: 90, ao: false };
  }
  if (d === 'VISION PRO') {
    return { id: 'visionpro', device: d, shadowDesktop: 2048, shadowVR: 2048, foliage: 1, city: 1, treeR: 400, windowTex: 2048, vrFps: 90, ao: false };
  }
  const coarse = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  return {
    id: coarse ? 'mobile' : 'desktop',
    device: d,
    shadowDesktop: coarse ? 2048 : 4096,
    shadowVR: 2048,
    foliage: 1,
    city: 1,
    treeR: Infinity,
    windowTex: coarse ? 1024 : 2048,
    vrFps: 90,
    ao: !coarse,
  };
}

export class FrameMonitor {
  /**
   * @param {object} o target (fps), steps: [{ id, label, run() }], onStep(step)
   */
  constructor({ target, steps, onStep, window = 2, warmup = 3 }) {
    this.target = target;
    this.steps = steps;
    this.onStep = onStep;
    this.window = window;
    this.warmup = warmup;
    this.reset();
  }

  reset() {
    this.samples = [];
    this.sum = 0;
    this.clock = 0;
    this.holdUntil = this.warmup;
    this.level = 0;
  }

  /** Restart the measurement window without undoing steps already taken. */
  hold(seconds = this.window) {
    this.samples = [];
    this.sum = 0;
    this.holdUntil = this.clock + seconds;
  }

  get exhausted() {
    return this.level >= this.steps.length;
  }

  /** Average frame rate over the window, or 0 until a full window exists. */
  get fps() {
    if (!this.samples.length || this.sum < this.window * 0.95) return 0;
    return this.samples.length / this.sum;
  }

  sample(dt) {
    if (!(dt > 0) || dt > 0.5) return; // tab switches, breakpoints
    this.clock += dt;
    if (this.clock < this.holdUntil) return;
    this.samples.push(dt);
    this.sum += dt;
    while (this.sum > this.window && this.samples.length > 1) this.sum -= this.samples.shift();
    const fps = this.fps;
    if (!fps || this.exhausted) return;
    if (fps < this.target * 0.9) {
      const step = this.steps[this.level++];
      step.run();
      if (this.onStep) this.onStep(step, fps);
      this.hold();
    }
  }
}
