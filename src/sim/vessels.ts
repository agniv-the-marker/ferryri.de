/**
 * Vessel positions at a moment in time, interpolated along the GTFS shape
 * between scheduled timepoints. Pure function of the clock — no network.
 */
import type { ScheduleData, Shape, Trip } from '../lib/types';
import { project, type WorldPt } from '../map/proj';
import { T } from '../lib/tunables';
import type { TimedTrip } from './schedule';

/** Vessels appear at the dock this long before scheduled departure (s). */
const dockLead = () => T.dockLeadMin * 60;

export interface VesselState {
  trip: Trip;
  routeId: string;
  /** World (unit-mercator) position */
  pos: WorldPt;
  /** Radians, screen convention (0 = east, y-down positive turns clockwise) */
  heading: number;
  docked: boolean;
  /** Stop ids */
  fromStop: string;
  toStop: string;
  /** Arrival at toStop, seconds since today's local midnight */
  arr: number;
  /** Departure that starts/started the current leg */
  dep: number;
}

interface PreppedShape {
  pts: WorldPt[];
  dist: number[];
}

/** Projected shapes, cached per data object. */
const shapeCache = new WeakMap<ScheduleData, Map<string, PreppedShape>>();

function prepped(data: ScheduleData, id: string): PreppedShape | undefined {
  let m = shapeCache.get(data);
  if (!m) {
    m = new Map();
    shapeCache.set(data, m);
  }
  let s = m.get(id);
  if (!s) {
    const raw: Shape | undefined = data.shapes[id];
    if (!raw) return undefined;
    s = {
      pts: raw.pts.map(([lng, lat]) => project(lng, lat)),
      dist: raw.dist,
    };
    m.set(id, s);
  }
  return s;
}

/** Position along a shape at a given shape-distance (binary search + lerp). */
function pointAt(s: PreppedShape, d: number): { p: WorldPt; heading: number } {
  const { pts, dist } = s;
  const n = dist.length;
  if (d <= dist[0]!) return { p: pts[0]!, heading: segHeading(s, 0) };
  if (d >= dist[n - 1]!) return { p: pts[n - 1]!, heading: segHeading(s, n - 2) };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (dist[mid]! <= d) lo = mid;
    else hi = mid;
  }
  const d0 = dist[lo]!;
  const d1 = dist[hi]!;
  const f = d1 > d0 ? (d - d0) / (d1 - d0) : 0;
  const a = pts[lo]!;
  const b = pts[hi]!;
  return {
    p: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f },
    heading: segHeading(s, lo),
  };
}

function segHeading(s: PreppedShape, i: number): number {
  const a = s.pts[Math.max(0, i)]!;
  const b = s.pts[Math.min(s.pts.length - 1, i + 1)]!;
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/**
 * All vessels on the water (or docked about to leave) at second `sec` of the
 * rendering day.
 */
export function vesselsAt(
  data: ScheduleData,
  timed: TimedTrip[],
  sec: number,
): VesselState[] {
  const out: VesselState[] = [];
  for (const { trip, shift } of timed) {
    const stops = trip.stops;
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    const t0 = first.dep + shift - dockLead();
    const t1 = last.arr + shift;
    if (sec < t0 || sec > t1) continue;

    const shape = prepped(data, trip.shape);
    if (!shape) continue;

    // Which leg are we on?
    let state: VesselState | undefined;
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i]!;
      const arrI = s.arr + shift;
      const depI = s.dep + shift;
      if (sec <= depI) {
        if (sec >= arrI - (i === 0 ? dockLead() : 0)) {
          // dwelling at stop i (or pre-departure dock)
          const at = pointAt(shape, s.dist);
          const next = stops[Math.min(i + 1, stops.length - 1)]!;
          state = {
            trip,
            routeId: trip.route,
            pos: at.p,
            heading: at.heading,
            docked: true,
            fromStop: s.stop,
            toStop: next.stop,
            arr: next.arr + shift,
            dep: depI,
          };
        } else {
          // underway from stop i-1 to stop i
          const prev = stops[i - 1]!;
          const dep = prev.dep + shift;
          const f = (sec - dep) / Math.max(1, arrI - dep);
          const d = prev.dist + (s.dist - prev.dist) * f;
          const at = pointAt(shape, d);
          state = {
            trip,
            routeId: trip.route,
            pos: at.p,
            heading: at.heading,
            docked: false,
            fromStop: prev.stop,
            toStop: s.stop,
            arr: arrI,
            dep,
          };
        }
        break;
      }
    }
    if (state) out.push(state);
  }
  return out;
}
