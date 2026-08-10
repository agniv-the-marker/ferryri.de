/**
 * Every magic number worth arguing about, in one live-editable registry.
 * The dev panel (?dev, or triple-tap the wordmark) binds sliders to these;
 * modules read values at use-time so edits apply immediately. "copy" in the
 * panel exports the current values as JSON for hand-off.
 */

export interface NumSpec {
  kind: 'num';
  label: string;
  group: string;
  min: number;
  max: number;
  step: number;
  value: number;
}

export interface ColorSpec {
  kind: 'color';
  label: string;
  group: string;
  /** CSS custom property this color mirrors (kept in sync on change) */
  cssVar?: string;
  value: string;
}

export interface BoolSpec {
  kind: 'bool';
  label: string;
  group: string;
  value: boolean;
}

export type Spec = NumSpec | ColorSpec | BoolSpec;

const num = (
  group: string,
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
): NumSpec => ({ kind: 'num', group, label, value, min, max, step });

const bool = (group: string, label: string, value: boolean): BoolSpec => ({
  kind: 'bool',
  group,
  label,
  value,
});

const color = (group: string, label: string, value: string, cssVar?: string): ColorSpec => ({
  kind: 'color',
  group,
  label,
  value,
  cssVar,
});

export const SPECS = {
  // ---- ui ----
  uiScale: num('ui', 'text scale', 1.5, 0.85, 1.8, 0.05),

  // ---- palette ----
  waterLo: color('palette', 'water lo', '#9ba2b5', '--water-lo'),
  waterMid: color('palette', 'water mid', '#b9c3ca', '--water-mid'),
  waterHi: color('palette', 'water hi', '#b1c3ce', '--water-hi'),
  land: color('palette', 'land', '#d6e0d9', '--land'),
  ink: color('palette', 'ink', '#000000', '--ink'),
  waterLevels: num('palette', 'water tones', 2, 2, 8, 1),
  landLevels: num('palette', 'land tones', 4, 2, 8, 1),

  // ---- water ----
  waterDrift: num('water', 'drift speed', 1.45, 0, 4, 0.05),
  waterFreq: num('water', 'noise scale', 0.015, 0.01, 0.2, 0.005),
  waterContrast: num('water', 'contrast band', 0.35, 0.02, 0.5, 0.01),
  waterFine: num('water', 'fine octave', 0.16, 0, 0.6, 0.02),
  ditherPx: num('water', 'dither cell px', 2, 1, 6, 1),

  // ---- swell (sum of Gerstner-style directional waves) ----
  swellAmp: num('swell', 'amplitude', 0.26, 0, 1, 0.02),
  swellScale: num('swell', 'wavelength ×', 1.5, 0.4, 2.5, 0.05),
  swellSharp: num('swell', 'crest sharpness', 2.2, 1, 5, 0.1),
  swellDir: num('swell', 'travel bearing°', 110, 0, 350, 5),
  swellZoom: num('swell', 'fade-out z', 12.3, 10, 15, 0.1),
  swellCalm: num('swell', 'shore calming', 0, 0, 1, 0.05),
  shoreWaveAmp: num('swell', 'shore band amp', 0, 0, 0.8, 0.02),
  shoreWaveFreq: num('swell', 'shore band freq', 160, 5, 160, 1),
  shoreWaveSpeed: num('swell', 'shore band speed', 4, 0, 4, 0.05),

  // ---- topo ----
  topoShade: num('topo', 'hillshade', 1.5, 0, 2, 0.05),
  topoGain: num('topo', 'shade contrast', 4, 0.2, 6, 0.1),
  topoElev: num('topo', 'elevation shade', 0.8, 0, 1.2, 0.02),
  topoInk: num('topo', 'dot darkness', 0.28, 0, 0.6, 0.02),
  topoZoomBoost: num('topo', 'zoom-in boost', 3, 0.3, 4, 0.1),
  topoShore: num('topo', 'coastal band', 0.12, 0, 0.8, 0.02),
  topoMax: num('topo', 'max land ink', 0.55, 0.1, 1, 0.02),

  // ---- ripple (tap the water; waves reflect off the coastline) ----
  rippleC: num('ripple', 'wave speed', 0.44, 0.02, 0.48, 0.01),
  rippleDamp: num('ripple', 'damping', 0.977, 0.9, 0.9995, 0.0005),
  rippleSplat: num('ripple', 'tap strength', 0.1, 0.1, 2, 0.05),
  rippleRadius: num('ripple', 'tap size px', 12, 3, 40, 1),
  rippleAmp: num('ripple', 'visual strength', 1.75, 0, 2.5, 0.05),

  // ---- boat bob (vessels ride the ripple field + the open-water swell) ----
  // Off by default: it costs a per-frame readback of the wave field, and the
  // right amount of motion is a taste call. Force it on with ?bob.
  bobEnable: bool('bob', 'boats bob', false),
  bobSwell: num('bob', 'swell share', 0.6, 0, 2, 0.05),
  bobLift: num('bob', 'lift px', 4, 0, 12, 0.25),
  bobScale: num('bob', 'size swell', 0.12, 0, 0.6, 0.01),
  bobRock: num('bob', 'rock °', 6, 0, 30, 0.5),
  bobSway: num('bob', 'sway px', 1.5, 0, 8, 0.1),
  bobDock: num('bob', 'docked ×', 0.4, 0, 1, 0.05),

  // ---- camera ----
  camStiffness: num('camera', 'damping stiffness', 12.5, 2, 20, 0.5),
  camFlyStiffness: num('camera', 'fly stiffness', 3.2, 1, 12, 0.2),
  camInertia: num('camera', 'pan inertia', 0.32, 0, 1, 0.02),
  camFlyZoomOut: num('camera', 'fly arc height', 0.85, 0, 2, 0.05),
  camFlySpeed: num('camera', 'fly speed', 1.0, 0.4, 2.5, 0.05),
  camMaxZoom: num('camera', 'max zoom', 16, 14, 18, 0.25),

  // ---- split-flap board ----
  flapMs: num('board', 'flip half (ms)', 55, 30, 200, 5),
  flapStagger: num('board', 'cell stagger (ms)', 24, 0, 60, 2),
  flapRowStagger: num('board', 'row stagger (ms)', 110, 0, 400, 10),
  flapCycles: num('board', 'shuffle cycles', 1, 0, 4, 1),

  // ---- vessels & labels ----
  vesselSize: num('vessels', 'vessel size px', 13, 5, 20, 0.5),
  dockLeadMin: num('vessels', 'dock lead (min)', 4, 0, 20, 1),
  routeAlpha: num('vessels', 'route line alpha', 0.3, 0, 0.6, 0.02),
  labelZoom: num('labels', 'labels fade-in z', 9, 9, 13, 0.1),
  chipZoom: num('labels', 'chips fade-in z', 12.6, 10, 16, 0.1),
} satisfies Record<string, Spec>;

export type TunableKey = keyof typeof SPECS;

type Values = { [K in TunableKey]: (typeof SPECS)[K]['value'] };

/** Live values — read these at use-time. */
export const T: Values = Object.fromEntries(
  Object.entries(SPECS).map(([k, s]) => [k, s.value]),
) as Values;

const listeners = new Set<() => void>();
export function onTune(fn: () => void) {
  listeners.add(fn);
}

export function setTunable(key: TunableKey, v: number | string | boolean) {
  (T as Record<string, number | string | boolean>)[key] = v;
  const spec = SPECS[key];
  if (spec.kind === 'color' && spec.cssVar && typeof v === 'string') {
    document.documentElement.style.setProperty(spec.cssVar, v);
  }
  if (key === 'uiScale') applyDomTunables();
  for (const fn of listeners) fn();
}

/**
 * Push the DOM-facing tunables (text scale + palette) onto the document.
 * Called once at boot so this file — not style.css — is the source of truth
 * for the palette; the renderer reads the CSS vars back out.
 */
export function applyDomTunables() {
  document.documentElement.style.fontSize = `${16 * T.uiScale}px`;
  for (const [key, spec] of Object.entries(SPECS)) {
    if (spec.kind === 'color' && spec.cssVar) {
      document.documentElement.style.setProperty(
        spec.cssVar,
        T[key as TunableKey] as string,
      );
    }
  }
}

export function exportTunables(): string {
  return JSON.stringify(T, null, 2);
}
