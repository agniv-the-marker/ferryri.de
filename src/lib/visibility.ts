import type { Route, ScheduleData, ServiceClass, ServiceStatus } from './types';

export interface VisibilitySnapshot {
  classes: Record<ServiceClass, boolean>;
  statuses: Record<ServiceStatus, boolean>;
  operators: Record<string, boolean>;
}

const listeners = new Set<() => void>();
let state: VisibilitySnapshot = {
  classes: { transport: true, event: true, attraction: false },
  statuses: { active: true, paused: false, future: false },
  operators: {},
};

export function initVisibility(data: ScheduleData) {
  state.operators = Object.fromEntries(data.operators.map((o) => [o.id, true]));
}

export function routeVisible(route: Route): boolean {
  return (
    state.classes[route.serviceClass] &&
    state.statuses[route.status] &&
    state.operators[route.operator] !== false
  );
}

/**
 * Which routes call at each terminal. Both the map and the music need it — the
 * map to decide whether to draw a station, the music to decide whether it may
 * sound — and the two must agree, because a terminal that isn't on the paper
 * making a noise is a ghost.
 */
export function stationRoutes(data: ScheduleData): Map<string, Route[]> {
  const out = new Map<string, Route[]>();
  for (const route of data.routes) {
    for (const id of route.terminals) {
      const list = out.get(id);
      if (list) list.push(route);
      else out.set(id, [route]);
    }
  }
  return out;
}

/** A terminal is on the map only while something that calls there is. */
export function stationVisible(routes: Route[] | undefined): boolean {
  return !!routes && routes.some(routeVisible);
}

export function visibilitySnapshot(): VisibilitySnapshot {
  return structuredClone(state);
}

export function setClassVisible(key: ServiceClass, value: boolean) {
  state.classes[key] = value;
  emit();
}

export function setStatusVisible(key: ServiceStatus, value: boolean) {
  state.statuses[key] = value;
  emit();
}

export function setOperatorVisible(key: string, value: boolean) {
  state.operators[key] = value;
  emit();
}

export function onVisibilityChange(fn: () => void) {
  listeners.add(fn);
}

function emit() {
  for (const fn of listeners) fn();
}
