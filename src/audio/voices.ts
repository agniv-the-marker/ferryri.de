/**
 * The instruments.
 *
 * An earlier pass tried to tell voices apart by envelope alone, which works
 * when the envelopes really differ — but once everything had drifted to a slow
 * swell on the same waveform, through the same reverb, in the same three
 * octaves, there was nothing left to hear. Timbre has to come from the
 * *spectrum*.
 *
 * So each family declares its own harmonic series, which becomes a
 * `PeriodicWave` — no more expensive than the sine it replaces. Three more
 * cheap tricks do the rest:
 *
 *  - an **inharmonic partial** at a non-integer ratio, which is the whole
 *    reason a bell sounds like metal and not like a note;
 *  - a **filter that closes as the note rings**, measured in *harmonics of the
 *    note* rather than in hertz, so a voice keeps its colour in every register
 *    instead of turning into a sine whenever it plays low;
 *  - a **noise onset** — breath for a pipe, a mallet click for wood.
 *
 * And struck families do not glide. A pitch sliding into place is the loudest
 * single thing about a note: when every voice did it, every voice sounded the
 * same no matter what spectrum sat behind it — measured, sixteen of nineteen
 * routes were indistinguishable through their whole attack. Bells, wood, metal
 * and plucked strings now arrive already in tune, the way they do in the world.
 *
 * Nine families across three registers is twenty-seven voices, which is enough
 * for nineteen routes with none of them colliding.
 */
import type { VoicePreset } from './engine';

export const FAMILIES = {
  /** Odd harmonics only: hollow, buzzy — the aulos this score keeps chasing. */
  reed: {
    partials: [1, 0, 0.75, 0, 0.55, 0, 0.38, 0, 0.22],
    attack: 0.3, decay: 3.5, sustain: 0.45, release: 5,
    bright: 9, brightEnd: 5, glide: 1, gain: 0.4,
  },
  /** Almost a pure tone, with breath on the front of it. */
  pipe: {
    partials: [1, 0.22, 0.08, 0.03],
    attack: 0.18, decay: 3, sustain: 0.5, release: 4.5,
    bright: 5, brightEnd: 4, glide: 1, chiff: [0.2, 0.22], gain: 0.42,
  },
  /** Every harmonic, arriving slowly and staying — a bowed string. */
  bowed: {
    partials: [1, 0.85, 0.7, 0.55, 0.45, 0.36, 0.3, 0.24],
    attack: 1.1, decay: 4, sustain: 0.6, release: 7,
    bright: 8, brightEnd: 6, glide: 1, chiff: [0.07, 0.5], gain: 0.34,
  },
  /** Struck, with a partial at 2.76× — the ratio that reads as bell metal. */
  bell: {
    // a real bell is weak at the fundamental and loud in its partials
    partials: [0.55, 0.45, 0.85, 0.35, 0.3],
    inharmonic: [2.76, 0.6],
    attack: 0.004, decay: 6, sustain: 0, release: 6,
    bright: 16, brightEnd: 3, glide: 0, gain: 0.38,
  },
  /** Short and bright, gone almost at once. */
  plucked: {
    partials: [1, 0.85, 0.65, 0.5, 0.38, 0.28, 0.2],
    attack: 0.003, decay: 1.2, sustain: 0, release: 2.4,
    bright: 12, brightEnd: 3, glide: 0, gain: 0.36,
  },
  /** Upper partials with the even ones missing: thin, glassy, slow to arrive. */
  glass: {
    partials: [0.7, 0, 0.8, 0, 0.65, 0, 0.5, 0, 0.35],
    attack: 0.8, decay: 5, sustain: 0.12, release: 7,
    bright: 11, brightEnd: 8, glide: 1, gain: 0.26,
  },
  /** A mallet on a bar: the 3.9× partial marimbas are tuned to, and a click. */
  wood: {
    // a marimba bar is its fundamental and its fourth partial, little else
    partials: [1, 0.12, 0.05],
    inharmonic: [3.9, 0.7],
    attack: 0.002, decay: 0.9, sustain: 0, release: 1.8,
    bright: 13, brightEnd: 3, glide: 0, chiff: [0.24, 0.05], gain: 0.42,
  },
  /** Dense and long: struck metal that will not stop ringing. */
  metal: {
    partials: [0.7, 0.8, 0.65, 0.55, 0.45, 0.35, 0.28],
    inharmonic: [5.4, 0.45],
    attack: 0.008, decay: 9, sustain: 0.05, release: 9,
    bright: 18, brightEnd: 4, glide: 0, gain: 0.3,
  },
  /** Low harmonics behind a low corner — closer to a voice than an instrument. */
  hum: {
    partials: [1, 0.75, 0.3, 0.12, 0.05],
    attack: 0.7, decay: 4, sustain: 0.55, release: 8,
    bright: 4, brightEnd: 3, glide: 1, gain: 0.44,
  },
} satisfies Record<string, VoicePreset>;

export type FamilyName = keyof typeof FAMILIES;

/**
 * Order routes are dealt across, arranged so that consecutive routes — which
 * are usually neighbours on the map — land in contrasting families.
 */
/**
 * What each family is, in a word you can read off the map.
 *
 * These are the recordings the sampled palette actually plays (see
 * `scripts/fetch-voices.ts`), and the synthesised voices are modelled on the
 * same instruments — so the name is true either way. Kept short because it is
 * printed in a 0.55rem legend row next to a route name.
 */
export const INSTRUMENT_NAME: Record<FamilyName, string> = {
  reed: 'clarinet',
  pipe: 'flute',
  bowed: 'cello',
  bell: 'tubular bells',
  plucked: 'pizzicato',
  glass: 'celesta',
  wood: 'marimba',
  metal: 'vibraphone',
  hum: 'choir',
};

export const FAMILY_ORDER: FamilyName[] = [
  'reed', 'bell', 'bowed', 'wood', 'pipe', 'metal', 'plucked', 'hum', 'glass',
];

/** The note the tap itself makes: low, plain, struck. */
export const TAP: VoicePreset = {
  partials: [1, 0.3, 0.1],
  attack: 0.005, decay: 4.5, sustain: 0.05, release: 4,
  bright: 10, brightEnd: 3, glide: 0, gain: 0.5,
};
