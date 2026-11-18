import type { PageAdjust } from "./tauri-bridge";

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export type Point = [number, number];

export function squareToQuad(quad: [Point, Point, Point, Point]): (u: number, v: number) => Point {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    a = x1 - x0; b = x2 - x1; c = x0;
    d = y1 - y0; e = y2 - y1; f = y0;
    g = 0; h = 0;
  } else {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
    a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; c = x0;
    d = y1 - y0 + g * y1; e = y3 - y0 + h * y3; f = y0;
  }
  return (u, v) => {
    const w = g * u + h * v + 1;
    return [(a * u + b * v + c) / w, (d * u + e * v + f) / w];
  };
}

export type Mat3 = [number, number, number, number, number, number, number, number, number];

export function affine3([a, b, c, d, e, f]: number[]): Mat3 {
  return [a, c, e, b, d, f, 0, 0, 1];
}

export function mul3(p: Mat3, q: Mat3): Mat3 {
  const r = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += p[i * 3 + k] * q[k * 3 + j];
  return r;
}

export function invert3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error("Matrix cannot be inverted");
  const k = 1 / det;
  return [
    A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
    B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
    C * k, -(a * h - b * g) * k, (a * e - b * d) * k,
  ];
}

export function apply3(m: Mat3, [x, y]: Point): Point {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

export function straightenMap(quad: [Point, Point, Point, Point], width: number, height: number): Mat3 {
  const px = quad.map(([x, y]) => [x * width, y * height] as Point) as [Point, Point, Point, Point];
  const H = quadMatrix(px);
  const toPixels: Mat3 = [width, 0, 0, 0, height, 0, 0, 0, 1];
  return mul3(toPixels, invert3(H));
}

function quadMatrix(q: [Point, Point, Point, Point]): Mat3 {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
  }
  return [
    x1 - x0 + g * x1, x3 - x0 + h * x3, x0,
    y1 - y0 + g * y1, y3 - y0 + h * y3, y0,
    g, h, 1,
  ];
}

export function warpToRect(src: Pixels, quad: [Point, Point, Point, Point], width: number, height: number): Pixels {
  const out = new Uint8ClampedArray(width * height * 4);
  const map = squareToQuad(quad);
  const { data, width: sw, height: sh } = src;
  const px = (x: number, y: number, ch: number): number =>
    x < 0 || y < 0 || x >= sw || y >= sh ? 255 : data[(y * sw + x) * 4 + ch];
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const [fx, fy] = map((x + 0.5) / width, v);
      const sx = fx - 0.5, sy = fy - 0.5;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const tx = sx - x0, ty = sy - y0;
      const o = (y * width + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = px(x0, y0, ch) * (1 - tx) + px(x0 + 1, y0, ch) * tx;
        const bottom = px(x0, y0 + 1, ch) * (1 - tx) + px(x0 + 1, y0 + 1, ch) * tx;
        out[o + ch] = top * (1 - ty) + bottom * ty;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width, height };
}

export function contentBounds(src: Pixels, tolerance = 40, margin = 0.015): { l: number; t: number; r: number; b: number } | null {
  const { data, width, height } = src;
  const at = (x: number, y: number) => (y * width + x) * 4;
  const bg = [0, 1, 2].map((ch) => {
    const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)].map((i) => data[i + ch]).sort((p, q) => p - q);
    return (corners[1] + corners[2]) / 2;
  });
  let l = width, t = height, r = -1, b = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = at(x, y);
      const diff = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
      if (diff > tolerance) {
        if (x < l) l = x;
        if (x > r) r = x;
        if (y < t) t = y;
        if (y > b) b = y;
      }
    }
  }
  if (r < 0) return null;
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return {
    l: clamp(l / width - margin), t: clamp(t / height - margin),
    r: clamp((r + 1) / width + margin), b: clamp((b + 1) / height + margin),
  };
}

export interface TextRun {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  size: number;
}

export interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

export function pageMap(shownTransform: number[], quad: [Point, Point, Point, Point], width: number, height: number): Mat3 {
  const toPixels = affine3(shownTransform);
  return mul3(invert3(toPixels), mul3(straightenMap(quad, width, height), toPixels));
}

export function moveTextRuns(items: TextItemLike[], map: Mat3): TextRun[] {
  const runs: TextRun[] = [];
  for (const item of items) {
    if (!item.str.trim()) continue;
    const [a, b, c, d, e, f] = item.transform;
    const along = Math.hypot(a, b), up = Math.hypot(c, d);
    if (along === 0 || up === 0 || item.width <= 0) continue;
    const height = item.height > 0 ? item.height : up;
    const start: Point = [e, f];
    const end: Point = [e + (a / along) * item.width, f + (b / along) * item.width];
    const top: Point = [e + (c / up) * height, f + (d / up) * height];
    const [x0, y0] = apply3(map, start);
    const [x1, y1] = apply3(map, end);
    const [tx, ty] = apply3(map, top);
    runs.push({ text: item.str, x0, y0, x1, y1, size: Math.hypot(tx - x0, ty - y0) });
  }
  return runs;
}

export function affine6(m: Mat3): [number, number, number, number, number, number] {
  return [m[0], m[3], m[1], m[4], m[2], m[5]];
}

export function reproject(from: number[], to: number[]): [number, number, number, number, number, number] {
  return affine6(mul3(affine3(to), invert3(affine3(from))));
}

export interface AdjustSetting {
  page: number;
  mode: "crop" | "straighten";
  crop: { l: number; t: number; r: number; b: number };
  flipH: boolean;
  flipV: boolean;
  quad: [Point, Point, Point, Point];
}

export interface ViewportLike {
  width: number;
  height: number;
  convertToPdfPoint(x: number, y: number): number[];
}

export interface DocLike {
  getPage(n: number): Promise<{ rotate: number; getViewport(o: { scale: number; rotation: number }): ViewportLike }>;
}

export function cropAdjustment(s: AdjustSetting, vp: ViewportLike, rotation: number): PageAdjust {
  const { l, t, r, b } = s.crop;
  const full = l <= 1e-4 && t <= 1e-4 && r >= 1 - 1e-4 && b >= 1 - 1e-4;
  const [x1, y1] = vp.convertToPdfPoint(l * vp.width, t * vp.height);
  const [x2, y2] = vp.convertToPdfPoint(r * vp.width, b * vp.height);
  const sideways = rotation % 180 !== 0;
  return {
    page: s.page,
    ...(full ? {} : { crop: [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)] as [number, number, number, number] }),
    flipH: sideways ? s.flipV : s.flipH,
    flipV: sideways ? s.flipH : s.flipV,
  };
}

export async function buildPageAdjustments(
  doc: DocLike,
  viewerRotation: number,
  settings: AdjustSetting[],
): Promise<{ crops: PageAdjust[]; warps: { page: number; quad: [Point, Point, Point, Point] }[] }> {
  const crops: PageAdjust[] = [];
  const warps: { page: number; quad: [Point, Point, Point, Point] }[] = [];
  for (const s of settings) {
    if (s.mode === "straighten") {
      warps.push({ page: s.page, quad: s.quad });
      continue;
    }
    const page = await doc.getPage(s.page);
    const rotation = (page.rotate + viewerRotation) % 360;
    crops.push(cropAdjustment(s, page.getViewport({ scale: 1, rotation }), rotation));
  }
  return { crops, warps };
}
