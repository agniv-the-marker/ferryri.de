/**
 * Route colour key, bottom right, and the key to the score with it: each row
 * names the instrument that route plays, since a colour tells you which line
 * you are looking at and nothing tells you which line you are *hearing*. Always on at desktop width, collapsed
 * behind a "routes" button on a phone. Selecting a route spotlights it on
 * the map and filters whatever board is open.
 *
 * Returns a setter so the same filter can be driven from elsewhere (the
 * all-departures dropdown) and the key stays in step.
 */
import type { ScheduleData } from '../lib/types';
import { onVisibilityChange, routeVisible } from '../lib/visibility';

export function initLegend(
  data: ScheduleData,
  onSelect: (routeId: string | null) => void,
  /** What this route sounds like, printed under its name. */
  instrumentOf?: (routeId: string) => string | null,
): (routeId: string | null) => void {
  const nav = document.getElementById('legend')!;
  const toggle = document.getElementById('legend-toggle')!;
  const list = document.getElementById('legend-list')!;
  const attribution = document.getElementById('attribution')!;
  const rows = new Map<string, HTMLElement>();
  const expanded = new Set<string>();
  const phone = window.matchMedia('(max-width: 719px)');
  let active: string | null = null;

  const paint = () => {
    for (const [id, li] of rows) {
      const lit = active !== null && id === active;
      li.style.color = lit ? 'var(--text)' : '';
      li.style.opacity = active === null || lit ? '' : '0.45';
    }
  };

  const rebuild = () => {
    rows.clear();
    list.replaceChildren();
    for (const operator of data.operators) {
      const routes = data.routes.filter((r) => r.operator === operator.id && routeVisible(r));
      if (!routes.length) continue;
      const addRoute = (r: (typeof routes)[number], collapsible: boolean) => {
        const li = document.createElement('li');
        li.className = `route-row${collapsible ? '' : ' singleton'}`;
        if (collapsible) li.dataset.operator = operator.id;
        li.textContent = phone.matches && r.operator === 'ggf'
          ? r.name.replace(/ - San Francisco Ferry$/, '')
          : r.name;
        li.style.cursor = 'pointer';
        const instrument = instrumentOf?.(r.id);
        if (instrument) {
          const voice = document.createElement('span');
          voice.className = 'voice';
          voice.textContent = instrument;
          li.append(voice);
        }
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = r.accent;
        li.append(swatch);
        li.addEventListener('click', () => onSelect(active === r.id ? null : r.id));
        rows.set(r.id, li);
        list.append(li);
        return li;
      };
      const heading = document.createElement('li');
      heading.className = 'operator-heading';
      const operatorToggle = document.createElement('button');
      operatorToggle.className = 'operator-toggle';
      const paintOperator = () => {
        const open = expanded.has(operator.id);
        operatorToggle.textContent = `${open ? '▾' : '▸'} ${operator.name}`;
        operatorToggle.setAttribute('aria-expanded', String(open));
        for (const row of list.querySelectorAll<HTMLElement>(`[data-operator="${operator.id}"]`)) {
          row.hidden = !open;
        }
      };
      operatorToggle.addEventListener('click', () => {
        if (expanded.has(operator.id)) expanded.delete(operator.id);
        else expanded.add(operator.id);
        paintOperator();
      });
      heading.append(operatorToggle);
      list.append(heading);
      for (const r of routes) {
        addRoute(r, true);
      }
      paintOperator();
    }
    if (active && !rows.has(active)) {
      active = null;
      onSelect(null);
    }
    paint();
  };
  rebuild();
  onVisibilityChange(rebuild);
  phone.addEventListener('change', rebuild);
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.textContent = open ? 'hide routes' : 'routes';
    toggle.setAttribute('aria-expanded', String(open));
  });
  toggle.setAttribute('aria-expanded', 'false');

  // Keep About above the phone legend using its real rendered height. This
  // remains correct with narrow screens, safe areas, and enlarged text.
  new ResizeObserver(() => {
    attribution.style.setProperty('--routes-height', `${nav.offsetHeight}px`);
  }).observe(nav);

  return (routeId) => {
    active = routeId;
    paint();
  };
}
