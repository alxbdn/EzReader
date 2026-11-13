import type { InkVector } from "./models";

/** Colour of a drawn signature (same on screen and in the PDF). */
export const SIGNATURE_INK = { r: 15, g: 15, b: 35 };

// ── Smoothing algorithms (ported from full-rust branch) ──────────────────────

/** Douglas-Peucker polyline simplification. */
function douglasPeucker(points: [number, number][], epsilon: number): [number, number][] {
  const n = points.length;
  if (n <= 2) return points.slice();

  const [ax, ay] = points[0];
  const [bx, by] = points[n - 1];
  const lineLen = Math.max(Math.hypot(bx - ax, by - ay), 0.001);

  let maxDist = 0;
  let maxIdx = 0;
  for (let i = 1; i < n - 1; i++) {
    const [px, py] = points[i];
    const dist = Math.abs((by - ay) * px - (bx - ax) * py + bx * ay - by * ax) / lineLen;
    if (dist > maxDist) { maxDist = dist; maxIdx = i; }
  }

  if (maxDist > epsilon) {
    const left = douglasPeucker(points.slice(0, maxIdx + 1), epsilon);
    const right = douglasPeucker(points.slice(maxIdx), epsilon);
    left.pop();
    return left.concat(right);
  }
  return [points[0], points[n - 1]];
}

/** Smooth point positions with moving average, keeping endpoints fixed. */
function smoothPoints(points: [number, number][], window: number): [number, number][] {
  const n = points.length;
  if (n <= 2) return points.slice();
  const half = Math.floor(window / 2);
  const result: [number, number][] = [points[0]];
  for (let i = 1; i < n - 1; i++) {
    const start = Math.max(0, i - half);
    const end = Math.min(n, i + half + 1);
    let sx = 0, sy = 0;
    for (let j = start; j < end; j++) { sx += points[j][0]; sy += points[j][1]; }
    const count = end - start;
    result.push([sx / count, sy / count]);
  }
  result.push(points[n - 1]);
  return result;
}

/** Smooth a float array with moving average, keeping endpoints fixed. */
function smoothValues(values: number[], window: number): number[] {
  const n = values.length;
  if (n <= 2) return values.slice();
  const half = Math.floor(window / 2);
  const result = [values[0]];
  for (let i = 1; i < n - 1; i++) {
    const start = Math.max(0, i - half);
    const end = Math.min(n, i + half + 1);
    let sum = 0;
    for (let j = start; j < end; j++) sum += values[j];
    result.push(sum / (end - start));
  }
  result.push(values[n - 1]);
  return result;
}

/**
 * The pen strokes as round-capped Bézier segments, each with its own width
 * (thicker where the pen moves vertically): x0 y0 c1x c1y c2x c2y x1 y1 width,
 * 9 numbers per segment, in the coordinates of the strokes.
 */
export function strokeSegments(strokes: [number, number][][]): number[] {
  const segs: number[] = [];
  for (const rawPoints of strokes) {
    if (rawPoints.length < 2) continue;

    let pts = douglasPeucker(rawPoints, 1.0);
    if (pts.length < 2) continue;

    for (let p = 0; p < 2; p++) pts = smoothPoints(pts, 3);
    if (pts.length < 2) continue;

    const n = pts.length;

    const rawWidths: number[] = [];
    for (let i = 0; i < n; i++) {
      const [dx, dy] = i === 0
        ? [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]]
        : i === n - 1
          ? [pts[n - 1][0] - pts[n - 2][0], pts[n - 1][1] - pts[n - 2][1]]
          : [pts[i + 1][0] - pts[i - 1][0], pts[i + 1][1] - pts[i - 1][1]];
      const len = Math.max(Math.hypot(dx, dy), 0.001);
      const verticality = Math.abs(dy / len);
      const minW = 0.8;
      const maxW = 4.0;
      rawWidths.push(minW + verticality * (maxW - minW));
    }

    let widths = rawWidths;
    for (let p = 0; p < 4; p++) widths = smoothValues(widths, 7);

    for (let i = 0; i < n - 1; i++) {
      const p0 = i > 0 ? pts[i - 1] : pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = i + 2 < n ? pts[i + 2] : pts[i + 1];

      segs.push(
        p1[0], p1[1],
        p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
        p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
        p2[0], p2[1],
        (widths[i] + widths[i + 1]) * 0.5,
      );
    }
  }
  return segs;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * The segments moved into the smallest box that holds their ink (half the
 * widest line as margin), or null when there is no ink.
 */
export function fitVector(segs: number[]): InkVector | null {
  if (segs.length < 9) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxW = 0;
  for (let i = 0; i < segs.length; i += 9) {
    for (let k = 0; k < 8; k += 2) {
      minX = Math.min(minX, segs[i + k]); maxX = Math.max(maxX, segs[i + k]);
      minY = Math.min(minY, segs[i + k + 1]); maxY = Math.max(maxY, segs[i + k + 1]);
    }
    maxW = Math.max(maxW, segs[i + 8]);
  }
  const m = maxW / 2 + 1;
  const ox = minX - m, oy = minY - m;
  const out = segs.map((v, i) => {
    const k = i % 9;
    return round2(k === 8 ? v : k % 2 === 0 ? v - ox : v - oy);
  });
  return { w: round2(maxX - minX + 2 * m), h: round2(maxY - minY + 2 * m), segs: out };
}

/** Draws `v` in the context's current transform, its box at (0, 0). */
export function drawVector(ctx: CanvasRenderingContext2D, v: InkVector): void {
  const { r, g, b } = SIGNATURE_INK;
  ctx.save();
  ctx.strokeStyle = `rgb(${r}, ${g}, ${b})`;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const s = v.segs;
  for (let i = 0; i + 8 < s.length; i += 9) {
    ctx.lineWidth = s[i + 8];
    ctx.beginPath();
    ctx.moveTo(s[i], s[i + 1]);
    ctx.bezierCurveTo(s[i + 2], s[i + 3], s[i + 4], s[i + 5], s[i + 6], s[i + 7]);
    ctx.stroke();
  }
  ctx.restore();
}

/** `v` as a PNG data URL, `scale` pixels per box unit (for thumbnails and the placing preview). */
export function vectorToPng(v: InkVector, scale: number): string {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(v.w * scale));
  c.height = Math.max(1, Math.ceil(v.h * scale));
  const ctx = c.getContext("2d")!;
  ctx.scale(scale, scale);
  drawVector(ctx, v);
  return c.toDataURL("image/png");
}
