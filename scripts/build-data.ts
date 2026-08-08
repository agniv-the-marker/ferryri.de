/**
 * Fetches the official San Francisco Bay Ferry GTFS feed and compiles it into
 * the compact public/data/schedule.json the app consumes.
 *
 * Data: https://gtfs.sanfranciscobayferry.com/gtfs.zip (ODC-BY — attribution
 * is rendered in the site footer).
 *
 * Usage: npm run data
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import type {
  Route,
  ScheduleData,
  Service,
  Shape,
  Terminal,
  Trip,
  TripStop,
} from '../src/lib/types.ts';

const GTFS_URL = 'https://gtfs.sanfranciscobayferry.com/gtfs.zip';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../public/data/schedule.json');

/** Curated short labels; anything absent falls back to a stripped stop_name. */
const SHORT_NAMES: Record<string, string> = {
  '7201': 'Ferry Building',
  '72011': 'Gate E',
  '72012': 'Gate G',
  '72013': 'Gate F',
  '7205': 'South S.F.',
  '7206': 'Harbor Bay',
  '7207': 'Seaplane',
  '7208': 'Alameda Main',
  '7209': 'Oakland',
  '7210': 'Pier 41',
  '7211': 'Richmond',
  '7212': 'Vallejo',
  '7213': 'Mare Island',
  '7214': 'Pier 48',
  '7215': 'Jack London',
  '7216': 'Bohol Circle',
};

// ---------- tiny CSV ----------

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift();
  if (!header) return [];
  return rows.map((r) => {
    const o: Record<string, string> = {};
    header.forEach((h, i) => (o[h.trim()] = (r[i] ?? '').trim()));
    return o;
  });
}

// ---------- color: official route color → paper-muted accent ----------

function hexToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function muteColor(hex: string): string {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h, Math.min(s, 0.45), Math.max(0.42, Math.min(l, 0.58)));
}

// ---------- time ----------

/** "25:15:00" → seconds since local midnight (may exceed 86400) */
function parseGtfsTime(t: string): number {
  const [h, m, s] = t.split(':').map(Number);
  return (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0);
}

function stripTerminalName(name: string): string {
  return name.replace(/ (Ferry Terminal|Ferry Dock|Marine Terminal|Water Shuttle Dock|Terminal|Dock)$/i, '');
}

// ---------- main ----------

async function main() {
  console.log(`fetching ${GTFS_URL} …`);
  const res = await fetch(GTFS_URL);
  if (!res.ok) throw new Error(`GTFS fetch failed: ${res.status}`);
  const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const file = (name: string) => {
    const f = zip[name];
    if (!f) throw new Error(`missing ${name} in feed`);
    return parseCsv(strFromU8(f));
  };

  const stopsRaw = file('stops.txt');
  const routesRaw = file('routes.txt');
  const tripsRaw = file('trips.txt');
  const stopTimesRaw = file('stop_times.txt');
  const shapesRaw = file('shapes.txt');
  const calendarRaw = file('calendar.txt');
  const calDatesRaw = file('calendar_dates.txt');
  const directionsRaw = zip['directions.txt'] ? file('directions.txt') : [];

  // --- stop_times grouped by trip ---
  const stByTrip = new Map<string, TripStop[]>();
  for (const r of stopTimesRaw) {
    const list = stByTrip.get(r.trip_id!) ?? [];
    list.push({
      stop: r.stop_id!,
      arr: parseGtfsTime(r.arrival_time!),
      dep: parseGtfsTime(r.departure_time!),
      dist: Math.round(Number(r.shape_dist_traveled ?? 0)),
    });
    stByTrip.set(r.trip_id!, list);
  }
  for (const [id, list] of stByTrip) {
    list.sort((a, b) => a.arr - b.arr);
    for (let i = 1; i < list.length; i++) {
      if (list[i]!.arr < list[i - 1]!.dep)
        throw new Error(`non-monotonic times in trip ${id}`);
    }
  }

  // --- trips (only ones with usable stop_times) ---
  const trips: Trip[] = [];
  for (const t of tripsRaw) {
    const stops = stByTrip.get(t.trip_id!);
    if (!stops || stops.length < 2) continue;
    trips.push({
      id: t.trip_id!,
      route: t.route_id!,
      service: t.service_id!,
      dir: t.direction_id === '1' ? 1 : 0,
      shape: t.shape_id!,
      stops,
    });
  }

  const usedShapes = new Set(trips.map((t) => t.shape));
  const usedServices = new Set(trips.map((t) => t.service));
  const servedStops = new Set(trips.flatMap((t) => t.stops.map((s) => s.stop)));

  // --- shapes (only referenced; coords rounded ~1m) ---
  const shapes: Record<string, Shape> = {};
  const shapePts = new Map<string, { lat: number; lng: number; seq: number; dist: number }[]>();
  for (const r of shapesRaw) {
    const id = r.shape_id!;
    if (!usedShapes.has(id)) continue;
    const list = shapePts.get(id) ?? [];
    list.push({
      lat: Number(r.shape_pt_lat),
      lng: Number(r.shape_pt_lon),
      seq: Number(r.shape_pt_sequence),
      dist: Number(r.shape_dist_traveled ?? 0),
    });
    shapePts.set(id, list);
  }
  for (const [id, pts] of shapePts) {
    pts.sort((a, b) => a.seq - b.seq);
    shapes[id] = {
      pts: pts.map((p) => [Number(p.lng.toFixed(5)), Number(p.lat.toFixed(5))]),
      dist: pts.map((p) => Math.round(p.dist)),
    };
  }
  for (const t of trips) {
    if (!shapes[t.shape]) throw new Error(`trip ${t.id} references missing shape ${t.shape}`);
  }

  // --- terminals ---
  const terminals: Terminal[] = [];
  const stopById = new Map(stopsRaw.map((s) => [s.stop_id!, s]));
  for (const s of stopsRaw) {
    if (s.location_type === '2') continue; // station entrances — not needed
    const id = s.stop_id!;
    const parent = s.parent_station || undefined;
    const childServed = stopsRaw.some(
      (c) => c.parent_station === id && servedStops.has(c.stop_id!),
    );
    terminals.push({
      id,
      name: s.stop_name!,
      short: SHORT_NAMES[id] ?? stripTerminalName(s.stop_name!),
      lat: Number(s.stop_lat),
      lng: Number(s.stop_lon),
      ...(parent ? { parent } : {}),
      ...(s.platform_code ? { gate: s.platform_code } : {}),
      active: servedStops.has(id) || childServed,
    });
  }

  // --- routes ---
  const dirNames = new Map<string, string>();
  for (const d of directionsRaw) dirNames.set(`${d.route_id}:${d.direction_id}`, d.direction!);
  const routes: Route[] = routesRaw
    .map((r) => ({
      id: r.route_id!,
      short: r.route_short_name!,
      name: r.route_long_name!,
      color: `#${r.route_color || '111111'}`,
      accent: muteColor(`#${r.route_color || '111111'}`),
      sort: Number(r.route_sort_order ?? 99),
      directions: [
        dirNames.get(`${r.route_id}:0`) ?? 'Outbound',
        dirNames.get(`${r.route_id}:1`) ?? 'Inbound',
      ] as [string, string],
    }))
    .sort((a, b) => a.sort - b.sort);

  // --- services ---
  const services: Record<string, Service> = {};
  for (const c of calendarRaw) {
    if (!usedServices.has(c.service_id!)) continue;
    const dayCols = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    let days = 0;
    dayCols.forEach((d, i) => {
      if (c[d] === '1') days |= 1 << i;
    });
    services[c.service_id!] = { days, start: c.start_date!, end: c.end_date!, add: [], remove: [] };
  }
  for (const e of calDatesRaw) {
    const id = e.service_id!;
    if (!usedServices.has(id)) continue;
    // calendar_dates-only services never appear in calendar.txt
    services[id] ??= { days: 0, start: e.date!, end: e.date!, add: [], remove: [] };
    const svc = services[id]!;
    if (e.exception_type === '1') {
      svc.add.push(e.date!);
      if (e.date! < svc.start) svc.start = e.date!;
      if (e.date! > svc.end) svc.end = e.date!;
    } else svc.remove.push(e.date!);
  }
  for (const t of trips) {
    if (!services[t.service]) throw new Error(`trip ${t.id} references missing service ${t.service}`);
  }

  const feedEnd = Object.values(services)
    .map((s) => s.end)
    .sort()
    .at(-1)!;

  const data: ScheduleData = {
    generated: new Date().toISOString(),
    feedEnd,
    terminals,
    routes,
    shapes,
    services,
    trips,
  };

  // --- sanity checks ---
  const gateStops = terminals.filter((t) => t.gate);
  const activeTerminals = terminals.filter((t) => t.active && !t.parent);
  const today = new Date()
    .toLocaleDateString('sv-SE', { timeZone: 'America/Los_Angeles' })
    .replaceAll('-', '');
  const dow = (new Date().getDay() + 6) % 7; // Monday = 0
  const todayServices = Object.entries(services).filter(([, s]) => {
    if (s.remove.includes(today)) return false;
    if (s.add.includes(today)) return true;
    return s.start <= today && today <= s.end && (s.days & (1 << dow)) !== 0;
  });
  const todayTrips = trips.filter((t) => todayServices.some(([id]) => id === t.service));

  console.log(`routes: ${routes.length}  (${routes.map((r) => r.short).join(' ')})`);
  console.log(`terminals: ${terminals.length} (${activeTerminals.length} active stations, ${gateStops.length} gates)`);
  console.log(`trips: ${trips.length}  shapes: ${Object.keys(shapes).length}  services: ${Object.keys(services).length}`);
  console.log(`today (${today}): ${todayServices.length} services, ${todayTrips.length} trips`);
  console.log(`feed covers service through ${feedEnd}`);

  if (routes.length < 5) throw new Error('suspiciously few routes');
  if (gateStops.length < 3) throw new Error('Ferry Building gate stops missing');
  if (trips.length < 100) throw new Error('suspiciously few trips');
  if (todayTrips.length === 0) console.warn('WARNING: no trips scheduled today — check calendars');
  const fb = stopById.get('7201');
  if (!fb) throw new Error('Ferry Building parent stop missing');

  mkdirSync(dirname(OUT), { recursive: true });
  const json = JSON.stringify(data);
  writeFileSync(OUT, json);
  console.log(`wrote ${OUT} (${(json.length / 1024).toFixed(0)} KB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
