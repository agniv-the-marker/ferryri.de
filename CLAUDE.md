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
- `npm run voices` — one-time fetch of `public/audio/bank/` (sampled voices,
  FluidR3_GM via MIDI.js soundfonts, CC-BY 3.0). Outputs are committed.
- `npm run geo` — one-time rebuild of `public/data/coast.json` (MTC/TIGER
  shoreline) and `topo.png` (terrarium hillshade). Outputs are committed.

## Dev URL params

- `?dev` — live tuning panel (also: About → "dev"). Values export via "copy".
- `?t=2026-08-08T09:00` — shift the simulation clock (test weekends/nights)
- `?v=<lng>,<lat>,<zoom>` — initial camera view
- `?sel=<stopId>` — open a terminal board on load (Ferry Building = 7201)
- `?wt=<sec>` — freeze water animation at a fixed time
- `?ripple` / `?ripplekick` — automatic ripples for tuning / headless testing
- `?music` / `?music=0` — force the generative score on or off. It is **off by
  default** and the footer's "music" button is the real control; a visitor who
  turned it on last time has it *armed*, and since no browser will autoplay it
  then starts on whatever they touch first. Note that `T.musicOn` means
  *wanted* and `music.enabled` means *sounding* — only the second is safe to
  toggle against, or clicking "music" first thing reads as "turn it off".
  `?musickick` renders a fixed
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
- `src/audio/` — the bay as a generative score, off until asked for and then
  started by a gesture (browsers require one). No library: voices are recorded
  instruments by default (`bank.ts`, 0.7 MB fetched only once music actually
  starts) over a synthesised fallback whose identity is a harmonic spectrum and
  an envelope, rung out through a procedurally generated reverb into a bus
  compressor and limiter. Vessels
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
| `terminal level` | terminals sounding on their own, about a quarter as often as a boat |
| `ripple bell` | the note the tap itself makes |
| `ripple → hulls` / `→ stations` / `→ routes` | what answers the passing wavefront |
| `station reach m` | how far offshore a terminal listens — metres, because a dock sampled at the dock never hears anything |
| `wave arrival` | how high the water must rise to count as "the wave got here". Peak under a hull is ~0.13, so 0.02 fires most things and 0.20 fires nothing |
| `heel → pan` | how far a rolling boat pushes its note toward one ear |
| `harbor` / `foghorn` | the room: wash, an idling engine, a bell buoy, and the horn |
| `wash` | just the fuzzy part of the room, trimmed under `harbor` — the first thing to turn down if the bay sounds like hiss |
| `sampled voices` | recorded instruments rather than synthesised ones — on by default; off is the pure-synth palette (`?voices=sf` forces on) |
| `music` is off by default | nothing sounds until the footer button is pressed; a remembered "on" only *arms* it for the next gesture |
| `focus lift ×` / `others duck ×` | tapping a ferry brings it forward and pushes the rest back; the bus is made up so the mix keeps its level |

**The key names the instruments.** A colour tells you which line you are
looking at and nothing tells you which line you are *hearing*, so each legend
row carries its route's instrument (`voiceNames()` in `score.ts`, from the same
`assignVoices` the music uses) and each terminal board carries its own, labelled
**instrument** rather than *voice* — "voice" is this codebase's word for it and
means nothing to a visitor. Pressing that line plays the place, and starts the
music if it was off. The
register is only printed when a family is dealt to more than one route, because
"flute, mid" tells a reader nothing when there is only one flute.

Clicking a route in the legend **auditions it** — solos it and plays its
instrument — because otherwise the only way to learn a route's voice is to wait
for it to come round in the bed. Tapping a terminal announces the place in its
own instrument before its departures play.

Every route and every station has its **own instrument**, not just its own
pitch. `src/audio/voices.ts` holds nine families whose identity is a harmonic
spectrum (`createPeriodicWave`), an optional inharmonic partial — 2.76× is what
makes a bell sound like metal — a filter that closes as the note rings, and a
noise onset — with cutoffs measured in *harmonics of the note*, not hertz, so a
voice keeps its colour in every register. Struck families never glide: a pitch
sliding into place is louder than any spectrum behind it, and when every voice
did it, sixteen of nineteen routes measured identical through their whole
attack. Keep the reverb short for the same reason — at four seconds the room
took longer to build than most attacks last, and what you heard peak was the
room. `assignVoices` deals families × registers so no two routes collide,
and `STATION_VOICE` in `score.ts` assigns each terminal by hand from what the
place *was*: the Ferry Building is a bell for its clock tower, Mare Island is
struck metal for the shipyard, Angel Island is wood for the immigration
barracks. Clicking one route in the legend solos it outright.

`harbor.ts` is the room tone — wash, engine hum, bell buoy, foghorn — and it is
**synthesised, not recorded**: nobody could hold a microphone off a pier, and
shipping downloaded audio nobody has listened to would be worse than shipping
none. `bank.ts` is the alternate palette, one recorded instrument per family at
four pitches with `playbackRate` between, sharing the score, the envelopes, the
voice pool and the bus — so the only thing that changes is where the sound
comes from. It is fetched only once music actually starts, never at page load.

Two things about those recordings, both measured rather than assumed. They are
a fixed 3.13 s, and **sixteen of the thirty-six are cut off while still
sounding** — the sustaining families (clarinet, flute, cello, choir) end at
4–10% of peak, and a source that stops mid-waveform is a step, which is a
click, on every note. `bank.ts` therefore fades each note out before its buffer
can run out. And they peak around 0.11 where a synthesised voice peaks at 1, so
`TRIM` makes the two palettes the same loudness; without it, switching to
recordings also turned the music down 23 dB and left the room sounding louder
than the instruments (measured: the harbor sat 1.3 dB *above* the fleet, and
sits 21.6 dB below it now).

**Terminals sound on their own too**, on the same randomised clock as the
boats but about a quarter as often — a place is not a vehicle — under
`terminal level`, and gated by exactly what the wave path is gated by:
`stationLit()`, the spotlight, and whether the dock is on screen. A terminal
**rings on the map** when it sounds, a circle leaving the dock rather than a
brighter dot, since a station's ink is the coastline's ink and brightening it
reads as a smudge.

A vessel **brightens on the map while its note sounds** — `music.flash(tripId)`
decays over ~0.9 s and `overlay.draw()` takes it as a fourth argument, lifting
the hull's size, stroke and colour a little. It is what makes the fleet bed
legible as the fleet rather than as weather; keep it subtle, since every boat
underway sounds regularly and a hard flash would read as blinking.

Two things worth knowing before changing this code. The wave field is flat far
more than 99% of the time, so everything that reads it is gated behind a
listening window opened by `music.tapped()` — the per-frame sampling (and the
GPU readback feeding it) was the map's stutter. And terminals stand on the
shore, where the sim pins the field flat so waves reflect; a station listens on
a small ring offshore or it never hears anything.

**Nothing sounds that isn't on the paper.** Hiding a class or an operator takes
routes, their vessels and their terminals off the map, and anything still
answering a wave from under there is a ghost — five terminals (Alcatraz, the
Piers, Redwood City) are drawn by nothing under the default filters alone.
`stationRoutes()`/`stationVisible()` in `src/lib/visibility.ts` are the single
predicate the map and the music both ask, so the two cannot drift.

## The listening bench (dev panel, `listen` group)

`src/ui/devTools.ts`. The same checks the headless `?kick` params run, with
buttons on them, reporting into the panel instead of the tab title:

| button | what it does |
| --- | --- |
| `instruments` | plays all nine synth families in turn at one pitch — the fastest way to hear whether they differ |
| `routes` | plays every route's voice, in legend order |
| `stations` | plays every terminal's voice |
| `tap the bay` | drops a ripple at the view centre and counts what answers as the wavefront spreads |
| `render check` | renders a fixed handful of notes offline and reports the level, no speaker needed |

The audition buttons exist because a route's instrument is otherwise only heard
when the bay happens to sound it, which can be minutes — there was no way to
answer "do these actually differ?" except by waiting.

Each button **holds the rest of the bay quiet while it runs** (`music.bench()`
— fleet bed, drone and harbor), because an audition heard over eight ferries
and a foghorn answers the wrong question. The hold is released when the run
ends, and music that was off before the button was pressed goes back to being
off, so the bench never leaves the mix somewhere the user did not put it. Only
"tap the bay" leaves the wave pass running, since what answers *is* its
subject; "render check" is offline and needs neither.

## Verifying schedule accuracy

Compare against https://sanfranciscobayferry.com/routes-schedules/ — e.g.
Vallejo weekday departures from Gate E must match the published column.
