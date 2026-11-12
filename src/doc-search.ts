import type { PDFDocumentProxy } from "pdfjs-dist";
import { matchOffsets } from "./pdf-viewer";

/** One occurrence: its page (1-based) and its index among that page's matches. */
export interface SearchMatch {
  page: number;
  index: number;
}

/**
 * Finds a term in every page of a document. Page texts are read once per
 * document and cached; a newer search cancels one still running.
 */
export class DocSearch {
  private doc: PDFDocumentProxy | null = null;
  /** Text items of each page (index = page - 1), filled lazily. */
  private texts: (string[] | undefined)[] = [];
  private generation = 0;

  /** Forgets the cached text (call when another document is shown). */
  reset(doc: PDFDocumentProxy | null): void {
    this.doc = doc;
    this.texts = [];
    this.generation++;
  }

  /**
   * All matches of `query`, in page order. Returns null when a newer search
   * or document replaced this one before it finished.
   */
  async find(query: string, onProgress?: (done: number, total: number) => void): Promise<SearchMatch[] | null> {
    const gen = ++this.generation;
    const doc = this.doc;
    const needle = query.trim().toLocaleLowerCase();
    if (!doc || !needle) return [];
    const total = doc.numPages;
    const matches: SearchMatch[] = [];
    for (let p = 1; p <= total; p++) {
      let items = this.texts[p - 1];
      if (!items) {
        try {
          const content = await (await doc.getPage(p)).getTextContent();
          items = content.items.flatMap((it) => ("str" in it && it.str ? [it.str] : []));
        } catch {
          items = [];
        }
        if (gen !== this.generation || doc !== this.doc) return null;
        this.texts[p - 1] = items;
      }
      let index = 0;
      for (const str of items) {
        for (let n = matchOffsets(str, needle).length; n > 0; n--) matches.push({ page: p, index: index++ });
      }
      if (p % 25 === 0) {
        onProgress?.(p, total);
        // Let the UI breathe on long documents.
        await new Promise((r) => setTimeout(r, 0));
        if (gen !== this.generation || doc !== this.doc) return null;
      }
    }
    return matches;
  }
}
