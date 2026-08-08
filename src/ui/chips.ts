/**
 * On-map departure chips — the semantic-zoom layer. Past a zoom band each
 * terminal grows a chip showing its next departure; zoomed into the Ferry
 * Building, one chip covers all its gates. Visibility is a continuous function of
 * the animated zoom, so chips materialize during the glide.
 */
import type { Camera } from '../map/camera';
import { project, type WorldPt } from '../map/proj';
import type { Terminal } from '../lib/types';
import { departuresFrom } from '../sim/schedule';
import { fmtClock } from '../lib/clock';
import { T } from '../lib/tunables';
import { stopFamily, type BoardCtx } from './board';

interface ChipNode {
  el: HTMLElement;
  world: WorldPt;
  text: string;
  w: number; // estimated css width for declutter
}

const fade = (z: number, from: number, width = 0.7) =>
  Math.max(0, Math.min(1, (z - from) / width));

export class Chips {
  private container = document.getElementById('chips')!;
  private nodes = new Map<string, ChipNode>();
  private lastMinute = -1;
  private terminals: Terminal[] = [];

  constructor(private ctx: () => BoardCtx) {}

  private ensure(t: Terminal): ChipNode {
    let n = this.nodes.get(t.id);
    if (!n) {
      const el = document.createElement('div');
      el.className = 'chip';
      this.container.append(el);
      n = { el, world: project(t.lng, t.lat), text: '', w: 60 };
      this.nodes.set(t.id, n);
    }
    return n;
  }

  /** Rebuild chip texts (called when the minute changes). */
  private refreshTexts() {
    const ctx = this.ctx();
    this.terminals = ctx.data.terminals.filter((t) => t.active);
    for (const t of this.terminals) {
      const n = this.ensure(t);
      const deps = departuresFrom(ctx.timed, stopFamily(ctx, t), ctx.nowSec, 1);
      const d = deps[0];
      if (!d) {
        n.text = '';
        n.el.innerHTML = '';
        continue;
      }
      const route = ctx.routeById.get(d.routeId);
      const dest = ctx.terminalById.get(d.destStop);
      const destShort = (
        dest?.parent ? ctx.terminalById.get(dest.parent)?.short ?? '' : dest?.short ?? ''
      ).toUpperCase();
      const text = `${fmtClock(d.dep).replace(/ [ap]m/, '')} → ${destShort}`;
      if (text !== n.text) {
        n.text = text;
        n.el.innerHTML = '';
        const b = document.createElement('b');
        b.textContent = fmtClock(d.dep).replace(/ [ap]m/, '');
        n.el.append(b, ` → ${destShort}`);
        n.el.style.borderLeft = `2px solid ${route?.accent ?? 'var(--border)'}`;
        n.w = 14 + text.length * 6.4;
      }
    }
  }

  update(cam: Camera) {
    const ctx = this.ctx();
    const minute = Math.floor(ctx.nowSec / 60);
    if (minute !== this.lastMinute) {
      this.lastMinute = minute;
      this.refreshTexts();
    }

    const z = cam.cur.z;
    const chipAlpha = fade(z, T.chipZoom);
    if (chipAlpha <= 0) {
      for (const n of this.nodes.values()) n.el.style.opacity = '0';
      return;
    }

    // sort by soonest (shorter text first is fine too) — draw order = priority
    const placed: { x: number; y: number; w: number }[] = [];
    const { w: vw, h: vh } = cam.viewport;

    for (const t of this.terminals) {
      const n = this.nodes.get(t.id);
      if (!n || !n.text) continue;
      // gates aren't drawn on the map — the Ferry Building keeps one chip
      let alpha = chipAlpha;
      if (t.parent) alpha = 0;

      const p = cam.worldToScreen(n.world);
      const x = p.x;
      const y = p.y - 16;
      if (alpha <= 0.02 || x < -80 || y < -30 || x > vw + 80 || y > vh + 30) {
        n.el.style.opacity = '0';
        continue;
      }
      // greedy declutter: skip if overlapping an already-placed chip
      const clash = placed.some(
        (r) => Math.abs(r.x - x) < (r.w + n.w) / 2 + 4 && Math.abs(r.y - y) < 22,
      );
      if (clash) {
        n.el.style.opacity = '0';
        continue;
      }
      placed.push({ x, y, w: n.w });
      n.el.style.opacity = String(alpha);
      n.el.style.transform =
        `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) ` +
        `translate(-50%, -100%) scale(${(0.92 + alpha * 0.08).toFixed(3)})`;
    }
  }
}
