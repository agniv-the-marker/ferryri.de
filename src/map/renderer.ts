/**
 * The paper-and-ink map surface. One full-screen WebGL2 pass composites:
 *
 *  - water: two paper-adjacent tones mixed through a Bayer 4×4 ordered dither
 *    whose threshold is modulated by a slowly drifting fractal noise field —
 *    a shimmering, print-like sea (the sunday.bike `o4x4` dither, animated);
 *  - land: flat paper with a faint hillshade expressed as sparse ink dithering;
 *  - coastline: a thin ink edge derived from the land mask's gradient.
 *
 * Land polygons are rasterized into an offscreen 2D canvas only when the
 * camera moves, then sampled as a texture. Vessels/labels live on a separate
 * crisp 2D overlay, not here.
 */
import type { Camera } from './camera';
import { lngToX, latToY, metersPerWorldUnit } from './proj';
import { T } from '../lib/tunables';

/**
 * The swell is four component waves: a long primary swell, two flanking
 * swells, and a short chop. Wavelengths are in metres, so the dispersion
 * relation gives each one a believable period on its own.
 */
const SWELL_WAVES = [
  { lambda: 130, amp: 1.0, offsetDeg: 0 },
  { lambda: 75, amp: 0.5, offsetDeg: 22 },
  { lambda: 55, amp: 0.4, offsetDeg: -22 },
  { lambda: 35, amp: 0.25, offsetDeg: 48 },
];
const GRAVITY = 9.81;

interface TopoMeta {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  w: number;
  h: number;
}

const VERT = /* glsl */ `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uMask;   // land mask (alpha), viewport-aligned
uniform sampler2D uTopo;   // R hillshade, G elevation/8
uniform vec2 uViewport;    // css px
uniform float uDpr;
uniform vec3 uCam;         // world center x, y, scale (px per world unit)
uniform vec4 uTopoRect;    // world x0,y0,x1,y1 of topo texture
uniform float uTime;
uniform vec3 uPaper;
uniform vec3 uInk;
uniform vec3 uWaterLo;
uniform vec3 uWaterMid;
uniform vec3 uWaterHi;
uniform vec2 uLevels;      // water tone levels, land tone levels
uniform vec3 uShoreWave;   // amplitude, band frequency, speed
uniform vec4 uWaterParams; // noise scale, contrast band, fine octave, dither px
uniform vec4 uTopoParams;  // hillshade, contrast gain, elevation dots, dot ink
uniform sampler2D uWave;   // simulated wave field (0.5 = flat), screen-aligned
uniform float uWaveAmp;
uniform float uLod;        // settled noise level = log2(scale * noise freq)
uniform vec2 uLandParams;  // coastal band strength, max land ink density
uniform float uShoreFade;  // 0..1 zoom fade for the coastal band
uniform sampler2D uMaskBlur; // low-res land mask ≈ distance-to-water field
uniform vec4 uSwell[4];    // per wave: dir.x*k, dir.y*k (world), omega, phase
uniform float uSwellAmp[4];// per-wave weights, pre-normalized to sum 1
uniform vec4 uSwellB;      // amplitude, crest sharpness, zoom fade, crest mean
uniform float uSwellCalm;  // how much the swell lies down near shore

// ---- Bayer 4×4 ordered dither ----
float bayer4(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  int m[16] = int[16](0,8,2,10, 12,4,14,6, 3,11,1,9, 15,7,13,5);
  return (float(m[i.y * 4 + i.x]) + 0.5) / 16.0;
}

// N-level ordered dither, the o4x4,N of the reference photo pipeline.
// Two levels is the old on/off stipple; more levels give real tonal steps.
float quantize(float v, float levels, float dth) {
  float n = max(1.0, levels - 1.0);
  return clamp(floor(clamp(v, 0.0, 1.0) * n + dth) / n, 0.0, 1.0);
}

// Three-stop colour ramp for the water tones.
vec3 ramp3(vec3 a, vec3 b, vec3 c, float t) {
  return t < 0.5 ? mix(a, b, t * 2.0) : mix(b, c, (t - 0.5) * 2.0);
}

// ---- value noise on a 289-periodic lattice ----
// All hash inputs stay small so mobile-GPU float32 sin() never degrades.
float hash(vec2 cell) {
  vec2 c = mod(cell, 289.0);
  return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453);
}

// World-fixed value noise at frequency f (cells per world unit), evaluated
// precisely near the camera: cell ids are split into a large integer base
// (from the camera position) plus a small local offset, so no coordinate
// ever exceeds a few hundred.
float vnoiseWorld(vec2 world, float f, vec2 driftCells) {
  vec2 cellBase = floor(uCam.xy * f);
  vec2 local = (world - cellBase / f) * f + driftCells;
  vec2 i = cellBase + floor(local);
  vec2 fr = fract(local);
  vec2 u = fr * fr * (3.0 - 2.0 * fr);
  return mix(
    mix(hash(i), hash(i + vec2(1, 0)), u.x),
    mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x),
    u.y);
}

void main() {
  vec2 css = vUv * uViewport;                       // css px, y-up here
  vec2 screen = vec2(css.x, uViewport.y - css.y);   // flip to canvas y-down
  vec2 world = (screen - uViewport * 0.5) / uCam.z + uCam.xy;

  float land = texture(uMask, vec2(vUv.x, 1.0 - vUv.y)).a;

  // Every dither input is sampled at the *center of its dither cell*, so a
  // cell is atomically on or off — no half-rendered squares. (This is the
  // ImageMagick o4x4 look: dither a small image, upscale nearest-neighbor.)
  float dpx = uWaterParams.w;
  vec2 cellCss = (floor(css / dpx) + 0.5) * dpx;
  vec2 cellScreen = vec2(cellCss.x, uViewport.y - cellCss.y);
  vec2 cellWorld = (cellScreen - uViewport * 0.5) / uCam.z + uCam.xy;
  vec2 cellUv = cellCss / uViewport;
  float dth = bayer4(floor(css / dpx));

  // blurred land mask ≈ distance to water; drives both the coastal ink band
  // and the calming of the swell inside coves and slips
  float blurredLand = texture(uMaskBlur, vec2(cellUv.x, 1.0 - cellUv.y)).a;

  // ---- water ----
  // Fractal noise at a frequency chosen for the current zoom — but the level
  // (uLod) is settled JS-side only when the camera stops zooming, so during a
  // zoom the pattern stays world-locked and scales with the map instead of
  // boiling. Two octave pairs cross-fade on the fractional level.
  float lod = floor(uLod);
  float lfrac = uLod - lod;
  float f0 = exp2(lod);
  float fine = uWaterParams.z;
  vec2 drift = vec2(uTime * 0.085, uTime * 0.05);
  float n0 = (1.0 - fine) * vnoiseWorld(cellWorld, f0, drift)
           + fine * vnoiseWorld(cellWorld, f0 * 3.0, -drift.yx * 1.7);
  float n1 = (1.0 - fine) * vnoiseWorld(cellWorld, f0 * 2.0, drift)
           + fine * vnoiseWorld(cellWorld, f0 * 6.0, -drift.yx * 1.7);
  float n = mix(n0, n1, lfrac);

  // ---- directional swell: sum of sharpened Gerstner-style crests ----
  // Each wave carries its own wavelength and a real deep-water angular speed
  // (omega = sqrt(g k)), so long swells roll slowly and chop rides fast. Phase
  // is evaluated against a camera-relative offset, keeping every term small
  // enough for float32 while the pattern stays anchored to the world.
  float swellTerm = 0.0;
  if (uSwellB.z > 0.001) {
    vec2 rel = cellWorld - uCam.xy;
    float sw = 0.0;
    for (int i = 0; i < 4; i++) {
      float theta = dot(uSwell[i].xy, rel) + uSwell[i].w - uSwell[i].z * uTime;
      float s = sin(theta) * 0.5 + 0.5;
      sw += uSwellAmp[i] * (pow(s, uSwellB.y) - uSwellB.w);
    }
    float calm = 1.0 - uSwellCalm * smoothstep(0.05, 0.5, blurredLand);
    swellTerm = sw * uSwellB.x * uSwellB.z * calm;
    n += swellTerm;
  }

  // ---- shore waves: bands that run parallel to the coastline ----
  // The blurred mask doubles as a coarse distance-to-land field, so banding on
  // its value produces crests that wrap headlands and islands the way real
  // swell refracts into a shore — the open-water noise alone knows nothing
  // about the coast. The envelope keeps them in the near-shore water.
  if (uShoreWave.x > 0.0) {
    float env = smoothstep(0.02, 0.22, blurredLand)
              * (1.0 - smoothstep(0.42, 0.8, blurredLand));
    n += sin(blurredLand * uShoreWave.y - uTime * uShoreWave.z)
       * uShoreWave.x * env;
  }

  // ---- tap ripples: simulated wave field (reflects off the coastline) ----
  n += (texture(uWave, cellUv).r - 0.5) * 2.0 * uWaveAmp;

  float band = uWaterParams.y;
  float wTone = quantize(smoothstep(0.5 - band, 0.5 + band, n), uLevels.x, dth);
  vec3 water = ramp3(uWaterLo, uWaterMid, uWaterHi, wTone);

  // ---- land: graded dither — coastal band, hypsometric tone, hillshade ----
  vec2 topoUv = (cellWorld - uTopoRect.xy) / (uTopoRect.zw - uTopoRect.xy);
  vec3 topo = texture(uTopo, topoUv).rgb;

  // Hillshade through a soft knee (x/(1+x)) rather than a hard clamp: the
  // response keeps climbing with slope, so a ridge still reads darker than a
  // hillside no matter how far the strength/gain sliders are pushed.
  float relS = max(0.0, 0.72 - topo.r) * uTopoParams.y * uTopoParams.x;
  float shadeT = relS / (1.0 + relS);
  // Hypsometric tone: lowlands stay paper, hills build density (full at ~850m)
  float elevT = clamp(pow(clamp(topo.g * 2.4, 0.0, 1.0), 0.75) * uTopoParams.z, 0.0, 1.0);
  // Coastal band, from the blurred mask sampled above. The blur is a fixed
  // number of screen pixels, so zoomed out it would cover kilometres and wash
  // whole marsh counties dark — it fades in as a close-up detail instead.
  float shoreT = clamp(
      (1.0 - smoothstep(0.3, 0.95, blurredLand)) * uLandParams.x * uShoreFade,
      0.0, 1.0);
  // Screen-combine so three moderate terms can't stack into one flat black
  // mass, then cap the ink so land never goes solid.
  float density =
      (1.0 - (1.0 - shadeT) * (1.0 - elevT) * (1.0 - shoreT)) * uLandParams.y;
  // Multi-level dither gives relief real tonal steps instead of one on/off ink
  vec3 landCol = mix(uPaper, uInk, quantize(density, uLevels.y, dth) * uTopoParams.w);

  // ---- coastline ink from mask gradient ----
  float edge = clamp(abs(dFdx(land)) + abs(dFdy(land)), 0.0, 1.0);
  edge = smoothstep(0.08, 0.6, edge);

  vec3 col = mix(water, landCol, land);
  col = mix(col, uInk * 0.35 + col * 0.2, edge * 0.9);

  outColor = vec4(col, 1.0);
}`;

/**
 * Wave-equation step for tap ripples, run on a small screen-aligned grid.
 * Land cells (from the mask) are pinned flat — a Dirichlet boundary — so
 * wavefronts genuinely reflect off the coastline. The field is advected by
 * camera pan so ripples stay glued to the water while you drag.
 */
const SIM_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uCurr;  // height at t   (r, 0.5 = flat)
uniform sampler2D uPrevT; // height at t-1
uniform sampler2D uMask;  // land mask, viewport-aligned (row 0 = screen top)
uniform vec2 uTexel;      // 1 / sim grid size
// Camera remaps, each (scale, shiftX, shiftY) applied about the view center.
// uMapCurr takes this frame's uv back to where that world point sat in the
// t field; uMapPrev is the *composition* of the last two frames' remaps, for
// the t-1 field. Using one map for both is what made zooming inject energy:
// the leapfrog term (2c - p) differenced two misregistered fields.
uniform vec3 uMapCurr;
uniform vec3 uMapPrev;
uniform vec4 uSplat;      // uv x, y, strength, radius (sim texels); strength 0 = none
uniform vec2 uParams;     // c^2, damping

// Outside the viewport there is no history — treat it as flat water rather
// than clamping, which would smear the edge row inward while zooming out.
float H(sampler2D t, vec2 uv) {
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;
  return texture(t, uv).r - 0.5;
}
float landAt(vec2 uv) { return texture(uMask, vec2(uv.x, 1.0 - uv.y)).a; }
vec2 remap(vec3 m, vec2 uv) { return (uv - 0.5) * m.x + m.yz + 0.5; }

void main() {
  if (landAt(vUv) > 0.5) { outColor = vec4(0.5, 0.5, 0.5, 1.0); return; }
  vec2 cuv = remap(uMapCurr, vUv);
  vec2 puv = remap(uMapPrev, vUv);
  // neighbour offsets live in destination space, so scale them into the source
  vec2 ex = vec2(uTexel.x, 0.0) * uMapCurr.x;
  vec2 ey = vec2(0.0, uTexel.y) * uMapCurr.x;
  float c = H(uCurr, cuv);
  float p = H(uPrevT, puv);
  float lap =
      H(uCurr, cuv + ex) +
      H(uCurr, cuv - ex) +
      H(uCurr, cuv + ey) +
      H(uCurr, cuv - ey) - 4.0 * c;
  float next = (2.0 * c - p + uParams.x * lap) * uParams.y;
  if (uSplat.z > 0.0) {
    vec2 d = (vUv - uSplat.xy) / uTexel;
    next -= uSplat.z * exp(-dot(d, d) / (uSplat.w * uSplat.w));
  }
  outColor = vec4(clamp(next + 0.5, 0.02, 0.98), 0.5, 0.5, 1.0);
}`;

function cssColor(name: string): [number, number, number] {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = parseInt(v.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export class Renderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private maskTex: WebGLTexture;
  private topoTex: WebGLTexture;
  private maskCanvas = document.createElement('canvas');
  private maskCtx = this.maskCanvas.getContext('2d')!;
  private maskBlurCanvas = document.createElement('canvas');
  private maskBlurCtx = this.maskBlurCanvas.getContext('2d')!;
  private maskBlurTex!: WebGLTexture;
  private landPath: Path2D;
  private topoRect: [number, number, number, number];
  private lastMaskKey = '';
  dpr = Math.min(devicePixelRatio || 1, 2);

  // ---- ripple wave-field sim ----
  private simProgram: WebGLProgram;
  private su: Record<string, WebGLUniformLocation | null> = {};
  private simTex: WebGLTexture[] = [];
  private simFbo: WebGLFramebuffer[] = [];
  private simW = 1;
  private simH = 1;
  private simPrev = 0; // index of t-1 texture
  private simCurr = 1;
  private splats: { x: number; y: number }[] = [];
  private lastCam: { x: number; y: number; scale: number } | null = null;
  /** Previous step's camera remap, for composing the t-1 field's mapping. */
  private lastMap: [number, number, number] = [1, 0, 0];

  // ---- swell scratch ----
  private swellBuf = new Float32Array(16);
  private swellAmps = new Float32Array(4);
  private crestMeanCache = new Map<number, number>();

  constructor(
    private canvas: HTMLCanvasElement,
    coast: { type: string; coordinates: number[][][][] },
    topoImg: HTMLImageElement,
    topoMeta: TopoMeta,
  ) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program) ?? 'link error');
    this.program = program;
    for (const name of [
      'uMask', 'uTopo', 'uViewport', 'uDpr', 'uCam', 'uTopoRect', 'uTime',
      'uPaper', 'uInk', 'uWaterLo', 'uWaterMid', 'uWaterHi', 'uLevels',
      'uShoreWave', 'uWaterParams', 'uTopoParams',
      'uWave', 'uWaveAmp', 'uLod', 'uLandParams', 'uShoreFade', 'uMaskBlur',
      'uSwell[0]', 'uSwellAmp[0]', 'uSwellB', 'uSwellCalm',
    ])
      this.u[name] = gl.getUniformLocation(program, name);

    // ripple sim program (shares the fullscreen vertex shader)
    const simProgram = gl.createProgram()!;
    gl.attachShader(simProgram, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(simProgram, compile(gl.FRAGMENT_SHADER, SIM_FRAG));
    gl.linkProgram(simProgram);
    if (!gl.getProgramParameter(simProgram, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(simProgram) ?? 'sim link error');
    this.simProgram = simProgram;
    for (const name of [
      'uCurr', 'uPrevT', 'uMask', 'uTexel', 'uSplat', 'uParams',
      'uMapCurr', 'uMapPrev',
    ])
      this.su[name] = gl.getUniformLocation(simProgram, name);
    for (let i = 0; i < 3; i++) {
      this.simTex.push(gl.createTexture()!);
      this.simFbo.push(gl.createFramebuffer()!);
    }

    // land polygons → one Path2D in world coords (unit mercator square)
    this.landPath = new Path2D();
    for (const poly of coast.coordinates) {
      for (const ring of poly) {
        ring.forEach(([lng, lat], i) => {
          const x = lngToX(lng!);
          const y = latToY(lat!);
          if (i === 0) this.landPath.moveTo(x, y);
          else this.landPath.lineTo(x, y);
        });
        this.landPath.closePath();
      }
    }

    this.maskTex = gl.createTexture()!;
    this.maskBlurTex = gl.createTexture()!;
    this.topoTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.topoTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, topoImg);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.topoRect = [topoMeta.x0, topoMeta.y0, topoMeta.x1, topoMeta.y1];
  }

  resize(w: number, h: number) {
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    // mask at css resolution: soft-enough edges, cheap uploads
    this.maskCanvas.width = Math.max(1, Math.round(w));
    this.maskCanvas.height = Math.max(1, Math.round(h));
    // Shore-blur raster at ~1/10 scale — its bilinear upsample *is* the blur,
    // giving a coastal band of roughly constant width in screen pixels.
    this.maskBlurCanvas.width = Math.max(1, Math.round(w / 10));
    this.maskBlurCanvas.height = Math.max(1, Math.round(h / 10));
    this.lastMaskKey = '';

    // ripple sim grid at 1/3 css resolution
    const gl = this.gl;
    this.simW = Math.max(8, Math.ceil(w / 3));
    this.simH = Math.max(8, Math.ceil(h / 3));
    for (let i = 0; i < 3; i++) {
      gl.bindTexture(gl.TEXTURE_2D, this.simTex[i]!);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, this.simW, this.simH, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, null,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.simFbo[i]!);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.simTex[i]!, 0,
      );
      gl.clearColor(0.5, 0.5, 0.5, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.lastCam = null;
    this.lastMap = [1, 0, 0];
  }

  /** Drop a tap ripple at css-pixel screen coordinates. */
  addRipple(x: number, y: number) {
    this.splats.push({ x, y });
  }

  /** One wave-equation step (called from draw; ~1/9 of a viewport of work). */
  private stepRipples(cam: Camera) {
    const gl = this.gl;
    const { w, h } = cam.viewport;

    // Camera advection: where did this world point sit in the previous
    // frame's field? Pan becomes a shift, zoom a scale about the view centre.
    let shiftX = 0;
    let shiftY = 0;
    let ratio = 1;
    const s = cam.scale;
    if (this.lastCam) {
      const sPrev = this.lastCam.scale;
      ratio = sPrev / s;
      shiftX = ((cam.cur.x - this.lastCam.x) * sPrev) / w;
      shiftY = -((cam.cur.y - this.lastCam.y) * sPrev) / h;
    }
    this.lastCam = { x: cam.cur.x, y: cam.cur.y, scale: s };

    // The t-1 field is one frame older, so it needs this remap composed with
    // the previous one: g2(g1(uv)) for g(uv) = (uv-½)·r + s + ½.
    const [r2, s2x, s2y] = this.lastMap;
    const prevMap: [number, number, number] = [
      ratio * r2,
      shiftX * r2 + s2x,
      shiftY * r2 + s2y,
    ];
    this.lastMap = [ratio, shiftX, shiftY];

    const next = 3 - this.simPrev - this.simCurr;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.simFbo[next]!);
    gl.viewport(0, 0, this.simW, this.simH);
    gl.useProgram(this.simProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.simTex[this.simCurr]!);
    gl.uniform1i(this.su.uCurr ?? null, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.simTex[this.simPrev]!);
    gl.uniform1i(this.su.uPrevT ?? null, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.uniform1i(this.su.uMask ?? null, 2);
    gl.uniform2f(this.su.uTexel ?? null, 1 / this.simW, 1 / this.simH);
    gl.uniform3f(this.su.uMapCurr ?? null, ratio, shiftX, shiftY);
    gl.uniform3f(this.su.uMapPrev ?? null, prevMap[0], prevMap[1], prevMap[2]);
    const splat = this.splats.shift();
    if (splat) {
      gl.uniform4f(
        this.su.uSplat ?? null,
        splat.x / w, 1 - splat.y / h,
        T.rippleSplat * 1.1,
        Math.max(2, T.rippleRadius / 3), // css px → sim texels
      );
    } else {
      gl.uniform4f(this.su.uSplat ?? null, 0, 0, 0, 1);
    }
    gl.uniform2f(this.su.uParams ?? null, T.rippleC, T.rippleDamp);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.simPrev = this.simCurr;
    this.simCurr = next;
  }

  /**
   * Mean of ((sin θ + 1)/2)^p over a full period — subtracted from each crest
   * so sharpening the crests doesn't also brighten the whole sea.
   */
  private crestMean(p: number): number {
    const key = Math.round(p * 100);
    let m = this.crestMeanCache.get(key);
    if (m === undefined) {
      const N = 128;
      let sum = 0;
      for (let i = 0; i < N; i++)
        sum += Math.pow((Math.sin((i / N) * Math.PI * 2) + 1) / 2, p);
      m = sum / N;
      this.crestMeanCache.set(key, m);
    }
    return m;
  }

  /**
   * Build the per-wave swell uniforms. Wavelengths convert metres → world
   * units at the current latitude, and each wave's phase at the camera centre
   * is folded to [0, 2π) in float64 here so the shader only ever adds a small
   * camera-relative offset — the pattern stays world-anchored without float32
   * precision falling apart at high zoom.
   */
  private setSwellUniforms(cam: Camera) {
    const gl = this.gl;
    const fade = Math.max(
      0,
      Math.min(1, (cam.cur.z - T.swellZoom) / 1.2),
    );
    gl.uniform4f(
      this.u.uSwellB ?? null,
      T.swellAmp,
      T.swellSharp,
      fade * fade * (3 - 2 * fade),
      this.crestMean(T.swellSharp),
    );
    gl.uniform1f(this.u.uSwellCalm ?? null, T.swellCalm);
    if (fade <= 0) return;

    const mpwu = metersPerWorldUnit(cam.cur.y);
    const totalAmp = SWELL_WAVES.reduce((a, w) => a + w.amp, 0);
    for (let i = 0; i < SWELL_WAVES.length; i++) {
      const wv = SWELL_WAVES[i]!;
      const lambdaM = wv.lambda * T.swellScale;
      const bearing = ((T.swellDir + wv.offsetDeg) * Math.PI) / 180;
      const dx = Math.sin(bearing);
      const dy = -Math.cos(bearing); // mercator y grows southward
      const kWorld = (2 * Math.PI * mpwu) / lambdaM;
      const omega = Math.sqrt((GRAVITY * 2 * Math.PI) / lambdaM);
      const phase =
        ((dx * cam.cur.x + dy * cam.cur.y) * kWorld) % (Math.PI * 2);
      this.swellBuf[i * 4] = dx * kWorld;
      this.swellBuf[i * 4 + 1] = dy * kWorld;
      this.swellBuf[i * 4 + 2] = omega;
      this.swellBuf[i * 4 + 3] = phase;
      this.swellAmps[i] = wv.amp / totalAmp;
    }
    gl.uniform4fv(this.u['uSwell[0]'] ?? null, this.swellBuf);
    gl.uniform1fv(this.u['uSwellAmp[0]'] ?? null, this.swellAmps);
  }

  /**
   * Peak |height| in the ripple field, 0 = flat. Dev aid: lets a test drive
   * the camera and assert the wave sim decays instead of gaining energy.
   */
  debugWavePeak(): number {
    const gl = this.gl;
    const px = new Uint8Array(this.simW * this.simH * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.simFbo[this.simCurr]!);
    gl.readPixels(0, 0, this.simW, this.simH, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    let peak = 0;
    for (let i = 0; i < px.length; i += 4)
      peak = Math.max(peak, Math.abs(px[i]! / 255 - 0.5));
    return peak;
  }

  /**
   * The viewport-aligned land raster (opaque over land, clear over water),
   * refreshed whenever the camera moves. The overlay uses it to clip things
   * that should appear to pass beneath the land.
   */
  get landMask(): HTMLCanvasElement {
    return this.maskCanvas;
  }

  /** Is this css-pixel over land? (Sampled from the current mask raster.) */
  isLand(x: number, y: number): boolean {
    const px = this.maskCtx.getImageData(
      Math.max(0, Math.min(this.maskCanvas.width - 1, Math.round(x))),
      Math.max(0, Math.min(this.maskCanvas.height - 1, Math.round(y))),
      1,
      1,
    ).data;
    return px[3]! > 128;
  }

  /** Re-rasterize the land mask if the camera moved since last frame. */
  private updateMask(cam: Camera) {
    const { w, h } = cam.viewport;
    const key = `${cam.cur.x.toFixed(9)}|${cam.cur.y.toFixed(9)}|${cam.cur.z.toFixed(5)}|${w}x${h}`;
    if (key === this.lastMaskKey) return;
    this.lastMaskKey = key;

    const ctx = this.maskCtx;
    const s = cam.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
    ctx.setTransform(s, 0, 0, s, w / 2 - cam.cur.x * s, h / 2 - cam.cur.y * s);
    ctx.fillStyle = '#fff';
    ctx.fill(this.landPath, 'evenodd');

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.maskCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // tiny second raster of the same polygons: its bilinear upsample is a
    // cheap blur = the shore distance field (no mipmaps — drivers disagree)
    const bw = this.maskBlurCanvas.width;
    const bh = this.maskBlurCanvas.height;
    const bs = s * (bw / this.maskCanvas.width);
    const bctx = this.maskBlurCtx;
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, bw, bh);
    bctx.setTransform(
      bs, 0, 0, bs,
      (w / 2 - cam.cur.x * s) * (bw / this.maskCanvas.width),
      (h / 2 - cam.cur.y * s) * (bh / this.maskCanvas.height),
    );
    bctx.fillStyle = '#fff';
    bctx.fill(this.landPath, 'evenodd');
    gl.bindTexture(gl.TEXTURE_2D, this.maskBlurTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.maskBlurCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private displayLod: number | null = null;
  private lastZoomZ: number | null = null;
  private lastDrawT = 0;

  draw(cam: Camera, timeSec: number, animate = true) {
    const gl = this.gl;
    this.updateMask(cam);
    if (animate) this.stepRipples(cam);

    // Settle the water-noise level only while the camera isn't zooming, so
    // zooming scales the pattern with the map instead of boiling it.
    const nowT = performance.now() / 1000;
    const dt = Math.min(0.1, nowT - this.lastDrawT || 0.016);
    this.lastDrawT = nowT;
    const targetLod = Math.log2(cam.scale * T.waterFreq);
    if (this.displayLod === null) this.displayLod = targetLod;
    const zoomVel = this.lastZoomZ === null ? 0 : Math.abs(cam.cur.z - this.lastZoomZ) / dt;
    this.lastZoomZ = cam.cur.z;
    if (zoomVel < 0.12) {
      const k = 1 - Math.exp(-2.5 * dt);
      this.displayLod += (targetLod - this.displayLod) * k;
    }

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.uniform1i(this.u.uMask ?? null, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.topoTex);
    gl.uniform1i(this.u.uTopo ?? null, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.simTex[this.simCurr]!);
    gl.uniform1i(this.u.uWave ?? null, 2);
    gl.uniform1f(this.u.uWaveAmp ?? null, T.rippleAmp);
    gl.uniform1f(this.u.uLod ?? null, this.displayLod);
    gl.uniform2f(this.u.uLandParams ?? null, T.topoShore, T.topoMax);
    gl.uniform1f(
      this.u.uShoreFade ?? null,
      Math.max(0, Math.min(1, (cam.cur.z - 11.6) / 1.4)),
    );
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.maskBlurTex);
    gl.uniform1i(this.u.uMaskBlur ?? null, 3);
    this.setSwellUniforms(cam);

    const { w, h } = cam.viewport;
    gl.uniform2f(this.u.uViewport ?? null, w, h);
    gl.uniform1f(this.u.uDpr ?? null, this.dpr);
    gl.uniform3f(this.u.uCam ?? null, cam.cur.x, cam.cur.y, cam.scale);
    gl.uniform4f(this.u.uTopoRect ?? null, ...this.topoRect);
    gl.uniform1f(this.u.uTime ?? null, timeSec);
    gl.uniform3f(this.u.uPaper ?? null, ...cssColor('--land'));
    gl.uniform3f(this.u.uInk ?? null, ...cssColor('--ink'));
    gl.uniform3f(this.u.uWaterLo ?? null, ...cssColor('--water-lo'));
    gl.uniform3f(this.u.uWaterMid ?? null, ...cssColor('--water-mid'));
    gl.uniform3f(this.u.uWaterHi ?? null, ...cssColor('--water-hi'));
    gl.uniform2f(this.u.uLevels ?? null, T.waterLevels, T.landLevels);
    gl.uniform3f(
      this.u.uShoreWave ?? null,
      T.shoreWaveAmp, T.shoreWaveFreq, T.shoreWaveSpeed,
    );
    gl.uniform4f(
      this.u.uWaterParams ?? null,
      T.waterFreq, T.waterContrast, T.waterFine, T.ditherPx,
    );
    // topography reveals itself as you zoom in
    const zt = Math.max(0, Math.min(1, (cam.cur.z - 11.2) / 3.2));
    const boost = 1 + (T.topoZoomBoost - 1) * zt * zt * (3 - 2 * zt);
    gl.uniform4f(
      this.u.uTopoParams ?? null,
      T.topoShade * boost, T.topoGain, T.topoElev * boost, T.topoInk,
    );

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
