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
import { PRESET_ORDER, PRESETS } from './voices';
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

/**
 * Where each preset sits, in octaves above the root. Three octaves, not four:
 * with the climb below, the highest note now lands around E4 rather than up in
 * the D6 whistle register.
 */
const REGISTER: Record<string, number> = {
  deep: 0,
  drift: 0,
  keys: 1,
  swell: 1,
  bell: 2,
  crystal: 2,
};

export interface RouteVoice {
  preset: VoicePreset;
  octave: number;
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
 * Give every route a fixed voice. Assignment follows the route's own sort
 * order, so a route sounds the same on every visit and neighbouring routes
 * land in contrasting registers.
 */
export function assignVoices(routes: Route[]): Map<string, RouteVoice> {
  const out = new Map<string, RouteVoice>();
  const ordered = [...routes].sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
  ordered.forEach((r, i) => {
    const name = PRESET_ORDER[i % PRESET_ORDER.length]!;
    // past one pass through the palette, lift a register rather than repeat
    const lift = Math.floor(i / PRESET_ORDER.length) % 2;
    out.set(r.id, { preset: PRESETS[name]!, octave: (REGISTER[name] ?? 2) + lift });
  });
  return out;
}

/** Walk the scale: degree 5 is the same note an octave up. */
export function degreeToFreq(voice: RouteVoice, degree: number): number {
  const step = ((degree % PENTATONIC.length) + PENTATONIC.length) % PENTATONIC.length;
  const octave = Math.floor(degree / PENTATONIC.length);
  return midiToFreq(ROOT_MIDI + 12 * (voice.octave + octave) + PENTATONIC[step]!);
}

/**
 * How often a given vessel sounds, in seconds. Each boat keeps its own period
 * derived from its trip id, so the fleet is polyrhythmic and never lines up
 * into a beat — the texture drifts the way traffic does.
 */
export function periodFor(tripId: string, density: number): number {
  const base = 4 + hash(tripId) * 8; // 4–12 s
  return base / Math.max(0.05, density);
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
 * A terminal's note: fixed for the life of the place, so the Ferry Building
 * always answers with the same pitch and you learn the bay by ear.
 */
export function stationDegree(id: string): number {
  return Math.floor(hash(id) * 8);
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

/** Active parent stations, projected once, for the same treatment. */
export function stationPosts(terminals: Terminal[]): { id: string; world: WorldPt; degree: number }[] {
  return terminals
    .filter((t) => t.active && !t.parent)
    .map((t) => ({ id: t.id, world: project(t.lng, t.lat), degree: stationDegree(t.id) }));
}
