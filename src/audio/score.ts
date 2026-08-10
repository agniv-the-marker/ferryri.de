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
import type { Route } from '../lib/types';
import { PRESET_ORDER, PRESETS } from './voices';
import type { VoicePreset } from './engine';

/** D major pentatonic — no semitone clashes, whatever collides. */
const PENTATONIC = [0, 2, 4, 7, 9];
/** D2, low enough that the deep voices have somewhere to sit. */
const ROOT_MIDI = 38;

/** Where each preset naturally sits, in octaves above the root. */
const REGISTER: Record<string, number> = {
  deep: 0,
  drift: 1,
  keys: 2,
  swell: 2,
  bell: 3,
  crystal: 3,
};

export interface RouteVoice {
  preset: VoicePreset;
  octave: number;
}

export const midiToFreq = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

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
