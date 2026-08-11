/**
 * The instruments.
 *
 * An earlier pass tried to tell voices apart by envelope alone, which works
 * when the envelopes really differ — but once everything had drifted to a slow
 * swell on the same waveform, through the same reverb, in the same three
 * octaves, there was nothing left to hear. Timbre has to come from the
 * *spectrum*.
 *
 * So each family here declares its own harmonic series, which becomes a
 * `PeriodicWave` — no more expensive than the sine it replaces. Three more
 * cheap tricks do the rest of the work:
 *
 *  - an **inharmonic partial** at a non-integer ratio, which is the whole
 *    reason a bell sounds like metal and not like a note;
 *  - a **filter that closes as the note rings**, which is most of what
 *    separates struck from bowed to the ear;
 *  - a **noise onset** — breath for a pipe, a mallet click for wood.
 *
 * Nine families across three registers is twenty-seven voices, which is enough
 * for nineteen routes with none of them colliding.
 */
import type { VoicePreset } from './engine';

export const FAMILIES = {
  /** Odd harmonics only: hollow, buzzy — the aulos this score keeps chasing. */
  reed: {
    partials: [1, 0, 0.55, 0, 0.32, 0, 0.18],
    attack: 0.35, decay: 3.5, sustain: 0.45, release: 5,
    cutoff: 1500, cutoffEnd: 900, gain: 0.4,
  },
  /** Almost a pure tone, with breath on the front of it. */
  pipe: {
    partials: [1, 0.16, 0.06],
    attack: 0.22, decay: 3, sustain: 0.5, release: 4.5,
    cutoff: 1900, cutoffEnd: 1300, chiff: [0.18, 0.22], gain: 0.42,
  },
  /** Every harmonic, arriving slowly and staying — a bowed string. */
  bowed: {
    partials: [1, 0.5, 0.33, 0.25, 0.2, 0.16, 0.13],
    attack: 1.2, decay: 4, sustain: 0.6, release: 7,
    cutoff: 1200, cutoffEnd: 800, chiff: [0.06, 0.5], gain: 0.34,
  },
  /** Struck, with a partial at 2.76× — the ratio that reads as bell metal. */
  bell: {
    partials: [1, 0.3, 0.12],
    inharmonic: [2.76, 0.3],
    attack: 0.005, decay: 6, sustain: 0, release: 6,
    cutoff: 3000, cutoffEnd: 800, gain: 0.38,
  },
  /** Short and bright, gone almost at once. */
  plucked: {
    partials: [1, 0.6, 0.4, 0.26, 0.16],
    attack: 0.004, decay: 1.2, sustain: 0, release: 2.4,
    cutoff: 2600, cutoffEnd: 600, gain: 0.36,
  },
  /** Upper partials with the even ones missing: thin, glassy, slow to arrive. */
  glass: {
    partials: [1, 0, 0.42, 0, 0.26, 0, 0.19],
    attack: 0.9, decay: 5, sustain: 0.12, release: 7,
    cutoff: 3400, cutoffEnd: 2200, gain: 0.26,
  },
  /** A mallet on a bar: the 3.9× partial marimbas are tuned to, and a click. */
  wood: {
    partials: [1, 0.26, 0.08],
    inharmonic: [3.9, 0.22],
    attack: 0.003, decay: 0.9, sustain: 0, release: 1.8,
    cutoff: 2000, cutoffEnd: 500, chiff: [0.22, 0.05], gain: 0.42,
  },
  /** Dense and long: struck metal that will not stop ringing. */
  metal: {
    partials: [1, 0.42, 0.22, 0.16, 0.1],
    inharmonic: [5.4, 0.18],
    attack: 0.01, decay: 9, sustain: 0.05, release: 9,
    cutoff: 4000, cutoffEnd: 700, gain: 0.3,
  },
  /** Low harmonics behind a low corner — closer to a voice than an instrument. */
  hum: {
    partials: [1, 0.7, 0.22, 0.06],
    attack: 0.8, decay: 4, sustain: 0.55, release: 8,
    cutoff: 700, cutoffEnd: 520, gain: 0.44,
  },
} satisfies Record<string, VoicePreset>;

export type FamilyName = keyof typeof FAMILIES;

/**
 * Order routes are dealt across, arranged so that consecutive routes — which
 * are usually neighbours on the map — land in contrasting families.
 */
export const FAMILY_ORDER: FamilyName[] = [
  'reed', 'bell', 'bowed', 'wood', 'pipe', 'metal', 'plucked', 'hum', 'glass',
];

/** The note the tap itself makes: low, plain, struck. */
export const TAP: VoicePreset = {
  partials: [1, 0.3, 0.1],
  attack: 0.006, decay: 4.5, sustain: 0.05, release: 4,
  cutoff: 1600, cutoffEnd: 600, gain: 0.5,
};
