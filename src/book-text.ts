import { EpubError, prepareChapter, type Book, type BookInfo, type Chapter, type ContentSource, type ResourceUrls, type TocEntry } from "./epub-book";

export function decodeText(bytes: Uint8Array, declared?: string): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  if (declared) {
    try { return new TextDecoder(declared).decode(bytes); } catch {}
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

const HEADING = /^\s*(chapter|chapitre|capítulo|capitulo|kapitel|capitolo|part|partie|book|livre|prologue|épilogue|epilogue|prologo|prólogo)\b[^\n]{0,70}$/i;

const PART_SIZE = 150_000;

const local: Omit<ContentSource, "resolve"> = {
  resource: async () => null,
  stylesheet: async () => null,
};

export class TextBook implements Book, ContentSource {
  readonly resource = local.resource;
  readonly stylesheet = local.stylesheet;

  private constructor(readonly info: BookInfo, private readonly parts: string[][]) {}

  static open(bytes: Uint8Array): TextBook {
    const text = decodeText(bytes).replace(/\r\n?/g, "\n");
    if (text.includes("\u0000")) throw new EpubError("invalid", "not a text file");
    const lines = text.split("\n");
    const blank = lines.filter((l) => l.trim() === "").length;
    const wrapped = blank > lines.length / 20;
    const paragraphs: string[] = [];
    if (wrapped) {
      for (const block of text.split(/\n\s*\n/)) {
        const p = block.split("\n").map((l) => l.trim()).join(" ").trim();
        if (p) paragraphs.push(p);
      }
    } else {
      for (const l of lines) if (l.trim()) paragraphs.push(l.trim());
    }
    if (paragraphs.length === 0) throw new EpubError("invalid", "empty file");

    const parts: string[][] = [];
    const toc: TocEntry[] = [];
    const headings = paragraphs.filter((p) => HEADING.test(p)).length;
    let size = 0;
    for (const p of paragraphs) {
      const heading = headings >= 2 && HEADING.test(p);
      if (parts.length === 0 || heading || (headings < 2 && size > PART_SIZE)) {
        parts.push([]);
        size = 0;
        if (heading) toc.push({ label: p, path: `text/${parts.length - 1}`, fragment: "", depth: 0 });
      }
      parts[parts.length - 1]!.push(p);
      size += p.length;
    }
    const info: BookInfo = { title: "", author: "", language: "", spine: parts.map((_, i) => `text/${i}`), toc };
    return new TextBook(info, parts);
  }

  async chapter(index: number, urls: ResourceUrls): Promise<Chapter> {
    const part = this.parts[index];
    if (!part) throw new EpubError("invalid", "no such chapter");
    const doc = document.implementation.createHTMLDocument("");
    part.forEach((p, i) => {
      const el = doc.createElement(i === 0 && this.info.toc.some((t) => t.path === `text/${index}`) ? "h2" : "p");
      el.textContent = p;
      doc.body.append(el);
    });
    return prepareChapter(doc, `text/${index}`, this.info.language, this, urls);
  }

  resolve(): null { return null; }
}

export class HtmlBook implements Book, ContentSource {
  readonly resource = local.resource;
  readonly stylesheet = local.stylesheet;

  private constructor(readonly info: BookInfo, private readonly html: string) {}

  static open(bytes: Uint8Array): HtmlBook {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
    const charset = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
    const html = decodeText(bytes, charset);
    const doc = new DOMParser().parseFromString(html, "text/html");
    if (!doc.body || !doc.body.textContent?.trim() && !doc.body.querySelector("img")) throw new EpubError("invalid", "empty page");
    const info: BookInfo = {
      title: (doc.title ?? "").trim(),
      author: doc.querySelector('meta[name="author" i]')?.getAttribute("content")?.trim() ?? "",
      language: doc.documentElement.getAttribute("lang") ?? "",
      spine: ["page"],
      toc: [],
    };
    const headings = HtmlBook.headings(doc);
    if (headings.length >= 2) {
      const top = Math.min(...headings.map((h) => Number(h.localName[1])));
      info.toc = headings.map((h) => ({
        label: (h.textContent ?? "").replace(/\s+/g, " ").trim(),
        path: "page",
        fragment: h.id,
        depth: Number(h.localName[1]) - top,
      })).filter((t) => t.label);
    }
    return new HtmlBook(info, html);
  }

  private static headings(doc: Document): Element[] {
    const all = Array.from(doc.body.querySelectorAll("h1, h2, h3"));
    all.forEach((h, i) => { if (!h.id) h.id = `ez-h${i}`; });
    return all;
  }

  async chapter(index: number, urls: ResourceUrls): Promise<Chapter> {
    if (index !== 0) throw new EpubError("invalid", "no such chapter");
    const doc = new DOMParser().parseFromString(this.html, "text/html");
    HtmlBook.headings(doc);
    return prepareChapter(doc, "page", this.info.language, this, urls);
  }

  resolve(_from: string, href: string): { path: string; fragment: string } | null {
    if (!href.startsWith("#")) return null;
    let fragment = href.slice(1);
    try { fragment = decodeURIComponent(fragment); } catch {}
    return { path: "page", fragment };
  }
}
