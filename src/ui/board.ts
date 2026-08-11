/**
 * Sheet content builders: the split-flap terminal departure board and the
 * vessel card. Terminal boards are a single time-sorted list labeled by
 * destination — like the real board in the Ferry Building nave.
 */
import type { Operator, Route, ScheduleData, Terminal } from '../lib/types';
import type { TimedTrip } from '../sim/schedule';
import { departuresFrom, tripsForDay } from '../sim/schedule';
import type { VesselState } from '../sim/vessels';
import { fmtClock, now as simNow } from '../lib/clock';
import { FlapBoard } from './flap';
import { routeVisible } from '../lib/visibility';

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
  operatorById: Map<string, Operator>;
  /** Route spotlighted in the legend — boards filter to it when set. */
  filterRoute?: string | null;
}

function routesAt(ctx: BoardCtx, terminal: Terminal, respectFilter = true): Route[] {
  const station = terminal.parent ?? terminal.id;
  return ctx.data.routes.filter(
    (r) =>
      routeVisible(r) &&
      r.terminals.includes(station) &&
      (!respectFilter || !ctx.filterRoute || r.id === ctx.filterRoute),
  );
}

function externalLink(label: string, href: string, primary = false) {
  const a = el('a', `service-link${primary ? ' primary' : ''}`, `${label} ↗`) as HTMLAnchorElement;
  a.href = href;
  a.target = '_blank';
  a.rel = 'external noopener';
  return a;
}

function serviceCard(ctx: BoardCtx, route: Route): HTMLElement {
  const operator = ctx.operatorById.get(route.operator);
  const card = el('section', 'service-card');
  card.style.setProperty('--accent', route.accent);
  const head = el('div', 'service-head');
  head.append(el('span', 'service-operator', operator?.name ?? route.operator));
  if (route.status !== 'active') head.append(el('span', `service-status ${route.status}`, route.status));
  card.append(head);
  card.append(el('div', 'service-route', route.name));
  card.append(el('p', 'service-note', route.ticketing.note));
  const links = el('div', 'service-links');
  if (route.ticketing.purchaseUrl && route.ticketing.purchase !== 'none') {
    links.append(externalLink('buy tickets', route.ticketing.purchaseUrl, true));
  }
  if (route.ticketing.scheduleUrl && route.ticketing.scheduleUrl !== route.ticketing.purchaseUrl) {
    links.append(externalLink('schedule', route.ticketing.scheduleUrl));
  }
  if (route.ticketing.fareUrl) links.append(externalLink('fares & payment', route.ticketing.fareUrl));
  if (links.childElementCount) card.append(links);
  return card;
}

function renderServiceCards(ctx: BoardCtx, terminal: Terminal, wrap: HTMLElement) {
  const routes = routesAt(ctx, terminal);
  const seen = new Set<string>();
  wrap.replaceChildren();
  for (const route of routes) {
    const key = `${route.operator}:${route.ticketing.note}:${route.ticketing.purchaseUrl ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    wrap.append(serviceCard(ctx, route));
  }
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
  const actions = el('div', 'board-actions planner-actions');
  actions.append(backBtn);

  // route filter — the legend does this on desktop, but it's off-screen while
  // the all-departures list is open on a phone
  const routeSel = document.createElement('select');
  routeSel.className = 'route-select';
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
  const syncRouteSelect = () => {
    const eligible = routesAt(cur, terminal, false).filter((r) => r.scheduleMode !== 'external');
    routeSel.hidden = eligible.length <= 1;
    routeSel.replaceChildren();
    if (eligible.length <= 1) return;
    const anyOpt = document.createElement('option');
    anyOpt.value = '';
    anyOpt.textContent = 'all routes';
    routeSel.append(anyOpt);
    for (const route of eligible) {
      const option = document.createElement('option');
      option.value = route.id;
      option.textContent = route.name;
      routeSel.append(option);
    }
  };
  const render = (tabIdx: number) => {
    activeTab = tabIdx;
    syncRouteSelect();
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
    deps = deps.filter((d) => routeVisible(cur.routeById.get(d.routeId)!));
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
      const operator = route && cur.operatorById.get(route.operator);
      row.append(el('span', 'op', operator?.short ?? ''));
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
  /** What this place sounds like, and how to hear it again. */
  voice?: { name: string; play: () => void },
): BoardHandle {
  const root = el('div');
  const isGate = !!terminal.gate;
  const isFB = terminal.id === '7201' || terminal.parent === '7201';
  const title = isGate
    ? `Gate ${terminal.gate} · Ferry Building`
    : terminal.name.replace(/ (Ferry Terminal|Water Shuttle Dock|Ferry Dock)$/, '');
  root.append(el('h1', 'sheet-title', title));
  if (voice) {
    // Every terminal has an instrument picked from what the place was, and
    // until now the only way to learn which was to wait for a wave to reach
    // it. Naming it makes the score readable; pressing it plays the place.
    //
    // The label says "instrument", not "voice": "voice" is what this codebase
    // calls it, and a reader who has not read the codebase has no idea what a
    // terminal's voice would be. The ▸ is the same one "all departures ▸"
    // uses, so it reads as something to press.
    const line = el('button', 'sheet-voice');
    line.append(document.createTextNode('instrument · '));
    const name = el('span', 'swatch-note', voice.name);
    line.append(name);
    line.append(document.createTextNode(' ▸'));
    line.title = `Play ${title}`;
    line.setAttribute('aria-label', `Play ${title} — ${voice.name}`);
    line.addEventListener('click', voice.play);
    root.append(line);
  }
  const sub = el('div', 'sheet-sub');

  const initialRoutes = routesAt(ctx, terminal);
  const initialOperators = new Set(initialRoutes.map((r) => r.operator));
  // Only the Ferry Building has gates, and there the gate is the one thing you
  // actually need off this board — it is which end of the building to walk to.
  // The operator column is what a real board would not print at all, so where
  // there is a gate to show, the gate gets the room.
  const showGate = isFB && !isGate;
  const showOperatorColumn = initialOperators.size > 1 && !showGate;

  // destination | departs | gate (at the Ferry Building) or operator
  const columns = [
    { width: 13, align: 'left' as const },
    { width: 6, align: 'right' as const },
    ...(showOperatorColumn ? [{ width: 5, align: 'left' as const }] : []),
    ...(showGate ? [{ width: 1, align: 'right' as const }] : []),
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

  const services = el('div', 'service-cards');
  mainView.append(services);
  renderServiceCards(ctx, terminal, services);

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
      let deps = departuresFrom(c.timed, stopFamily(c, terminal), c.nowSec, 200)
        .filter((d) => routeVisible(c.routeById.get(d.routeId)!));
      if (c.filterRoute) deps = deps.filter((d) => d.routeId === c.filterRoute);
      deps = deps.slice(0, ROWS);
      const routeName = c.filterRoute ? c.routeById.get(c.filterRoute)?.name : null;
      const visibleRoutes = routesAt(c, terminal);
      const operators = new Set(visibleRoutes.map((r) => r.operator));
      const soleOperator = operators.size === 1 ? c.operatorById.get([...operators][0]!)?.short : null;
      sub.textContent = routeName
        ? `${routeName} · ${fmtClock(c.nowSec)}`
        : `${soleOperator ? `${soleOperator} · ` : ''}next departures · ${fmtClock(c.nowSec)}`;
      board.update(
        deps.map((d) => {
          const route = c.routeById.get(d.routeId);
          const gate = c.terminalById.get(d.stop)?.gate ?? '';
          const cols = [destLabel(c, d.destStop), flapTime(d.dep)];
          if (showOperatorColumn) cols.push(route ? c.operatorById.get(route.operator)?.short ?? '' : '');
          if (showGate) cols.push(gate);
          return { cols, accent: route?.accent };
        }),
      );
      note.textContent = deps.length
        ? `first departs ${countdown(deps[0]!.dep, c.nowSec)}`
        : visibleRoutes.some((r) => r.scheduleMode === 'external')
          ? 'see the official schedule below'
          : 'no more departures today';
      renderServiceCards(c, terminal, services);
    },
  };
  handle.refresh(ctx);
  return handle;
}

export function vesselCard(ctx: BoardCtx, v: VesselState): BoardHandle {
  const root = el('div');
  const route = ctx.routeById.get(v.routeId);
  const operator = route ? ctx.operatorById.get(route.operator) : undefined;
  root.append(el('div', 'operator-eyebrow', operator?.name ?? 'Ferry service'));
  root.append(el('h1', 'sheet-title', route?.name ?? 'Ferry'));
  const sub = el('div', 'sheet-sub');
  root.append(sub);
  const group = el('div', 'dep-group');
  group.style.setProperty('--accent', route?.accent ?? 'var(--text)');
  root.append(group);
  if (route) root.append(serviceCard(ctx, route));

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
