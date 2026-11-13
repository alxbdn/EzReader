/**
 * Reads a list of pages such as "1-3, 5, 8-" (1-based, within 1…count).
 * Empty or "all" means every page. Returns null when the text is not a
 * valid list or names no page.
 */
export function parsePageRange(text: string, count: number): number[] | null {
  const t = text.trim().toLowerCase();
  if (t === "" || t === "all" || /^all\b/.test(t) || /^tout/.test(t)) {
    return Array.from({ length: count }, (_, i) => i + 1);
  }
  const pages = new Set<number>();
  for (const part of t.split(/[,;]/)) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(\d*)\s*[-–]\s*(\d*)$/.exec(p);
    if (m) {
      const a = m[1] ? Number(m[1]) : 1;
      const b = m[2] ? Number(m[2]) : count;
      if (a < 1 || b > count || a > b) return null;
      for (let n = a; n <= b; n++) pages.add(n);
    } else if (/^\d+$/.test(p)) {
      const n = Number(p);
      if (n < 1 || n > count) return null;
      pages.add(n);
    } else {
      return null;
    }
  }
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
