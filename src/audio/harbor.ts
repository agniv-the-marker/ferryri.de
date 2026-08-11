/**
 * The room the music sits in: what the bay itself sounds like.
 *
 * Every part of this is synthesised, which was not the original plan — the
 * plan was field recordings. Two reasons it changed. Nobody here can hold a
 * microphone off the end of a pier, and shipping downloaded audio nobody has
 * listened to onto a public site is worse than shipping none. What is left is
 * the honest option, and it happens to suit: a foghorn is a low tone with a
 * slow swell, a bell buoy is a struck bell, wash is filtered noise, and an
 * idling engine is a buzz with a wobble in it. All four are things this engine
 * was already good at, and they cost nothing to download.
 *
 * It is punctuation and room tone, never melody. The foghorn is rare enough to
 * stay an event; the wash and the hum sit under everything without asking to
 * be noticed.
 */
import { T } from '../lib/tunables';

/** Seconds between foghorns, picked fresh each time within this range. */
const HORN_GAP = [38, 95];
/** Seconds between bell-buoy strikes. */
const BUOY_GAP = [9, 26];

export class Harbor {
  private wash: AudioBufferSourceNode | null = null;
  private washGain: GainNode | null = null;
  private hum: OscillatorNode[] = [];
  private humGain: GainNode | null = null;
  private nextHorn = 0;
  private nextBuoy = 0;
  /** 0..1, how much of the fleet is in front of you right now. */
  private activity = 0;
  private running = false;

  constructor(
    private ctx: BaseAudioContext,
    private bus: AudioNode,
    private noise: AudioBuffer,
  ) {}

  /** How busy the visible water is; the engine hum follows it. */
  setActivity(vessels: number) {
    this.activity = Math.max(0, Math.min(1, vessels / 8));
  }

  start() {
    if (this.running) return;
    this.running = true;
    const { ctx } = this;
    const now = ctx.currentTime;

    // ---- wash: the sea itself, a band of noise breathing slowly ----
    const wash = ctx.createBufferSource();
    wash.buffer = this.noise;
    wash.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 620;
    band.Q.value = 0.7;
    const washGain = ctx.createGain();
    washGain.gain.value = 0;
    // a slow swell over the wash, so it is never a flat hiss
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.4;
    lfo.connect(lfoGain);
    lfoGain.connect(washGain.gain);
    wash.connect(band);
    band.connect(washGain);
    washGain.connect(this.bus);
    wash.start();
    lfo.start();
    this.wash = wash;
    this.washGain = washGain;

    // ---- engine hum: a working boat, felt more than heard ----
    const humGain = ctx.createGain();
    humGain.gain.value = 0;
    const humLp = ctx.createBiquadFilter();
    humLp.type = 'lowpass';
    humLp.frequency.value = 190;
    humLp.connect(humGain);
    humGain.connect(this.bus);
    for (const [freq, detune] of [[62, -4], [93, 5]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      osc.connect(humLp);
      osc.start();
      this.hum.push(osc);
    }
    this.humGain = humGain;

    this.nextHorn = now + 12 + Math.random() * 20;
    this.nextBuoy = now + 4 + Math.random() * 8;
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    const t = this.ctx.currentTime;
    this.washGain?.gain.setTargetAtTime(0, t, 0.5);
    this.humGain?.gain.setTargetAtTime(0, t, 0.5);
    this.wash?.stop(t + 3);
    for (const osc of this.hum) osc.stop(t + 3);
    this.hum = [];
    this.wash = null;
  }

  /** Called from the scheduler tick; schedules the occasional event. */
  tick() {
    if (!this.running) return;
    const level = T.musicHarbor;
    const now = this.ctx.currentTime;
    this.washGain?.gain.setTargetAtTime(level * 0.05, now, 1.5);
    this.humGain?.gain.setTargetAtTime(level * this.activity * 0.05, now, 2);
    if (level <= 0) return;

    if (now >= this.nextHorn) {
      this.horn(now + 0.1, level * T.musicFoghorn);
      this.nextHorn = now + HORN_GAP[0]! + Math.random() * (HORN_GAP[1]! - HORN_GAP[0]!);
    }
    if (now >= this.nextBuoy) {
      this.buoy(now + 0.1, level);
      this.nextBuoy = now + BUOY_GAP[0]! + Math.random() * (BUOY_GAP[1]! - BUOY_GAP[0]!);
    }
  }

  /**
   * A foghorn: two low tones a little apart, swelling over most of a second
   * and holding. Rare on purpose — heard often it stops being weather and
   * starts being a jingle.
   */
  private horn(at: number, level: number) {
    if (level <= 0) return;
    const { ctx } = this;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(level * 0.16, at + 0.7);
    env.gain.setValueAtTime(level * 0.16, at + 1.9);
    env.gain.setTargetAtTime(0, at + 1.9, 0.6);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 430;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.4 - 0.7;
    env.connect(lp);
    lp.connect(pan);
    pan.connect(this.bus);
    for (const freq of [88, 110.5]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.connect(env);
      osc.start(at);
      osc.stop(at + 4.5);
    }
  }

  /** A bell buoy: struck, inharmonic, rolling with the swell. */
  private buoy(at: number, level: number) {
    const { ctx } = this;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(level * 0.05, at + 0.004);
    env.gain.setTargetAtTime(0, at + 0.004, 1.1);
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    env.connect(pan);
    pan.connect(this.bus);
    const root = 430 + Math.random() * 60;
    for (const [ratio, gain] of [[1, 1], [2.76, 0.55], [5.4, 0.28]] as const) {
      const osc = ctx.createOscillator();
      osc.frequency.value = root * ratio;
      const g = ctx.createGain();
      g.gain.value = gain;
      osc.connect(g);
      g.connect(env);
      osc.start(at);
      osc.stop(at + 5);
    }
  }
}
