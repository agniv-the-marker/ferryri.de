/**
 * Sheet content builders: the split-flap terminal departure board and the
 * vessel card. Terminal boards are a single time-sorted list labeled by
 * destination — like the real board in the Ferry Building nave.
 */
import type { Route, ScheduleData, Terminal } from '../lib/types';
import type { TimedTrip } from '../sim/schedule';
import { departuresFrom, tripsForDay } from '../sim/schedule';
import type { VesselState } from '../sim/vessels';
import { fmtClock, now as simNow } from '../lib/clock';
import { FlapBoard } from './flap';

const el = (tag: string, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function countdown(depSec: number, nowSec: number): string {
  const d = Math.round((depSec - nowSec) / 60);
  if (d <= 0) return 'now';
  if (d < 60) return `in ${d} min`;
  const h = Math.floor(d / 60);
  return `in ${h}h ${String(d % 60).padStart(2, '0')}m`;
}

/** "5:30P" — compact board time */
const flapTime = (sec: number) =>
  fmtClock(sec).replace(' ', '').replace('m', '').toUpperCase();

export interface BoardCtx {
  data: ScheduleData;
  timed: TimedTrip[];
  nowSec: number;
  terminalById: Map<string, Terminal>;
  routeById: Map<string, Route>;
  /** Route spotlighted in the legend — boards filter to it when set. */
  filterRoute?: string | null;
}

/** Stop ids covered by a tap on this terminal (a station includes its gates). */
export function stopFamily(ctx: BoardCtx, t: Terminal): Set<string> {
  const ids = new Set([t.id]);
  if (!t.parent) {
    for (const c of ctx.data.terminals) if (c.parent === t.id) ids.add(c.id);
  }
  return ids;
}

const destLabel = (ctx: BoardCtx, stopId: string) => {
  const t = ctx.terminalById.get(stopId);
  if (!t) return '?';
  const station = t.parent ? ctx.terminalById.get(t.parent) ?? t : t;
  // the real boards say SAN FRANCISCO, so do we
  return station.id === '7201' ? 'San Francisco' : station.short;
};

export interface BoardHandle {
  el: HTMLElement;
  /** Re-render with fresh time/data (flap cells animate the changes). */
  refresh(ctx: BoardCtx): void;
}

const ROWS = 7;

/**
 * Planner tabs: label + how to find a matching date from today. Whichever one
 * covers today is selected on open, so there's no redundant "today" tab.
 */
const DAY_TABS: { label: string; match: (dow: number) => boolean }[] = [
  { label: 'weekday', match: (d) => d <= 4 },
  { label: 'weekend', match: (d) => d >= 5 },
];

/**
 * Full-day departure list for planning, with weekday/weekend tabs.
 * Returns a re-render hook so the legend's route filter reaches it too.
 */
function plannerView(
  ctx: BoardCtx,
  terminal: Terminal,
  back: () => void,
  onFilterRoute?: (routeId: string | null) => void,
): { el: HTMLElement; refresh(c: BoardCtx): void } {
  const root = el('div');
  const backBtn = el('button', undefined, '◂ next departures');
  const actions = el('div', 'board-actions');
  actions.append(backBtn);

  // route filter — the legend does this on desktop, but it's off-screen while
  // the all-departures list is open on a phone
  const routeSel = document.createElement('select');
  routeSel.className = 'route-select';
  const anyOpt = document.createElement('option');
  anyOpt.value = '';
  anyOpt.textContent = 'all routes';
  routeSel.append(anyOpt);
  for (const r of ctx.data.routes) {
    const o = document.createElement('option');
    o.value = r.id;
    o.textContent = r.name;
    routeSel.append(o);
  }
  routeSel.addEventListener('change', () =>
    onFilterRoute?.(routeSel.value || null),
  );
  actions.append(routeSel);
  root.append(actions);
  backBtn.addEventListener('click', back);

  const tabs = el('div', 'day-tabs');
  root.append(tabs);
  const listWrap = el('div');
  root.append(listWrap);

  let activeTab = 0;
  let cur = ctx; // latest context, so filter/time changes re-render in place
  const render = (tabIdx: number) => {
    activeTab = tabIdx;
    routeSel.value = cur.filterRoute ?? '';
    [...tabs.children].forEach((b, i) =>
      (b as HTMLElement).classList.toggle('active', i === tabIdx),
    );
    const tab = DAY_TABS[tabIdx]!;
    // the soonest date matching this tab — today itself when it qualifies
    let date = simNow();
    let timed: TimedTrip[] = cur.timed;
    for (let k = 0; k < 7; k++) {
      const d = new Date(simNow().getTime() + k * 86400_000);
      if (tab.match((d.getDay() + 6) % 7)) {
        date = d;
        if (k > 0) timed = tripsForDay(cur.data, d);
        break;
      }
    }
    let deps = departuresFrom(timed, stopFamily(cur, terminal), 0, 500);
    if (cur.filterRoute) deps = deps.filter((d) => d.routeId === cur.filterRoute);
    const routeName = cur.filterRoute ? cur.routeById.get(cur.filterRoute)?.name : null;
    listWrap.replaceChildren();
    listWrap.append(
      el(
        'div',
        'sheet-sub',
        `${routeName ?? 'all departures'} · ${date.toLocaleDateString('en-US', {
          timeZone: 'America/Los_Angeles',
          weekday: 'long',
          month: 'short',
          day: 'numeric',
        })}`,
      ),
    );
    if (deps.length === 0) {
      listWrap.append(el('p', 'muted-note', 'no service on this day'));
      return;
    }
    for (const d of deps) {
      const route = cur.routeById.get(d.routeId);
      const row = el('div', 'plan-row');
      row.style.borderLeftColor = route?.accent ?? 'transparent';
      row.append(el('span', 't', fmtClock(d.dep)));
      const to = el('span', 'to');
      to.append(el('span', 'arrow', '→ '), destLabel(cur, d.destStop).toUpperCase());
      // some sailings call at another terminal on the way
      if (d.via.length) {
        const via = el('span', 'via');
        via.textContent = ` via ${d.via.map((v) => destLabel(cur, v)).join(', ')}`;
        to.append(via);
      }
      row.append(to);
      const gate = cur.terminalById.get(d.stop)?.gate;
      const g = el('span', 'g');
      if (gate) g.append(el('span', 'g-word', 'GATE '), gate);
      row.append(g);
      listWrap.append(row);
    }
  };

  DAY_TABS.forEach((t, i) => {
    const b = el('button', undefined, t.label);
    b.addEventListener('click', () => render(i));
    tabs.append(b);
  });
  const todayDow = (simNow().getDay() + 6) % 7;
  render(Math.max(0, DAY_TABS.findIndex((t) => t.match(todayDow))));
  return {
    el: root,
    refresh(c: BoardCtx) {
      cur = c;
      render(activeTab);
    },
  };
}

export function terminalBoard(
  ctx: BoardCtx,
  terminal: Terminal,
  onExpand?: () => void,
  onFilterRoute?: (routeId: string | null) => void,
): BoardHandle {
  const root = el('div');
  const isGate = !!terminal.gate;
  const isFB = terminal.id === '7201' || terminal.parent === '7201';
  const title = isGate
    ? `Gate ${terminal.gate} · Ferry Building`
    : terminal.name.replace(/ (Ferry Terminal|Water Shuttle Dock|Ferry Dock)$/, '');
  root.append(el('h1', 'sheet-title', title));
  const sub = el('div', 'sheet-sub');

  // destination | departs | (gate at the Ferry Building)
  const columns = isFB && !isGate
    ? [
        { width: 13, align: 'left' as const },
        { width: 6, align: 'right' as const },
        { width: 1, align: 'right' as const },
      ]
    : [
        { width: 13, align: 'left' as const },
        { width: 6, align: 'right' as const },
      ];
  // two swappable views: the flap board, and the full-day planner
  const mainView = el('div');
  root.append(mainView);
  mainView.append(sub);

  const board = new FlapBoard(columns, ROWS);
  mainView.append(board.el);

  const note = el('p', 'muted-note');
  mainView.append(note);

  const actions = el('div', 'board-actions');
  const allBtn = el('button', undefined, 'all departures ▸');
  actions.append(allBtn);
  mainView.append(actions);

  let latestCtx = ctx;
  // non-null while the all-departures list is showing instead of the board
  let planner: { el: HTMLElement; refresh(c: BoardCtx): void } | null = null;
  allBtn.addEventListener('click', () => {
    onExpand?.();
    // The phone-only selector should always open in its neutral state rather
    // than carrying a route choice over from the previous planner visit.
    if (matchMedia('(max-width: 719px)').matches) onFilterRoute?.(null);
    const p = plannerView(
      latestCtx,
      terminal,
      () => {
        p.el.replaceWith(mainView);
        planner = null;
      },
      onFilterRoute,
    );
    planner = p;
    mainView.replaceWith(p.el);
  });

  const handle: BoardHandle = {
    el: root,
    refresh(c: BoardCtx) {
      latestCtx = c;
      // the planner owns the view while open — refresh it instead
      if (planner) {
        planner.refresh(c);
        return;
      }
      let deps = departuresFrom(c.timed, stopFamily(c, terminal), c.nowSec, 200);
      if (c.filterRoute) deps = deps.filter((d) => d.routeId === c.filterRoute);
      deps = deps.slice(0, ROWS);
      const routeName = c.filterRoute ? c.routeById.get(c.filterRoute)?.name : null;
      sub.textContent = routeName
        ? `${routeName} · ${fmtClock(c.nowSec)}`
        : `next departures · ${fmtClock(c.nowSec)}`;
      board.update(
        deps.map((d) => {
          const route = c.routeById.get(d.routeId);
          const gate = c.terminalById.get(d.stop)?.gate ?? '';
          const cols = [destLabel(c, d.destStop), flapTime(d.dep)];
          if (isFB && !isGate) cols.push(gate);
          return { cols, accent: route?.accent };
        }),
      );
      note.textContent = deps.length
        ? `first departs ${countdown(deps[0]!.dep, c.nowSec)}`
        : 'no more departures today';
    },
  };
  handle.refresh(ctx);
  return handle;
}

export function vesselCard(ctx: BoardCtx, v: VesselState): BoardHandle {
  const root = el('div');
  const route = ctx.routeById.get(v.routeId);
  root.append(el('h1', 'sheet-title', route?.name ?? 'Ferry'));
  const sub = el('div', 'sheet-sub');
  root.append(sub);
  const group = el('div', 'dep-group');
  group.style.setProperty('--accent', route?.accent ?? 'var(--text)');
  root.append(group);

  const handle: BoardHandle = {
    el: root,
    refresh(c: BoardCtx) {
      const from = destLabel(c, v.fromStop);
      const to = destLabel(c, v.toStop);
      sub.textContent = `${from} → ${to}`;
      group.replaceChildren();

      const rows: [string, string][] = v.docked
        ? [
            ['departs', `${fmtClock(v.dep)} · ${countdown(v.dep, c.nowSec)}`],
            [`arrives ${to.toLowerCase()}`, fmtClock(v.arr)],
          ]
        : [
            [`departed ${from.toLowerCase()}`, fmtClock(v.dep)],
            [
              `arrives ${to.toLowerCase()}`,
              `${fmtClock(v.arr)} · ${countdown(v.arr, c.nowSec)}`,
            ],
          ];

      const stops = v.trip.stops;
      const legEnd = stops.findIndex((s) => s.stop === v.toStop);
      for (let i = legEnd + 1; i > 0 && i < stops.length; i++) {
        const s = stops[i]!;
        rows.push([`then ${destLabel(c, s.stop).toLowerCase()}`, fmtClock(s.arr)]);
      }
      const gateT = c.terminalById.get(v.toStop);
      if (gateT?.gate) rows.push(['docks at', `gate ${gateT.gate}`]);

      for (const [label, val] of rows) {
        const row = el('div', 'dep-row');
        row.append(el('span', 'to', label.toUpperCase()));
        row.append(el('span', 't', val));
        group.append(row);
      }
    },
  };
  handle.refresh(ctx);
  return handle;
}
