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
/** Seconds of fade guaranteeing a recording never stops while still sounding. */
const FADE = 0.06;
/**
 * The recordings peak around 0.11 where a synthesised voice peaks at 1, so
 * without a make-up, switching palettes also turns the music down by twenty-odd
 * dB — which is why the room sounded loud and the instruments faint. Set by
 * measuring the two palettes through the same score, not by eye.
 */
const TRIM = 14;

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
   * would have used. Returns null when this family has no samples, so the
   * caller can fall back rather than fall silent.
   *
   * What comes back is the note's own envelope and a way to cut it short,
   * because the engine's voice pool has to be able to retire this note the
   * same way it retires a synthesised one. Handing back a bare boolean is what
   * let the pool believe it had freed a voice while the sample played on.
   */
  play(
    family: string,
    n: Note,
    dest: AudioNode,
  ): { env: GainNode; source: AudioBufferSourceNode; stop: (at: number) => void } | null {
    const { ctx } = this;
    // nearest recorded note, so the stretch stays small
    let best = NOTES[0]!;
    for (const candidate of NOTES) {
      if (Math.abs(Math.log2(candidate.freq / n.freq)) < Math.abs(Math.log2(best.freq / n.freq))) {
        best = candidate;
      }
    }
    const buf = this.buffers.get(`${family}-${best.name}`);
    if (!buf) return null;

    const p: VoicePreset = n.preset;
    const t = Math.max(n.when, ctx.currentTime);
    const peak = Math.max(0, Math.min(1, n.velocity)) * p.gain * TRIM;

    const rate = n.freq / best.freq;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    if (n.detune) src.detune.value = n.detune;

    // How long this recording can actually sound. It matters because these
    // renderings are a fixed 3.13 s and the sustaining instruments — clarinet,
    // flute, cello, choir — are still going at full tilt when the file ends:
    // measured, sixteen of the thirty-six stop at between 4% and 10% of peak.
    // A source that ends mid-waveform is a step discontinuity, which is a
    // click, and at a couple of notes a second that is heard as crackle. So
    // the note is always faded out before its buffer runs out.
    const playable = buf.duration / rate;

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

    // The fade lives on its own stage rather than on the musical envelope: an
    // envelope that is mid-`setTargetAtTime` cannot be ramped from cleanly, and
    // the two jobs are different anyway — one shapes the note, this one only
    // makes sure the recording never stops while it is still moving.
    const tail = ctx.createGain();
    src.connect(env);
    env.connect(tail);
    tail.connect(pan);
    pan.connect(dest);

    const releaseAt = t + Math.max(0.05, n.ring);
    env.gain.setTargetAtTime(0, releaseAt, Math.max(0.02, p.release / 3));
    const endAt = Math.min(t + playable, releaseAt + p.release);
    const fade = Math.min(FADE, playable / 4);
    tail.gain.setValueAtTime(1, t);
    tail.gain.setValueAtTime(1, Math.max(t, endAt - fade));
    tail.gain.linearRampToValueAtTime(0, endAt);
    src.start(t);
    src.stop(endAt);
    src.onended = () => {
      src.disconnect();
      env.disconnect();
      tail.disconnect();
      pan.disconnect();
    };
    return {
      env,
      source: src,
      // stopping a source twice throws, and a stolen note is stopped early by
      // definition, so the second call is swallowed rather than guarded at
      // every call site
      stop: (at: number) => {
        try {
          src.stop(at);
        } catch {
          /* already stopped: nothing left to do */
        }
      },
    };
  }
}
