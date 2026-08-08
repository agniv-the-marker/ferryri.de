/**
 * Simulation clock. Follows wall time; a dev override (?t=2026-08-08T09:30)
 * shifts it by a fixed offset so weekend/late-night service can be tested.
 * All schedule math lives in America/Los_Angeles regardless of the viewer's
 * zone — a ferry map of the bay runs on bay time.
 */

const TZ = 'America/Los_Angeles';

let offsetMs = 0;
{
  const t = new URLSearchParams(location.search).get('t');
  if (t) {
    const parsed = Date.parse(t);
    if (Number.isFinite(parsed)) offsetMs = parsed - Date.now();
  }
}

export function now(): Date {
  return new Date(Date.now() + offsetMs);
}

const ymdFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }); // YYYY-MM-DD
const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hour12: false,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export interface LocalTime {
  /** YYYYMMDD in bay time */
  ymd: string;
  /** Monday = 0 … Sunday = 6 */
  dow: number;
  /** Seconds since local midnight */
  sec: number;
}

const DOW: Record<string, number> = {
  Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
};

export function localTime(d: Date): LocalTime {
  const ymd = ymdFmt.format(d).replaceAll('-', '');
  let dow = 0;
  let h = 0;
  let m = 0;
  let s = 0;
  for (const p of partsFmt.formatToParts(d)) {
    if (p.type === 'weekday') dow = DOW[p.value] ?? 0;
    else if (p.type === 'hour') h = Number(p.value) % 24;
    else if (p.type === 'minute') m = Number(p.value);
    else if (p.type === 'second') s = Number(p.value);
  }
  return { ymd, dow, sec: h * 3600 + m * 60 + s };
}

/** The local time exactly one day before (for >24h GTFS trips). */
export function previousServiceDay(d: Date): LocalTime {
  return localTime(new Date(d.getTime() - 86400_000));
}

/** Format seconds-since-midnight as "4:35 pm". */
export function fmtClock(sec: number): string {
  const h24 = Math.floor(sec / 3600) % 24;
  const m = Math.floor((sec % 3600) / 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'am' : 'pm'}`;
}
