import '@fontsource-variable/eb-garamond';
import '@fontsource-variable/jetbrains-mono';
import './style.css';

import { Camera } from './map/camera';
import { Renderer } from './map/renderer';
import { Overlay } from './map/overlay';
import { project } from './map/proj';
import { attachGestures } from './map/gestures';
import { now as simNow, localTime } from './lib/clock';
import { departuresFrom, tripsForDay, type TimedTrip } from './sim/schedule';
import { vesselsAt } from './sim/vessels';
import { initDevPanel } from './ui/devPanel';
import { initAbout } from './ui/about';
import { initLegend } from './ui/legend';
import { Sheet } from './ui/sheet';
import { Chips } from './ui/chips';
import { stopFamily, terminalBoard, vesselCard, type BoardCtx, type BoardHandle } from './ui/board';
import type { ScheduleData, Terminal } from './lib/types';
import { SPECS, T, applyDomTunables, onTune, setTunable, type TunableKey } from './lib/tunables';
import { initVisibility, onVisibilityChange, routeVisible } from './lib/visibility';
import { Music, musicKick, type FrameState } from './audio/music';

const BASE = import.meta.env.BASE_URL;

// ---------- boot ----------

async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

async function boot() {
  applyDomTunables();
  // dev: ?tune=musicRippleSeq:0,bobLift:8 — pin any tunable at boot, so a
  // headless run can hold values the dev panel would otherwise have to be
  // clicked to reach.
  const tuneParam = new URLSearchParams(location.search).get('tune');
  if (tuneParam) {
    for (const pair of tuneParam.split(',')) {
      const [key, raw] = pair.split(':');
      if (!key || raw === undefined || !(key in SPECS)) continue;
      const spec = SPECS[key as TunableKey];
      setTunable(
        key as TunableKey,
        spec.kind === 'num' ? Number(raw) : spec.kind === 'bool' ? raw !== '0' : raw,
      );
    }
  }
  const [coast, topoMeta, schedule, topoImg] = await Promise.all([
    fetch(`${BASE}data/coast.json`).then((r) => r.json()),
    fetch(`${BASE}data/topo.json`).then((r) => r.json()),
    // Schema v2 adds operators/ticketing; query version avoids an incompatible
    // stale v1 response from an already-installed offline cache.
    fetch(`${BASE}data/schedule.json?v=2`).then((r) => r.json()) as Promise<ScheduleData>,
    loadImage(`${BASE}data/topo.png`),
  ]);

  const glCanvas = document.getElementById('map-gl') as HTMLCanvasElement;
  const app = document.getElementById('app')!;
  initVisibility(schedule);

  // ---- camera fitted to the ferry system ----
  const visibleStations = new Set(schedule.routes.filter(routeVisible).flatMap((r) => r.terminals));
  const active = schedule.terminals.filter((t) => t.active && !t.parent && visibleStations.has(t.id));
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const t of active) {
    const p = project(t.lng, t.lat);
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  const pad = 0.12;
  const bw = (x1 - x0) * (1 + pad * 2);
  const bh = (y1 - y0) * (1 + pad * 2);
  const fit = (w: number, h: number) =>
    Math.log2(Math.min(w / bw, h / bh) / 256);

  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const camera = new Camera({ x: cx, y: cy, z: 11 });

  const renderer = new Renderer(glCanvas, coast, topoImg, topoMeta);
  const overlayCanvas = document.getElementById('map-overlay') as HTMLCanvasElement;
  const overlay = new Overlay(overlayCanvas, schedule);

  function resize() {
    const w = app.clientWidth;
    const h = app.clientHeight;
    camera.setViewport(w, h);
    renderer.resize(w, h);
    overlay.resize(w, h);
    const f = fit(w, h);
    // The roam box is exactly the fitted whole-system view plus a whisper of
    // slack — you can never zoom or pan far enough to see the map's edge.
    const SLACK = 1.05;
    const ww = (w / (256 * 2 ** f)) * SLACK;
    const wh = (h / (256 * 2 ** f)) * SLACK;
    camera.bounds = {
      x0: cx - ww / 2, y0: cy - wh / 2,
      x1: cx + ww / 2, y1: cy + wh / 2,
    };
    camera.minZ = f - Math.log2(SLACK);
    if (firstFit) {
      camera.cur.z = camera.tgt.z = f;
      firstFit = false;
    }
  }
  let firstFit = true;
  resize();
  new ResizeObserver(resize).observe(app);

  // deep-linkable view: ?v=lng,lat,zoom
  const vParam = new URLSearchParams(location.search).get('v');
  if (vParam) {
    const [lng, lat, z] = vParam.split(',').map(Number);
    if (Number.isFinite(lng) && Number.isFinite(lat) && Number.isFinite(z)) {
      const p = project(lng!, lat!);
      camera.cur = { x: p.x, y: p.y, z: z! };
      camera.tgt = { ...camera.cur };
    }
  }

  // ---- render loop ----
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let last = performance.now();
  let waterTime = 0;
  // dev: freeze the water at a fixed time with ?wt=<seconds>
  const wtParam = Number(new URLSearchParams(location.search).get('wt'));
  const wtFrozen = Number.isFinite(wtParam) && wtParam > 0;
  if (wtFrozen) waterTime = wtParam;

  // ---- music: the bay as a score, off until asked for ----
  const music = new Music(schedule);
  const musicBtn = document.getElementById('music-link') as HTMLButtonElement;
  // The tunable is the switch; the button and the dev panel's checkbox are two
  // handles on it. Tunable listeners run synchronously, so audio still starts
  // inside the click's own call stack — which is the gesture browsers require.
  musicBtn.addEventListener('click', () => setTunable('musicOn', !music.enabled));
  onTune(() => {
    if (T.musicOn === music.enabled) return;
    musicBtn.setAttribute('aria-pressed', String(T.musicOn));
    void music.setEnabled(T.musicOn);
  });
  const musicParam = new URLSearchParams(location.search).get('music');
  // A choice left on last visit can't resume itself — browsers need a gesture,
  // so it arms here and starts on whatever the visitor touches first.
  const wantMusic = musicParam !== null ? musicParam !== '0' : Music.remembered();
  if (wantMusic) {
    setTunable('musicOn', true);
    musicBtn.setAttribute('aria-pressed', 'true');
    const arm = () => {
      removeEventListener('pointerdown', arm);
      if (T.musicOn) void music.setEnabled(true);
    };
    addEventListener('pointerdown', arm, { once: true });
  }

  // dev: ?bob turns on boat bobbing (off by default; also a dev-panel switch)
  const bobParam = new URLSearchParams(location.search).get('bob');
  if (bobParam !== null) setTunable('bobEnable', bobParam !== '0');

  const musicSnapshot: FrameState = {
    vessels: [],
    cam: camera,
    ripple: null,
    water: overlay.waterMotion,
    nowSec: 0,
    spotlight: null,
  };

  // ---- simulation state (recomputed when the service day changes) ----
  const bootWall = simNow();
  const bootLt = localTime(bootWall);
  let timed: TimedTrip[] = tripsForDay(schedule, bootWall);
  let timedYmd = bootLt.ymd;
  let currentSec = bootLt.sec;
  let lastVesselList: ReturnType<typeof vesselsAt> = [];

  const terminalById = new Map(schedule.terminals.map((t) => [t.id, t]));
  const routeById = new Map(schedule.routes.map((r) => [r.id, r]));
  const operatorById = new Map(schedule.operators.map((o) => [o.id, o]));
  const boardCtx = (): BoardCtx => ({
    data: schedule,
    timed,
    nowSec: currentSec,
    terminalById,
    routeById,
    operatorById,
    filterRoute: overlay.highlightRoute,
  });

  const sheet = new Sheet();
  const chips = new Chips(boardCtx);
  const stationName = document.getElementById('station-name')!;
  let currentBoard: BoardHandle | null = null;
  let selectedVesselTrip: string | null = null;
  let lastRefreshMin = -1;

  const setStationName = (name: string | null) => {
    stationName.hidden = !name;
    stationName.textContent = name ?? '';
  };

  // One route filter, two controls: the legend on the map and the dropdown
  // inside the all-departures list (the legend is off-screen on a phone).
  let syncLegend: (routeId: string | null) => void = () => {};
  const setRouteFilter = (routeId: string | null) => {
    overlay.highlightRoute = routeId;
    syncLegend(routeId);
    currentBoard?.refresh(boardCtx());
  };

  onVisibilityChange(() => {
    chips.invalidate();
    currentBoard?.refresh(boardCtx());
  });

  sheet.onClose = () => {
    overlay.selected = null;
    currentBoard = null;
    selectedVesselTrip = null;
    setStationName(null);
  };

  function openTerminal(t: Terminal) {
    selectedVesselTrip = null;
    // A route spotlight is useful within one terminal, but carrying it to a
    // different station can make the new board appear empty or stale when
    // that route does not serve the destination. Every station opens in its
    // complete, unfiltered state.
    if (overlay.highlightRoute) setRouteFilter(null);
    const p = project(t.lng, t.lat);
    const z = t.gate || t.id === '7201' ? 15.1 : 13.7;
    const desktop = matchMedia('(min-width: 720px)').matches;
    // phone: sit the terminal above the half sheet; desktop: left of the panel
    const dy = desktop ? 0 : (0.17 * camera.viewport.h) / (256 * 2 ** z);
    const dx = desktop ? (0.14 * camera.viewport.w) / (256 * 2 ** z) : 0;
    camera.flyTo({ x: p.x + dx, y: p.y + dy, z });
    currentBoard = terminalBoard(
      boardCtx(),
      t,
      () => sheet.expand(),
      setRouteFilter,
    );
    sheet.open(currentBoard.el, 'half');
    // the board and the phrase are the same information, read two ways
    const ctx = boardCtx();
    music.terminalPhrase(
      departuresFrom(timed, stopFamily(ctx, t), currentSec, 6),
      currentSec,
      schedule.routes.filter((r) => r.terminals.includes(t.id) && routeVisible(r)).map((r) => r.id),
    );
    setStationName(
      t.gate ? `Gate ${t.gate}` : t.name.replace(/ (Ferry Terminal|Water Shuttle Dock|Ferry Dock)$/, ''),
    );
  }

  function frame(now: number) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!reducedMotion.matches && !wtFrozen) waterTime += dt * T.waterDrift;
    camera.update(dt);
    renderer.draw(camera, waterTime, !reducedMotion.matches);

    const wall = simNow();
    const lt = localTime(wall);
    if (lt.ymd !== timedYmd) {
      timedYmd = lt.ymd;
      timed = tripsForDay(schedule, wall);
    }
    currentSec = lt.sec + wall.getMilliseconds() / 1000;
    lastVesselList = vesselsAt(schedule, timed, currentSec);
    // boats ride the water only when it is moving in the first place
    overlay.draw(
      camera,
      lastVesselList,
      reducedMotion.matches ? null : renderer.waterSampler(camera, waterTime),
    );
    // One snapshot object, refilled each frame rather than rebuilt: at 60 fps
    // the garbage from allocating here (and a sampler closure with it) is what
    // the map's stutter was made of. The sampler is only built while something
    // is still listening for a wave, which is almost never.
    musicSnapshot.vessels = lastVesselList;
    renderer.rippleWanted = music.listening;
    musicSnapshot.ripple = renderer.rippleWanted ? renderer.rippleSampler(camera) : null;
    musicSnapshot.water = overlay.waterMotion;
    musicSnapshot.nowSec = currentSec;
    musicSnapshot.spotlight = overlay.highlightRoute;
    music.frame(musicSnapshot);
    chips.update(camera);

    // minute tick: refresh open board / vessel card
    const minute = Math.floor(currentSec / 60);
    if (minute !== lastRefreshMin) {
      lastRefreshMin = minute;
      if (selectedVesselTrip) {
        const v = lastVesselList.find((x) => x.trip.id === selectedVesselTrip);
        if (v) {
          currentBoard = vesselCard(boardCtx(), v);
          sheet.setContent(currentBoard.el);
          overlay.selected = { type: 'vessel', vessel: v };
        } else sheet.close(); // journey over
      } else if (currentBoard) {
        currentBoard.refresh(boardCtx());
      }
    }

    raf = requestAnimationFrame(frame);
  }
  let raf = requestAnimationFrame(frame);

  document.addEventListener('visibilitychange', () => {
    void music.setAwake(!document.hidden);
    if (document.hidden) cancelAnimationFrame(raf);
    else {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  });

  attachGestures(overlayCanvas, camera, (x, y) => {
    const hit = overlay.pick(camera, x, y);
    overlay.selected = hit;
    if (hit?.type === 'terminal') {
      openTerminal(hit.terminal);
    } else if (hit?.type === 'vessel') {
      const v = hit.vessel;
      selectedVesselTrip = v.trip.id;
      camera.flyTo({
        x: v.pos.x,
        y: v.pos.y,
        z: Math.max(camera.cur.z, 12.4),
      });
      currentBoard = vesselCard(boardCtx(), v);
      sheet.open(currentBoard.el, 'half');
      music.vesselRun(v, currentSec);
      setStationName(routeById.get(v.routeId)?.name ?? 'Ferry');
    } else {
      // empty map: ripple on water, close whatever is open
      if (!renderer.isLand(x, y)) {
        renderer.addRipple(x, y);
        music.tapped();
      }
      sheet.close();
    }
  });

  // dev: ?ripplekick splats once and runs 150 sim steps synchronously —
  // lets headless screenshots capture wave propagation (rAF barely runs there)
  if (new URLSearchParams(location.search).has('ripplekick')) {
    setTimeout(() => {
      const { w, h } = camera.viewport;
      renderer.addRipple(w / 2, h / 2);
      for (let i = 0; i < 150; i++) renderer.draw(camera, waterTime, true);
      // a fence never signals inside a synchronous loop — take the field the
      // blocking way so bobbing shows up in the screenshot too
      renderer.probeNow();
      overlay.draw(camera, lastVesselList, renderer.waterSampler(camera, waterTime));
    }, 300);
  }

  // dev: ?zoomkick splats once, settles, then zooms hard while stepping the
  // sim — reports peak wave height at each stage in the tab title so a test
  // can assert zooming damps the ripple instead of pumping it.
  if (new URLSearchParams(location.search).has('zoomkick')) {
    setTimeout(() => {
      const { w, h } = camera.viewport;
      renderer.addRipple(w / 2, h / 2);
      for (let i = 0; i < 40; i++) renderer.draw(camera, waterTime, true);
      const settled = renderer.debugWavePeak();
      for (let i = 0; i < 60; i++) {
        camera.cur.z += i < 30 ? 0.04 : -0.04; // zoom in, then back out
        renderer.draw(camera, waterTime, true);
      }
      const zoomed = renderer.debugWavePeak();
      for (let i = 0; i < 60; i++) renderer.draw(camera, waterTime, true);
      const after = renderer.debugWavePeak();
      document.title = `settled=${settled.toFixed(3)} zoomed=${zoomed.toFixed(3)} after=${after.toFixed(3)}`;
    }, 400);
  }

  // dev: ?musickick renders a fixed handful of notes offline and reports what
  // came out in the tab title — a speaker-free way to assert the mix works
  if (new URLSearchParams(location.search).has('musickick')) {
    void musicKick(schedule).then((r) => {
      document.title =
        `peak=${r.peak.toFixed(3)} rms=${r.rms.toFixed(4)} ` +
        `bed=${r.bed} bell=${r.bell} hull=${r.hull} ` +
        `stations=${r.stations} routes=${r.lines}`;
    });
  }

  // dev: ?wavekick taps the middle of the bay and steps the ripple sim by hand,
  // feeding each step to the music the way a frame would. The sim advances once
  // per draw, so on a slow headless GPU a wavefront never travels far enough to
  // reach a boat in real time — this makes the coupling assertable anyway.
  if (new URLSearchParams(location.search).has('wavekick')) {
    void (async () => {
      setTunable('musicOn', true);
      await music.setEnabled(true);
      const { w, h } = camera.viewport;
      renderer.addRipple(w / 2, h / 2);
      music.tapped();
      for (let i = 0; i < 240; i++) {
        renderer.draw(camera, waterTime, true);
        renderer.probeNow();
        musicSnapshot.vessels = lastVesselList;
        musicSnapshot.ripple = renderer.rippleSampler(camera);
        musicSnapshot.water = overlay.waterMotion;
        musicSnapshot.nowSec = currentSec;
        musicSnapshot.spotlight = overlay.highlightRoute;
        music.frame(musicSnapshot);
      }
      document.title =
        `hulls=${music.debugWaveNotes} stations=${music.debugStationNotes} ` +
        `routes=${music.debugLineNotes} peak=${music.debugWavePeak.toFixed(3)} ` +
        `boats=${lastVesselList.length}`;
    })();
  }

  // dev: ?ripple drops a ripple at the viewport center every 1.8s (for tuning)
  if (new URLSearchParams(location.search).has('ripple')) {
    setInterval(() => {
      const { w, h } = camera.viewport;
      if (!renderer.isLand(w / 2, h / 2)) {
        renderer.addRipple(w / 2, h / 2);
        music.tapped(); // so ?ripple exercises the music path too
      }
    }, 1800);
  }

  // dev/deep-link: open a terminal board on load with ?sel=<stopId>
  const selParam = new URLSearchParams(location.search).get('sel');
  if (selParam) {
    const t = terminalById.get(selParam);
    if (t) {
      overlay.selected = { type: 'terminal', terminal: t };
      openTerminal(t);
    }
  }

  initDevPanel(schedule);
  initAbout();
  // the legend and the planner's dropdown are two faces of one filter
  syncLegend = initLegend(schedule, setRouteFilter);
}

// offline: everything is static + simulated, so the whole site works mid-bay
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register(`${BASE}sw.js`).catch(() => {});
  });
}

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<pre style="position:fixed;inset:auto 0 0 0;background:#fee;padding:1rem;z-index:99">${e}</pre>`,
  );
});
