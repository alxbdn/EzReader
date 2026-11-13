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

/** A 3×3 matrix, row by row, acting on column vectors [x, y, 1]. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** The 3×3 form of a pdf.js / canvas affine transform [a, b, c, d, e, f]. */
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

/**
 * Where straightening moves each point: `quad` (fractions of a `width` ×
 * `height` picture, as for `warpToRect`) becomes the whole picture. Returns
 * the map in picture pixels: a point inside the quad goes to where
 * `warpToRect` draws it.
 */
export function straightenMap(quad: [Point, Point, Point, Point], width: number, height: number): Mat3 {
  // warpToRect samples pixel (u·width, v·height) at H·(u, v): invert it.
  const px = quad.map(([x, y]) => [x * width, y * height] as Point) as [Point, Point, Point, Point];
  const H = quadMatrix(px);
  const toPixels: Mat3 = [width, 0, 0, 0, height, 0, 0, 0, 1];
  return mul3(toPixels, invert3(H));
}

/** The projective matrix sending the unit square's corners (0,0) (1,0) (1,1) (0,1) to `q`. */
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
