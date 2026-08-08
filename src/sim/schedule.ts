/**
 * Which trips run when — pure functions over the compiled GTFS.
 */
import type { ScheduleData, Service, Trip } from '../lib/types';
import { localTime, previousServiceDay, type LocalTime } from '../lib/clock';

function serviceRuns(s: Service, lt: LocalTime): boolean {
  if (s.remove.includes(lt.ymd)) return false;
  if (s.add.includes(lt.ymd)) return true;
  return s.start <= lt.ymd && lt.ymd <= s.end && (s.days & (1 << lt.dow)) !== 0;
}

export function activeServices(data: ScheduleData, lt: LocalTime): Set<string> {
  const out = new Set<string>();
  for (const [id, s] of Object.entries(data.services)) {
    if (serviceRuns(s, lt)) out.add(id);
  }
  return out;
}

export interface TimedTrip {
  trip: Trip;
  /** Seconds since *the rendering day's* local midnight (yesterday's >24h
   * trips arrive shifted by −86400 so everything shares one time base). */
  shift: number;
}

/**
 * All trips that could be visible around local time `d`: today's trips plus
 * yesterday's overnight (>24h) stragglers.
 */
export function tripsForDay(data: ScheduleData, d: Date): TimedTrip[] {
  const today = localTime(d);
  const yesterday = previousServiceDay(d);
  const todaySvc = activeServices(data, today);
  const ydaySvc = activeServices(data, yesterday);

  const out: TimedTrip[] = [];
  for (const trip of data.trips) {
    if (todaySvc.has(trip.service)) out.push({ trip, shift: 0 });
    if (ydaySvc.has(trip.service)) {
      const last = trip.stops[trip.stops.length - 1]!;
      if (last.arr > 86400) out.push({ trip, shift: -86400 });
    }
  }
  return out;
}

export interface Departure {
  trip: Trip;
  routeId: string;
  /** Departure in seconds since today's local midnight */
  dep: number;
  /** Stop id it departs from (gate-level where applicable) */
  stop: string;
  /** Final destination stop id + arrival there */
  destStop: string;
  destArr: number;
  /** Stop ids called at between boarding and the final destination */
  via: string[];
}

/** Upcoming departures from a terminal (or any of its child gates). */
export function departuresFrom(
  timed: TimedTrip[],
  stopIds: Set<string>,
  afterSec: number,
  limit = 60,
): Departure[] {
  const out: Departure[] = [];
  for (const { trip, shift } of timed) {
    for (let i = 0; i < trip.stops.length - 1; i++) {
      const s = trip.stops[i]!;
      if (!stopIds.has(s.stop)) continue;
      const dep = s.dep + shift;
      if (dep < afterSec) continue;
      const last = trip.stops[trip.stops.length - 1]!;
      out.push({
        trip,
        routeId: trip.route,
        dep,
        stop: s.stop,
        destStop: last.stop,
        destArr: last.arr + shift,
        via: trip.stops.slice(i + 1, -1).map((v) => v.stop),
      });
    }
  }
  out.sort((a, b) => a.dep - b.dep);
  return out.slice(0, limit);
}

/** Arrival time at `toStop` for a given trip, if it stops there after `fromStop`. */
export function arrivalAt(trip: Trip, fromStop: string, toStops: Set<string>) {
  let seen = false;
  for (const s of trip.stops) {
    if (seen && toStops.has(s.stop)) return s;
    if (s.stop === fromStop) seen = true;
  }
  return undefined;
}
