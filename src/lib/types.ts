/** Shared data contract between scripts/build-data.ts and the app. */

export interface Terminal {
  id: string;
  /** Full display name, e.g. "Vallejo Ferry Terminal" */
  name: string;
  /** Short map label, e.g. "Vallejo" or "Gate E" */
  short: string;
  lat: number;
  lng: number;
  /** Parent station id (gates of the Ferry Building point at "7201") */
  parent?: string;
  /** Platform code from GTFS, e.g. "E" for Ferry Building Gate E */
  gate?: string;
  /** True if any trip in the feed serves this stop (or one of its children) */
  active: boolean;
}

export interface Route {
  id: string;
  /** GTFS short name, e.g. "VJO" */
  short: string;
  /** e.g. "Vallejo" */
  name: string;
  /** Official GTFS hex color, e.g. "#008c99" */
  color: string;
  /** Paper-muted accent derived from color */
  accent: string;
  sort: number;
  /** direction_id → human name, e.g. ["North", "South"] */
  directions: [string, string];
}

export interface Shape {
  /** [lng, lat] pairs */
  pts: [number, number][];
  /** Cumulative shape_dist_traveled (meters, GTFS measure) per point */
  dist: number[];
}

export interface Service {
  /** Weekday bitmask, bit 0 = Monday … bit 6 = Sunday */
  days: number;
  /** YYYYMMDD inclusive range */
  start: string;
  end: string;
  /** YYYYMMDD dates added / removed via calendar_dates */
  add: string[];
  remove: string[];
}

export interface TripStop {
  /** Terminal id (gate-level where applicable) */
  stop: string;
  /** Arrival / departure, seconds since local midnight (may exceed 86400) */
  arr: number;
  dep: number;
  /** shape_dist_traveled at this stop (meters, same measure as Shape.dist) */
  dist: number;
}

export interface Trip {
  id: string;
  route: string;
  service: string;
  dir: 0 | 1;
  shape: string;
  stops: TripStop[];
}

export interface ScheduleData {
  /** ISO timestamp of generation */
  generated: string;
  /** Last date (YYYYMMDD) with any scheduled service */
  feedEnd: string;
  terminals: Terminal[];
  routes: Route[];
  shapes: Record<string, Shape>;
  services: Record<string, Service>;
  trips: Trip[];
}
