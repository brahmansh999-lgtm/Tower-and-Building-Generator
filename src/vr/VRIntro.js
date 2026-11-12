/**
 * VRIntro.js
 *
 * The spawn moment. The user starts in darkness; the grid and sky fade in, the
 * tower draws itself floor by floor from the ground up, the fins rise last and
 * the bridges sweep across as arcs. Any trigger or grip skips to the end.
 *
 * No geometry is touched per frame: every VR mesh carries a reveal table
 * (see buildVRMeshes.js), and the intro only moves each geometry's drawRange.
 *
 * Timeline (seconds):
 *   0.0 – 1.2   grid, horizon, stars and city fade in
 *   0.8 – 4.2   shell + floor bands, by height (eased)
 *   2.6 – 4.6   fins, by height
 *   3.8 – 5.2   bridge bodies, rails and glow, sweeping A → B
 */

import { revealCount } from '../geometry/buildVRMeshes.js';

const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const phase = (t, a, b) => ease((t - a) / (b - a));

export const INTRO_LENGTH = 5.2;

export class VRIntro {
  constructor() {
    this.t = 0;
    this.active = false;
  }

  start() {
    this.t = 0;
    this.active = true;
  }

  skip() {
    if (!this.active) return false;
    this.t = INTRO_LENGTH;
    return true;
  }

  /**
   * Advance and apply. `layers` = { tower: Mesh[], fins: Mesh[], bridges: Mesh[],
   * onReveal?(0..1) },
   * `maxZ` = model height in metres, `env` has setReveal(0..1).
   */
  update(dt, layers, maxZ, env) {
    if (!this.active) return;
    this.t += dt;
    const t = this.t;
    env.setReveal(phase(t, 0, 1.2));
    // A little over maxZ so the parapet and overrun pieces are included at 1.
    const zTower = phase(t, 0.8, 4.2) * (maxZ + 10);
    const zFins = phase(t, 2.6, 4.6) * (maxZ + 10);
    const sweep = phase(t, 3.8, 5.2) * 1.0001;
    const show = (mesh, threshold) => {
      if (!mesh || !mesh.visible) return;
      const r = mesh.geometry.userData.reveal;
      if (r) mesh.geometry.setDrawRange(0, revealCount(r, threshold));
    };
    layers.tower.forEach((m) => show(m, zTower));
    layers.fins.forEach((m) => show(m, zFins));
    layers.bridges.forEach((m) => show(m, sweep - 1e-6));
    // Content without reveal tables (the villa) rises through a clipping plane instead.
    if (layers.onReveal) layers.onReveal(phase(t, 0.8, 4.2));
    if (t >= INTRO_LENGTH) this.finish(layers, env);
  }

  /** Make sure everything is fully drawn and stop. */
  finish(layers, env) {
    this.active = false;
    env.setReveal(1);
    for (const m of [...layers.tower, ...layers.fins, ...layers.bridges]) {
      if (m) m.geometry.setDrawRange(0, Infinity);
    }
    if (layers.onReveal) layers.onReveal(1);
  }
}
