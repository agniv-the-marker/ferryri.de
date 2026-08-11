/**
 * The sampled palette: one recorded instrument per synth family, to be judged
 * against the synthesised one by ear rather than by argument.
 *
 * No library. A sampler is four notes an octave apart and `playbackRate` to
 * reach everything between, so nothing stretches more than six semitones; the
 * family's own envelope is still applied on top, which means the score does
 * not know or care which palette is playing. Loaded only when someone actually
 * switches — a visitor on the synth palette never fetches a byte of it.
 *
 * Samples are MIDI.js renderings of FluidR3_GM, CC-BY 3.0, credited in the
 * about panel. See `scripts/fetch-voices.ts`.
 */
import type { Note, VoicePreset } from './engine';

const BASE = `${import.meta.env.BASE_URL}audio/bank`;
const NOTES = [
  { name: 'C2', freq: 65.41 },
  { name: 'C3', freq: 130.81 },
  { name: 'C4', freq: 261.63 },
  { name: 'C5', freq: 523.25 },
];

export class Bank {
  private buffers = new Map<string, AudioBuffer>();
  private loading: Promise<void> | null = null;

  constructor(private ctx: BaseAudioContext) {}

  get ready(): boolean {
    return this.buffers.size > 0;
  }

  /**
   * Pull the bank down once. Failures are swallowed on purpose: a missing
   * sample should leave the synth palette playing, not break the music.
   */
  load(families: string[]): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      await Promise.all(
        families.flatMap((family) =>
          NOTES.map(async ({ name }) => {
            try {
              const res = await fetch(`${BASE}/${family}-${name}.mp3`);
              if (!res.ok) return;
              const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
              this.buffers.set(`${family}-${name}`, buf);
            } catch {
              /* leave it out; the synth voice covers for it */
            }
          }),
        ),
      );
    })();
    return this.loading;
  }

  /**
   * Play a note from the bank, shaped by the same envelope the synth voice
   * would have used. Returns false when this family has no samples, so the
   * caller can fall back rather than fall silent.
   */
  play(family: string, n: Note, dest: AudioNode): boolean {
    const { ctx } = this;
    // nearest recorded note, so the stretch stays small
    let best = NOTES[0]!;
    for (const candidate of NOTES) {
      if (Math.abs(Math.log2(candidate.freq / n.freq)) < Math.abs(Math.log2(best.freq / n.freq))) {
        best = candidate;
      }
    }
    const buf = this.buffers.get(`${family}-${best.name}`);
    if (!buf) return false;

    const p: VoicePreset = n.preset;
    const t = Math.max(n.when, ctx.currentTime);
    const peak = Math.max(0, Math.min(1, n.velocity)) * p.gain;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = n.freq / best.freq;
    if (n.detune) src.detune.value = n.detune;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + Math.max(0.004, p.attack * 0.5));
    env.gain.setTargetAtTime(
      peak * Math.max(p.sustain, 0.05),
      t + p.attack,
      Math.max(0.05, p.decay / 3),
    );

    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, n.pan ?? 0));
    src.connect(env);
    env.connect(pan);
    pan.connect(dest);

    const releaseAt = t + Math.max(0.05, n.ring);
    env.gain.setTargetAtTime(0, releaseAt, Math.max(0.02, p.release / 3));
    src.start(t);
    src.stop(releaseAt + p.release);
    src.onended = () => {
      src.disconnect();
      env.disconnect();
      pan.disconnect();
    };
    return true;
  }
}
