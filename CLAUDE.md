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
- `?music` / `?music=0` — force the generative score on or off (off by default;
  the footer's "music" button is the real control). `?musickick` renders a fixed
  handful of notes through an OfflineAudioContext and reports peak/RMS/note
  counts in the tab title; `?wavekick` taps the bay and hand-steps the ripple
  sim, reporting how many hulls answered the wavefront — both exist because a
  speaker feature is otherwise unassertable headlessly.
- `?tune=musicRippleGate:0.02,bobLift:8` — pin any tunable at boot, so a
  headless run can hold values the dev panel would otherwise have to be clicked.
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
- `src/audio/` — the bay as a generative score, off until the footer's "music"
  button is pressed (browsers require the gesture). No samples and no library:
  every voice is a sine whose identity is its envelope, rung out through a
  procedurally generated 6 s reverb into a bus compressor and limiter. Vessels
  underway sound on their own periods, a terminal tap plays its next departures
  as a phrase, and the ripple field triggers a hull as the wavefront reaches it
  (`renderer.rippleSampler()` — ripple only, since the swell would trip any
  threshold constantly). After Train Jazz and LA Metro: Ambient, credited in
  the about panel.
- `src/lib/tunables.ts` — every tweakable constant; the dev panel binds to it.
  When the user hands back exported JSON, update the defaults here.

## The music knobs (dev panel, `music` group)

| tunable | what it does |
| --- | --- |
| `music` | the switch — same one as the footer button |
| `master` | overall volume |
| `drone` | the low pedal held while music is on; 0 silences it |
| `beat cents` | how far a note's paired oscillators are detuned — the aulos wobble |
| `glide s` | how long a note slides into pitch. 0 = struck, high = siren |
| `note ring s` | how long a note sounds before it fades |
| `reverb wet` | how much of the room you hear |
| `fleet density` | how often each vessel underway sounds |
| `fleet level` / `phrase level` | loudness of the fleet bed / a terminal's departures |
| `ripple bell` | the note the tap itself makes |
| `ripple → hulls` / `→ stations` / `→ routes` | what answers the passing wavefront |
| `station reach m` | how far offshore a terminal listens — metres, because a dock sampled at the dock never hears anything |
| `wave arrival` | how high the water must rise to count as "the wave got here". Peak under a hull is ~0.13, so 0.02 fires most things and 0.20 fires nothing |
| `heel → pan` | how far a rolling boat pushes its note toward one ear |

Every route and every station has its **own instrument**, not just its own
pitch. `src/audio/voices.ts` holds nine families whose identity is a harmonic
spectrum (`createPeriodicWave`), an optional inharmonic partial — 2.76× is what
makes a bell sound like metal — a filter that closes as the note rings, and a
noise onset. `assignVoices` deals families × registers so no two routes collide,
and `STATION_VOICE` in `score.ts` assigns each terminal by hand from what the
place *was*: the Ferry Building is a bell for its clock tower, Mare Island is
struck metal for the shipyard, Angel Island is wood for the immigration
barracks. Clicking one route in the legend solos it outright.

Two things worth knowing before changing this code. The wave field is flat far
more than 99% of the time, so everything that reads it is gated behind a
listening window opened by `music.tapped()` — the per-frame sampling (and the
GPU readback feeding it) was the map's stutter. And terminals stand on the
shore, where the sim pins the field flat so waves reflect; a station listens on
a small ring offshore or it never hears anything.

## Verifying schedule accuracy

Compare against https://sanfranciscobayferry.com/routes-schedules/ — e.g.
Vallejo weekday departures from Gate E must match the published column.
