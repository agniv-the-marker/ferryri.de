import '@fontsource-variable/eb-garamond';
import '@fontsource-variable/jetbrains-mono';
import './style.css';

import { Camera } from './map/camera';
import { Renderer } from './map/renderer';
import { Overlay } from './map/overlay';
import { project } from './map/proj';
import { attachGestures } from './map/gestures';
import { now as simNow, localTime } from './lib/clock';
import { tripsForDay, type TimedTrip } from './sim/schedule';
import { vesselsAt } from './sim/vessels';
import { initDevPanel } from './ui/devPanel';
import { initAbout } from './ui/about';
import { initLegend } from './ui/legend';
import { Sheet } from './ui/sheet';
import { Chips } from './ui/chips';
import { terminalBoard, vesselCard, type BoardCtx, type BoardHandle } from './ui/board';
import type { ScheduleData, Terminal } from './lib/types';
import { T, applyDomTunables } from './lib/tunables';

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
  const [coast, topoMeta, schedule, topoImg] = await Promise.all([
    fetch(`${BASE}data/coast.json`).then((r) => r.json()),
    fetch(`${BASE}data/topo.json`).then((r) => r.json()),
    fetch(`${BASE}data/schedule.json`).then((r) => r.json()) as Promise<ScheduleData>,
    loadImage(`${BASE}data/topo.png`),
  ]);

  const glCanvas = document.getElementById('map-gl') as HTMLCanvasElement;
  const app = document.getElementById('app')!;

  // ---- camera fitted to the ferry system ----
  const active = schedule.terminals.filter((t) => t.active && !t.parent);
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

  // ---- simulation state (recomputed when the service day changes) ----
  const bootWall = simNow();
  const bootLt = localTime(bootWall);
  let timed: TimedTrip[] = tripsForDay(schedule, bootWall);
  let timedYmd = bootLt.ymd;
  let currentSec = bootLt.sec;
  let lastVesselList: ReturnType<typeof vesselsAt> = [];

  const terminalById = new Map(schedule.terminals.map((t) => [t.id, t]));
  const routeById = new Map(schedule.routes.map((r) => [r.id, r]));
  const boardCtx = (): BoardCtx => ({
    data: schedule,
    timed,
    nowSec: currentSec,
    terminalById,
    routeById,
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

  sheet.onClose = () => {
    overlay.selected = null;
    currentBoard = null;
    selectedVesselTrip = null;
    setStationName(null);
  };

  function openTerminal(t: Terminal) {
    selectedVesselTrip = null;
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
    overlay.draw(camera, lastVesselList);
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
      setStationName(routeById.get(v.routeId)?.name ?? 'Ferry');
    } else {
      // empty map: ripple on water, close whatever is open
      if (!renderer.isLand(x, y)) renderer.addRipple(x, y);
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
      overlay.draw(camera, lastVesselList);
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

  // dev: ?ripple drops a ripple at the viewport center every 1.8s (for tuning)
  if (new URLSearchParams(location.search).has('ripple')) {
    setInterval(() => {
      const { w, h } = camera.viewport;
      if (!renderer.isLand(w / 2, h / 2)) renderer.addRipple(w / 2, h / 2);
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

  initDevPanel();
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
