/**
 * The bay, playing itself.
 *
 * Three things make notes. Every vessel underway sounds on its own slow period,
 * pitched by how far through its crossing it is, so the fleet is a drifting
 * polyrhythm that never lines up. Tapping a terminal reads its next departures
 * and plays them as a phrase. And a tap on open water sends a real wavefront
 * out across the bay — as it reaches each hull, that boat sounds, so the
 * arpeggio's rhythm is the wave's own physics reflecting off the coastline.
 *
 * Timing does not come from requestAnimationFrame, which stutters and stalls
 * with the tab. rAF only leaves a snapshot of the world here; a short interval
 * reads it and schedules notes a little way ahead against the audio clock.
 */
import type { Camera } from '../map/camera';
import type { BobState } from '../map/overlay';
import type { Departure } from '../sim/schedule';
import type { Route, ScheduleData } from '../lib/types';
import type { VesselState } from '../sim/vessels';
import { T } from '../lib/tunables';
import { routeVisible } from '../lib/visibility';
import { Engine } from './engine';
import { CHIME } from './voices';
import {
  assignVoices,
  degreeToFreq,
  hash,
  idleFigure,
  periodFor,
  phraseFrom,
  type PhraseNote,
  type RouteVoice,
} from './score';

/** How far ahead of the audio clock notes are scheduled. */
const LOOKAHEAD = 0.12;
const TICK_MS = 25;
/** A hull can only answer a passing wave this often. */
const WAVE_REFRACTORY = 0.35;

export interface FrameState {
  vessels: VesselState[];
  cam: Camera;
  /** ripple-only water height at a css-pixel point, or null when unavailable */
  ripple: ((x: number, y: number) => number) | null;
  /** per-vessel water response the overlay already sampled */
  water: ReadonlyMap<string, BobState>;
  nowSec: number;
  spotlight: string | null;
}

const STORAGE_KEY = 'ferryride.music';

export class Music {
  private ctx: AudioContext | null = null;
  private engine: Engine | null = null;
  private timer: number | null = null;
  private voices: Map<string, RouteVoice>;
  private routeById: Map<string, Route>;
  private snapshot: FrameState | null = null;
  /** next fleet-bed note per trip, in context time */
  private nextAt = new Map<string, number>();
  /** last ripple height + last trigger time per trip */
  private waveSeen = new Map<string, { h: number; at: number }>();
  private on = false;
  /**
   * Dev aid, in the spirit of `debugWavePeak`: how many hulls have answered a
   * wavefront, and the highest the water has been seen to reach under one.
   * Lets a headless test assert the coupling without a speaker.
   */
  debugWaveNotes = 0;
  debugWavePeak = 0;

  constructor(data: ScheduleData) {
    this.voices = assignVoices(data.routes);
    this.routeById = new Map(data.routes.map((r) => [r.id, r]));
  }

  /** Was music left on last visit? Restored, but never resumed without a gesture. */
  static remembered(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'on';
    } catch {
      return false;
    }
  }

  get enabled(): boolean {
    return this.on;
  }

  /**
   * Browsers require a gesture before audio can start, so this must be called
   * from a click handler. Creating the context lazily also means a visitor who
   * never asks for music never pays for any of it.
   */
  async setEnabled(on: boolean) {
    this.on = on;
    try {
      localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
    } catch {
      /* private mode: the session still works, it just won't be remembered */
    }
    if (!on) {
      await this.ctx?.suspend().catch(() => {});
      if (this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
      return;
    }
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.engine = new Engine(this.ctx);
    }
    // Chrome leaves resume() pending indefinitely — not rejected, pending —
    // when the autoplay policy blocks it, so never hang a caller on it.
    await Promise.race([
      this.ctx.resume().catch(() => {}),
      new Promise((done) => setTimeout(done, 500)),
    ]);
    // iOS routes Web Audio through the ringer bus (and the silent switch) unless
    // the page says it means to play back
    const session = (navigator as { audioSession?: { type: string } }).audioSession;
    if (session) session.type = 'playback';
    if (this.timer === null) {
      this.timer = setInterval(() => this.tick(), TICK_MS) as unknown as number;
    }
  }

  /** Follows the page: no reason to keep a mix running for a hidden tab. */
  async setAwake(awake: boolean) {
    if (!this.ctx || !this.on) return;
    await (awake ? this.ctx.resume() : this.ctx.suspend()).catch(() => {});
  }

  /** Called every rAF; cheap by design — it only leaves state behind. */
  frame(state: FrameState) {
    this.snapshot = state;
    if (this.on) this.listenForWaves(state);
  }

  // ---- ripple → hulls -----------------------------------------------------

  /**
   * A hull sounds when the water under it rises through the gate. The ripple
   * field is read on its own here rather than through the combined water
   * sampler: the swell would cross any threshold constantly, and only the tap
   * ripple should be playing anything.
   */
  private listenForWaves(state: FrameState) {
    const gain = T.musicRippleSeq;
    if (!this.ctx || !this.engine || gain <= 0 || !state.ripple) return;
    const now = this.ctx.currentTime;
    const { cam } = state;
    const s = cam.scale;
    const tx = cam.viewport.w / 2 - cam.cur.x * s;
    const ty = cam.viewport.h / 2 - cam.cur.y * s;
    const gate = T.musicRippleGate;

    for (const v of state.vessels) {
      const voice = this.voices.get(v.routeId);
      if (!voice || !this.visible(v.routeId)) continue;
      const x = v.pos.x * s + tx;
      const y = v.pos.y * s + ty;
      if (x < 0 || y < 0 || x > cam.viewport.w || y > cam.viewport.h) continue;
      const h = Math.abs(state.ripple(x, y));
      if (h > this.debugWavePeak) this.debugWavePeak = h;
      const prev = this.waveSeen.get(v.trip.id);
      this.waveSeen.set(v.trip.id, { h, at: prev?.at ?? -1 });
      if (!prev || prev.h >= gate || h < gate) continue;
      if (now - prev.at < WAVE_REFRACTORY) continue;
      this.waveSeen.set(v.trip.id, { h, at: now });
      this.debugWaveNotes++;
      this.engine.play({
        preset: voice.preset,
        freq: degreeToFreq(voice, this.degreeOf(v, state.nowSec)),
        when: now + 0.02,
        ring: T.musicRing * 0.6,
        velocity: Math.min(0.9, 0.3 + h * 2) * gain * this.duck(v.routeId, state.spotlight),
        pan: this.panOf(v, state),
      });
    }
    // trips that ended shouldn't keep state around
    if (this.waveSeen.size > state.vessels.length * 3) this.waveSeen.clear();
  }

  // ---- the fleet bed ------------------------------------------------------

  private tick() {
    const { ctx, engine, snapshot } = this;
    if (!ctx || !engine || !snapshot || !this.on) return;
    engine.sync();
    const horizon = ctx.currentTime + LOOKAHEAD;
    const bed = T.musicBed;
    if (bed <= 0) return;

    for (const v of snapshot.vessels) {
      const voice = this.voices.get(v.routeId);
      if (!voice || !this.visible(v.routeId)) continue;
      const id = v.trip.id;
      let at = this.nextAt.get(id);
      if (at === undefined) {
        // stagger first entries by the trip's own hash so a service day doesn't
        // start with the whole fleet striking at once
        at = ctx.currentTime + hash(id) * 6;
        this.nextAt.set(id, at);
        continue;
      }
      if (at > horizon) continue;
      const period = periodFor(id, T.musicDensity);
      this.nextAt.set(id, at + period);
      // docked boats are tied up, not sailing — they murmur
      const velocity = (v.docked ? 0.18 : 0.45) * bed * this.duck(v.routeId, snapshot.spotlight);
      engine.play({
        preset: voice.preset,
        freq: degreeToFreq(voice, this.degreeOf(v, snapshot.nowSec)),
        when: Math.max(at, ctx.currentTime),
        ring: T.musicRing,
        velocity,
        pan: this.panOf(v, snapshot),
        detune: this.detuneOf(v, snapshot),
      });
    }
    if (this.nextAt.size > 400) this.nextAt.clear();
  }

  // ---- taps ---------------------------------------------------------------

  /** The tap itself: a bell over the water, whatever else it sets off. */
  tapped() {
    const { ctx, engine } = this;
    if (!ctx || !engine || !this.on || T.musicRippleBell <= 0) return;
    const v = this.voices.values().next().value as RouteVoice | undefined;
    const octave = (v?.octave ?? 3) + 1;
    engine.play({
      preset: CHIME,
      freq: degreeToFreq({ preset: CHIME, octave }, 2 + Math.floor(Math.random() * 3)),
      when: ctx.currentTime + 0.01,
      ring: 0.6,
      velocity: 0.55 * T.musicRippleBell,
    });
  }

  /** Tapping a terminal: its next sailings, as a phrase. */
  terminalPhrase(deps: Departure[], nowSec: number, routesHere: string[]) {
    const notes = deps.length ? phraseFrom(deps, nowSec) : idleFigure(routesHere);
    this.playPhrase(notes);
  }

  /** Tapping a ferry: its own voice, running out the rest of the crossing. */
  vesselRun(v: VesselState, nowSec: number) {
    const voice = this.voices.get(v.routeId);
    if (!voice) return;
    const from = this.degreeOf(v, nowSec);
    this.playPhrase(
      [0, 1, 2].map((i) => ({
        routeId: v.routeId,
        at: i * 0.34,
        degree: from + i,
        velocity: 0.5 - i * 0.08,
      })),
    );
  }

  private playPhrase(notes: PhraseNote[]) {
    const { ctx, engine } = this;
    if (!ctx || !engine || !this.on || T.musicPhrase <= 0) return;
    const t0 = ctx.currentTime + 0.05;
    for (const n of notes) {
      const voice = this.voices.get(n.routeId);
      if (!voice || !this.visible(n.routeId)) continue;
      engine.play({
        preset: voice.preset,
        freq: degreeToFreq(voice, n.degree),
        when: t0 + n.at,
        ring: T.musicRing,
        velocity: n.velocity * T.musicPhrase,
      });
    }
  }

  // ---- shared helpers -----------------------------------------------------

  private visible(routeId: string): boolean {
    const route = this.routeById.get(routeId);
    return !!route && routeVisible(route);
  }

  /** Legend spotlight solos a route; everything else steps back. */
  private duck(routeId: string, spotlight: string | null): number {
    return spotlight === null || spotlight === routeId ? 1 : 0.25;
  }

  /** Pitch climbs with progress through the crossing, so an arrival is audible. */
  private degreeOf(v: VesselState, nowSec: number): number {
    const span = Math.max(1, v.arr - v.dep);
    const f = Math.max(0, Math.min(1, (nowSec - v.dep) / span));
    return Math.round(f * 6);
  }

  /** A hull heeled to starboard is heard to starboard. */
  private panOf(v: VesselState, state: FrameState): number {
    const w = state.water.get(v.trip.id);
    if (!w) return 0;
    return Math.max(-1, Math.min(1, w.gx * 8)) * T.musicPan;
  }

  /** Riding a crest lifts the note a few cents — the bob, made audible. */
  private detuneOf(v: VesselState, state: FrameState): number {
    const w = state.water.get(v.trip.id);
    return w ? Math.max(-12, Math.min(12, w.h * 25)) : 0;
  }
}

/**
 * Render a fixed handful of notes through an OfflineAudioContext and report
 * what came out. A fence-and-speaker feature is otherwise untestable in a
 * headless browser; this is the audio equivalent of `debugWavePeak`, and it
 * respects the layer tunables so a test can assert that silencing one layer
 * silences exactly that layer.
 */
export async function musicKick(data: ScheduleData, seconds = 6) {
  const rate = 44100;
  const ctx = new OfflineAudioContext(2, Math.ceil(rate * seconds), rate);
  const engine = new Engine(ctx);
  const voices = [...assignVoices(data.routes).values()];
  if (!voices.length) return { peak: 0, rms: 0, bed: 0, bell: 0, hull: 0 };

  let bed = 0;
  let bell = 0;
  let hull = 0;
  if (T.musicBed > 0) {
    for (let i = 0; i < 6; i++) {
      const v = voices[i % voices.length]!;
      if (engine.play({
        preset: v.preset,
        freq: degreeToFreq(v, i),
        when: i * 0.4,
        ring: T.musicRing,
        velocity: 0.45 * T.musicBed,
      })) bed++;
    }
  }
  if (T.musicRippleBell > 0) {
    if (engine.play({
      preset: CHIME,
      freq: degreeToFreq({ preset: CHIME, octave: 4 }, 2),
      when: 0.05,
      ring: 0.6,
      velocity: 0.55 * T.musicRippleBell,
    })) bell++;
  }
  if (T.musicRippleSeq > 0) {
    // the wavefront reaching four hulls in turn
    for (let i = 0; i < 4; i++) {
      const v = voices[i % voices.length]!;
      if (engine.play({
        preset: v.preset,
        freq: degreeToFreq(v, 3 + i),
        when: 0.3 + i * 0.22,
        ring: T.musicRing * 0.6,
        velocity: 0.5 * T.musicRippleSeq,
      })) hull++;
    }
  }

  const buf = await ctx.startRendering();
  let peak = 0;
  let sum = 0;
  let n = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]!);
      if (a > peak) peak = a;
      sum += d[i]! * d[i]!;
      n++;
    }
  }
  return { peak, rms: Math.sqrt(sum / Math.max(1, n)), bed, bell, hull };
}
