import type { RgbColor } from "./models";

/** RGBA pixels, as in an ImageData. */
export interface Pixels { data: Uint8ClampedArray; width: number; height: number }

/** The longest side of a saved stamp, in pixels. */
export const STAMP_MAX_SIDE = 600;
/** The cut-out strength the dialog starts at. */
export const DEFAULT_CUTOUT = 50;

const MAX_DIST = Math.sqrt(3 * 255 * 255);

/** True when a fair share of the pixels are see-through: the picture already has no paper. */
export function hasTransparency(px: Pixels): boolean {
  const { data } = px;
  let clear = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) clear++;
  return clear > (data.length / 4) * 0.01;
}

/** The paper colour: the median of the opaque pixels along the edges, or null when there are none. */
export function paperColor(px: Pixels): RgbColor | null {
  const { data, width: w, height: h } = px;
  const ring = Math.max(1, Math.round(Math.min(w, h) * 0.04));
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  const take = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    if (data[i + 3] < 250) return;
    rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < ring || y < ring || x >= w - ring || y >= h - ring) take(x, y);
    }
  }
  if (rs.length === 0) return null;
  const median = (a: number[]) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
  return { r: median(rs), g: median(gs), b: median(bs) };
}

/**
 * Makes the paper see-through: pixels close to `paper` fade out, with a soft edge, and the colour
 * of the half-faded ones is unmixed from the paper so no light halo is left around the ink.
 * `strength` goes from 0 (keep almost everything) to 100 (keep only the strongest ink).
 */
export function cutOut(px: Pixels, paper: RgbColor, strength: number): void {
  const { data } = px;
  const s = Math.min(100, Math.max(0, strength)) / 100;
  const lo = (0.03 + s * 0.32) * MAX_DIST;
  const hi = lo + (0.08 + s * 0.12) * MAX_DIST;
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - paper.r, dg = data[i + 1] - paper.g, db = data[i + 2] - paper.b;
    const d = Math.sqrt(dr * dr + dg * dg + db * db);
    const a = d <= lo ? 0 : d >= hi ? 1 : (d - lo) / (hi - lo);
    if (a > 0 && a < 1) {
      // The pixel is a mix of ink and paper: keep the ink's own colour.
      const k = Math.max(a, d / MAX_DIST);
      data[i] = paper.r + dr / k;
      data[i + 1] = paper.g + dg / k;
      data[i + 2] = paper.b + db / k;
    }
    data[i + 3] = Math.round(data[i + 3] * a);
  }
}

/** Paints every pixel in `color`, keeping its transparency. */
export function recolor(px: Pixels, color: RgbColor): void {
  const { data } = px;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = color.r;
    data[i + 1] = color.g;
    data[i + 2] = color.b;
  }
}

/** The box around the pixels that show, or null when the picture is empty. */
export function visibleBounds(px: Pixels): { x: number; y: number; w: number; h: number } | null {
  const { data, width: w, height: h } = px;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** The scale that brings a `w` × `h` picture within `max` pixels on its longest side. */
export function fitScale(w: number, h: number, max = STAMP_MAX_SIDE): number {
  return Math.min(1, max / Math.max(w, h, 1));
}

export interface StampSettings {
  /** Cut-out strength, or null to keep the picture's own transparency. */
  cutout: number | null;
  /** The ink colour, or null for the picture's own colours. */
  color: RgbColor | null;
}

/**
 * The stamp drawn from `img`: paper removed, recoloured if asked, transparent margins trimmed,
 * at most STAMP_MAX_SIDE pixels. Null when nothing is left.
 */
export function makeStamp(img: CanvasImageSource & { width: number; height: number }, settings: StampSettings): HTMLCanvasElement | null {
  const k = fitScale(img.width, img.height);
  const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  const id = ctx.getImageData(0, 0, w, h);
  const px: Pixels = { data: id.data, width: w, height: h };
  if (settings.cutout !== null) {
    const paper = paperColor(px);
    if (paper) cutOut(px, paper, settings.cutout);
  }
  if (settings.color) recolor(px, settings.color);
  const box = visibleBounds(px);
  if (!box) return null;
  ctx.putImageData(id, 0, 0);
  if (box.w === w && box.h === h) return c;
  const out = document.createElement("canvas");
  out.width = box.w;
  out.height = box.h;
  out.getContext("2d")!.drawImage(c, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  c.width = c.height = 0;
  return out;
}

/** `img` recoloured in `color`, as PNG base64 (without the data: prefix). */
export function tintedPng(img: HTMLImageElement, color: RgbColor): string | null {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d");
  if (!ctx || c.width === 0) return null;
  ctx.drawImage(img, 0, 0);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = `rgb(${color.r} ${color.g} ${color.b})`;
  ctx.fillRect(0, 0, c.width, c.height);
  return c.toDataURL("image/png").split(",")[1] ?? null;
}
