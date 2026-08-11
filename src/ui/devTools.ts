/**
 * The listening bench in the dev panel.
 *
 * Everything the music does was previously only checkable by loading a URL
 * with a `?kick` on it and reading the browser tab title, which is a fine way
 * for a headless test to work and a miserable way for a person to work. These
 * are the same checks with a button on them, and they report into the panel.
 *
 * The audition buttons matter most: a route's instrument is otherwise only
 * heard when the bay happens to sound it, which can be minutes, so there was
 * no way to answer "do these actually differ?" except by waiting.
 *
 * Every one of them holds the rest of the bay quiet while it runs. Auditioning
 * nine instruments over eight ferries, a drone and a foghorn answers the wrong
 * question — you cannot tell whether two voices differ if you cannot hear
 * either of them. The hold is released when the run ends, and music that was
 * off before a button was pressed goes back to being off.
 */
import type { ScheduleData } from '../lib/types';
import type { Music } from '../audio/music';
import { musicKick } from '../audio/music';
import { setTunable } from '../lib/tunables';

interface Ctx {
  music: Music;
  data: ScheduleData;
  /** Drop a ripple at the centre of the view, as a tap would. */
  tapBay: () => void;
}

/** Walk a list, sounding one every `gap` ms, reporting each as it plays. */
function walk(
  items: { id: string; label: string }[],
  gap: number,
  play: (id: string) => string,
  say: (text: string) => void,
  onDone: () => void,
) {
  let i = 0;
  const step = () => {
    if (i >= items.length) {
      say('done');
      onDone();
      return;
    }
    const item = items[i]!;
    say(`${i + 1}/${items.length}  ${item.label} — ${play(item.id)}`);
    i++;
    setTimeout(step, gap);
  };
  step();
}

export function buildDevTools(ctx: Ctx): HTMLElement {
  const wrap = document.createElement('div');
  const heading = document.createElement('h2');
  heading.textContent = 'listen';
  wrap.append(heading);

  const out = document.createElement('div');
  out.className = 'tool-out';
  out.textContent = 'nothing running';
  const say = (text: string) => {
    out.textContent = text;
  };

  const row = document.createElement('div');
  row.className = 'tool-row';
  let busy = false;
  /** Was the bay already playing before a button borrowed the speakers? */
  let wasPlaying = false;

  /** Take the speakers: start audio if needed, and hold the bay quiet. */
  const hold = () => {
    busy = true;
    wasPlaying = ctx.music.enabled;
    // the hold goes on first, so audio starting for this audition starts quiet
    ctx.music.bench(true);
    // the click is itself the gesture a browser wants before audio can start;
    // `enabled` — not the tunable — is what says whether it already has, since
    // the tunable can be on while the context is still suspended
    if (!wasPlaying) setTunable('musicOn', true);
  };

  /** Give them back, and leave the mix exactly as it was found. */
  const release = () => {
    // off first if it was off, so the drone is never started just to be stopped
    if (!wasPlaying) setTunable('musicOn', false);
    ctx.music.bench(false);
    busy = false;
  };

  const button = (label: string, title: string, run: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', () => {
      if (busy) return;
      run();
    });
    row.append(b);
    return b;
  };

  const sequence = (
    label: string,
    title: string,
    items: () => { id: string; label: string }[],
    kind: 'family' | 'route' | 'station',
    gap: number,
  ) =>
    button(label, title, () => {
      hold();
      // the last note still has to ring out, so the bay comes back after it
      walk(items(), gap, (id) => ctx.music.audition(kind, id), say, () =>
        setTimeout(release, gap),
      );
    });

  sequence(
    'instruments',
    'Play all nine synth families in turn, at the same pitch — the fastest way to hear whether they actually differ.',
    () => ctx.music.families.map((f) => ({ id: f, label: f })),
    'family',
    1400,
  );

  sequence(
    'routes',
    "Play every route's voice in turn, in the order the legend lists them.",
    () =>
      [...ctx.data.routes]
        .sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id))
        .map((r) => ({ id: r.id, label: r.short })),
    'route',
    1300,
  );

  sequence(
    'stations',
    'Play every terminal’s voice — each one is picked from what the place used to be.',
    () =>
      ctx.data.terminals
        .filter((t) => t.active && !t.parent)
        .map((t) => ({ id: t.id, label: t.short })),
    'station',
    1300,
  );

  button(
    'tap the bay',
    'Drop a ripple in the middle of the view and report what answers it as the wavefront spreads.',
    () => {
      // the wave's answers are the subject here, so the hold silences the
      // fleet bed and the room around them but not what the wavefront triggers
      hold();
      ctx.music.resetCounts();
      ctx.tapBay();
      say('wave going out…');
      const started = performance.now();
      const poll = setInterval(() => {
        const m = ctx.music;
        say(
          `hulls ${m.debugWaveNotes} · stations ${m.debugStationNotes} · ` +
            `routes ${m.debugLineNotes} · dropped ${m.debugDropped} · ` +
            `tallest wave under anything ${m.debugWavePeak.toFixed(3)}`,
        );
        if (performance.now() - started > 9000) {
          clearInterval(poll);
          release();
        }
      }, 500);
    },
  );

  button(
    'render check',
    'Render a fixed handful of notes offline and report the level — proves the mix works without needing a speaker.',
    () => {
      // offline: it renders into a buffer nobody hears, so it needs neither
      // the speakers nor the hold
      say('rendering…');
      void musicKick(ctx.data).then((r) => {
        say(
          `peak ${r.peak.toFixed(3)} · rms ${r.rms.toFixed(4)} · ` +
            `fleet ${r.bed} · tap ${r.bell} · hulls ${r.hull} · ` +
            `stations ${r.stations} · routes ${r.lines}`,
        );
      });
    },
  );

  wrap.append(row, out);
  return wrap;
}
