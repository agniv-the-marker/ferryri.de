/**
 * The mapping from bay to music. Pure functions over schedule data — no audio
 * objects here, so this can be reasoned about (and rendered offline) the same
 * way `src/sim/` can.
 *
 * Everything is drawn from one pentatonic scale. That is not decoration: a
 * dozen ferries sound whenever their own timing says to, with no conductor and
 * no bar lines, so the only way to guarantee that any two notes landing
 * together are consonant is to make every note consonant with every other.
 */
import type { Departure } from '../sim/schedule';
import type { Route, ScheduleData, Terminal } from '../lib/types';
import { project, type WorldPt } from '../map/proj';
import { FAMILIES, FAMILY_ORDER, type FamilyName } from './voices';
import type { VoicePreset } from './engine';

/**
 * A *minor* pentatonic. Still no semitone clashes whatever collides — which is
 * the whole reason for a pentatonic here, since a dozen boats sound whenever
 * their own timing says to with no conductor between them — but darker than
 * the major it replaced, which is the direction "Sirens" points.
 */
const PENTATONIC = [0, 3, 5, 7, 10];
/** A1. The old root was a fifth higher and the top of the range read as shrill. */
const ROOT_MIDI = 33;

/** Where each family sits by nature, in octaves above the root. */
const HOME: Record<FamilyName, number> = {
  hum: 0,
  reed: 1,
  bowed: 1,
  metal: 1,
  pipe: 2,
  wood: 2,
  bell: 2,
  plucked: 2,
  glass: 3,
};

export interface RouteVoice {
  preset: VoicePreset;
  octave: number;
  family?: FamilyName;
}

export const midiToFreq = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/** The pedal the drone holds: the root, and a fifth above it. */
export const DRONE_FREQS = [midiToFreq(ROOT_MIDI - 12), midiToFreq(ROOT_MIDI - 5)];

/** Stable small integer from a string, so a trip always behaves the same way. */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

/**
 * Give every route its own instrument. Nine families across three registers is
 * twenty-seven distinct voices, and the feed has nineteen routes — so the deal
 * is: walk the families first and only drop a register once the whole palette
 * has been used. Two routes can then never share both a family and a register,
 * which is exactly what went wrong when six presets were cycled across
 * nineteen routes and seven pairs came out identical.
 *
 * Assignment follows the routes' own sort order, so a route sounds the same on
 * every visit and neighbours on the map contrast with each other.
 */
export function assignVoices(routes: Route[]): Map<string, RouteVoice> {
  const out = new Map<string, RouteVoice>();
  const ordered = [...routes].sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
  const taken = new Set<string>();
  ordered.forEach((r, i) => {
    const name = FAMILY_ORDER[i % FAMILY_ORDER.length]!;
    const home = HOME[name];
    // Second and third times through the palette a family moves register. The
    // shifts are tried in order and the first free one wins, because simply
    // subtracting and clamping at zero folded voices back on top of each other
    // — which is how two routes ended up identical again.
    let octave = home;
    for (const shift of [0, -1, 1, -2, 2]) {
      const candidate = Math.max(0, Math.min(3, home + shift));
      if (!taken.has(`${name}${candidate}`)) {
        octave = candidate;
        break;
      }
    }
    taken.add(`${name}${octave}`);
    out.set(r.id, { preset: FAMILIES[name], octave, family: name });
  });
  return out;
}

/**
 * The same instrument, a different player. Two ferries on one route share its
 * voice — that is what makes a route legible — but each vessel carries a small
 * fixed detune from its own trip id, so a pair working the same crossing are
 * not clones of each other.
 */
export function vesselDetune(tripId: string): number {
  return (hash(tripId) - 0.5) * 14;
}

/** Walk the scale: degree 5 is the same note an octave up. */
export function degreeToFreq(voice: RouteVoice, degree: number): number {
  const step = ((degree % PENTATONIC.length) + PENTATONIC.length) % PENTATONIC.length;
  const octave = Math.floor(degree / PENTATONIC.length);
  return midiToFreq(ROOT_MIDI + 12 * (voice.octave + octave) + PENTATONIC[step]!);
}

/**
 * How often a given vessel sounds, on average, in seconds. Each boat keeps its
 * own period derived from its trip id, so the fleet is polyrhythmic and never
 * lines up into a beat — the texture drifts the way traffic does.
 */
export function periodFor(tripId: string, density: number): number {
  const base = 4 + hash(tripId) * 8; // 4–12 s
  return base / Math.max(0.05, density);
}

/**
 * The actual wait until this boat sounds again: its own period, thrown about.
 * A boat on an exact period is a metronome — nineteen metronomes at nineteen
 * tempos still read as machinery, and what you want is a boat that goes off
 * when it feels like it. The spread is wide enough to break the grid and
 * bounded either side, because a draw with no floor puts two notes on top of
 * each other and one with no ceiling leaves a boat silent long enough that you
 * stop believing it is there.
 */
export function nextGapFor(tripId: string, density: number): number {
  return periodFor(tripId, density) * (0.45 + Math.random() * 1.15);
}

/** A terminal speaks this many times more slowly than a boat: it is a place. */
const STATION_SLOWER = 3.5;

/**
 * The same throw of the dice for a terminal, over a much longer period. A
 * ferry is a thing passing through and can chatter; a dock is a thing that has
 * been there since 1898 and should say so about once a minute.
 */
export function stationGapFor(stationId: string, density: number): number {
  return nextGapFor(`station:${stationId}`, density / STATION_SLOWER);
}

export interface PhraseNote {
  routeId: string;
  /** seconds from the start of the phrase */
  at: number;
  degree: number;
  velocity: number;
}

/**
 * The next few departures, as a phrase. Pitch climbs through the list so the
 * board reads as a rising figure; onset comes from how far off each sailing is,
 * compressed hard (a square root) so a 90-minute wait is a few seconds rather
 * than an absence. The board you are looking at is the score.
 */
export function phraseFrom(
  deps: Departure[],
  nowSec: number,
  limit = 5,
): PhraseNote[] {
  return deps.slice(0, limit).map((d, i) => {
    const minutes = Math.max(0, (d.dep - nowSec) / 60);
    return {
      routeId: d.routeId,
      at: Math.min(4, Math.sqrt(minutes) * 0.55),
      degree: i,
      velocity: 0.35 + 0.5 * Math.exp(-minutes / 25),
    };
  });
}

/**
 * What a terminal plays when nothing is sailing — late at night, or for an
 * operator that only publishes a link. Its routes arpeggiate slowly instead, so
 * the place still has a voice.
 */
export function idleFigure(routeIds: string[]): PhraseNote[] {
  return routeIds.slice(0, 4).map((routeId, i) => ({
    routeId,
    at: i * 0.9,
    degree: i * 2,
    velocity: 0.32,
  }));
}

/**
 * What each terminal is made of. Assigned by hand from what the place actually
 * was, not by hash: the bay's history is right there in the stops, and a map
 * that sounds like its own past is worth more than one that sounds random.
 * Anything missing falls back to a pipe.
 */
const STATION_VOICE: Record<string, [FamilyName, number]> = {
  '7201': ['bell', 1],            // Ferry Building — the 1898 clock tower
  alcatraz: ['metal', 0],         // the iron of the cellhouse
  'pier-33': ['plucked', 1],      // the Embarcadero landing boats leave from
  'angel-island': ['wood', 2],    // the immigration station's timber barracks
  '7212': ['metal', 2],           // Vallejo, downstream of the shipyard
  '7213': ['metal', 1],           // Mare Island itself — the yard
  '7211': ['metal', 3],           // Richmond, the Kaiser yards and their rivets
  sausalito: ['hum', 1],          // houseboats, and Marinship before them
  tiburon: ['bell', 2],           // the railroad ferry terminus
  larkspur: ['glass', 3],         // the modern commute
  '7209': ['reed', 1],            // Oakland, on the estuary
  '7208': ['reed', 2],            // Alameda Main Street
  '7207': ['pipe', 2],            // Seaplane Lagoon — NAS Alameda
  'treasure-island': ['glass', 2], // the 1939 Exposition's Magic City
  '7205': ['wood', 1],            // South San Francisco, "The Industrial City"
  '7206': ['pipe', 1],            // Harbor Bay
  'redwood-city': ['hum', 0],     // the port, and the salt ponds
  '7215': ['plucked', 2],         // Jack London, a water shuttle stop
  '7216': ['plucked', 3],         // Bohol Circle, likewise
  'pier-39': ['hum', 2],          // the sea lions
  'pier-43': ['bell', 3],         // Pier 43½, under the Belt Railroad arch
};

/** A terminal's voice — its instrument and its one fixed note. */
export function stationVoice(id: string): RouteVoice {
  const [name, octave] = STATION_VOICE[id] ?? ['pipe', 1];
  return { preset: FAMILIES[name], octave, family: name };
}

/**
 * A terminal's note: fixed for the life of the place, so the Ferry Building
 * always answers with the same pitch and you learn the bay by ear.
 */
export function stationDegree(id: string): number {
  return Math.floor(hash(id) * 5);
}

export interface Post {
  routeId: string;
  world: WorldPt;
  degree: number;
}

/**
 * Listening posts along each route: a dozen or so points, spaced by the GTFS
 * distance measure the shapes already carry. A route breathes at a few places
 * rather than everywhere at once, which is both cheaper than testing the whole
 * path and better to listen to.
 */
export function listeningPosts(data: ScheduleData, spacingM = 1500): Post[] {
  // one representative shape per route — the longest, so it covers the run
  const best = new Map<string, string>();
  for (const trip of data.trips) {
    const shape = data.shapes[trip.shape];
    if (!shape) continue;
    const current = best.get(trip.route);
    const currentLen = current ? (data.shapes[current]?.dist.at(-1) ?? 0) : -1;
    if ((shape.dist.at(-1) ?? 0) > currentLen) best.set(trip.route, trip.shape);
  }

  const out: Post[] = [];
  for (const [routeId, shapeId] of best) {
    const shape = data.shapes[shapeId]!;
    let next = spacingM;
    let degree = 0;
    for (let i = 0; i < shape.pts.length; i++) {
      if (shape.dist[i]! < next) continue;
      next += spacingM;
      const [lng, lat] = shape.pts[i]!;
      out.push({ routeId, world: project(lng, lat), degree: degree++ % 5 });
    }
  }
  return out;
}

export interface StationPost {
  id: string;
  world: WorldPt;
  degree: number;
  voice: RouteVoice;
}

/** Active parent stations, projected and voiced once at boot. */
export function stationPosts(terminals: Terminal[]): StationPost[] {
  return terminals
    .filter((t) => t.active && !t.parent)
    .map((t) => ({
      id: t.id,
      world: project(t.lng, t.lat),
      degree: stationDegree(t.id),
      voice: stationVoice(t.id),
    }));
}
