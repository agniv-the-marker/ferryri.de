/**
 * Compiles the Bay Area's rider-facing ferry network into schedule.json.
 * Machine-readable departures come from official SF Bay Ferry and Golden
 * Gate GTFS feeds. Operators without dependable GTFS are represented with
 * official schedule/ticket links and indicative route geometry only.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import type {
  Operator,
  Route,
  ScheduleData,
  Service,
  Shape,
  Terminal,
  Ticketing,
  Trip,
  TripStop,
} from '../src/lib/types.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../public/data/schedule.json');
const VERIFIED_AT = '2026-08-09';

const OPERATORS: Operator[] = [
  { id: 'sfbf', name: 'San Francisco Bay Ferry', short: 'SFBF', kind: 'public', color: '#008c99', website: 'https://sanfranciscobayferry.com', attribution: 'ODC-BY' },
  { id: 'ggf', name: 'Golden Gate Ferry', short: 'GGF', kind: 'public', color: '#d97932', website: 'https://www.goldengate.org/ferry/' },
  { id: 'ti', name: 'Treasure Island Ferry', short: 'TI', kind: 'private', color: '#596c84', website: 'https://www.tisf.com/ferry' },
  { id: 'aitf', name: 'Angel Island–Tiburon Ferry', short: 'AITF', kind: 'private', color: '#7b6a47', website: 'https://angelislandferry.com' },
  { id: 'alcatraz', name: 'Alcatraz City Cruises', short: 'ALC', kind: 'private', color: '#5d646c', website: 'https://alcatrazcitycruises.com' },
  { id: 'bluegold', name: 'Blue & Gold Fleet', short: 'B&G', kind: 'private', color: '#1e62a1', website: 'https://www.blueandgoldfleet.com' },
  { id: 'redwhite', name: 'Red and White Fleet', short: 'R&W', kind: 'private', color: '#a8423b', website: 'https://www.redandwhite.com' },
];

const SHORT_NAMES: Record<string, string> = {
  '7201': 'Ferry Building', '72011': 'Gate E', '72012': 'Gate G', '72013': 'Gate F',
  '7205': 'South S.F.', '7206': 'Harbor Bay', '7207': 'Seaplane', '7208': 'Alameda Main',
  '7209': 'Oakland', '7210': 'Pier 41', '7211': 'Richmond', '7212': 'Vallejo',
  '7213': 'Mare Island', '7214': 'Pier 48', '7215': 'Jack London', '7216': 'Bohol Circle',
  'ferry-building': 'Ferry Building', 'larkspur': 'Larkspur', 'sausalito': 'Sausalito',
  'tiburon': 'Tiburon', 'angel-island': 'Angel Island',
};

interface Source {
  id: 'sfbf' | 'ggf';
  url: string;
  keepRoute: (r: Record<string, string>) => boolean;
  idFor: (kind: string, raw: string) => string;
}

const SOURCES: Source[] = [
  {
    id: 'sfbf',
    url: 'https://gtfs.sanfranciscobayferry.com/gtfs.zip',
    keepRoute: () => true,
    idFor: (_kind, raw) => raw,
  },
  {
    id: 'ggf',
    url: 'https://realtime.goldengate.org/gtfsstatic/GTFSTransitData.zip',
    keepRoute: (r) => r.route_type === '4',
    idFor: (kind, raw) => {
      if (kind === 'stop') {
        const canonical: Record<string, string> = {
          SFFT: '7201', LFT: 'larkspur', SFT: 'sausalito', TFT: 'tiburon', AIFT: 'angel-island',
        };
        if (canonical[raw]) return canonical[raw]!;
      }
      return `ggf:${raw}`;
    },
  },
];

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  if (!header) return [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

function hexToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  const [r, g, b] = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6 : max === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number) {
  const f = (n: number) => {
    const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function muteColor(hex: string): string {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h, Math.min(s, 0.45), Math.max(0.42, Math.min(l, 0.58)));
}

const parseTime = (t: string) => {
  const [h = 0, m = 0, s = 0] = t.split(':').map(Number);
  return h * 3600 + m * 60 + s;
};
const stripTerminalName = (name: string) => name.replace(/ (Ferry Terminal|Ferry Landing|Ferry Dock|Marine Terminal|Water Shuttle Dock|Terminal|Dock)$/i, '');

const regularSfbf: Ticketing = {
  methods: ['clipper', 'contactless', 'mobile-ticket', 'paper-ticket'], purchase: 'optional',
  note: 'Clipper, contactless cards, mobile tickets, and paper tickets accepted.',
  fareUrl: 'https://sanfranciscobayferry.com/general-tickets-payment-options/', verifiedAt: VERIFIED_AT,
};
const regularGgf: Ticketing = {
  methods: ['clipper', 'contactless', 'paper-ticket'], purchase: 'none',
  note: 'Tap Clipper or a contactless bank card, or buy a ticket at the terminal.',
  scheduleUrl: 'https://www.goldengate.org/ferry/schedules-maps/',
  fareUrl: 'https://www.goldengate.org/ferry/ferry-fares-payment/', verifiedAt: VERIFIED_AT,
};

function routeMeta(source: Source, raw: Record<string, string>): Pick<Route, 'serviceClass' | 'status' | 'scheduleMode' | 'ticketing'> {
  const event = /oracle|chase|giants|event/i.test(`${raw.route_long_name} ${raw.route_short_name}`);
  if (source.id === 'ggf') return { serviceClass: event ? 'event' : 'transport', status: 'active', scheduleMode: 'gtfs', ticketing: event ? {
    methods: ['mobile-ticket'], purchase: 'required', note: 'Advance ticket required; Clipper is not accepted.',
    purchaseUrl: 'https://www.goldengate.org/ferry/oracle-park-service/', verifiedAt: VERIFIED_AT,
  } : regularGgf };
  return { serviceClass: event ? 'event' : 'transport', status: 'active', scheduleMode: 'gtfs', ticketing: event ? {
    methods: ['mobile-ticket'], purchase: 'required', note: 'Advance ticket required for special-event service.',
    purchaseUrl: 'https://sanfranciscobayferry.com/fares-tickets/', verifiedAt: VERIFIED_AT,
  } : regularSfbf };
}

async function fetchZip(source: Source) {
  console.log(`fetching ${source.id}: ${source.url}`);
  const res = await fetch(source.url);
  if (!res.ok) throw new Error(`${source.id} GTFS fetch failed: ${res.status}`);
  return unzipSync(new Uint8Array(await res.arrayBuffer()));
}

async function main() {
  const terminals = new Map<string, Terminal>();
  const routes: Route[] = [];
  const shapes: Record<string, Shape> = {};
  const services: Record<string, Service> = {};
  const trips: Trip[] = [];

  for (const source of SOURCES) {
    const zip = await fetchZip(source);
    const file = (name: string) => {
      const f = zip[name];
      if (!f) throw new Error(`${source.id}: missing ${name}`);
      return parseCsv(strFromU8(f));
    };
    const stopsRaw = file('stops.txt');
    const routesRaw = file('routes.txt').filter(source.keepRoute);
    const keptRoutes = new Set(routesRaw.map((r) => r.route_id!));
    const tripsRaw = file('trips.txt').filter((t) => keptRoutes.has(t.route_id!));
    const keptTripIds = new Set(tripsRaw.map((t) => t.trip_id!));
    const stopTimesRaw = file('stop_times.txt').filter((s) => keptTripIds.has(s.trip_id!));
    const keptShapes = new Set(tripsRaw.map((t) => t.shape_id!));
    const keptServices = new Set(tripsRaw.map((t) => t.service_id!));
    const directionsRaw = zip['directions.txt'] ? file('directions.txt') : [];

    const stopRowsByTrip = new Map<string, { stop: TripStop; seq: number }[]>();
    const servedRawStops = new Set<string>();
    for (const r of stopTimesRaw) {
      servedRawStops.add(r.stop_id!);
      const list = stopRowsByTrip.get(r.trip_id!) ?? [];
      list.push({ seq: Number(r.stop_sequence), stop: {
        stop: source.idFor('stop', r.stop_id!), arr: parseTime(r.arrival_time!), dep: parseTime(r.departure_time!),
        dist: Math.round(Number(r.shape_dist_traveled || 0)),
      } });
      stopRowsByTrip.set(r.trip_id!, list);
    }
    for (const list of stopRowsByTrip.values()) list.sort((a, b) => a.seq - b.seq);

    for (const t of tripsRaw) {
      const rows = stopRowsByTrip.get(t.trip_id!);
      if (!rows || rows.length < 2) continue;
      trips.push({
        id: source.idFor('trip', t.trip_id!), route: source.idFor('route', t.route_id!),
        service: source.idFor('service', t.service_id!), dir: t.direction_id === '1' ? 1 : 0,
        shape: source.idFor('shape', t.shape_id!), stops: rows.map((r) => r.stop),
      });
    }

    const shapePts = new Map<string, { lng: number; lat: number; seq: number; dist: number }[]>();
    for (const r of file('shapes.txt')) {
      if (!keptShapes.has(r.shape_id!)) continue;
      const id = source.idFor('shape', r.shape_id!);
      const list = shapePts.get(id) ?? [];
      list.push({ lng: Number(r.shape_pt_lon), lat: Number(r.shape_pt_lat), seq: Number(r.shape_pt_sequence), dist: Number(r.shape_dist_traveled || 0) });
      shapePts.set(id, list);
    }
    for (const [id, pts] of shapePts) {
      pts.sort((a, b) => a.seq - b.seq);
      shapes[id] = { pts: pts.map((p) => [Number(p.lng.toFixed(5)), Number(p.lat.toFixed(5))]), dist: pts.map((p) => Math.round(p.dist)) };
    }

    const rawStop = new Map(stopsRaw.map((s) => [s.stop_id!, s]));
    const includedRaw = new Set(servedRawStops);
    for (const id of servedRawStops) {
      let parent = rawStop.get(id)?.parent_station;
      while (parent) { includedRaw.add(parent); parent = rawStop.get(parent)?.parent_station; }
    }
    for (const rawId of includedRaw) {
      const s = rawStop.get(rawId);
      if (!s) continue;
      const id = source.idFor('stop', rawId);
      const parent = s.parent_station ? source.idFor('stop', s.parent_station) : undefined;
      const gate = s.platform_code || s.stop_name?.match(/Gate\s+([A-Z0-9]+)/i)?.[1];
      const next: Terminal = {
        id, name: s.stop_name!, short: SHORT_NAMES[id] ?? stripTerminalName(s.stop_name!),
        lat: Number(s.stop_lat), lng: Number(s.stop_lon), ...(parent ? { parent } : {}), ...(gate ? { gate } : {}), active: true,
      };
      const existing = terminals.get(id);
      if (!existing || (!existing.parent && next.parent)) terminals.set(id, next);
    }

    const dirNames = new Map(directionsRaw.map((d) => [`${d.route_id}:${d.direction_id}`, d.direction!.trim()]));
    for (const [i, r] of routesRaw.entries()) {
      const id = source.idFor('route', r.route_id!);
      const routeTrips = trips.filter((t) => t.route === id);
      const stationIds = new Set<string>();
      for (const t of routeTrips) for (const s of t.stops) stationIds.add(terminals.get(s.stop)?.parent ?? s.stop);
      const fallback = OPERATORS.find((o) => o.id === source.id)!.color;
      const color = `#${r.route_color || fallback.slice(1)}`;
      routes.push({
        id, short: r.route_short_name || stripTerminalName(r.route_long_name!), name: stripTerminalName(r.route_long_name!),
        color, accent: muteColor(color), sort: (source.id === 'ggf' ? 100 : 0) + Number(r.route_sort_order || i),
        directions: [dirNames.get(`${r.route_id}:0`) ?? 'Outbound', dirNames.get(`${r.route_id}:1`) ?? 'Inbound'],
        operator: source.id, ...routeMeta(source, r), terminals: [...stationIds],
      });
    }

    for (const c of file('calendar.txt')) {
      if (!keptServices.has(c.service_id!)) continue;
      let days = 0;
      ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].forEach((d, i) => { if (c[d] === '1') days |= 1 << i; });
      services[source.idFor('service', c.service_id!)] = { days, start: c.start_date!, end: c.end_date!, add: [], remove: [] };
    }
    for (const e of file('calendar_dates.txt')) {
      if (!keptServices.has(e.service_id!)) continue;
      const id = source.idFor('service', e.service_id!);
      services[id] ??= { days: 0, start: e.date!, end: e.date!, add: [], remove: [] };
      const svc = services[id]!;
      if (e.exception_type === '1') { svc.add.push(e.date!); svc.start = e.date! < svc.start ? e.date! : svc.start; svc.end = e.date! > svc.end ? e.date! : svc.end; }
      else svc.remove.push(e.date!);
    }
  }

  const addTerminal = (t: Terminal) => { if (!terminals.has(t.id)) terminals.set(t.id, t); };
  addTerminal({ id: 'treasure-island', name: 'Treasure Island Ferry Landing', short: 'Treasure Island', lat: 37.8175, lng: -122.3713, active: true });
  addTerminal({ id: 'pier-33', name: 'Pier 33 Alcatraz Landing', short: 'Pier 33', lat: 37.8067, lng: -122.4050, active: true });
  addTerminal({ id: 'alcatraz', name: 'Alcatraz Island Ferry Dock', short: 'Alcatraz', lat: 37.8267, lng: -122.4228, active: true });
  addTerminal({ id: 'pier-39', name: 'Pier 39 West Marina', short: 'Pier 39', lat: 37.8098, lng: -122.4102, active: true });
  addTerminal({ id: 'pier-43', name: 'Pier 43½', short: 'Pier 43½', lat: 37.8099, lng: -122.4153, active: true });
  addTerminal({ id: 'redwood-city', name: 'Port of Redwood City', short: 'Redwood City', lat: 37.5124, lng: -122.2015, active: true });

  const ext = (r: Omit<Route, 'color' | 'accent'> & { color?: string }) => {
    const color = r.color ?? OPERATORS.find((o) => o.id === r.operator)!.color;
    routes.push({ ...r, color, accent: muteColor(color) });
  };
  ext({ id: 'ti:sf', short: 'TI', name: 'Treasure Island', sort: 200, directions: ['Treasure Island', 'San Francisco'], operator: 'ti', serviceClass: 'transport', status: 'active', scheduleMode: 'external', terminals: ['7201', 'treasure-island'], displayPath: [[-122.3938,37.7965],[-122.381,37.802],[-122.3713,37.8175]], ticketing: { methods: ['mobile-ticket','paper-ticket','cash'], purchase: 'recommended', note: 'Clipper is not accepted. Buy online, in the app, or at boarding.', purchaseUrl: 'https://www.tisf.com/ferry', scheduleUrl: 'https://www.tisf.com/ferry', verifiedAt: VERIFIED_AT } });
  ext({ id: 'aitf:angel', short: 'AI', name: 'Tiburon–Angel Island', sort: 210, directions: ['Angel Island', 'Tiburon'], operator: 'aitf', serviceClass: 'transport', status: 'active', scheduleMode: 'external', terminals: ['tiburon','angel-island'], displayPath: [[-122.4562,37.8729],[-122.447,37.87],[-122.4349,37.8685]], ticketing: { methods: ['mobile-ticket','paper-ticket'], purchase: 'recommended', note: 'Advance booking is recommended; fare includes park admission.', purchaseUrl: 'https://angelislandferry.com/schedule', scheduleUrl: 'https://angelislandferry.com/schedule', verifiedAt: VERIFIED_AT } });
  ext({ id: 'alcatraz:day', short: 'ALC', name: 'Alcatraz Island', sort: 300, directions: ['Alcatraz', 'San Francisco'], operator: 'alcatraz', serviceClass: 'attraction', status: 'active', scheduleMode: 'external', terminals: ['pier-33','alcatraz'], displayPath: [[-122.405,37.8067],[-122.414,37.816],[-122.4228,37.8267]], ticketing: { methods: ['mobile-ticket','paper-ticket'], purchase: 'required', note: 'A timed ferry ticket is required to visit Alcatraz.', purchaseUrl: 'https://alcatrazcitycruises.com/tickets/?refid=compare-tour-options', scheduleUrl: 'https://alcatrazcitycruises.com/plan-your-visit/schedule/', verifiedAt: VERIFIED_AT } });
  ext({ id: 'bluegold:bay', short: 'BAY', name: 'San Francisco Bay Cruise', sort: 310, directions: ['Cruise', 'Cruise'], operator: 'bluegold', serviceClass: 'attraction', status: 'active', scheduleMode: 'external', terminals: ['pier-39'], displayPath: [[-122.4102,37.8098],[-122.425,37.8125],[-122.445,37.8155],[-122.466,37.8185],[-122.4785,37.8202],[-122.469,37.823],[-122.448,37.826],[-122.430,37.830],[-122.419,37.832],[-122.414,37.826],[-122.408,37.819],[-122.4102,37.8098]], ticketing: { methods: ['mobile-ticket','paper-ticket','cash'], purchase: 'recommended', note: 'Timed cruise tickets are sold separately; Clipper is not accepted.', purchaseUrl: 'https://www.blueandgoldfleet.com/buy-tickets/', scheduleUrl: 'https://www.blueandgoldfleet.com/visitor-information/', verifiedAt: VERIFIED_AT } });
  ext({ id: 'redwhite:bay', short: 'BAY', name: 'Golden Gate Bay Cruise', sort: 320, directions: ['Cruise', 'Cruise'], operator: 'redwhite', serviceClass: 'attraction', status: 'active', scheduleMode: 'external', terminals: ['pier-43'], displayPath: [[-122.4153,37.8099],[-122.428,37.8132],[-122.447,37.8162],[-122.467,37.8191],[-122.4785,37.8202],[-122.468,37.824],[-122.447,37.827],[-122.429,37.831],[-122.418,37.8315],[-122.412,37.824],[-122.409,37.816],[-122.4153,37.8099]], ticketing: { methods: ['mobile-ticket','paper-ticket'], purchase: 'recommended', note: 'This is a ticketed sightseeing cruise.', purchaseUrl: 'https://www.redandwhite.com/', scheduleUrl: 'https://www.redandwhite.com/schedule', verifiedAt: VERIFIED_AT } });
  ext({ id: 'bluegold:sausalito', short: 'SAU', name: 'Pier 41–Sausalito', sort: 400, directions: ['Sausalito', 'San Francisco'], operator: 'bluegold', serviceClass: 'transport', status: 'paused', scheduleMode: 'external', terminals: ['pier-39','sausalito'], displayPath: [[-122.4102,37.8098],[-122.445,37.827],[-122.4775,37.8562]], ticketing: { methods: ['mobile-ticket','paper-ticket'], purchase: 'none', note: 'Service suspended May 3, 2026; use Golden Gate Ferry instead.', scheduleUrl: 'https://www.blueandgoldfleet.com/', verifiedAt: VERIFIED_AT } });
  ext({ id: 'sfbf:redwood-future', short: 'RWC', name: 'Redwood City (proposed)', sort: 500, directions: ['Redwood City', 'San Francisco'], operator: 'sfbf', serviceClass: 'transport', status: 'future', scheduleMode: 'external', terminals: ['7201','redwood-city'], displayPath: [[-122.3938,37.7965],[-122.32,37.69],[-122.25,37.57],[-122.2015,37.5124]], ticketing: { methods: [], purchase: 'none', note: 'Proposed service; no passenger timetable or tickets are available.', scheduleUrl: 'https://weta.sanfranciscobayferry.com/', verifiedAt: VERIFIED_AT } });

  routes.sort((a, b) => a.sort - b.sort);
  const feedEnd = Object.values(services).map((s) => s.end).sort().at(-1)!;
  const data: ScheduleData = { generated: new Date().toISOString(), feedEnd, operators: OPERATORS, terminals: [...terminals.values()], routes, shapes, services, trips };

  for (const t of trips) {
    if (!shapes[t.shape]) throw new Error(`trip ${t.id} references missing shape ${t.shape}`);
    if (!services[t.service]) throw new Error(`trip ${t.id} references missing service ${t.service}`);
  }
  for (const r of routes) {
    if (!OPERATORS.some((o) => o.id === r.operator)) throw new Error(`route ${r.id} has unknown operator`);
    if (r.scheduleMode === 'external' && r.status === 'active' && !r.ticketing.scheduleUrl) throw new Error(`active external route ${r.id} lacks schedule URL`);
  }

  mkdirSync(dirname(OUT), { recursive: true });
  const json = JSON.stringify(data);
  writeFileSync(OUT, json);
  console.log(`operators: ${OPERATORS.length}; routes: ${routes.length}; terminals: ${terminals.size}`);
  console.log(`trips: ${trips.length}; shapes: ${Object.keys(shapes).length}; services: ${Object.keys(services).length}`);
  console.log(`feed covers service through ${feedEnd}`);
  console.log(`wrote ${OUT} (${(json.length / 1024).toFixed(0)} KB)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
