/**
 * The palette. Seven envelopes over a triangle behind a low corner — that is
 * the entire instrument list, and it is enough to tell one ferry route from
 * another by ear.
 *
 * The shapes lean the way "Sirens" leans: Göransson built that cue from
 * layered wails and the aulos, the double-piped reed whose two pipes beat
 * against each other, rather than from anything orchestral. So these are
 * breath rather than bell — attacks you can hear arriving, real sustain, and
 * long releases — and every note is voiced as a detuned pair (see `musicBeat`)
 * so it wavers against itself the way two pipes do.
 */
import type { VoicePreset } from './engine';

export const PRESETS: Record<string, VoicePreset> = {
  // arrives quickly and holds — the closest thing here to a keyboard
  keys: { wave: 'triangle', attack: 0.35, decay: 3, sustain: 0.45, release: 5, cutoff: 900, gain: 0.4 },
  // a slow bloom that keeps ringing
  bell: { wave: 'triangle', attack: 1.37, decay: 7, sustain: 0.12, release: 6, cutoff: 1400, gain: 0.34 },
  // the brightest thing here, and still not bright
  crystal: { wave: 'triangle', attack: 1.14, decay: 5, sustain: 0.1, release: 8, cutoff: 1800, gain: 0.28 },
  // arrives late, leaves slowly
  swell: { wave: 'triangle', attack: 1.2, decay: 10, sustain: 0.3, release: 7, cutoff: 700, gain: 0.42 },
  // sustained, sits under everything
  drift: { wave: 'triangle', attack: 2.5, decay: 4, sustain: 0.4, release: 14, cutoff: 520, gain: 0.4 },
  // the low end of the bay
  deep: { wave: 'sine', attack: 1, decay: 6, sustain: 0.35, release: 10, cutoff: 320, gain: 0.55 },
  // what a terminal answers with: struck low, rings a long time
  stone: { wave: 'sine', attack: 0.6, decay: 9, sustain: 0.08, release: 9, cutoff: 600, gain: 0.45 },
};

/** Order routes cycle through, low to bright, so neighbours contrast. */
export const PRESET_ORDER = ['deep', 'keys', 'bell', 'drift', 'crystal', 'swell'] as const;

/** A terminal's voice — one fixed note per station, struck when a wave reaches it. */
export const STATION = PRESETS.stone!;

/** A route line's voice: the quietest thing on the map, barely a breath. */
export const LINE: VoicePreset = {
  wave: 'sine',
  attack: 0.9,
  decay: 4,
  sustain: 0,
  release: 4,
  cutoff: 640,
  gain: 0.2,
};

/** The tap itself: low, plain, deliberate — you pressed the water, it answers. */
export const TAP: VoicePreset = {
  wave: 'triangle',
  attack: 0.02,
  decay: 4.5,
  sustain: 0.06,
  release: 4,
  cutoff: 1100,
  gain: 0.5,
};
