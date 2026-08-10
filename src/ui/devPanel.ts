/**
 * Live tuning panel. Open with ?dev in the URL or by triple-tapping the
 * wordmark. Sliders/color wells bind straight to the tunables registry;
 * "copy" puts the current values on the clipboard as JSON for hand-off.
 */
import { SPECS, T, setTunable, exportTunables, type TunableKey } from '../lib/tunables';
import type { ScheduleData, ServiceClass, ServiceStatus } from '../lib/types';
import {
  setClassVisible,
  setOperatorVisible,
  setStatusVisible,
  visibilitySnapshot,
} from '../lib/visibility';

const PANEL_CSS = `
#dev-panel {
  position: absolute; top: calc(3rem + env(safe-area-inset-top, 0px)); left: 0.75rem;
  z-index: 9; width: 15rem; max-height: 70vh; overflow-y: auto;
  background: color-mix(in srgb, var(--bg) 96%, transparent);
  border: 1px solid var(--border); padding: 0.6rem 0.75rem 0.75rem;
  font-family: var(--mono); font-size: 0.6rem; letter-spacing: 0.02em;
  overscroll-behavior: contain;
}
#dev-panel h2 { font: inherit; text-transform: uppercase; color: var(--text-tertiary); margin: 0.7rem 0 0.2rem; }
#dev-panel h2:first-child { margin-top: 0; }
#dev-panel .row { display: grid; grid-template-columns: 6.4rem 1fr 2.4rem; gap: 0.4rem; align-items: center; padding: 0.12rem 0; }
#dev-panel .row label { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#dev-panel input[type=range] { width: 100%; accent-color: #666; height: 0.9rem; }
#dev-panel input[type=color] { width: 100%; height: 1.1rem; border: 1px solid var(--border); background: none; padding: 0; }
#dev-panel input[type=checkbox] { accent-color: #666; justify-self: start; }
#dev-panel .val { text-align: right; color: var(--text); font-variant-numeric: tabular-nums; }
#dev-panel .actions { display: flex; gap: 0.4rem; margin-top: 0.8rem; }
#dev-panel button {
  font: inherit; text-transform: uppercase; letter-spacing: 0.02em; cursor: pointer;
  border: 1px solid var(--border); background: transparent; color: var(--text-secondary);
  padding: 0.25rem 0.6rem;
}
#dev-panel button:hover { border-color: var(--text-tertiary); color: var(--text); }
`;

let open = false;
let panel: HTMLElement | null = null;
let schedule: ScheduleData | null = null;

export function toggleDevPanel() {
  open = !open;
  if (open && !panel) panel = build();
  if (panel) panel.style.display = open ? '' : 'none';
}

export function initDevPanel(data: ScheduleData) {
  schedule = data;
  if (new URLSearchParams(location.search).has('dev')) toggleDevPanel();
}

function build(): HTMLElement {
  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  document.head.append(style);

  const panel = document.createElement('div');
  panel.id = 'dev-panel';

  const groups = new Map<string, HTMLElement>();
  for (const [key, spec] of Object.entries(SPECS)) {
    let g = groups.get(spec.group);
    if (!g) {
      const h = document.createElement('h2');
      h.textContent = spec.group;
      panel.append(h);
      g = document.createElement('div');
      panel.append(g);
      groups.set(spec.group, g);
    }
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('label');
    label.textContent = spec.label;
    row.append(label);

    if (spec.kind === 'num') {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = String(spec.step);
      input.value = String(T[key as TunableKey]);
      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = String(T[key as TunableKey]);
      input.addEventListener('input', () => {
        setTunable(key as TunableKey, Number(input.value));
        val.textContent = input.value;
      });
      row.append(input, val);
    } else {
      const input = document.createElement('input');
      input.type = 'color';
      input.value = T[key as TunableKey] as string;
      input.addEventListener('input', () => setTunable(key as TunableKey, input.value));
      const spacer = document.createElement('span');
      row.append(input, spacer);
    }
    g.append(row);
  }

  if (schedule) {
    const snapshot = visibilitySnapshot();
    const addChecks = (
      title: string,
      values: [string, string, boolean][],
      set: (id: string, checked: boolean) => void,
    ) => {
      const h = document.createElement('h2');
      h.textContent = title;
      panel.append(h);
      for (const [id, name, checked] of values) {
        const row = document.createElement('div');
        row.className = 'row';
        const label = document.createElement('label');
        label.textContent = name;
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = checked;
        input.addEventListener('change', () => set(id, input.checked));
        row.append(label, input, document.createElement('span'));
        panel.append(row);
      }
    };
    addChecks(
      'service classes',
      (Object.entries(snapshot.classes) as [ServiceClass, boolean][]).map(([id, value]) => [id, id, value]),
      (id, value) => setClassVisible(id as ServiceClass, value),
    );
    addChecks(
      'service status',
      (Object.entries(snapshot.statuses) as [ServiceStatus, boolean][]).map(([id, value]) => [id, id, value]),
      (id, value) => setStatusVisible(id as ServiceStatus, value),
    );
    addChecks(
      'operators',
      schedule.operators.map((operator) => [operator.id, operator.short, snapshot.operators[operator.id] !== false]),
      setOperatorVisible,
    );
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  const copy = document.createElement('button');
  copy.textContent = 'copy';
  copy.addEventListener('click', async () => {
    const json = JSON.stringify({ tunables: JSON.parse(exportTunables()), visibility: visibilitySnapshot() }, null, 2);
    console.log('[tunables]', json);
    try {
      await navigator.clipboard.writeText(json);
      copy.textContent = 'copied ✓';
    } catch {
      copy.textContent = 'in console';
    }
    setTimeout(() => (copy.textContent = 'copy'), 1200);
  });
  const close = document.createElement('button');
  close.textContent = 'close';
  close.addEventListener('click', () => (panel.style.display = 'none'));
  actions.append(copy, close);
  panel.append(actions);

  document.getElementById('app')!.append(panel);
  return panel;
}
