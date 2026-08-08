/**
 * Damped map camera. The camera is never set directly: input mutates the
 * *target*, and the rendered state eases toward it every frame with
 * frame-rate-independent exponential damping — so every motion glides and any
 * animation is interruptible (grab mid-flight and it just redirects).
 */
import type { WorldPt } from './proj';
import { T } from '../lib/tunables';

export interface View {
  x: number; // world center
  y: number;
  z: number; // zoom: world pixel size = TILE * 2^z
}

const TILE = 256;

export class Camera {
  cur: View;
  tgt: View;
  minZ = 9.5;
  get maxZ() {
    return T.camMaxZoom;
  }
  /** World-space bounds the center may roam (padded data bbox). */
  bounds = { x0: 0, y0: 0, x1: 1, y1: 1 };

  private vw = 1;
  private vh = 1;
  private fly: { from: View; to: View; t: number; dur: number } | null = null;
  private stiffness = T.camStiffness;

  constructor(initial: View) {
    this.cur = { ...initial };
    this.tgt = { ...initial };
  }

  setViewport(w: number, h: number) {
    this.vw = w;
    this.vh = h;
  }

  get viewport() {
    return { w: this.vw, h: this.vh };
  }

  /** Screen px per world unit at the rendered zoom. */
  get scale(): number {
    return TILE * 2 ** this.cur.z;
  }

  worldToScreen(p: WorldPt): { x: number; y: number } {
    const s = this.scale;
    return {
      x: (p.x - this.cur.x) * s + this.vw / 2,
      y: (p.y - this.cur.y) * s + this.vh / 2,
    };
  }

  screenToWorld(sx: number, sy: number): WorldPt {
    const s = this.scale;
    return {
      x: (sx - this.vw / 2) / s + this.cur.x,
      y: (sy - this.vh / 2) / s + this.cur.y,
    };
  }

  /** Pan the target by a screen-space delta (px). */
  panBy(dx: number, dy: number) {
    this.cancelFly();
    const s = TILE * 2 ** this.tgt.z;
    this.tgt.x -= dx / s;
    this.tgt.y -= dy / s;
    this.clampTarget();
  }

  /**
   * Zoom the target by dz, keeping the world point under the given screen
   * coordinate fixed (wheel cursor / pinch centroid anchoring).
   */
  zoomAt(sx: number, sy: number, dz: number) {
    this.cancelFly();
    const z0 = this.tgt.z;
    const z1 = Math.max(this.minZ, Math.min(this.maxZ, z0 + dz));
    if (z1 === z0) return;
    // anchor in target-space
    const s0 = TILE * 2 ** z0;
    const ax = (sx - this.vw / 2) / s0 + this.tgt.x;
    const ay = (sy - this.vh / 2) / s0 + this.tgt.y;
    const s1 = TILE * 2 ** z1;
    this.tgt.z = z1;
    this.tgt.x = ax - (sx - this.vw / 2) / s1;
    this.tgt.y = ay - (sy - this.vh / 2) / s1;
    this.clampTarget();
  }

  /**
   * Smooth zoom-and-pan arc to a destination (van Wijk & Nuij flavored: zooms
   * out proportionally to the distance before diving in). The arc animates the
   * *target*; damping does the rest, so it stays interruptible.
   */
  flyTo(dest: { x: number; y: number; z: number }) {
    const from = { ...this.tgt };
    const to = {
      x: dest.x,
      y: dest.y,
      z: Math.max(this.minZ, Math.min(this.maxZ, dest.z)),
    };
    // travel distance in screen px at the destination zoom → how far to arc out
    const sDest = TILE * 2 ** to.z;
    const distPx = Math.hypot(to.x - from.x, to.y - from.y) * sDest;
    const span = Math.min(this.vw, this.vh);
    const zoomOut = Math.min(
      Math.max(0, Math.log2(Math.max(1, distPx / span)) * T.camFlyZoomOut),
      Math.max(0, Math.min(from.z, to.z) - this.minZ),
    );
    const dur =
      Math.min(2.2, 0.55 + 0.28 * (zoomOut + Math.abs(to.z - from.z))) / T.camFlySpeed;
    this.fly = { from, to: { ...to, z: to.z }, t: 0, dur };
    (this.fly as { zoomOut?: number }).zoomOut = zoomOut;
  }

  cancelFly() {
    this.fly = null;
    this.stiffness = T.camStiffness;
  }

  get flying(): boolean {
    return this.fly !== null;
  }

  /** Advance one frame. Returns true while anything is still moving. */
  update(dt: number): boolean {
    if (this.fly) {
      const f = this.fly;
      f.t = Math.min(1, f.t + dt / f.dur);
      const e = f.t * f.t * (3 - 2 * f.t); // smoothstep along the path
      const zoomOut = (f as { zoomOut?: number }).zoomOut ?? 0;
      // zoom dips by `zoomOut` mid-flight (sin arc), while xy eases across
      this.tgt.x = f.from.x + (f.to.x - f.from.x) * e;
      this.tgt.y = f.from.y + (f.to.y - f.from.y) * e;
      this.tgt.z =
        f.from.z + (f.to.z - f.from.z) * e - zoomOut * Math.sin(Math.PI * e);
      this.stiffness =
        T.camFlyStiffness + (T.camStiffness - T.camFlyStiffness) * f.t;
      if (f.t >= 1) {
        this.fly = null;
        this.stiffness = T.camStiffness;
      }
    }

    const k = 1 - Math.exp(-this.stiffness * dt);
    const dx = this.tgt.x - this.cur.x;
    const dy = this.tgt.y - this.cur.y;
    const dz = this.tgt.z - this.cur.z;
    this.cur.x += dx * k;
    this.cur.y += dy * k;
    this.cur.z += dz * k;

    const sp = this.scale;
    const still =
      Math.abs(dx) * sp < 0.05 && Math.abs(dy) * sp < 0.05 && Math.abs(dz) < 0.0005;
    if (still && !this.fly) {
      this.cur.x = this.tgt.x;
      this.cur.y = this.tgt.y;
      this.cur.z = this.tgt.z;
      return false;
    }
    return true;
  }

  /**
   * Keep the whole *viewport* inside the bounds box (not just the center),
   * so the edge of the world never scrolls into view.
   */
  private clampTarget() {
    this.tgt.z = Math.max(this.minZ, Math.min(this.maxZ, this.tgt.z));
    const b = this.bounds;
    const s = TILE * 2 ** this.tgt.z;
    const hw = this.vw / (2 * s);
    const hh = this.vh / (2 * s);
    this.tgt.x =
      b.x1 - b.x0 <= 2 * hw
        ? (b.x0 + b.x1) / 2
        : Math.max(b.x0 + hw, Math.min(b.x1 - hw, this.tgt.x));
    this.tgt.y =
      b.y1 - b.y0 <= 2 * hh
        ? (b.y0 + b.y1) / 2
        : Math.max(b.y0 + hh, Math.min(b.y1 - hh, this.tgt.y));
  }
}
