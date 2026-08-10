/**
 * The palette. Six envelopes over the same sine — that is the entire
 * instrument list, and it is enough to tell one ferry route from another by
 * ear. Shapes follow the ambient transit pieces this takes after: attacks from
 * an instant to two and a half seconds, decays measured in whole seconds, and
 * releases long enough that a note is still fading when the next arrives.
 */
import type { VoicePreset } from './engine';

export const PRESETS: Record<string, VoicePreset> = {
  // fast in, holds — the closest thing here to a keyboard
  keys: { attack: 0.04, decay: 3, sustain: 0.4, release: 4, cutoff: 2400, gain: 0.55 },
  // slow bloom, long ring, dies away
  bell: { attack: 1.37, decay: 7, sustain: 0, release: 5, cutoff: 3000, gain: 0.5 },
  // medium bloom with shimmer on top
  crystal: { attack: 1.14, decay: 5, sustain: 0, release: 8, cutoff: 3600, gain: 0.4 },
  // arrives late, leaves slowly
  swell: { attack: 0.7, decay: 10, sustain: 0, release: 6, cutoff: 1200, gain: 0.6 },
  // sustained, sits under everything
  drift: { attack: 2.5, decay: 4, sustain: 0.35, release: 14, cutoff: 700, gain: 0.5 },
  // the low end of the bay
  deep: { attack: 1, decay: 6, sustain: 0.2, release: 10, cutoff: 400, gain: 0.75 },
};

/** Order routes cycle through, low to bright, so neighbours contrast. */
export const PRESET_ORDER = ['deep', 'keys', 'bell', 'drift', 'crystal', 'swell'] as const;

/** A short, quiet voice for taps and arrivals — rings out fast, stays out of the way. */
export const CHIME: VoicePreset = {
  attack: 0.005,
  decay: 2.4,
  sustain: 0,
  release: 2.6,
  cutoff: 4200,
  gain: 0.42,
};
