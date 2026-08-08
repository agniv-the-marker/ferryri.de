/**
 * One-time build of the static geography assets (outputs are committed):
 *
 *  - public/data/coast.json  — bay-area land polygons (islands included),
 *    from MTC/ABAG "San Francisco Bay Region Counties (clipped)" (TIGER-derived
 *    shoreline), dissolved to a single land layer, clipped + simplified.
 *  - public/data/topo.png    — 1024×1024 texture over the same web-mercator
 *    window: R = hillshade (Horn), G = elevation/8 (m). For faint land shading.
 *  - public/data/topo.json   — mercator bounds of topo.png for texture mapping.
 *
 * Usage: npm run geo
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';

// mapshaper's ESM entry misbehaves under tsx; the CJS build works.
const mapshaper = createRequire(import.meta.url)('mapshaper') as {
  applyCommands: (cmd: string, input: Record<string, string>) => Promise<Record<string, Buffer>>;
};

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../public/data');

/** Coast clip: far beyond the camera roam area so its cut edge never shows. */
const COAST_BBOX = [-123.2, 37.0, -121.55, 38.6] as const; // W S E N
/** Topo window: just the ferry system — beyond it land renders flat paper. */
const BBOX = [-122.85, 37.3, -121.85, 38.35] as const;
/** Emit topo at half resolution — the hillshade is a faint dither source. */
const TOPO_DOWNSCALE = 2;

const COUNTIES_URL =
  'https://services3.arcgis.com/i2dkYWmb4wHvYPda/arcgis/rest/services/region_county_clp/FeatureServer/0/query';

// Terrarium elevation tiles (Mapzen/AWS Open Data, no key required)
const TERRAIN_Z = 10;
const terrariumUrl = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

const lng2tile = (lng: number, z: number) => ((lng + 180) / 360) * 2 ** z;
const lat2tile = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

async function buildCoast() {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: '',
    geometry: COAST_BBOX.join(','),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outSR: '4326',
    f: 'geojson',
  });
  console.log('fetching county shoreline polygons …');
  const res = await fetch(`${COUNTIES_URL}?${params}`);
  if (!res.ok) throw new Error(`counties fetch failed: ${res.status}`);
  const raw = await res.text();
  console.log(`  raw: ${(raw.length / 1e6).toFixed(1)} MB`);

  const cmd = [
    '-i counties.json',
    `-clip bbox=${COAST_BBOX.join(',')}`,
    '-dissolve2', // one land layer, no county borders
    '-simplify interval=10 keep-shapes', // ~10 m tolerance
    '-filter-islands min-area=10000m2', // drop rocks/slivers, keep Alcatraz etc.
    '-clean',
    '-o coast.json format=geojson precision=0.00001',
  ].join(' ');
  const out = await mapshaper.applyCommands(cmd, { 'counties.json': raw });
  const result = out['coast.json'];
  if (!result) throw new Error(`mapshaper produced no output; keys: ${Object.keys(out)}`);

  // Dissolved output arrives as a GeometryCollection of one MultiPolygon —
  // normalize to a bare MultiPolygon so the client stays simple.
  const parsed = JSON.parse(result.toString());
  const geom =
    parsed.type === 'GeometryCollection'
      ? parsed.geometries[0]
      : parsed.type === 'FeatureCollection'
        ? parsed.features[0].geometry
        : parsed;
  if (geom?.type !== 'MultiPolygon' && geom?.type !== 'Polygon')
    throw new Error(`unexpected geometry: ${geom?.type}`);
  const coords: number[][][][] =
    geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  const json = JSON.stringify({ type: 'MultiPolygon', coordinates: coords });
  writeFileSync(join(OUT_DIR, 'coast.json'), json);
  const nPts = coords.flat(2).length;
  console.log(
    `  wrote coast.json (${(json.length / 1024).toFixed(0)} KB, ${coords.length} polygons, ${nPts} points)`,
  );
}

async function buildTopo() {
  const x0 = Math.floor(lng2tile(BBOX[0], TERRAIN_Z));
  const x1 = Math.floor(lng2tile(BBOX[2], TERRAIN_Z));
  const y0 = Math.floor(lat2tile(BBOX[3], TERRAIN_Z)); // north edge → smaller y
  const y1 = Math.floor(lat2tile(BBOX[1], TERRAIN_Z));
  const cols = x1 - x0 + 1;
  const rows = y1 - y0 + 1;
  const W = cols * 256;
  const H = rows * 256;
  console.log(`fetching ${cols}×${rows} terrarium tiles (z${TERRAIN_Z}) → ${W}×${H} …`);

  const height = new Float32Array(W * H);
  await Promise.all(
    Array.from({ length: cols * rows }, async (_, i) => {
      const tx = x0 + (i % cols);
      const ty = y0 + Math.floor(i / cols);
      const res = await fetch(terrariumUrl(TERRAIN_Z, tx, ty));
      if (!res.ok) throw new Error(`tile ${tx}/${ty} failed: ${res.status}`);
      const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
      for (let py = 0; py < 256; py++) {
        for (let px = 0; px < 256; px++) {
          const s = (py * 256 + px) * 4;
          const h =
            png.data[s]! * 256 + png.data[s + 1]! + png.data[s + 2]! / 256 - 32768;
          height[(( (ty - y0) * 256 + py) * W) + (tx - x0) * 256 + px] = h;
        }
      }
    }),
  );

  // Horn hillshade, light from NW, 45° altitude.
  const latMid = (BBOX[1] + BBOX[3]) / 2;
  const cell = ((156543.03 * Math.cos((latMid * Math.PI) / 180)) / 2 ** TERRAIN_Z) * 1; // m/px
  const az = (315 * Math.PI) / 180;
  const alt = (45 * Math.PI) / 180;
  const at = (x: number, y: number) =>
    height[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))]!;
  const shadeAt = (x: number, y: number) => {
    const dzdx =
      (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))) /
      (8 * cell);
    const dzdy =
      (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))) /
      (8 * cell);
    const slope = Math.atan(Math.hypot(dzdx, dzdy));
    const aspect = Math.atan2(dzdy, -dzdx);
    return (
      Math.sin(alt) * Math.cos(slope) +
      Math.cos(alt) * Math.sin(slope) * Math.cos(az - Math.PI / 2 - aspect)
    );
  };

  const D = TOPO_DOWNSCALE;
  const OW = W / D;
  const OH = H / D;
  const out = new PNG({ width: OW, height: OH, colorType: 2 }); // RGB
  for (let y = 0; y < OH; y++) {
    for (let x = 0; x < OW; x++) {
      // box-average shade and height over the D×D block
      let s = 0;
      let h = 0;
      for (let dy = 0; dy < D; dy++)
        for (let dx = 0; dx < D; dx++) {
          s += shadeAt(x * D + dx, y * D + dy);
          h += at(x * D + dx, y * D + dy);
        }
      s /= D * D;
      h /= D * D;
      const i = (y * OW + x) * 4;
      out.data[i] = Math.round(Math.max(0, Math.min(1, s)) * 255);
      out.data[i + 1] = Math.round(Math.max(0, Math.min(255, h / 8)));
      out.data[i + 2] = 0;
      out.data[i + 3] = 255;
    }
  }
  writeFileSync(join(OUT_DIR, 'topo.png'), PNG.sync.write(out));

  // Mercator-fraction bounds of the stitched block (x/2^z … in [0,1])
  const meta = {
    z: TERRAIN_Z,
    // normalized web-mercator coords of the texture corners
    x0: x0 / 2 ** TERRAIN_Z,
    y0: y0 / 2 ** TERRAIN_Z,
    x1: (x1 + 1) / 2 ** TERRAIN_Z,
    y1: (y1 + 1) / 2 ** TERRAIN_Z,
    w: W / TOPO_DOWNSCALE,
    h: H / TOPO_DOWNSCALE,
  };
  writeFileSync(join(OUT_DIR, 'topo.json'), JSON.stringify(meta));
  console.log(`  wrote topo.png (${W}×${H}) + topo.json`, meta);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  await buildCoast();
  await buildTopo();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
