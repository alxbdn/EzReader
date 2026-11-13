/**
 * Turns the text runs of a page (as pdf.js gives them: a string, where it
 * starts and how big it is) into lines and cells for "Convert" (Word,
 * Excel, RTF, HTML, text, XML). The writers in Rust group the lines into
 * paragraphs and tables.
 */

/** One run of text, in points, `y` being its baseline from the top of the page. */
export interface TextRun {
  str: string;
  x: number;
  y: number;
  width: number;
  size: number;
}

export interface TextCell { text: string; x: number; col: number }

export interface TextLine {
  cells: TextCell[];
  size: number;
  top: number;
  paraStart: boolean;
  heading: number;
}

export interface TextPage { number: number; width: number; height: number; lines: TextLine[] }

export interface TextDoc { title: string; pages: TextPage[] }

/** Lines of a page before the document-wide parts (titles) are known. */
interface RawLine { cells: TextCell[]; size: number; y: number; right: number }

/** A gap this wide (in font sizes) between two runs splits them into cells. */
const CELL_GAP = 2.2;
/** Cells starting within this many points of each other are one column. */
const COLUMN_TOLERANCE = 12;

/** Rounds a left edge so that runs starting within ~1.5 pt compare equal. */
const bucket = (x: number): number => Math.round(x / 1.5);

/**
 * Groups `runs` into lines (top to bottom), and each line into cells: runs
 * split on a wide gap, or on a narrower one where at least 3 lines have a
 * run starting at the same place (the columns of a tight table).
 */
function toLines(runs: TextRun[]): RawLine[] {
  const sorted = runs
    .filter((r) => r.str.trim() !== "" && Number.isFinite(r.x) && Number.isFinite(r.y) && r.size > 0)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const groups: TextRun[][] = [];
  for (const r of sorted) {
    const g = groups[groups.length - 1];
    const ref = g?.[0];
    if (ref && Math.abs(r.y - ref.y) < Math.max(ref.size, r.size) * 0.5) g.push(r);
    else groups.push([r]);
  }
  for (const g of groups) g.sort((a, b) => a.x - b.x);

  // Left edges of runs that follow a visible gap, and how many lines have one there.
  const gapAfter = (g: TextRun[], i: number): number =>
    g[i].x - Math.max(...g.slice(0, i).map((r) => r.x + r.width));
  const starts = new Map<number, number>();
  for (const g of groups) {
    const seen = new Set<number>();
    for (let i = 1; i < g.length; i++) {
      if (gapAfter(g, i) > g[i].size * 0.3) seen.add(bucket(g[i].x));
    }
    for (const b of seen) starts.set(b, (starts.get(b) ?? 0) + 1);
  }
  const aligned = (x: number): boolean =>
    [-1, 0, 1].some((d) => (starts.get(bucket(x) + d) ?? 0) >= 3);

  return groups.map((g) => {
    const size = Math.max(...g.map((r) => r.size));
    const cells: TextCell[] = [];
    let end = -Infinity;
    for (const r of g) {
      const gap = r.x - end;
      const cell = cells[cells.length - 1];
      if (!cell || gap > Math.max(size * CELL_GAP, 14) || (gap > size * 0.3 && aligned(r.x))) {
        cells.push({ text: r.str, x: r.x, col: 0 });
      } else {
        const needsSpace = gap > size * 0.15 && !/\s$/.test(cell.text) && !/^\s/.test(r.str);
        cell.text += (needsSpace ? " " : "") + r.str;
      }
      end = Math.max(end, r.x + r.width);
    }
    for (const c of cells) c.text = c.text.replace(/\s+/g, " ").trim();
    return { cells: cells.filter((c) => c.text !== ""), size, y: g[0].y, right: end };
  }).filter((l) => l.cells.length > 0);
}

/** Left edges the multi-cell lines (table rows) of a page line up on. */
function columnAnchors(lines: RawLine[]): number[] {
  const xs = lines.filter((l) => l.cells.length > 1).flatMap((l) => l.cells.map((c) => c.x)).sort((a, b) => a - b);
  const anchors: number[] = [];
  for (const x of xs) {
    if (anchors.length === 0 || x - anchors[anchors.length - 1] > COLUMN_TOLERANCE) anchors.push(x);
  }
  return anchors;
}

function columnOf(x: number, anchors: number[]): number {
  let col = 0;
  for (let i = 0; i < anchors.length; i++) if (anchors[i] <= x + COLUMN_TOLERANCE) col = i;
  return col;
}

/**
 * Lays out one page. `bodySize` is the usual text size of the document:
 * lines clearly bigger are titles (1 = big, 2 = a bit bigger).
 */
export function layoutPage(runs: TextRun[], number: number, width: number, height: number, bodySize: number): TextPage {
  const raw = toLines(runs);
  const anchors = columnAnchors(raw);
  const rightEdge = Math.max(0, ...raw.map((l) => l.right));
  const leftEdge = Math.min(Infinity, ...raw.map((l) => l.cells[0].x));

  // Usual distance between two lines of the same paragraph.
  const steps = raw.slice(1).map((l, i) => l.y - raw[i].y).filter((d) => d > 0).sort((a, b) => a - b);
  const step = steps.length ? steps[Math.floor(steps.length / 2)] : bodySize * 1.2;

  const lines: TextLine[] = raw.map((l, i) => {
    const heading = headingLevel(l.size, bodySize, l.cells);
    const prev = raw[i - 1];
    let paraStart = true;
    if (prev) {
      const gap = l.y - prev.y;
      const sameSize = Math.abs(l.size - prev.size) <= Math.max(l.size, prev.size) * 0.15;
      const prevText = prev.cells[prev.cells.length - 1].text;
      const prevEnded = prev.right < rightEdge - Math.max(4 * prev.size, (rightEdge - leftEdge) * 0.15)
        && /[.!?:;»"”)]$/.test(prevText);
      const indented = l.cells[0].x > prev.cells[0].x + l.size && prev.cells[0].x <= leftEdge + l.size;
      paraStart = !sameSize || gap > Math.max(step * 1.35, l.size * 1.6) || gap < 0 || prevEnded || indented
        || l.cells.length > 1 || prev.cells.length > 1;
    }
    return {
      cells: l.cells.map((c) => ({ text: c.text, x: round(c.x), col: columnOf(c.x, anchors) })),
      size: round(l.size),
      top: round(l.y - l.size),
      paraStart,
      heading,
    };
  });
  return { number, width: round(width), height: round(height), lines };
}

function headingLevel(size: number, body: number, cells: TextCell[]): number {
  if (cells.length > 1 || body <= 0) return 0;
  const length = cells[0].text.length;
  if (length > 200) return 0;
  if (size >= body * 1.45) return 1;
  if (size >= body * 1.15) return 2;
  return 0;
}

/**
 * Makes title levels consistent across the document: the largest titles
 * are level 1, every smaller title level 2.
 */
export function normalizeHeadings(pages: TextPage[]): void {
  const sizes = pages.flatMap((p) => p.lines.filter((l) => l.heading > 0).map((l) => l.size));
  if (sizes.length === 0) return;
  const top = Math.max(...sizes);
  for (const p of pages) {
    for (const l of p.lines) if (l.heading > 0) l.heading = l.size >= top * 0.95 ? 1 : 2;
  }
}

/** The size most of the text is written in (weighted by characters). */
export function bodySize(runs: TextRun[]): number {
  const weight = new Map<number, number>();
  for (const r of runs) {
    if (!(r.size > 0)) continue;
    const k = Math.round(r.size * 2) / 2;
    weight.set(k, (weight.get(k) ?? 0) + r.str.trim().length);
  }
  let best = 0, bestW = -1;
  for (const [k, w] of weight) if (w > bestW || (w === bestW && k < best)) { best = k; bestW = w; }
  return best || 11;
}

/** Number of characters of text in `doc` (0 for a scan without text). */
export function textLength(doc: TextDoc): number {
  return doc.pages.reduce((n, p) => n + p.lines.reduce((m, l) => m + l.cells.reduce((k, c) => k + c.text.length, 0), 0), 0);
}

function round(v: number): number { return Math.round(v * 100) / 100; }
