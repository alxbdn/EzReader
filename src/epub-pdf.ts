import { DataUrls, type BookInfo, type Chapter, type EpubBook } from "./epub-book";
import { BASE_CSS } from "./epub-reader";

/** Paper look: black text on white, no reader frame. Page size and margins come from the print settings. */
export const PRINT_CSS = `
html { font-size: 11pt !important; background: #fff !important; color: #000 !important; }
body { margin: 0 !important; padding: 0 !important; max-width: none !important; background: #fff !important; color: #000 !important; }
img, svg, figure, table { break-inside: avoid; }
img { max-width: 100% !important; max-height: 100vh; height: auto; }
h1, h2, h3, h4, h5, h6 { break-after: avoid; }
p { orphans: 2; widows: 2; }
a { color: inherit; text-decoration: none; }
`;

/** Nothing loads or runs in the printed page except its own styles and inlined pictures. */
const PRINT_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

/** A standalone HTML page for one chapter, ready to print. */
export function printableHtml(chapter: Chapter, title: string): string {
  const doc = document.implementation.createHTMLDocument(title);
  doc.documentElement.lang = chapter.language;
  const meta = (attrs: Record<string, string>) => {
    const m = doc.createElement("meta");
    for (const [k, v] of Object.entries(attrs)) m.setAttribute(k, v);
    doc.head.prepend(m);
  };
  meta({ "http-equiv": "Content-Security-Policy", content: PRINT_CSP });
  meta({ charset: "utf-8" });
  for (const css of [BASE_CSS, ...chapter.styles, PRINT_CSS]) {
    const s = doc.createElement("style");
    s.textContent = css;
    doc.head.append(s);
  }
  if (chapter.bodyClass) doc.body.className = chapter.bodyClass;
  for (const node of Array.from(chapter.body.childNodes)) doc.body.append(doc.importNode(node, true));
  for (const a of Array.from(doc.querySelectorAll("a"))) {
    a.removeAttribute("href");
    a.removeAttribute("data-ez-target");
    a.removeAttribute("data-ez-external");
  }
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function squash(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");
}

/** The first page, from `from` on, whose text holds `label` (ignoring case, spaces and punctuation); -1 if none. */
export function findPage(texts: string[], label: string, from = 0): number {
  const needle = squash(label);
  if (needle.length < 3) return -1;
  for (let i = Math.max(0, from); i < texts.length; i++) {
    if (squash(texts[i]!).includes(needle)) return i;
  }
  return -1;
}

export interface Bookmark { title: string; page: number; depth: number }

/**
 * Bookmarks from the table of contents: each entry points to the first page of its chapter,
 * or, for a section inside a chapter, to the page where its title is printed.
 */
export async function planBookmarks(
  info: BookInfo,
  starts: number[],
  pageTexts: (chapter: number) => Promise<string[]>,
): Promise<Bookmark[]> {
  const out: Bookmark[] = [];
  const reached = new Map<number, number>();
  const seen = new Set<number>();
  for (const entry of info.toc) {
    const ch = info.spine.indexOf(entry.path);
    if (ch < 0 || starts[ch] === undefined) continue;
    let offset = 0;
    if (entry.fragment && seen.has(ch)) {
      const at = findPage(await pageTexts(ch), entry.label, reached.get(ch) ?? 0);
      if (at >= 0) offset = at;
      else offset = reached.get(ch) ?? 0;
    }
    seen.add(ch);
    reached.set(ch, offset);
    out.push({ title: entry.label, page: starts[ch]! + offset, depth: entry.depth });
  }
  return out;
}

export interface BookPdfDeps {
  /** Prints each page to a PDF, in order; returns their paths. */
  printPages(html: string[], done: (n: number) => void): Promise<string[]>;
  pageCount(path: string): Promise<number>;
  pageTexts(path: string): Promise<string[]>;
  /** Puts the chapter PDFs together; returns the path of the whole book. */
  merge(parts: { path: string; pages: number }[]): Promise<string>;
  finish(input: string, bookmarks: Bookmark[], title: string, author: string): Promise<void>;
}

/** Prints the whole book to one PDF with the table of contents as bookmarks. */
export async function bookToPdf(book: EpubBook, deps: BookPdfDeps, progress: (done: number, total: number) => void): Promise<void> {
  const { info } = book;
  const urls = new DataUrls();
  const total = info.spine.length;
  const html: string[] = [];
  for (let i = 0; i < total; i++) html.push(printableHtml(await book.chapter(i, urls), info.title));
  await urls.revokeAll();
  progress(0, total);
  const parts = await deps.printPages(html, (n) => progress(n, total));
  const counts = await Promise.all(parts.map((p) => deps.pageCount(p)));
  const starts: number[] = [];
  let next = 1;
  for (const c of counts) { starts.push(next); next += c; }
  const texts = new Map<number, Promise<string[]>>();
  const bookmarks = await planBookmarks(info, starts, (ch) => {
    let t = texts.get(ch);
    if (!t) { t = deps.pageTexts(parts[ch]!); texts.set(ch, t); }
    return t;
  });
  const whole = await deps.merge(parts.map((path, i) => ({ path, pages: counts[i]! })));
  await deps.finish(whole, bookmarks, info.title, info.author);
}
