/** Pixels as in ImageData: RGBA, row by row. */
export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export type Point = [number, number];

/**
 * The projective map that sends the unit square (0,0) (1,0) (1,1) (0,1)
 * onto `quad` (same order: top left, top right, bottom right, bottom left).
 * Returns a function from (u, v) in the square to the point in the quad.
 */
export function squareToQuad(quad: [Point, Point, Point, Point]): (u: number, v: number) => Point {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    // A parallelogram: the map is affine.
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

/**
 * Straightens the area of `src` inside `quad` (pixel corners: top left,
 * top right, bottom right, bottom left) into a `width` × `height` picture,
 * with bilinear sampling. Outside the source reads as white.
 */
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

/**
 * The box around what is drawn on a page (pixels that differ from the
 * page colour, read at its corners), as fractions of the picture, with a
 * small margin; null when the page is blank.
 */
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
