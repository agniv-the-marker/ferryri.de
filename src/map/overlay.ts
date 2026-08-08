/**
 * The crisp 2D layer above the dithered water: route lines, vessels,
 * terminal markers, gate markers, and labels. Also owns hit-testing.
 *
 * All route lines are a single ink pass (one Path2D, one stroke — overlapping
 * subpaths don't double-darken); color belongs to vessels and UI accents.
 */
import type { Camera } from './camera';
import { project, type WorldPt } from './proj';
import type { Route, ScheduleData, Terminal } from '../lib/types';
import type { VesselState } from '../sim/vessels';
import { T } from '../lib/tunables';

export type Pick =
  | { type: 'terminal'; terminal: Terminal }
  | { type: 'vessel'; vessel: VesselState };

interface TerminalPt extends Terminal {
  world: WorldPt;
}

const cssVar = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * Gazetteer so the paper isn't anonymous. `min` is the zoom the label fades
 * in at, which doubles as an importance ranking — labels are drawn in list
 * order and any that would collide with one already placed is dropped, so
 * put the ones that matter most first.
 */
const PLACES: {
  kind: 'city' | 'peak' | 'place';
  name: string;
  lng: number;
  lat: number;
  min: number;
}[] = [
  // --- cities (terminals label themselves, so those names are absent) ---
  { kind: 'city', name: 'San Francisco', lng: -122.4415, lat: 37.7585, min: 9.6 },
  { kind: 'city', name: 'Berkeley', lng: -122.2728, lat: 37.8716, min: 10.4 },
  { kind: 'city', name: 'San Rafael', lng: -122.5311, lat: 37.9735, min: 10.6 },
  { kind: 'city', name: 'Hayward', lng: -122.0808, lat: 37.6688, min: 10.6 },
  { kind: 'city', name: 'San Mateo', lng: -122.3255, lat: 37.563, min: 10.6 },
  { kind: 'city', name: 'Napa', lng: -122.2869, lat: 38.2975, min: 10.6 },
  { kind: 'city', name: 'Concord', lng: -122.0311, lat: 37.978, min: 10.8 },
  { kind: 'city', name: 'Petaluma', lng: -122.6367, lat: 38.2324, min: 10.8 },
  { kind: 'city', name: 'Walnut Creek', lng: -122.0652, lat: 37.9101, min: 11 },
  { kind: 'city', name: 'Novato', lng: -122.5697, lat: 38.1074, min: 11 },
  { kind: 'city', name: 'San Leandro', lng: -122.1561, lat: 37.7249, min: 11 },
  { kind: 'city', name: 'Daly City', lng: -122.4702, lat: 37.6879, min: 11.2 },
  { kind: 'city', name: 'Emeryville', lng: -122.2853, lat: 37.8313, min: 11.6 },
  { kind: 'city', name: 'Tiburon', lng: -122.4569, lat: 37.8735, min: 11.4 },
  { kind: 'city', name: 'Mill Valley', lng: -122.545, lat: 37.906, min: 11.4 },
  { kind: 'city', name: 'Larkspur', lng: -122.5353, lat: 37.9341, min: 11.4 },
  { kind: 'city', name: 'Benicia', lng: -122.1583, lat: 38.0494, min: 11.2 },
  { kind: 'city', name: 'Martinez', lng: -122.1341, lat: 38.0194, min: 11.2 },
  { kind: 'city', name: 'Pacifica', lng: -122.4869, lat: 37.6138, min: 11.2 },
  { kind: 'city', name: 'San Bruno', lng: -122.4111, lat: 37.6305, min: 11.6 },
  { kind: 'city', name: 'Burlingame', lng: -122.3661, lat: 37.5841, min: 11.8 },
  { kind: 'city', name: 'El Cerrito', lng: -122.3108, lat: 37.9158, min: 11.8 },
  { kind: 'city', name: 'Vacaville', lng: -121.9877, lat: 38.3566, min: 11 },
  { kind: 'city', name: 'Fairfield', lng: -122.0399, lat: 38.2494, min: 10.8 },
  { kind: 'city', name: 'Union City', lng: -122.0438, lat: 37.5934, min: 11.4 },
  { kind: 'city', name: 'Redwood City', lng: -122.2364, lat: 37.4852, min: 11 },
  { kind: 'city', name: 'Sonoma', lng: -122.4569, lat: 38.2919, min: 11.2 },

  // --- islands and landmarks ---
  { kind: 'place', name: 'Alcatraz', lng: -122.4229, lat: 37.8267, min: 11.6 },
  { kind: 'place', name: 'Angel Island', lng: -122.4326, lat: 37.8609, min: 11.4 },
  { kind: 'place', name: 'Treasure Island', lng: -122.3705, lat: 37.8235, min: 11.8 },
  { kind: 'place', name: 'Yerba Buena I.', lng: -122.3644, lat: 37.8095, min: 12.6 },
  { kind: 'place', name: 'Mare Island', lng: -122.2694, lat: 38.0919, min: 11.6 },
  { kind: 'place', name: 'The Presidio', lng: -122.4662, lat: 37.7989, min: 12.2 },
  { kind: 'place', name: 'Point Bonita', lng: -122.5297, lat: 37.8158, min: 12.2 },
  { kind: 'place', name: 'Brooks Island', lng: -122.3494, lat: 37.9083, min: 12.6 },
  { kind: 'place', name: 'Red Rock', lng: -122.4297, lat: 37.9294, min: 12.8 },
  { kind: 'place', name: 'Oracle Park', lng: -122.3892, lat: 37.7786, min: 13.2 },
  { kind: 'place', name: 'Chase Center', lng: -122.3878, lat: 37.7679, min: 13.4 },
  { kind: 'place', name: 'Crissy Field', lng: -122.4653, lat: 37.8039, min: 13 },
  { kind: 'place', name: 'Ocean Beach', lng: -122.5097, lat: 37.7594, min: 12.4 },
  { kind: 'place', name: 'Berkeley Marina', lng: -122.3181, lat: 37.8656, min: 12.8 },
  { kind: 'place', name: 'Point Richmond', lng: -122.3872, lat: 37.9269, min: 12.6 },
  { kind: 'place', name: 'Coyote Point', lng: -122.3197, lat: 37.5906, min: 12.8 },

  // --- peaks ---
  { kind: 'peak', name: 'Mt Tamalpais', lng: -122.5965, lat: 37.9235, min: 10.4 },
  { kind: 'peak', name: 'Mt Diablo', lng: -121.9142, lat: 37.8816, min: 10.4 },
  { kind: 'peak', name: 'Mt St Helena', lng: -122.6283, lat: 38.6772, min: 10.8 },
  { kind: 'peak', name: 'Mt Hamilton', lng: -121.6428, lat: 37.3414, min: 10.8 },
  { kind: 'peak', name: 'San Bruno Mtn', lng: -122.4344, lat: 37.6866, min: 11.4 },
  { kind: 'peak', name: 'Twin Peaks', lng: -122.4477, lat: 37.7544, min: 11.6 },
  { kind: 'peak', name: 'Grizzly Peak', lng: -122.2437, lat: 37.8816, min: 11.4 },
  { kind: 'peak', name: 'Mt Livermore', lng: -122.4326, lat: 37.8609, min: 12.8 },
  { kind: 'peak', name: 'Sonoma Mtn', lng: -122.5964, lat: 38.3536, min: 11.4 },
  { kind: 'peak', name: 'Vollmer Peak', lng: -122.2183, lat: 37.8961, min: 12.4 },
  { kind: 'peak', name: 'Mt Davidson', lng: -122.4544, lat: 37.7383, min: 12.6 },
  { kind: 'peak', name: 'Mt Wittenberg', lng: -122.8022, lat: 38.0403, min: 11.8 },
  { kind: 'peak', name: 'Mt Umunhum', lng: -121.8975, lat: 37.1583, min: 11.2 },
  { kind: 'peak', name: 'Loma Prieta', lng: -121.8869, lat: 37.1122, min: 11.4 },
  { kind: 'peak', name: 'Bald Peak', lng: -122.2181, lat: 37.8836, min: 13 },
];
const LABEL_MIN_ZOOM: Record<string, number> = {
  '7215': 12.6, // Jack London (water shuttle)
  '7216': 12.6, // Bohol Circle (water shuttle)
  '7208': 11.8, // Main St (next to Oakland)
  '7213': 11.2, // Mare Island (next to Vallejo)
};

/** smoothstep fade for zoom bands */
const fade = (z: number, from: number, width = 0.6) =>
  Math.max(0, Math.min(1, (z - from) / width));

export class Overlay {
  private ctx: CanvasRenderingContext2D;
  private routePaths: { routeId: string; accent: string; path: Path2D }[];
  private places: {
    kind: 'city' | 'peak' | 'place';
    name: string;
    world: WorldPt;
    min: number;
  }[];
  /** Route id to emphasize (from the legend); null = all equal. */
  highlightRoute: string | null = null;
  private terminals: TerminalPt[];
  private stations: TerminalPt[];
  private routeById: Map<string, Route>;
  private dpr = Math.min(devicePixelRatio || 1, 2);
  private lastVessels: VesselState[] = [];
  /** Currently highlighted (selected) stop/vessel for subtle emphasis. */
  selected: Pick | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    data: ScheduleData,
  ) {
    this.ctx = canvas.getContext('2d')!;
    // each route's shapes as one path, tinted with its accent
    const shapesByRoute = new Map<string, Set<string>>();
    for (const trip of data.trips) {
      let set = shapesByRoute.get(trip.route);
      if (!set) shapesByRoute.set(trip.route, (set = new Set()));
      set.add(trip.shape);
    }
    this.routePaths = data.routes
      .filter((r) => shapesByRoute.has(r.id))
      .map((r) => {
        const path = new Path2D();
        for (const shapeId of shapesByRoute.get(r.id)!) {
          const shape = data.shapes[shapeId];
          if (!shape) continue;
          shape.pts.forEach(([lng, lat], i) => {
            const p = project(lng!, lat!);
            if (i === 0) path.moveTo(p.x, p.y);
            else path.lineTo(p.x, p.y);
          });
        }
        return { routeId: r.id, accent: r.accent, path };
      });
    this.places = PLACES.map((p) => ({
      kind: p.kind,
      name: p.name,
      world: project(p.lng, p.lat),
      min: p.min,
    }));
    this.terminals = data.terminals
      .filter((t) => t.active)
      .map((t) => ({ ...t, world: project(t.lng, t.lat) }));
    this.stations = this.terminals.filter((t) => !t.parent);
    this.routeById = new Map(data.routes.map((r) => [r.id, r]));
  }

  resize(w: number, h: number) {
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
  }

  draw(cam: Camera, vessels: VesselState[]) {
    this.lastVessels = vessels;
    const ctx = this.ctx;
    const { w, h } = cam.viewport;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const ink = cssVar('--ink') || '#111';
    const bg = cssVar('--bg') || '#fafafa';
    const z = cam.cur.z;
    const s = cam.scale;
    const tx = w / 2 - cam.cur.x * s;
    const ty = h / 2 - cam.cur.y * s;

    // ---- route lines, world-transformed; legend can spotlight one ----
    ctx.save();
    ctx.setTransform(this.dpr * s, 0, 0, this.dpr * s, this.dpr * tx, this.dpr * ty);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const baseAlpha = Math.min(1, T.routeAlpha * 2.2);
    for (const r of this.routePaths) {
      const spotlight = this.highlightRoute !== null;
      const isLit = r.routeId === this.highlightRoute;
      ctx.globalAlpha = spotlight ? (isLit ? 0.85 : baseAlpha * 0.25) : baseAlpha;
      ctx.lineWidth = (isLit ? 2.2 : 1.2) / s;
      ctx.strokeStyle = r.accent;
      ctx.stroke(r.path);
    }
    ctx.restore();
    ctx.globalAlpha = 1;

    const toScreen = (p: WorldPt) => ({ x: p.x * s + tx, y: p.y * s + ty });
    const labelAlpha = fade(z, T.labelZoom);

    // ---- gazetteer: cities, landmarks and peaks ----
    // Drawn in list order (most important first); anything that would land on
    // top of a label already placed is dropped, so the map thins out
    // gracefully instead of turning into a pile of text.
    const gray = cssVar('--text-tertiary') || '#999';
    ctx.textAlign = 'center';
    const placed: { x: number; y: number; w: number }[] = [];
    // terminal labels are drawn later but win — reserve their boxes first
    for (const t of this.stations) {
      const p = toScreen(t.world);
      placed.push({ x: p.x, y: p.y + 15, w: t.short.length * 7 * T.uiScale });
    }
    for (const pl of this.places) {
      // cities and landmarks give way once you're close in; peaks stay
      let a = fade(z, pl.min, 0.8);
      if (pl.kind !== 'peak') a *= 1 - fade(z, 15.2, 1);
      if (a <= 0.02) continue;
      const p = toScreen(pl.world);
      if (p.x < -80 || p.y < -30 || p.x > w + 80 || p.y > h + 30) continue;

      const isPeak = pl.kind === 'peak';
      const size = Math.round((isPeak ? 9 : 10) * T.uiScale);
      const text = isPeak ? `▲ ${pl.name.toUpperCase()}` : pl.name.toUpperCase();
      const tw = text.length * size * 0.62;
      const clash = placed.some(
        (r) => Math.abs(r.x - p.x) < (r.w + tw) / 2 + 5 && Math.abs(r.y - p.y) < size + 5,
      );
      if (clash) continue;
      placed.push({ x: p.x, y: p.y, w: tw });

      ctx.globalAlpha = a;
      ctx.font = `500 ${size}px 'JetBrains Mono Variable', monospace`;
      this.label(ctx, text, p.x, p.y, gray, bg);
    }
    ctx.globalAlpha = 1;

    // ---- terminal markers ----
    ctx.font = `500 ${Math.round(10 * T.uiScale)}px 'JetBrains Mono Variable', monospace`;
    ctx.textAlign = 'center';
    for (const t of this.stations) {
      const p = toScreen(t.world);
      if (p.x < -60 || p.y < -40 || p.x > w + 60 || p.y > h + 40) continue;
      const selected =
        this.selected?.type === 'terminal' &&
        (this.selected.terminal.id === t.id ||
          this.selected.terminal.parent === t.id);
      const r = selected ? 4.5 : 3.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.lineWidth = selected ? 2 : 1.4;
      ctx.strokeStyle = ink;
      ctx.stroke();

      const minZ = LABEL_MIN_ZOOM[t.id];
      const thisLabelAlpha = minZ ? labelAlpha * fade(z, minZ) : labelAlpha;
      if (thisLabelAlpha > 0.02) {
        ctx.globalAlpha = thisLabelAlpha;
        this.label(ctx, t.short.toUpperCase(), p.x, p.y + 15, ink, bg);
      }
      ctx.globalAlpha = 1;
    }

    // Gates are deliberately not drawn on the map — they live in the
    // departure board and the all-departures list, where they're useful.

    // ---- vessels ----
    const size = T.vesselSize;
    for (const v of vessels) {
      const p = toScreen(v.pos);
      if (p.x < -30 || p.y < -30 || p.x > w + 30 || p.y > h + 30) continue;
      const route = this.routeById.get(v.routeId);
      const accent = route?.accent ?? '#666';
      // legend spotlight: ghost every other route's vessels
      ctx.globalAlpha =
        this.highlightRoute !== null && v.routeId !== this.highlightRoute ? 0.22 : 1;
      const selected =
        this.selected?.type === 'vessel' &&
        this.selected.vessel.trip.id === v.trip.id;
      ctx.save();
      ctx.translate(p.x, p.y);
      if (!v.docked) ctx.rotate(v.heading);
      const L = size * (selected ? 1.25 : 1);
      const W2 = L * 0.36;
      ctx.beginPath();
      // pointed-bow hull
      ctx.moveTo(L * 0.55, 0);
      ctx.quadraticCurveTo(L * 0.18, -W2, -L * 0.4, -W2 * 0.9);
      ctx.quadraticCurveTo(-L * 0.52, 0, -L * 0.4, W2 * 0.9);
      ctx.quadraticCurveTo(L * 0.18, W2, L * 0.55, 0);
      ctx.closePath();
      ctx.fillStyle = v.docked ? bg : accent;
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = v.docked ? accent : ink;
      ctx.stroke();
      ctx.restore();
    }
  }

  private label(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    ink: string,
    halo: string,
  ) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = halo;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = ink;
    ctx.fillText(text, x, y);
  }

  /** Nearest interactive thing within reach of a tap. */
  pick(cam: Camera, x: number, y: number): Pick | null {
    const s = cam.scale;
    const { w, h } = cam.viewport;
    const tx = w / 2 - cam.cur.x * s;
    const ty = h / 2 - cam.cur.y * s;
    const toScreen = (p: WorldPt) => ({ x: p.x * s + tx, y: p.y * s + ty });

    let best: Pick | null = null;
    let bestD = Infinity;

    for (const v of this.lastVessels) {
      const p = toScreen(v.pos);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < 18 && d < bestD) {
        bestD = d;
        best = { type: 'vessel', vessel: v };
      }
    }
    for (const t of this.stations) {
      const p = toScreen(t.world);
      const d = Math.hypot(p.x - x, p.y - y);
      // terminals get a generous 22px touch target; vessels win ties
      if (d < 22 && d - 4 < bestD) {
        bestD = d;
        best = { type: 'terminal', terminal: t };
      }
    }
    return best;
  }
}
