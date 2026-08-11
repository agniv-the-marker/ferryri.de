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
 * Chain: voice pair → lowpass → pan → master → (dry + reverb) → compressor →
 * limiter. Every note is two oscillators a few cents apart so it wavers
 * against itself, the way the two pipes of an aulos do.
 * The compressor keeps a rush-hour fleet from stacking into mud; the limiter is
 * the backstop so a tap during a full bay can never clip.
 */
import { T } from '../lib/tunables';

export interface VoicePreset {
  /**
   * Harmonic amplitudes, index 0 being the fundamental. This is what makes an
   * instrument an instrument: odd harmonics read as a reed, a lone fundamental
   * as a pipe, the full series as a bowed string.
   */
  partials: number[];
  /**
   * An extra partial at a non-integer ratio of the fundamental, [ratio, level].
   * Nothing else turns a tone into struck metal — 2.76× is bell, 3.9× is the
   * bar of a marimba.
   */
  inharmonic?: [number, number];
  /** Noise on the onset, [level, seconds]: breath for a pipe, a mallet click. */
  chiff?: [number, number];
  /** seconds to reach full level */
  attack: number;
  /** seconds of fall toward `sustain` */
  decay: number;
  /** fraction of peak held while the note rings, 0 = let it die away */
  sustain: number;
  /** seconds of tail once the note is released */
  release: number;
  /** lowpass corner in Hz at the onset */
  cutoff: number;
  /** where that corner settles as the note rings; most of struck-vs-bowed */
  cutoffEnd?: number;
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
  /**
   * Who yields to whom when the pool is full. Anything the listener just
   * caused outranks the ambient bed, so a tap is never the thing that gets
   * dropped. See `play`.
   */
  priority?: number;
}

/**
 * Above this many overlapping notes the bay is mush. Sines are cheap — a mix
 * this size measured 20× realtime with the reverb — so the number is about
 * taste, not CPU. It has to be generous, because a note here holds its voice
 * for its ring plus its release, which is fifteen seconds or more.
 */
const MAX_VOICES = 20;
/**
 * Reverb length. Measured against a dry mix of the same voices: six seconds of
 * convolution costs 1.7× dry, two seconds 1.1×. Four is the compromise — still
 * a big room, with the headroom back.
 */
const REVERB_SECONDS = 4;
/** The drone is meant to be felt more than heard, so its tunable starts quiet. */
const DRONE_TRIM = 0.08;

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
  /** Sounding notes, oldest first, each with the rank that can displace it. */
  private live: { env: GainNode; oscs: OscillatorNode[]; priority: number }[] = [];
  /** Dev aid: notes that never sounded because the pool was full. */
  debugDropped = 0;
  private drone: OscillatorNode[] = [];
  private droneGain: GainNode | null = null;
  /** One PeriodicWave per preset, built on first use and kept. */
  private waves = new Map<VoicePreset, PeriodicWave>();
  private noise: AudioBuffer | null = null;

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
    this.reverb.buffer = impulse(ctx, REVERB_SECONDS);
    this.wet = ctx.createGain();
    this.wet.gain.value = T.musicReverb;
    this.master.connect(this.reverb);
    this.reverb.connect(this.wet);
    this.wet.connect(comp);
  }

  /** The preset's harmonic series, as a wave the oscillator can play. */
  private waveFor(p: VoicePreset): PeriodicWave {
    let w = this.waves.get(p);
    if (!w) {
      // index 0 of a PeriodicWave is DC, so the partials shift up by one
      const real = new Float32Array(p.partials.length + 1);
      const imag = new Float32Array(p.partials.length + 1);
      for (let i = 0; i < p.partials.length; i++) imag[i + 1] = p.partials[i]!;
      w = this.ctx.createPeriodicWave(real, imag, { disableNormalization: false });
      this.waves.set(p, w);
    }
    return w;
  }

  /** One second of noise, shared by every onset that wants breath or a click. */
  private noiseBuffer(): AudioBuffer {
    if (!this.noise) {
      const len = Math.floor(this.ctx.sampleRate);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return this.noise;
  }

  /** Live-tunable levels, pushed on every dev-panel change. */
  sync() {
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(T.musicGain, t, 0.05);
    this.wet.gain.setTargetAtTime(T.musicReverb, t, 0.05);
    if (this.droneGain) {
      this.droneGain.gain.setTargetAtTime(T.musicDrone * DRONE_TRIM, t, 0.4);
    }
  }

  /**
   * A pedal under everything, held for as long as the music is on. Two pairs
   * of oscillators wavering against each other a long way down — the low
   * oscillation "Sirens" is built on, and the thing that keeps the bay from
   * going silent between sailings.
   */
  startDrone(freqs: number[]) {
    if (this.droneGain) return;
    const { ctx } = this;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setTargetAtTime(T.musicDrone * DRONE_TRIM, ctx.currentTime, 3);
    g.connect(this.master);
    this.droneGain = g;
    for (const freq of freqs) {
      for (const side of [-1, 1]) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        // a wider split than a note gets: down here it reads as swell, not tuning
        osc.detune.value = side * 6;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 220;
        osc.connect(lp);
        lp.connect(g);
        osc.start();
        this.drone.push(osc);
      }
    }
  }

  stopDrone() {
    if (!this.droneGain) return;
    const t = this.ctx.currentTime;
    this.droneGain.gain.setTargetAtTime(0, t, 0.3);
    for (const osc of this.drone) osc.stop(t + 2);
    this.drone = [];
    this.droneGain = null;
  }

  /**
   * Schedule one note. Returns false when the pool was full of notes that
   * outrank this one — which is how the ambient bed yields to anything the
   * listener actually did. A note holds its voice for its whole ring and
   * release, so without this a tap arrives to find every voice taken by boats
   * that sounded ten seconds ago, and nothing answers the water.
   */
  play(n: Note): boolean {
    const { ctx } = this;
    const priority = n.priority ?? 0;
    if (this.live.length >= MAX_VOICES && !this.steal(priority)) {
      this.debugDropped++;
      return false;
    }
    const p = n.preset;
    const t = Math.max(n.when, ctx.currentTime);
    const peak = Math.max(0, Math.min(1, n.velocity)) * p.gain;
    if (peak <= 0.0001) return false;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + p.attack);
    // setTargetAtTime approaches asymptotically, so a third of the stated decay
    // as the time constant lands it near the target within the decay
    const held = peak * p.sustain;
    env.gain.setTargetAtTime(held, t + p.attack, Math.max(0.01, p.decay / 3));

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    // The corner closes as the note rings. A bell is bright for an instant and
    // dark for the rest of its life; a bowed note barely moves. This is most of
    // what the ear uses to tell one from the other.
    lp.frequency.setValueAtTime(p.cutoff, t);
    if (p.cutoffEnd !== undefined && p.cutoffEnd !== p.cutoff) {
      lp.frequency.setTargetAtTime(p.cutoffEnd, t, Math.max(0.05, p.decay / 3));
    }

    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, n.pan ?? 0));

    // Two oscillators, split by `beat cents`, so the note breathes against
    // itself instead of sitting dead still.
    const spread = T.musicBeat / 2;
    const glide = T.musicGlide;
    const wave = this.waveFor(p);
    const oscs = [-1, 1].map((side) => {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave);
      osc.detune.value = (n.detune ?? 0) + side * spread;
      if (glide > 0.005) {
        // slide up into pitch — a siren, in both senses
        osc.frequency.setValueAtTime(n.freq * 0.89, t);
        osc.frequency.exponentialRampToValueAtTime(n.freq, t + glide);
      } else {
        osc.frequency.value = n.freq;
      }
      osc.connect(env);
      return osc;
    });

    // A partial at a ratio no harmonic series contains — the difference
    // between a struck tone and struck metal.
    if (p.inharmonic) {
      const [ratio, level] = p.inharmonic;
      const extra = ctx.createOscillator();
      extra.frequency.value = n.freq * ratio;
      const g = ctx.createGain();
      g.gain.value = level;
      extra.connect(g);
      g.connect(env);
      oscs.push(extra);
    }

    env.connect(lp);
    lp.connect(pan);
    pan.connect(this.master);

    // Breath, or the knock of a mallet: a short noise burst filtered around the
    // note, which is how an onset stops sounding synthetic.
    if (p.chiff) {
      const [level, secs] = p.chiff;
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = Math.min(8000, n.freq * 3);
      bp.Q.value = 1.2;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0, t);
      ng.gain.linearRampToValueAtTime(peak * level, t + Math.min(0.02, secs / 2));
      ng.gain.setTargetAtTime(0, t + Math.min(0.02, secs / 2), Math.max(0.01, secs / 3));
      src.connect(bp);
      bp.connect(ng);
      ng.connect(lp);
      src.start(t);
      src.stop(t + secs + 0.2);
    }

    const releaseAt = t + Math.max(0.05, n.ring);
    env.gain.setTargetAtTime(0, releaseAt, Math.max(0.02, p.release / 3));
    const stopAt = releaseAt + p.release;
    for (const osc of oscs) {
      osc.start(t);
      osc.stop(stopAt);
    }

    const entry = { env, oscs, priority };
    this.live.push(entry);
    oscs[0]!.onended = () => {
      const i = this.live.indexOf(entry);
      if (i >= 0) this.live.splice(i, 1);
      for (const osc of oscs) osc.disconnect();
      env.disconnect();
      lp.disconnect();
      pan.disconnect();
    };
    return true;
  }

  /**
   * Make room by retiring the oldest note this one outranks, fading it rather
   * than cutting it so the theft is inaudible. Returns false when everything
   * sounding matters more than what is asking.
   */
  private steal(priority: number): boolean {
    const i = this.live.findIndex((v) => v.priority <= priority);
    if (i < 0) return false;
    const victim = this.live[i]!;
    const t = this.ctx.currentTime;
    victim.env.gain.cancelScheduledValues(t);
    victim.env.gain.setTargetAtTime(0, t, 0.08);
    for (const osc of victim.oscs) osc.stop(t + 0.4);
    this.live.splice(i, 1);
    return true;
  }
}
