import { ZipArchive } from "./epub-zip";
import { EpubError, guessType, prepareChapter, type Book, type BookInfo, type Chapter, type ContentSource, type ResourceUrls, type TocEntry } from "./epub-book";

const PICTURE = /\.(jpe?g|png|gif|webp|bmp|avif)$/i;

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** A comic book archive (.cbz): its pictures, one page each, in name order. */
export class CbzBook implements Book, ContentSource {
  private constructor(private readonly zip: ZipArchive, readonly info: BookInfo) {}

  static async open(bytes: Uint8Array): Promise<CbzBook> {
    let zip: ZipArchive;
    try {
      zip = ZipArchive.open(bytes);
    } catch (e) {
      throw new EpubError("invalid", String(e));
    }
    const pages = zip.names
      .filter((n) => PICTURE.test(n) && !/(^|\/)(__MACOSX|\.)/.test(n))
      .sort((a, b) => byName.compare(a, b));
    if (pages.length === 0) throw new EpubError("invalid", "no pictures");

    const info: BookInfo = { title: "", author: "", language: "", spine: pages, toc: [] };
    if (zip.has("ComicInfo.xml")) {
      try {
        const doc = new DOMParser().parseFromString(await zip.text("ComicInfo.xml"), "application/xml");
        const field = (name: string) => (doc.getElementsByTagName(name)[0]?.textContent ?? "").trim();
        const series = field("Series");
        const number = field("Number");
        info.title = field("Title") || [series, number && `#${number}`].filter(Boolean).join(" ");
        info.author = field("Writer");
        info.language = field("LanguageISO");
      } catch { /* the pictures are what matters */ }
    }
    // Pictures sorted in folders: each folder is a chapter.
    const folder = (p: string) => p.slice(0, p.lastIndexOf("/") + 1);
    const folders = new Set(pages.map(folder));
    if (folders.size > 1) {
      let last: string | null = null;
      for (const p of pages) {
        const f = folder(p);
        if (f === last) continue;
        last = f;
        const label = f.replace(/\/$/, "").split("/").pop() ?? "";
        if (label) info.toc.push({ label, path: p, fragment: "", depth: 0 } satisfies TocEntry);
      }
    }
    return new CbzBook(zip, info);
  }

  async chapter(index: number, urls: ResourceUrls): Promise<Chapter> {
    const path = this.info.spine[index];
    if (path === undefined) throw new EpubError("invalid", "no such page");
    const doc = document.implementation.createHTMLDocument("");
    const img = doc.createElement("img");
    img.setAttribute("src", path);
    img.setAttribute("alt", "");
    doc.body.append(img);
    return { ...(await prepareChapter(doc, path, this.info.language, this, urls)), picture: true };
  }

  resolve(_from: string, href: string): { path: string; fragment: string } | null {
    return this.zip.has(href) ? { path: href, fragment: "" } : null;
  }

  async resource(path: string): Promise<Blob | null> {
    return this.zip.has(path) ? new Blob([await this.zip.read(path) as BlobPart], { type: guessType(path) }) : null;
  }

  async stylesheet(): Promise<string | null> { return null; }
}
