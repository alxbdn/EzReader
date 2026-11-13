import { affine3, apply3, invert3, mul3, straightenMap, type Mat3, type Point } from "./warp";

/** A run of text after straightening, in PDF user space (see `straighten_pages`). */
export interface TextRun {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  size: number;
}

/** What pdf.js's getTextContent gives for a run of text. */
export interface TextItemLike {
  str: string;
  /** [a, b, c, d, e, f] in PDF user space; (e, f) is where the baseline starts. */
  transform: number[];
  width: number;
  height: number;
}

/**
 * Where straightening moves each point of the page, in PDF user space.
 * `shownTransform` is the viewport transform the page was rendered with
 * (user space → pixels of a `width` × `height` picture) and `quad` the area
 * stretched over that whole picture (fractions of it).
 */
export function pageMap(shownTransform: number[], quad: [Point, Point, Point, Point], width: number, height: number): Mat3 {
  const toPixels = affine3(shownTransform);
  return mul3(invert3(toPixels), mul3(straightenMap(quad, width, height), toPixels));
}

/** The text runs of a page, moved by `map`; empty runs are left out. */
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
