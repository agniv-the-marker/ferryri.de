/**
 * Pointer input → camera targets. Everything feeds the damped camera, so all
 * motion inherits the same glide:
 *
 *  - one finger / mouse drag: pan, with velocity sampled on release for an
 *    inertial coast
 *  - two fingers: pinch zoom anchored at the centroid (plus centroid pan)
 *  - wheel / trackpad: zoom at cursor (ctrlKey = trackpad pinch, finer)
 *  - tap: reported to the caller for picking; double-tap zooms in
 */
import type { Camera } from './camera';
import { T } from '../lib/tunables';

interface PointerRec {
  x: number;
  y: number;
}

const TAP_MAX_PX = 8;
const TAP_MAX_MS = 350;

export function attachGestures(
  el: HTMLElement,
  camera: Camera,
  onTap: (x: number, y: number) => void,
) {
  const pointers = new Map<number, PointerRec>();
  const samples: { t: number; x: number; y: number }[] = [];
  let downAt = 0;
  let moved = 0;
  let pinchDist = 0;

  const centroid = () => {
    let x = 0;
    let y = 0;
    for (const p of pointers.values()) {
      x += p.x;
      y += p.y;
    }
    return { x: x / pointers.size, y: y / pointers.size };
  };

  const dist = () => {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    camera.cancelFly();
    if (pointers.size === 1) {
      downAt = performance.now();
      moved = 0;
      samples.length = 0;
      samples.push({ t: downAt, x: e.offsetX, y: e.offsetY });
    } else if (pointers.size === 2) {
      pinchDist = dist();
    }
    el.classList.add('dragging');
  });

  el.addEventListener('pointermove', (e) => {
    const rec = pointers.get(e.pointerId);
    if (!rec) return;
    const prev = pointers.size === 1 ? { ...rec } : centroid();
    rec.x = e.offsetX;
    rec.y = e.offsetY;

    if (pointers.size === 1) {
      const dx = rec.x - prev.x;
      const dy = rec.y - prev.y;
      moved += Math.abs(dx) + Math.abs(dy);
      camera.panBy(dx, dy);
      const now = performance.now();
      samples.push({ t: now, x: rec.x, y: rec.y });
      while (samples.length > 2 && now - samples[0]!.t > 90) samples.shift();
    } else if (pointers.size === 2) {
      const c = centroid();
      camera.panBy(c.x - prev.x, c.y - prev.y);
      const d = dist();
      if (pinchDist > 0 && d > 0) camera.zoomAt(c.x, c.y, Math.log2(d / pinchDist));
      pinchDist = d;
      moved = Infinity; // a pinch is never a tap
    }
  });

  const endPointer = (e: PointerEvent) => {
    const was = pointers.size;
    pointers.delete(e.pointerId);
    if (was === 2) {
      // dropping to one finger: reset pan/tap tracking to the survivor
      samples.length = 0;
      pinchDist = 0;
      return;
    }
    if (was !== 1) return;
    el.classList.remove('dragging');

    const now = performance.now();
    if (moved < TAP_MAX_PX && now - downAt < TAP_MAX_MS) {
      // every tap is just a tap — zooming belongs to pinch and wheel
      onTap(e.offsetX, e.offsetY);
      return;
    }

    // inertial coast from release velocity
    const a = samples[0];
    const b = samples[samples.length - 1];
    if (a && b && b.t > a.t) {
      const dt = (b.t - a.t) / 1000;
      const vx = (b.x - a.x) / dt;
      const vy = (b.y - a.y) / dt;
      if (Math.hypot(vx, vy) > 120)
        camera.panBy(vx * T.camInertia, vy * T.camInertia);
    }
  };
  el.addEventListener('pointerup', endPointer);
  el.addEventListener('pointercancel', endPointer);

  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const px =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY;
      // ctrlKey marks trackpad pinch: browsers emit fine-grained deltas there
      const dz = -px * (e.ctrlKey ? 0.011 : 0.0028);
      camera.zoomAt(e.offsetX, e.offsetY, dz);
    },
    { passive: false },
  );
}
