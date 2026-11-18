import type { PDFDocumentProxy } from "pdfjs-dist";
import { matchOffsets } from "./pdf-viewer";

export interface SearchMatch {
  page: number;
  index: number;
}

export class DocSearch {
  private doc: PDFDocumentProxy | null = null;
  private texts: (string[] | undefined)[] = [];
  private generation = 0;

  reset(doc: PDFDocumentProxy | null): void {
    this.doc = doc;
    this.texts = [];
    this.generation++;
  }

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
        await new Promise((r) => setTimeout(r, 0));
        if (gen !== this.generation || doc !== this.doc) return null;
      }
    }
    return matches;
  }
}
