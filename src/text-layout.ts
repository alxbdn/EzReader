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

interface RawCell { text: string; x: number; right: number }
interface RawLine { cells: RawCell[]; size: number; y: number; right: number }

const CELL_GAP = 2.2;

const bucket = (x: number): number => Math.round(x / 1.5);

/** "12", "-3.5", "1 234,50", "(12.00)", "€ 4,99", "15 %": the values a table column holds. */
export function looksNumeric(s: string): boolean {
  const t = s.trim();
  return /\d/.test(t) && /^[-−+(]?\s?[€$£¥]?\s?[\d\s  .,']+\s?(%|[€$£¥])?\)?-?$/.test(t);
}

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

  // Where text starts or ends after/before a gap, counted over the page:
  // columns line up on their left edge (text) or their right edge (numbers).
  const starts = new Map<number, number>();
  const ends = new Map<number, number>();
  for (const g of groups) {
    const seenStart = new Set<number>();
    const seenEnd = new Set<number>();
    let end = g.length ? g[0].x + g[0].width : 0;
    for (let i = 1; i < g.length; i++) {
      if (g[i].x - end > g[i].size * 0.3) {
        seenStart.add(bucket(g[i].x));
        seenEnd.add(bucket(end));
      }
      end = Math.max(end, g[i].x + g[i].width);
    }
    for (const b of seenStart) starts.set(b, (starts.get(b) ?? 0) + 1);
    for (const b of seenEnd) ends.set(b, (ends.get(b) ?? 0) + 1);
  }
  const lined = (counts: Map<number, number>, x: number): boolean =>
    [-1, 0, 1].some((d) => (counts.get(bucket(x) + d) ?? 0) >= 3);

  return groups.map((g) => {
    const size = Math.max(...g.map((r) => r.size));
    const cells: RawCell[] = [];
    let end = -Infinity;
    for (const r of g) {
      const gap = r.x - end;
      const cell = cells[cells.length - 1];
      const split = !cell
        || gap > Math.max(size * CELL_GAP, 14)
        || (gap > size * 0.3 && (lined(starts, r.x) || lined(ends, end)))
        || (gap > size * 0.5 && looksNumeric(r.str) && looksNumeric(cell.text));
      if (split) {
        cells.push({ text: r.str, x: r.x, right: r.x + r.width });
      } else {
        const needsSpace = gap > size * 0.15 && !/\s$/.test(cell.text) && !/^\s/.test(r.str);
        cell.text += (needsSpace ? " " : "") + r.str;
        cell.right = Math.max(cell.right, r.x + r.width);
      }
      end = Math.max(end, r.x + r.width);
    }
    for (const c of cells) c.text = c.text.replace(/\s+/g, " ").trim();
    return { cells: cells.filter((c) => c.text !== ""), size, y: g[0].y, right: end };
  }).filter((l) => l.cells.length > 0);
}

/** Runs of lines that form a table: lines of several cells, and the one-cell rows between them. */
function tableRegions(lines: RawLine[]): [number, number][] {
  const multi = lines.map((l) => l.cells.length > 1);
  const close = (a: RawLine, b: RawLine): boolean => b.y - a.y <= Math.max(a.size, b.size) * 2.6;
  const inTable = multi.map((m, i) => m || (i > 0 && i < lines.length - 1 && multi[i - 1] && multi[i + 1]
    && close(lines[i - 1], lines[i]) && close(lines[i], lines[i + 1])));
  const regions: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!inTable[i]) continue;
    let j = i;
    while (j + 1 < lines.length && inTable[j + 1]) j++;
    regions.push([i, j]);
    i = j;
  }
  return regions;
}

/**
 * The columns of a table, as x ranges: where its cells overlap from row to
 * row. A cell that spans several columns (a header over two) is left out,
 * else it would glue them together.
 */
export function tableColumns(rows: { x: number; right: number }[][]): [number, number][] {
  const cells = rows.flat();
  if (cells.length === 0) return [];
  const lo = Math.floor(Math.min(...cells.map((c) => c.x)));
  const hi = Math.ceil(Math.max(...cells.map((c) => c.right)));
  const cover = new Array<number>(hi - lo + 1).fill(0);
  const span = (c: { x: number; right: number }): [number, number] =>
    [Math.floor(c.x) - lo, Math.max(Math.floor(c.x) - lo, Math.ceil(c.right) - lo - 1)];
  for (const c of cells) {
    const [a, b] = span(c);
    for (let i = a; i <= b; i++) cover[i]++;
  }
  const spans = (c: { x: number; right: number }): boolean => {
    const [a, b] = span(c);
    let seenShared = false, alone = false;
    for (let i = a; i <= b; i++) {
      if (cover[i] >= 2) {
        if (alone && seenShared) return true;
        seenShared = true;
      } else if (seenShared) alone = true;
    }
    return false;
  };
  const kept = cells.filter((c) => !spans(c));
  const intervals = (kept.length ? kept : cells).map((c) => [c.x, c.right] as [number, number]).sort((a, b) => a[0] - b[0]);
  const columns: [number, number][] = [];
  for (const [a, b] of intervals) {
    const last = columns[columns.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else columns.push([a, b]);
  }
  return columns;
}

/** The column a cell belongs to: the one it overlaps most (the first one for a spanning cell). */
export function columnFor(cell: { x: number; right: number }, columns: [number, number][]): number {
  let best = -1, bestOverlap = 0;
  for (let i = 0; i < columns.length; i++) {
    const overlap = Math.min(cell.right, columns[i][1]) - Math.max(cell.x, columns[i][0]);
    if (overlap > 0 && best < 0) { best = i; bestOverlap = overlap; }
    else if (overlap > bestOverlap && overlap >= (cell.right - cell.x) * 0.75) { best = i; bestOverlap = overlap; }
  }
  if (best >= 0) return best;
  let nearest = 0, dist = Infinity;
  for (let i = 0; i < columns.length; i++) {
    const d = Math.max(columns[i][0] - cell.right, cell.x - columns[i][1], 0);
    if (d < dist) { dist = d; nearest = i; }
  }
  return nearest;
}

interface PlacedLine { line: RawLine; cols: number[] }

/**
 * Lines up the cells of each table in columns, and folds a cell that wraps
 * onto a second line back into its row: a line right under a row, with
 * only text, and nothing in the first column.
 */
function placeTables(raw: RawLine[]): PlacedLine[] {
  const placed: PlacedLine[] = raw.map((line) => ({ line, cols: line.cells.map(() => 0) }));
  const keep = new Array<boolean>(raw.length).fill(true);
  for (const [from, to] of tableRegions(raw)) {
    const rows = raw.slice(from, to + 1);
    const columns = tableColumns(rows.map((l) => l.cells));
    for (let i = from; i <= to; i++) placed[i].cols = raw[i].cells.map((c) => columnFor(c, columns));
    let head = from;
    for (let i = from + 1; i <= to; i++) {
      const row = placed[head], next = placed[i];
      const gap = next.line.y - row.line.y;
      const wraps = columns.length > 2
        && next.line.cells.length < row.line.cells.length
        && !next.cols.includes(0) && row.cols.includes(0)
        && next.line.cells.every((c) => !looksNumeric(c.text))
        && next.cols.every((c) => row.cols.includes(c))
        && gap > 0 && gap <= Math.max(row.line.size, next.line.size) * 1.45;
      if (!wraps) { head = i; continue; }
      next.line.cells.forEach((c, k) => {
        const at = row.cols.indexOf(next.cols[k]);
        row.line.cells[at] = { ...row.line.cells[at], text: `${row.line.cells[at].text} ${c.text}` };
      });
      keep[i] = false;
    }
  }
  return placed.filter((_, i) => keep[i]);
}

export function layoutPage(runs: TextRun[], number: number, width: number, height: number, bodySize: number): TextPage {
  const placed = placeTables(toLines(runs));
  const raw = placed.map((p) => p.line);
  const rightEdge = Math.max(0, ...raw.map((l) => l.right));
  const leftEdge = Math.min(Infinity, ...raw.map((l) => l.cells[0].x));

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
      cells: l.cells.map((c, k) => ({ text: c.text, x: round(c.x), col: placed[i].cols[k] })),
      size: round(l.size),
      top: round(l.y - l.size),
      paraStart,
      heading,
    };
  });
  return { number, width: round(width), height: round(height), lines };
}

function headingLevel(size: number, body: number, cells: { text: string }[]): number {
  if (cells.length > 1 || body <= 0) return 0;
  const length = cells[0].text.length;
  if (length > 200) return 0;
  if (size >= body * 1.45) return 1;
  if (size >= body * 1.15) return 2;
  return 0;
}

export function normalizeHeadings(pages: TextPage[]): void {
  const sizes = pages.flatMap((p) => p.lines.filter((l) => l.heading > 0).map((l) => l.size));
  if (sizes.length === 0) return;
  const top = Math.max(...sizes);
  for (const p of pages) {
    for (const l of p.lines) if (l.heading > 0) l.heading = l.size >= top * 0.95 ? 1 : 2;
  }
}

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

export function textLength(doc: TextDoc): number {
  return doc.pages.reduce((n, p) => n + p.lines.reduce((m, l) => m + l.cells.reduce((k, c) => k + c.text.length, 0), 0), 0);
}

function round(v: number): number { return Math.round(v * 100) / 100; }
