/** A run of pages, 1-based and inclusive. */
export interface PageSpan {
  start: number;
  end: number;
}

/**
 * Reads page runs such as "1-3, 5, 8-" (1-based, within 1…count), in the
 * order typed. "-3" starts at the first page, "8-" ends at the last; parts
 * are separated by "," or ";". Empty text gives []. Returns null when the
 * text is not a valid list.
 */
export function parsePageSpans(text: string, count: number): PageSpan[] | null {
  const spans: PageSpan[] = [];
  for (const part of text.trim().split(/[,;]/)) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(\d*)\s*[-–]\s*(\d*)$/.exec(p);
    if (m) {
      const a = m[1] ? Number(m[1]) : 1;
      const b = m[2] ? Number(m[2]) : count;
      if (a < 1 || b > count || a > b) return null;
      spans.push({ start: a, end: b });
    } else if (/^\d+$/.test(p)) {
      const n = Number(p);
      if (n < 1 || n > count) return null;
      spans.push({ start: n, end: n });
    } else {
      return null;
    }
  }
  return spans;
}

/**
 * Reads a list of pages such as "1-3, 5, 8-" (see `parsePageSpans`).
 * Empty or "all" means every page. Returns the pages sorted, without
 * repeats, or null when the text is not a valid list or names no page.
 */
export function parsePageRange(text: string, count: number): number[] | null {
  const t = text.trim().toLowerCase();
  if (t === "" || t === "all" || /^all\b/.test(t) || /^tout/.test(t)) {
    return Array.from({ length: count }, (_, i) => i + 1);
  }
  const spans = parsePageSpans(t, count);
  if (!spans) return null;
  const pages = new Set<number>();
  for (const { start, end } of spans) for (let n = start; n <= end; n++) pages.add(n);
  return pages.size > 0 ? [...pages].sort((x, y) => x - y) : null;
}

/** Writes sorted pages the short way: [2, 3, 4, 7] → "2-4, 7". */
export function formatPageRange(pages: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    parts.push(j === i ? String(pages[i]) : `${pages[i]}-${pages[j]}`);
    i = j;
  }
  return parts.join(", ");
}
