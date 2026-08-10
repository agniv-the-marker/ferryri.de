# ferryri.de — sf ferry rides

Live map of scheduled Bay Area ferry services. Vessels are **simulated from
official SF Bay Ferry and Golden Gate Ferry GTFS timetables, plus locally
curated Treasure Island and Angel Island–Tiburon published schedules**;
operators without machine-readable timetables appear with official links.
Paper-and-ink
aesthetic after sunday.bike (user's source: `~/Documents/sundaybike`).

## Commands

- `npm run dev` — Vite dev server
- `npm run build` — typecheck + production build to `dist/`
- `npm run data` — refresh `public/data/schedule.json` from the official SF Bay
  Ferry and Golden Gate feeds and merge locally curated published schedules
  and the external-service catalog.
- `npm run geo` — one-time rebuild of `public/data/coast.json` (MTC/TIGER
  shoreline) and `topo.png` (terrarium hillshade). Outputs are committed.

## Dev URL params

- `?dev` — live tuning panel (also: About → "dev"). Values export via "copy".
- `?t=2026-08-08T09:00` — shift the simulation clock (test weekends/nights)
- `?v=<lng>,<lat>,<zoom>` — initial camera view
- `?sel=<stopId>` — open a terminal board on load (Ferry Building = 7201)
- `?wt=<sec>` — freeze water animation at a fixed time
- `?ripple` / `?ripplekick` — automatic ripples for tuning / headless testing
- `?bob=0` — stop boats riding the water (on by default). Same switch as the
  dev panel's "bob" group; the rest of that group tunes it. "hull length m" is
  the load-bearing one — it sets both which waves a boat answers and the
  baseline its heel is measured over.

## Architecture

- `scripts/build-data.ts` — multi-feed GTFS + external-service catalog → compact
  schedule.json. Ferry Building is
  parent stop `7201`; gates are child stops (72011=E, 72012=G, 72013=F) so
  departures know their gate natively.
- `src/map/renderer.ts` — WebGL2: Bayer-dithered water w/ zoom-settled fractal
  noise, hillshade land, coastline from the rasterized land-mask texture, and
  a wave-equation ripple sim (land = reflective boundary). `waterSampler()`
  reads that field back (async PBO + fence, only while boat bob is on) and adds
  the analytic swell, so the overlay can float hulls on the water it draws.
- `src/map/camera.ts` — damped camera; input only moves the *target*.
- `src/sim/` — pure schedule math: active services, vessel interpolation
  along GTFS shapes via `shape_dist_traveled`.
- `src/ui/` — split-flap boards (flap.ts), bottom sheet / desktop right panel,
  on-map departure chips, legend (click = spotlight route), dev panel.
- `src/lib/tunables.ts` — every tweakable constant; the dev panel binds to it.
  When the user hands back exported JSON, update the defaults here.

## Verifying schedule accuracy

Compare against https://sanfranciscobayferry.com/routes-schedules/ — e.g.
Vallejo weekday departures from Gate E must match the published column.
