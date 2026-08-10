/**
 * The bus every note passes through.
 *
 * The whole palette is sine oscillators. What tells one voice from another is
 * its envelope and nothing else — a bell is a slow bloom with a long ring, keys
 * are an instant attack that sustains, a swell takes most of a second to arrive.
 * That is the trick behind the ambient transit pieces this follows: the soft
 * bloom people hear is not sample quality, it is long envelopes and a six
 * second reverb. Which means no samples, no library, and nothing to download.
 *
 * Chain: voice → lowpass → pan → master → (dry + reverb) → compressor → limiter.
 * The compressor keeps a rush-hour fleet from stacking into mud; the limiter is
 * the backstop so a tap during a full bay can never clip.
 */
import { T } from '../lib/tunables';

export interface VoicePreset {
  /** seconds to reach full level */
  attack: number;
  /** seconds of fall toward `sustain` */
  decay: number;
  /** fraction of peak held while the note rings, 0 = let it die away */
  sustain: number;
  /** seconds of tail once the note is released */
  release: number;
  /** lowpass corner in Hz — how far back in the room the voice sits */
  cutoff: number;
  /** level trim, 0..1 */
  gain: number;
}

export interface Note {
  preset: VoicePreset;
  freq: number;
  /** context time to start; anything in the past is nudged to now */
  when: number;
  /** how long before the release begins */
  ring: number;
  /** 0..1 */
  velocity: number;
  /** −1 left … +1 right */
  pan?: number;
  /** cents, for hulls riding a crest */
  detune?: number;
}

/** Above this many overlapping notes the bay is mush, so new ones are dropped. */
const MAX_VOICES = 14;

/**
 * A decaying noise burst, which is all a reverb impulse response has to be.
 * Generated rather than downloaded — the same thing the sampled libraries do
 * behind the scenes, minus the asset.
 */
function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const len = Math.max(1, Math.floor(seconds * ctx.sampleRate));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // ^2.5 leaves a long tail without a hard stop at the end of the buffer
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.5);
    }
  }
  return buf;
}

export class Engine {
  private master: GainNode;
  private wet: GainNode;
  private reverb: ConvolverNode;
  private active = 0;

  constructor(private ctx: BaseAudioContext, destination?: AudioNode) {
    // limiter first: high ratio, fast attack, so it only ever catches peaks
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    limiter.connect(destination ?? (ctx as AudioContext).destination);

    // bus compressor: slow enough to be inaudible, there to stop density from
    // turning into level
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 10;
    comp.ratio.value = 3;
    comp.attack.value = 0.3;
    comp.release.value = 1;
    comp.connect(limiter);

    this.master = ctx.createGain();
    this.master.gain.value = T.musicGain;
    this.master.connect(comp);

    // The reverb hangs off the master, not off the voices: fed in parallel it
    // would sail straight past the volume control, and turning the music down
    // would leave the room ringing at full level.
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = impulse(ctx, 6);
    this.wet = ctx.createGain();
    this.wet.gain.value = T.musicReverb;
    this.master.connect(this.reverb);
    this.reverb.connect(this.wet);
    this.wet.connect(comp);
  }

  /** Live-tunable levels, pushed on every dev-panel change. */
  sync() {
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(T.musicGain, t, 0.05);
    this.wet.gain.setTargetAtTime(T.musicReverb, t, 0.05);
  }

  /**
   * Schedule one note. Returns false when the voice cap turned it away, which
   * the callers treat as "the bay was already singing" rather than an error.
   */
  play(n: Note): boolean {
    if (this.active >= MAX_VOICES) return false;
    const { ctx } = this;
    const p = n.preset;
    const t = Math.max(n.when, ctx.currentTime);
    const peak = Math.max(0, Math.min(1, n.velocity)) * p.gain;
    if (peak <= 0.0001) return false;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = n.freq;
    if (n.detune) osc.detune.value = n.detune;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + p.attack);
    // setTargetAtTime approaches asymptotically, so a third of the stated decay
    // as the time constant lands it near the target within the decay
    const held = peak * p.sustain;
    env.gain.setTargetAtTime(held, t + p.attack, Math.max(0.01, p.decay / 3));

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = p.cutoff;

    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, n.pan ?? 0));

    osc.connect(env);
    env.connect(lp);
    lp.connect(pan);
    pan.connect(this.master);

    const releaseAt = t + Math.max(0.05, n.ring);
    env.gain.setTargetAtTime(0, releaseAt, Math.max(0.02, p.release / 3));
    const stopAt = releaseAt + p.release;
    osc.start(t);
    osc.stop(stopAt);

    this.active++;
    osc.onended = () => {
      this.active--;
      osc.disconnect();
      env.disconnect();
      lp.disconnect();
      pan.disconnect();
    };
    return true;
  }
}
