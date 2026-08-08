/** Normalized web-mercator: the world maps to the unit square [0,1]². */

export interface WorldPt {
  x: number;
  y: number;
}

export function lngToX(lng: number): number {
  return (lng + 180) / 360;
}

export function latToY(lat: number): number {
  const r = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
}

export function project(lng: number, lat: number): WorldPt {
  return { x: lngToX(lng), y: latToY(lat) };
}

export function xToLng(x: number): number {
  return x * 360 - 180;
}

export function yToLat(y: number): number {
  const n = Math.PI * (1 - 2 * y);
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

/** Meters per world-unit at a given world y (for scale-accurate distances). */
export function metersPerWorldUnit(y: number): number {
  const lat = yToLat(y);
  return 40075016.686 * Math.cos((lat * Math.PI) / 180);
}
