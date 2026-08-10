/**
 * The crisp 2D layer above the dithered water: route lines, vessels,
 * terminal markers, gate markers, and labels. Also owns hit-testing.
 *
 * All route lines are a single ink pass (one Path2D, one stroke — overlapping
 * subpaths don't double-darken); color belongs to vessels and UI accents.
 */
import type { Camera } from './camera';
import { project, metersPerWorldUnit, type WorldPt } from './proj';
import type { Route, ScheduleData, Terminal } from '../lib/types';
import type { VesselState } from '../sim/vessels';
import { T } from '../lib/tunables';
import { routeVisible } from '../lib/visibility';

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
  { kind: 'place', name: 'Farallon Islands', lng: -123.002, lat: 37.699, min: 9.8 },
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

/**
 * Water-slope response, normalized to ±1. The argument is the height
 * *difference* between one end of the hull and the other; measured across the
 * fleet that sits around 0.08 in ordinary water and reaches 0.3 in the
 * steepest, so a quarter-unit is where a boat's reaction saturates and the bob
 * tunables read as maxima.
 */
const slopeUnit = (dh: number) => Math.max(-1, Math.min(1, dh * 4));

/** What the water was doing under a hull last frame, so it can lag. */
export interface BobState {
  h: number;
  gx: number;
  gy: number;
  /** frame counter, for sweeping out vessels that have finished their run */
  seen: number;
}

/** smoothstep fade for zoom bands */
const fade = (z: number, from: number, width = 0.6) =>
  Math.max(0, Math.min(1, (z - from) / width));

/** Turn sparse curated waypoints into a restrained Catmull–Rom/Bézier path. */
function addSmoothPath(path: Path2D, raw: [number, number][]) {
  let pts = raw.map(([lng, lat]) => project(lng, lat));
  if (pts.length < 2) return;
  const closed = pts.length > 2 && pts[0]!.x === pts.at(-1)!.x && pts[0]!.y === pts.at(-1)!.y;
  if (closed) pts = pts.slice(0, -1);
  path.moveTo(pts[0]!.x, pts[0]!.y);
  const tension = 0.65 / 6;
  const count = closed ? pts.length : pts.length - 1;
  const at = (i: number) => closed
    ? pts[(i + pts.length) % pts.length]!
    : pts[Math.max(0, Math.min(pts.length - 1, i))]!;
  for (let i = 0; i < count; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    path.bezierCurveTo(
      p1.x + (p2.x - p0.x) * tension,
      p1.y + (p2.y - p0.y) * tension,
      p2.x - (p3.x - p1.x) * tension,
      p2.y - (p3.y - p1.y) * tension,
      p2.x,
      p2.y,
    );
  }
  if (closed) path.closePath();
}

export class Overlay {
  private ctx: CanvasRenderingContext2D;
  private routePaths: { route: Route; path: Path2D }[];
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
  private stationRoutes = new Map<string, Route[]>();
  private dpr = Math.min(devicePixelRatio || 1, 2);
  private lastVessels: VesselState[] = [];
  /** Per-vessel water response, eased frame to frame — see the bob block. */
  private bobState = new Map<string, BobState>();
  private lastBobT = 0;
  private bobFrame = 0;
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
      .filter((r) => shapesByRoute.has(r.id) || r.displayPath)
      .map((r) => {
        const path = new Path2D();
        for (const shapeId of shapesByRoute.get(r.id) ?? []) {
          const shape = data.shapes[shapeId];
          if (!shape) continue;
          shape.pts.forEach(([lng, lat], i) => {
            const p = project(lng!, lat!);
            if (i === 0) path.moveTo(p.x, p.y);
            else path.lineTo(p.x, p.y);
          });
        }
        if (!shapesByRoute.has(r.id) && r.displayPath) addSmoothPath(path, r.displayPath);
        return { route: r, path };
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
    for (const route of data.routes) {
      for (const id of route.terminals) {
        const list = this.stationRoutes.get(id) ?? [];
        list.push(route);
        this.stationRoutes.set(id, list);
      }
    }
  }

  /**
   * What the water is doing under each hull right now, keyed by trip id.
   * The music pans and detunes a boat's voice from this rather than sampling
   * the field a second time.
   */
  get waterMotion(): ReadonlyMap<string, BobState> {
    return this.bobState;
  }

  resize(w: number, h: number) {
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
  }

  /**
   * @param water optional water-height sampler (css px → surface height);
   *   when present, hulls ride the ripple/swell field instead of sitting flat.
   */
  draw(
    cam: Camera,
    vessels: VesselState[],
    water: ((x: number, y: number) => number) | null = null,
  ) {
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
      if (!routeVisible(r.route)) continue;
      const spotlight = this.highlightRoute !== null;
      const isLit = r.route.id === this.highlightRoute;
      ctx.globalAlpha = spotlight ? (isLit ? 0.85 : baseAlpha * 0.25) : baseAlpha;
      ctx.lineWidth = (isLit ? 2.2 : 1.2) / s;
      ctx.strokeStyle = r.route.accent;
      if (r.route.status !== 'active') ctx.setLineDash([4 / s, 5 / s]);
      else if (r.route.serviceClass === 'attraction') ctx.setLineDash([7 / s, 4 / s]);
      else ctx.setLineDash([]);
      ctx.stroke(r.path);
    }
    ctx.setLineDash([]);
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
    const visibleStationNames = new Set<string>();
    // terminal labels are drawn later but win — reserve their boxes first
    for (const t of this.stations) {
      if (!this.terminalVisible(t)) continue;
      visibleStationNames.add(t.short.trim().toLowerCase());
      const p = toScreen(t.world);
      placed.push({ x: p.x, y: p.y + 15, w: t.short.length * 7 * T.uiScale });
    }
    for (const pl of this.places) {
      if (visibleStationNames.has(pl.name.trim().toLowerCase())) continue;
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
    const terminalLabelBoxes: { x: number; y: number; w: number; h: number }[] = [];
    for (const t of this.stations) {
      if (!this.terminalVisible(t)) continue;
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
        const text = t.short.toUpperCase();
        const tw = text.length * 6.2 * T.uiScale;
        const th = 12 * T.uiScale;
        const candidates = [
          { x: p.x, y: p.y + 15 },
          { x: p.x, y: p.y - 10 },
          { x: p.x + tw / 2 + 10, y: p.y + 3 },
          { x: p.x - tw / 2 - 10, y: p.y + 3 },
        ];
        const pos = candidates.find((candidate) =>
          !terminalLabelBoxes.some(
            (box) =>
              Math.abs(box.x - candidate.x) < (box.w + tw) / 2 + 5 &&
              Math.abs(box.y - candidate.y) < (box.h + th) / 2 + 3,
          ),
        );
        if (pos) {
          terminalLabelBoxes.push({ ...pos, w: tw, h: th });
          ctx.globalAlpha = thisLabelAlpha;
          this.label(ctx, text, pos.x, pos.y, ink, bg);
        }
      }
      ctx.globalAlpha = 1;
    }

    // Gates are deliberately not drawn on the map — they live in the
    // departure board and the all-departures list, where they're useful.

    // ---- vessels ----
    const size = T.vesselSize;
    // A hull is a physical object in the water, so it is measured in metres,
    // not pixels: the slope it feels is the one across its own length. (A
    // fixed screen-space stencil spans kilometres when zoomed out, where it
    // samples wave crests that have nothing to do with each other and the
    // boat shivers instead of rolling.)
    const reach = T.bobHull / 2 / (metersPerWorldUnit(cam.cur.y) / s);
    // and it has mass, so it can't answer the water instantly
    const nowT = performance.now() / 1000;
    const bobDt = Math.min(0.1, nowT - this.lastBobT || 0.016);
    this.lastBobT = nowT;
    const ease = T.bobEase > 0.005 ? 1 - Math.exp(-bobDt / T.bobEase) : 1;
    // One map, mutated in place and swept by frame stamp. Rebuilding it — and
    // the state objects in it — every frame meant thousands of short-lived
    // objects a second, and the GC pauses read as stutter.
    const frameId = ++this.bobFrame;
    for (const v of vessels) {
      const route = this.routeById.get(v.routeId);
      if (!route || !routeVisible(route)) continue;
      const p = toScreen(v.pos);
      if (p.x < -30 || p.y < -30 || p.x > w + 30 || p.y > h + 30) continue;
      const accent = route?.accent ?? '#666';
      // legend spotlight: ghost every other route's vessels
      ctx.globalAlpha =
        this.highlightRoute !== null && v.routeId !== this.highlightRoute ? 0.22 : 1;
      const selected =
        this.selected?.type === 'vessel' &&
        this.selected.vessel.trip.id === v.trip.id;
      // ---- ride the water ----
      // A top-down map has no vertical axis, so "bobbing" is spelled the way a
      // print illustrator would: a crest nudges the hull up the page and draws
      // it a touch larger (nearer the eye), and the slope under it shoulders
      // the boat off its heading and slides it toward the trough. Docked
      // vessels are on lines, so they only murmur.
      let lift = 0;
      let grow = 1;
      let rock = 0;
      let swayX = 0;
      let swayY = 0;
      if (water) {
        const ride = v.docked ? T.bobDock : 1;
        const rawH = water(p.x, p.y);
        const rawGx = water(p.x + reach, p.y) - water(p.x - reach, p.y);
        const rawGy = water(p.x, p.y + reach) - water(p.x, p.y - reach);
        let st = this.bobState.get(v.trip.id);
        if (!st) {
          st = { h: rawH, gx: rawGx, gy: rawGy, seen: frameId };
          this.bobState.set(v.trip.id, st);
        } else {
          st.h += (rawH - st.h) * ease;
          st.gx += (rawGx - st.gx) * ease;
          st.gy += (rawGy - st.gy) * ease;
          st.seen = frameId;
        }
        const { h: hgt, gx, gy } = st;
        lift = -hgt * T.bobLift * ride;
        grow = Math.max(0.5, 1 + hgt * T.bobScale * ride);
        // heel toward the beam-on slope; docked hulls are drawn unrotated, so
        // their beam is the screen's y axis
        const dir = v.docked ? 0 : v.heading;
        rock =
          (slopeUnit(-Math.sin(dir) * gx + Math.cos(dir) * gy) *
            T.bobRock *
            ride *
            Math.PI) /
          180;
        swayX = -slopeUnit(gx) * T.bobSway * ride;
        swayY = -slopeUnit(gy) * T.bobSway * ride;
      }

      ctx.save();
      ctx.translate(p.x + swayX, p.y + lift + swayY);
      if (!v.docked) ctx.rotate(v.heading + rock);
      else if (rock) ctx.rotate(rock);
      const L = size * (selected ? 1.25 : 1) * grow;
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
    // vessels that ended their run drop out of the map with them
    if (this.bobState.size > vessels.length) {
      for (const [id, st] of this.bobState) {
        if (st.seen !== frameId) this.bobState.delete(id);
      }
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
      const route = this.routeById.get(v.routeId);
      if (!route || !routeVisible(route)) continue;
      const p = toScreen(v.pos);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < 18 && d < bestD) {
        bestD = d;
        best = { type: 'vessel', vessel: v };
      }
    }
    for (const t of this.stations) {
      if (!this.terminalVisible(t)) continue;
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

  private terminalVisible(t: Terminal): boolean {
    return (this.stationRoutes.get(t.id) ?? []).some(routeVisible);
  }
}
