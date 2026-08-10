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
import { LINE, STATION, TAP } from './voices';
import {
  DRONE_FREQS,
  assignVoices,
  degreeToFreq,
  hash,
  idleFigure,
  listeningPosts,
  periodFor,
  phraseFrom,
  stationPosts,
  type PhraseNote,
  type Post,
  type RouteVoice,
} from './score';

/** How far ahead of the audio clock notes are scheduled. */
const LOOKAHEAD = 0.12;
const TICK_MS = 25;
/** A hull can only answer a passing wave this often. */
const WAVE_REFRACTORY = 0.35;
/**
 * How long after a tap anything is still listening. The wave field is flat far
 * more than 99% of the time, and sampling it under every vessel, station and
 * route post on every frame for nothing was the map's stutter — this window is
 * what makes the whole pass free when the water is still.
 */
const LISTEN_WINDOW = 8;
/** How far off a dock to listen, in css px, to clear the shoreline. */
const STATION_REACH = 16;

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
  private posts: Post[];
  private stations: { id: string; world: { x: number; y: number }; degree: number }[];
  private stationVoice: RouteVoice = { preset: STATION, octave: 1 };
  private lineVoice: RouteVoice = { preset: LINE, octave: 1 };
  private tapVoice: RouteVoice = { preset: TAP, octave: 1 };
  /** Context time after which the water is assumed flat again. */
  private listenUntil = 0;
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
  debugStationNotes = 0;
  debugLineNotes = 0;
  debugWavePeak = 0;

  constructor(data: ScheduleData) {
    this.voices = assignVoices(data.routes);
    this.routeById = new Map(data.routes.map((r) => [r.id, r]));
    // projected once at boot, not per frame
    this.posts = listeningPosts(data);
    this.stations = stationPosts(data.terminals);
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
      this.engine?.stopDrone();
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
    this.engine?.startDrone(DRONE_FREQS);
  }

  /** Follows the page: no reason to keep a mix running for a hidden tab. */
  async setAwake(awake: boolean) {
    if (!this.ctx || !this.on) return;
    await (awake ? this.ctx.resume() : this.ctx.suspend()).catch(() => {});
  }

  /**
   * Is anything still listening? False almost always, which lets the frame loop
   * skip even building a sampler for a field that is flat.
   */
  get listening(): boolean {
    return this.on && !!this.ctx && this.ctx.currentTime <= this.listenUntil;
  }

  /** Called every rAF; cheap by design — it only leaves state behind. */
  frame(state: FrameState) {
    this.snapshot = state;
    if (this.on) this.listenForWaves(state);
  }

  // ---- ripple → hulls -----------------------------------------------------

  /**
   * Everything the wavefront touches answers: hulls in their route's voice,
   * terminals with their own fixed note, route lines with a breath. Near things
   * first, far ones later, so the figure's rhythm is the wave spreading out and
   * reflecting off the coastline.
   *
   * The ripple field is read on its own here rather than through the combined
   * water sampler — the swell would trip any threshold constantly, and only a
   * wave you started should be playing anything.
   */
  private listenForWaves(state: FrameState) {
    if (!this.ctx || !this.engine || !state.ripple) return;
    const now = this.ctx.currentTime;
    if (now > this.listenUntil) return; // the water went flat; nothing to do

    const { cam } = state;
    const s = cam.scale;
    const { w, h } = cam.viewport;
    const tx = w / 2 - cam.cur.x * s;
    const ty = h / 2 - cam.cur.y * s;
    const gate = T.musicRippleGate;
    const ripple = state.ripple;
    const panOfX = (x: number) => ((x / w) * 2 - 1) * T.musicPan;

    // ---- hulls ----
    const hulls = T.musicRippleSeq;
    if (hulls > 0) {
      for (const v of state.vessels) {
        const voice = this.voices.get(v.routeId);
        if (!voice || !this.visible(v.routeId)) continue;
        const x = v.pos.x * s + tx;
        const y = v.pos.y * s + ty;
        if (x < 0 || y < 0 || x > w || y > h) continue;
        const height = Math.abs(ripple(x, y));
        if (height > this.debugWavePeak) this.debugWavePeak = height;
        if (!this.arrived(v.trip.id, height, now, gate)) continue;
        this.debugWaveNotes++;
        this.engine.play({
          preset: voice.preset,
          freq: degreeToFreq(voice, this.degreeOf(v, state.nowSec)),
          when: now + 0.02,
          ring: T.musicRing * 0.6,
          velocity: Math.min(0.9, 0.3 + height * 2) * hulls * this.duck(v.routeId, state.spotlight),
          pan: this.panOf(v, state),
        });
      }
    }

    // ---- terminals ----
    const stops = T.musicRippleStop;
    if (stops > 0) {
      for (const st of this.stations) {
        const x = st.world.x * s + tx;
        const y = st.world.y * s + ty;
        if (x < 0 || y < 0 || x > w || y > h) continue;
        // A terminal stands on the shore, and the sim pins land flat so waves
        // reflect off the coast — sampled at the dock itself a station would
        // never hear anything. Take the loudest of a small ring around it, so
        // whichever side faces open water is the side that listens.
        let height = 0;
        for (let k = 0; k < 4; k++) {
          const dx = k === 0 ? -STATION_REACH : k === 1 ? STATION_REACH : 0;
          const dy = k === 2 ? -STATION_REACH : k === 3 ? STATION_REACH : 0;
          const at = Math.abs(ripple(x + dx, y + dy));
          if (at > height) height = at;
        }
        if (!this.arrived(`s${st.id}`, height, now, gate)) continue;
        this.debugStationNotes++;
        this.engine.play({
          preset: STATION,
          freq: degreeToFreq(this.stationVoice, st.degree),
          when: now + 0.02,
          ring: T.musicRing,
          velocity: Math.min(0.8, 0.28 + height * 1.6) * stops,
          pan: panOfX(x),
        });
      }
    }

    // ---- route lines ----
    const lines = T.musicRippleLine;
    if (lines > 0) {
      for (let i = 0; i < this.posts.length; i++) {
        const post = this.posts[i]!;
        if (!this.visible(post.routeId)) continue;
        const x = post.world.x * s + tx;
        const y = post.world.y * s + ty;
        if (x < 0 || y < 0 || x > w || y > h) continue;
        const height = Math.abs(ripple(x, y));
        if (!this.arrived(`l${i}`, height, now, gate)) continue;
        this.debugLineNotes++;
        this.engine.play({
          preset: LINE,
          freq: degreeToFreq(this.lineVoice, post.degree),
          when: now + 0.02,
          ring: T.musicRing * 0.4,
          velocity: 0.3 * lines * this.duck(post.routeId, state.spotlight),
          pan: panOfX(x),
        });
      }
    }
  }

  /**
   * Has the wave just *arrived* here — risen through the gate since last look,
   * and not too soon after the last time this thing sounded? The record is
   * mutated rather than replaced: at a few hundred listening points a frame,
   * allocating here is what turns into stutter.
   */
  private arrived(key: string, height: number, now: number, gate: number): boolean {
    const rec = this.waveSeen.get(key);
    if (!rec) {
      this.waveSeen.set(key, { h: height, at: -1 });
      return false;
    }
    const rising = rec.h < gate && height >= gate;
    rec.h = height;
    if (!rising || now - rec.at < WAVE_REFRACTORY) return false;
    rec.at = now;
    return true;
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

  /**
   * You pressed the water, so the water answers — plainly, on its own note —
   * and everything the wave then reaches follows behind it.
   */
  tapped() {
    const { ctx, engine } = this;
    if (!ctx || !engine || !this.on) return;
    this.listenUntil = ctx.currentTime + LISTEN_WINDOW;
    if (T.musicRippleBell <= 0) return;
    engine.play({
      preset: TAP,
      freq: degreeToFreq(this.tapVoice, 0),
      when: ctx.currentTime + 0.01,
      ring: 2.2,
      velocity: 0.6 * T.musicRippleBell,
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
  // Kept deliberately under the engine's voice cap: in an offline render
  // nothing ever ends, so `active` only climbs and a fuller pattern would have
  // later layers refused for reasons that say nothing about the live mix.
  const voices = [...assignVoices(data.routes).values()];
  if (!voices.length) return { peak: 0, rms: 0, bed: 0, bell: 0, hull: 0, stations: 0, lines: 0 };

  let bed = 0;
  let bell = 0;
  let hull = 0;
  if (T.musicBed > 0) {
    for (let i = 0; i < 4; i++) {
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
      preset: TAP,
      freq: degreeToFreq({ preset: TAP, octave: 1 }, 0),
      when: 0.05,
      ring: 2.2,
      velocity: 0.6 * T.musicRippleBell,
    })) bell++;
  }
  if (T.musicRippleSeq > 0) {
    // the wavefront reaching three hulls in turn
    for (let i = 0; i < 3; i++) {
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

  let stations = 0;
  if (T.musicRippleStop > 0) {
    for (let i = 0; i < 2; i++) {
      if (engine.play({
        preset: STATION,
        freq: degreeToFreq({ preset: STATION, octave: 1 }, i * 2),
        when: 0.5 + i * 0.5,
        ring: T.musicRing,
        velocity: 0.4 * T.musicRippleStop,
      })) stations++;
    }
  }
  let lines = 0;
  if (T.musicRippleLine > 0) {
    for (let i = 0; i < 2; i++) {
      if (engine.play({
        preset: LINE,
        freq: degreeToFreq({ preset: LINE, octave: 1 }, i),
        when: 0.7 + i * 0.3,
        ring: T.musicRing * 0.4,
        velocity: 0.3 * T.musicRippleLine,
      })) lines++;
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
  return { peak, rms: Math.sqrt(sum / Math.max(1, n)), bed, bell, hull, stations, lines };
}
