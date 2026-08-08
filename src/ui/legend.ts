/**
 * Route colour key, bottom right. Always on at desktop width, collapsed
 * behind a "routes" button on a phone. Selecting a route spotlights it on
 * the map and filters whatever board is open.
 *
 * Returns a setter so the same filter can be driven from elsewhere (the
 * all-departures dropdown) and the key stays in step.
 */
import type { ScheduleData } from '../lib/types';

export function initLegend(
  data: ScheduleData,
  onSelect: (routeId: string | null) => void,
): (routeId: string | null) => void {
  const nav = document.getElementById('legend')!;
  const toggle = document.getElementById('legend-toggle')!;
  const list = document.getElementById('legend-list')!;
  const attribution = document.getElementById('attribution')!;
  const rows = new Map<string, HTMLElement>();
  let active: string | null = null;

  const paint = () => {
    for (const [id, li] of rows) {
      const lit = active !== null && id === active;
      li.style.color = lit ? 'var(--text)' : '';
      li.style.opacity = active === null || lit ? '' : '0.45';
    }
  };

  for (const r of data.routes) {
    const li = document.createElement('li');
    li.textContent = r.name;
    li.style.cursor = 'pointer';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = r.accent;
    li.append(swatch);
    li.addEventListener('click', () => onSelect(active === r.id ? null : r.id));
    rows.set(r.id, li);
    list.append(li);
  }
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
