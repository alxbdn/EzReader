import * as pdfjs from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { convertFileSrc } from "@tauri-apps/api/core";
import { bodySize, layoutPage, normalizeHeadings, type TextDoc, type TextRun } from "./text-layout";

/**
 * Reads the text of `pages` (1-based) of the PDF at `filePath` with pdf.js
 * and lays it out for "Convert". Pages that are pictures (scans) come back
 * without lines.
 */
export async function extractText(filePath: string, pages: number[], title: string): Promise<TextDoc> {
  const doc = await pdfjs.getDocument({ url: convertFileSrc(filePath) + `?t=${Date.now()}` }).promise;
  try {
    const read: { n: number; runs: TextRun[]; width: number; height: number }[] = [];
    for (const n of pages) {
      if (n < 1 || n > doc.numPages) continue;
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1, rotation: page.rotate });
      const content = await page.getTextContent();
      const runs: TextRun[] = [];
      for (const item of content.items) {
        if (!("str" in item) || !(item as TextItem).str) continue;
        const t = item as TextItem;
        const m = pdfjs.Util.transform(viewport.transform, t.transform);
        runs.push({ str: t.str, x: m[4], y: m[5], width: t.width, size: Math.hypot(m[2], m[3]) });
      }
      read.push({ n, runs, width: viewport.width, height: viewport.height });
      page.cleanup();
    }
    const body = bodySize(read.flatMap((p) => p.runs));
    const laid = read.map((p) => layoutPage(p.runs, p.n, p.width, p.height, body));
    normalizeHeadings(laid);
    return { title, pages: laid };
  } finally {
    await doc.destroy();
  }
}
