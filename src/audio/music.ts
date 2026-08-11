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
import { metersPerWorldUnit } from '../map/proj';
import type { BobState } from '../map/overlay';
import type { Departure } from '../sim/schedule';
import type { Route, ScheduleData } from '../lib/types';
import type { VesselState } from '../sim/vessels';
import { T } from '../lib/tunables';
import { routeVisible, stationRoutes, stationVisible } from '../lib/visibility';
import { Engine } from './engine';
import { Harbor } from './harbor';
import { Bank } from './bank';
import { FAMILIES, TAP, type FamilyName } from './voices';
import {
  DRONE_FREQS,
  assignVoices,
  degreeToFreq,
  hash,
  idleFigure,
  listeningPosts,
  nextGapFor,
  phraseFrom,
  stationGapFor,
  stationPosts,
  stationVoice,
  vesselDetune,
  type PhraseNote,
  type Post,
  type RouteVoice,
  type StationPost,
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
/** Points around a station's radius, so whichever side faces water is heard. */
const STATION_RING = 8;
/** How long a hull stays tinted after it sounds. */
const FLASH_MS = 900;
/** How far off the edge of the screen a boat still counts as on the map. */
const EDGE = 30;

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
  private harbor: Harbor | null = null;
  private bank: Bank | null = null;
  private timer: number | null = null;
  private voices: Map<string, RouteVoice>;
  private routeById: Map<string, Route>;
  private posts: Post[];
  private stations: StationPost[];
  /** Which routes call at each terminal — the map's own test for drawing one. */
  private stationRoutes: Map<string, Route[]>;
  private tapVoice: RouteVoice = { preset: TAP, octave: 1 };
  /** Context time after which the water is assumed flat again. */
  private listenUntil = 0;
  /** Trip id of the vessel brought forward in the mix, if any. */
  private focus: string | null = null;
  /**
   * When each vessel last sounded, on the wall clock — the overlay tints a
   * hull for a moment as its note goes out, so you can see which boat you are
   * hearing. Wall clock rather than context time because the overlay has no
   * reason to know about the audio clock.
   */
  private flashes = new Map<string, number>();
  /** The same for terminals: a dock lights up as its own note goes out. */
  private stationFlashes = new Map<string, number>();
  private snapshot: FrameState | null = null;
  /** next fleet-bed note per trip, in context time */
  private nextAt = new Map<string, number>();
  /** the same, for terminals sounding on their own */
  private nextStationAt = new Map<string, number>();
  /** last ripple height + last trigger time per trip */
  private waveSeen = new Map<string, { h: number; at: number }>();
  private on = false;
  /** The dev panel is auditioning: everything the bay does on its own is held. */
  private benched = false;
  /**
   * Dev aid, in the spirit of `debugWavePeak`: how many hulls have answered a
   * wavefront, and the highest the water has been seen to reach under one.
   * Lets a headless test assert the coupling without a speaker.
   */
  debugWaveNotes = 0;
  debugStationNotes = 0;
  debugLineNotes = 0;
  debugWavePeak = 0;
  /** Notes the pool refused — should stay near zero for anything you did. */
  get debugDropped(): number {
    return this.engine?.debugDropped ?? 0;
  }

  constructor(data: ScheduleData) {
    this.voices = assignVoices(data.routes);
    this.routeById = new Map(data.routes.map((r) => [r.id, r]));
    // projected once at boot, not per frame
    this.posts = listeningPosts(data);
    this.stations = stationPosts(data.terminals);
    this.stationRoutes = stationRoutes(data);
  }

  /**
   * Play one family, one route or one station on demand, so the dev panel can
   * walk you through the palette instead of you waiting for the bay to happen
   * to sound them.
   */
  audition(kind: 'family' | 'route' | 'station', id: string): string {
    const { ctx, engine } = this;
    if (!ctx || !engine) return 'music is off';
    let voice: RouteVoice | undefined;
    let degree = 2;
    if (kind === 'family') {
      const preset = FAMILIES[id as FamilyName];
      if (preset) voice = { preset, octave: 2, family: id as FamilyName };
    } else if (kind === 'route') {
      voice = this.voices.get(id);
    } else {
      const st = this.stations.find((x) => x.id === id);
      if (st) { voice = st.voice; degree = st.degree; }
    }
    if (!voice) return `no voice for ${id}`;
    engine.play({
      preset: voice.preset,
      family: voice.family,
      freq: degreeToFreq(voice, degree),
      when: ctx.currentTime + 0.02,
      ring: Math.min(T.musicRing, 2.4),
      velocity: 0.75,
      priority: 3,
    });
    return `${voice.family} · register ${voice.octave} · ${degreeToFreq(voice, degree).toFixed(0)} Hz`;
  }

  /**
   * Hold everything the bay is doing on its own — the fleet bed, the drone and
   * the room — so the listening bench can play one thing against silence. An
   * audition heard over eight ferries, a foghorn and a bell buoy answers the
   * wrong question: you cannot tell whether the voices differ if you cannot
   * hear them. What the bench itself triggers still sounds, which is why the
   * wave pass is left alone — tapping the bay is the one check whose whole
   * subject is what answers.
   */
  bench(on: boolean) {
    if (on === this.benched) return;
    this.benched = on;
    this.harbor?.setMuted(on);
    if (!this.engine) return;
    if (on) this.engine.stopDrone();
    else if (this.on) this.engine.startDrone(DRONE_FREQS);
  }

  /** Names the dev panel can walk through. */
  get families(): string[] {
    return Object.keys(FAMILIES);
  }

  /** What answered the last wave — reset each time the bay is tapped. */
  resetCounts() {
    this.debugWaveNotes = 0;
    this.debugStationNotes = 0;
    this.debugLineNotes = 0;
    this.debugWavePeak = 0;
  }

  /**
   * What was chosen last visit, or null if this visitor has never said. Null
   * matters: it is the difference between "they turned it off" and "they have
   * not been here", and only the first should override the default.
   */
  static rememberedChoice(): boolean | null {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return v === null ? null : v === 'on';
    } catch {
      return null;
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
      this.harbor?.stop();
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
      this.harbor = new Harbor(this.ctx, this.engine.bus, this.engine.noiseSource);
    }
    this.syncPalette();
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
    // starting up *into* a bench hold: bring the room up already quiet, and
    // leave the drone for when the hold is released
    if (!this.benched) this.engine?.startDrone(DRONE_FREQS);
    this.harbor?.setMuted(this.benched);
    this.harbor?.start();
  }

  /**
   * Switch palettes. The bank is only fetched the first time someone actually
   * asks for it, so nobody pays 0.7 MB for a palette they never chose.
   */
  syncPalette() {
    const { ctx, engine } = this;
    if (!ctx || !engine) return;
    if (!T.musicSampled) {
      engine.bank = null;
      return;
    }
    if (!this.bank) {
      this.bank = new Bank(ctx);
      void this.bank.load([...new Set([...this.voices.values()].map((v) => v.family!))])
        .then(() => {
          if (T.musicSampled && this.engine) this.engine.bank = this.bank;
        });
      return;
    }
    engine.bank = this.bank;
  }
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

  /**
   * Bring one vessel forward. Everything else steps back and the bus is made
   * up to match, so the mix keeps its level and that boat simply becomes the
   * thing you can hear in it.
   */
  setFocus(tripId: string | null) {
    this.focus = tripId;
    this.engine?.setFocused(tripId !== null);
  }

  /**
   * How brightly to tint a hull right now, 0..1 — a short decay from the
   * moment its note began. Read every frame by the overlay, so it allocates
   * nothing and takes a map lookup.
   */
  flashAt(tripId: string): number {
    const at = this.flashes.get(tripId);
    if (at === undefined) return 0;
    const age = (performance.now() - at) / FLASH_MS;
    return age >= 1 ? 0 : 1 - age;
  }

  private flash(tripId: string) {
    this.flashes.set(tripId, performance.now());
    if (this.flashes.size > 300) {
      const cutoff = performance.now() - FLASH_MS;
      for (const [id, at] of this.flashes) if (at < cutoff) this.flashes.delete(id);
    }
  }

  /** How brightly to ring a terminal right now, 0..1. */
  stationFlashAt(stationId: string): number {
    const at = this.stationFlashes.get(stationId);
    if (at === undefined) return 0;
    const age = (performance.now() - at) / FLASH_MS;
    return age >= 1 ? 0 : 1 - age;
  }

  private flashStation(stationId: string) {
    this.stationFlashes.set(stationId, performance.now());
  }

  /** How loud a given vessel should be, given what is in focus. */
  private focusGain(tripId: string): number {
    if (this.focus === null) return 1;
    return this.focus === tripId ? T.musicFocus : T.musicFocusDuck;
  }

  /** Called every rAF; cheap by design — it only leaves state behind. */
  frame(state: FrameState) {
    this.snapshot = state;
    if (!this.on) return;
    this.harbor?.setActivity(state.vessels.length);
    this.listenForWaves(state);
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
    const reachPx = Math.max(2, T.musicStationReach / (metersPerWorldUnit(cam.cur.y) / s));
    const panOfX = (x: number) => ((x / w) * 2 - 1) * T.musicPan;

    // ---- hulls ----
    const hulls = T.musicRippleSeq;
    if (hulls > 0) {
      for (const v of state.vessels) {
        const voice = this.voices.get(v.routeId);
        if (!voice || !this.visible(v.routeId) || this.muted(v.routeId, state.spotlight)) continue;
        const x = v.pos.x * s + tx;
        const y = v.pos.y * s + ty;
        if (x < 0 || y < 0 || x > w || y > h) continue;
        const height = Math.abs(ripple(x, y));
        if (height > this.debugWavePeak) this.debugWavePeak = height;
        if (!this.arrived(v.trip.id, height, now, gate)) continue;
        if (this.engine.play({
          preset: voice.preset,
          family: voice.family,
          freq: degreeToFreq(voice, this.degreeOf(v, state.nowSec)),
          when: now + 0.02,
          ring: T.musicRing * 0.35,
          velocity: Math.min(1, 0.55 + height * 2) * hulls * this.focusGain(v.trip.id),
          pan: this.panOf(v, state),
          detune: vesselDetune(v.trip.id),
          priority: 3,
        })) {
          this.debugWaveNotes++;
          this.flash(v.trip.id);
        }
      }
    }

    // ---- terminals ----
    const stops = T.musicRippleStop;
    if (stops > 0) {
      for (const st of this.stations) {
        if (!this.stationLit(st.id)) continue;
        if (state.spotlight !== null && !this.serves(st.id, state.spotlight)) continue;
        const x = st.world.x * s + tx;
        const y = st.world.y * s + ty;
        if (x < 0 || y < 0 || x > w || y > h) continue;
        // A terminal stands on the shore, and the sim pins land flat so waves
        // reflect off the coast — sampled at the dock itself a station would
        // never hear anything, ever. So it listens on a ring around itself.
        //
        // The radius is in *metres*, not pixels: a fixed pixel ring is two
        // kilometres offshore at the whole-bay zoom and still on the pier at a
        // slip, so a station would answer a different question at every zoom.
        // Land reads flat and contributes nothing, which means the loudest
        // point on the ring is automatically the side facing open water — no
        // shoreline geometry needed.
        let height = 0;
        for (let k = 0; k < STATION_RING; k++) {
          const a = (k / STATION_RING) * Math.PI * 2;
          const at = Math.abs(ripple(x + Math.cos(a) * reachPx, y + Math.sin(a) * reachPx));
          if (at > height) height = at;
        }
        if (!this.arrived(`s${st.id}`, height, now, gate)) continue;
        if (this.engine.play({
          preset: st.voice.preset,
          family: st.voice.family,
          freq: degreeToFreq(st.voice, st.degree),
          when: now + 0.02,
          ring: T.musicRing,
          velocity: Math.min(0.8, 0.28 + height * 1.6) * stops,
          pan: panOfX(x),
          priority: 2,
        })) {
          this.debugStationNotes++;
          this.flashStation(st.id);
        }
      }
    }

    // ---- route lines ----
    const lines = T.musicRippleLine;
    if (lines > 0) {
      for (let i = 0; i < this.posts.length; i++) {
        const post = this.posts[i]!;
        if (!this.visible(post.routeId) || this.muted(post.routeId, state.spotlight)) continue;
        // a line answering should tell you *which* line, so it borrows its
        // route's instrument — just quieter and shorter than a hull's note
        const voice = this.voices.get(post.routeId);
        if (!voice) continue;
        const x = post.world.x * s + tx;
        const y = post.world.y * s + ty;
        if (x < 0 || y < 0 || x > w || y > h) continue;
        const height = Math.abs(ripple(x, y));
        if (!this.arrived(`l${i}`, height, now, gate)) continue;
        if (this.engine.play({
          preset: voice.preset,
          family: voice.family,
          freq: degreeToFreq(voice, post.degree),
          when: now + 0.02,
          ring: T.musicRing * 0.4,
          velocity: 0.3 * lines,
          pan: panOfX(x),
          priority: 1,
        })) this.debugLineNotes++;
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
    this.harbor?.tick();
    if (this.benched) return;
    const horizon = ctx.currentTime + LOOKAHEAD;
    const bed = T.musicBed;
    const { cam } = snapshot;
    const sc = cam.scale;
    const { w, h } = cam.viewport;
    const tx = w / 2 - cam.cur.x * sc;
    const ty = h / 2 - cam.cur.y * sc;

    // `fleet level` at zero means no boats, not no bay: the terminals below
    // have their own level and keep sounding
    for (const v of bed > 0 ? snapshot.vessels : []) {
      const voice = this.voices.get(v.routeId);
      if (!voice || !this.visible(v.routeId) || this.muted(v.routeId, snapshot.spotlight)) continue;
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
      const gap = nextGapFor(id, T.musicDensity * (this.focus === id ? 2.2 : 1));
      this.nextAt.set(id, at + gap);
      // A boat you cannot see is a boat that isn't on the map, and the flash
      // that shows which hull is sounding has nothing to light. Its clock is
      // rolled forward rather than left to run down, so a fleet that was
      // offscreen doesn't all strike at once the moment you pan back.
      const x = v.pos.x * sc + tx;
      const y = v.pos.y * sc + ty;
      if (x < -EDGE || y < -EDGE || x > w + EDGE || y > h + EDGE) {
        this.nextAt.set(id, ctx.currentTime + gap);
        continue;
      }
      // docked boats are tied up, not sailing — they murmur
      const velocity = (v.docked ? 0.18 : 0.45) * bed * this.focusGain(id);
      if (engine.play({
        preset: voice.preset,
        family: voice.family,
        freq: degreeToFreq(voice, this.degreeOf(v, snapshot.nowSec)),
        when: Math.max(at, ctx.currentTime),
        ring: T.musicRing,
        velocity,
        pan: this.panOf(v, snapshot),
        detune: this.detuneOf(v, snapshot) + vesselDetune(id),
      })) this.flash(id);
    }
    if (this.nextAt.size > 400) this.nextAt.clear();

    this.stationBed(ctx, engine, snapshot, horizon, sc, tx, ty);
  }

  /**
   * Terminals sound on their own as well, the way the boats do — far more
   * slowly, because a place is not a vehicle, and each on its own throw of the
   * dice so the shoreline never falls into a rhythm.
   *
   * It answers to the same gates as everything else: a terminal drawn by
   * nothing is silent, a spotlit route silences the terminals it does not
   * serve, and one off the edge of the screen keeps its clock rolling rather
   * than banking up notes to fire when you pan back.
   */
  private stationBed(
    ctx: AudioContext,
    engine: Engine,
    snapshot: FrameState,
    horizon: number,
    sc: number,
    tx: number,
    ty: number,
  ) {
    const level = T.musicStationBed;
    if (level <= 0) return;
    const { w, h } = snapshot.cam.viewport;

    for (const st of this.stations) {
      if (!this.stationLit(st.id)) continue;
      if (snapshot.spotlight !== null && !this.serves(st.id, snapshot.spotlight)) continue;
      let at = this.nextStationAt.get(st.id);
      if (at === undefined) {
        // spread the first entries out, or the whole shoreline speaks at once
        at = ctx.currentTime + hash(st.id) * 25;
        this.nextStationAt.set(st.id, at);
        continue;
      }
      if (at > horizon) continue;
      const gap = stationGapFor(st.id, T.musicDensity);
      this.nextStationAt.set(st.id, at + gap);
      const x = st.world.x * sc + tx;
      const y = st.world.y * sc + ty;
      if (x < -EDGE || y < -EDGE || x > w + EDGE || y > h + EDGE) {
        this.nextStationAt.set(st.id, ctx.currentTime + gap);
        continue;
      }
      if (engine.play({
        preset: st.voice.preset,
        family: st.voice.family,
        freq: degreeToFreq(st.voice, st.degree),
        when: Math.max(at, ctx.currentTime),
        ring: T.musicRing,
        velocity: 0.3 * level,
        pan: ((x / w) * 2 - 1) * T.musicPan,
        priority: 0,
      })) this.flashStation(st.id);
    }
    if (this.nextStationAt.size > 200) this.nextStationAt.clear();
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
      priority: 3,
    });
  }

  /**
   * Tapping a terminal: the place announces itself in its own instrument —
   * the Ferry Building's bell, Mare Island's struck metal — and its next
   * sailings follow as a phrase.
   */
  terminalPhrase(stationId: string, deps: Departure[], nowSec: number, routesHere: string[]) {
    const { ctx, engine } = this;
    if (ctx && engine && this.on && T.musicPhrase > 0) {
      const st = this.stations.find((s) => s.id === stationId);
      if (st) {
        engine.play({
          preset: st.voice.preset,
          family: st.voice.family,
          freq: degreeToFreq(st.voice, st.degree),
          when: ctx.currentTime + 0.02,
          ring: T.musicRing,
          velocity: 0.6 * T.musicPhrase,
          priority: 3,
        });
        this.flashStation(st.id);
      }
    }
    const notes = deps.length ? phraseFrom(deps, nowSec) : idleFigure(routesHere);
    this.playPhrase(notes, 0.45);
  }

  /**
   * Picking a route out of the legend plays it, alone. Every route has its own
   * instrument, and this is how you hear that — otherwise the only way to
   * learn one is to wait for it to come round in the bed.
   */
  auditionRoute(routeId: string) {
    const voice = this.voices.get(routeId);
    if (!voice) return;
    this.playPhrase(
      [0, 2, 4].map((degree, i) => ({
        routeId,
        at: i * 0.42,
        degree,
        velocity: 0.62 - i * 0.06,
      })),
    );
  }

  /** Tapping a ferry: its own voice, running out the rest of the crossing. */
  vesselRun(v: VesselState, nowSec: number) {
    const voice = this.voices.get(v.routeId);
    if (!voice) return;
    this.flash(v.trip.id);
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

  private playPhrase(notes: PhraseNote[], delay = 0.05) {
    const { ctx, engine } = this;
    if (!ctx || !engine || !this.on || T.musicPhrase <= 0) return;
    const t0 = ctx.currentTime + delay;
    for (const n of notes) {
      const voice = this.voices.get(n.routeId);
      if (!voice || !this.visible(n.routeId)) continue;
      engine.play({
        preset: voice.preset,
        family: voice.family,
        freq: degreeToFreq(voice, n.degree),
        when: t0 + n.at,
        ring: T.musicRing,
        velocity: n.velocity * T.musicPhrase,
        priority: 3,
      });
    }
  }

  // ---- shared helpers -----------------------------------------------------

  private visible(routeId: string): boolean {
    const route = this.routeById.get(routeId);
    return !!route && routeVisible(route);
  }

  /**
   * Clicking into one route means *only* that route. Ducking the others to a
   * quarter still left the bay murmuring underneath, which is not what picking
   * a single line out of the legend is asking for.
   */
  private muted(routeId: string, spotlight: string | null): boolean {
    return spotlight !== null && spotlight !== routeId;
  }

  /**
   * Is this terminal on the paper right now? Hiding a class or an operator
   * takes its stations off the map, and a dock nobody can see answering a wave
   * is a ghost — so the music asks the same question the map does, through the
   * same predicate.
   */
  private stationLit(stationId: string): boolean {
    return stationVisible(this.stationRoutes.get(stationId));
  }

  /** A station belongs to no route, so it answers only for the ones it serves. */
  private serves(stationId: string, routeId: string): boolean {
    return this.routeById.get(routeId)?.terminals.includes(stationId) ?? false;
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
      const sv = stationVoice(['7201', 'alcatraz'][i]!);
      if (engine.play({
        preset: sv.preset,
        freq: degreeToFreq(sv, i * 2),
        when: 0.5 + i * 0.5,
        ring: T.musicRing,
        velocity: 0.4 * T.musicRippleStop,
      })) stations++;
    }
  }
  let lines = 0;
  if (T.musicRippleLine > 0) {
    for (let i = 0; i < 2; i++) {
      const lv = voices[i % voices.length]!;
      if (engine.play({
        preset: lv.preset,
        freq: degreeToFreq(lv, i),
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
