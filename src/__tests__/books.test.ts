// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ResourceUrls, EpubError } from "../epub-book";
import { openBook, isBookPath } from "../books";
import { decodeText } from "../book-text";

function zip(files: Record<string, string | Uint8Array>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === "string" ? enc.encode(content) : content;
    const n = enc.encode(name);
    const local = new Uint8Array(30 + n.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, n.length, true);
    local.set(n, 30);
    local.set(data, 30 + n.length);
    const cd = new Uint8Array(46 + n.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, n.length, true);
    cv.setUint32(42, offset, true);
    cd.set(n, 46);
    locals.push(local);
    central.push(cd);
    offset += local.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...locals, ...central, end]) { out.set(part, p); p += part.length; }
  return out;
}

class DataUrlsForTest extends ResourceUrls {
  protected override toUrl(b: Blob): Promise<string> { return Promise.resolve(`blob:${b.type}`); }
}

const enc = (s: string) => new TextEncoder().encode(s);

describe("book formats", () => {
  it("knows which files the reader opens", () => {
    for (const p of ["a.epub", "B.CBZ", "notes.txt", "page.html", "page.HTM"]) expect(isBookPath(p)).toBe(true);
    for (const p of ["a.pdf", "a.zip", "a.mobi", "a.docx"]) expect(isBookPath(p)).toBe(false);
  });

  it("reads a comic page by page, in natural name order, with folders as chapters", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const book = await openBook("x.cbz", zip({
      "ComicInfo.xml": "<ComicInfo><Series>Astro</Series><Number>3</Number><Writer>Léa</Writer></ComicInfo>",
      "Ch 2/p1.png": png,
      "Ch 1/p10.png": png,
      "Ch 1/p2.png": png,
      "__MACOSX/Ch 1/._p2.png": png,
      "notes.txt": "x",
    }));
    expect(book.info.spine).toEqual(["Ch 1/p2.png", "Ch 1/p10.png", "Ch 2/p1.png"]);
    expect(book.info.title).toBe("Astro #3");
    expect(book.info.author).toBe("Léa");
    expect(book.info.toc.map((t) => [t.label, t.path])).toEqual([["Ch 1", "Ch 1/p2.png"], ["Ch 2", "Ch 2/p1.png"]]);
    const page = await book.chapter(1, new DataUrlsForTest());
    expect(page.picture).toBe(true);
    expect(page.body.querySelector("img")!.getAttribute("src")).toBe("blob:image/png");
  });

  it("refuses an archive without pictures", async () => {
    await expect(openBook("x.cbz", zip({ "a.txt": "x" }))).rejects.toBeInstanceOf(EpubError);
  });

  it("reflows hard-wrapped text and cuts it at chapter headings", async () => {
    const text = "Title page\r\n\r\nChapter 1\r\n\r\nIt was a dark\r\nand stormy night.\r\n\r\nChapter 2\r\n\r\nThe end.\r\n";
    const book = await openBook("story.txt", enc(text));
    expect(book.info.spine.length).toBe(3);
    expect(book.info.toc.map((t) => t.label)).toEqual(["Chapter 1", "Chapter 2"]);
    const ch = await book.chapter(1, new ResourceUrls());
    expect(ch.body.querySelector("h2")!.textContent).toBe("Chapter 1");
    expect(ch.body.querySelector("p")!.textContent).toBe("It was a dark and stormy night.");
  });

  it("decodes UTF-8, then falls back to Windows-1252", () => {
    expect(decodeText(enc("été"))).toBe("été");
    expect(decodeText(new Uint8Array([0x65, 0xe9]))).toBe("eé");
  });

  it("opens a web page without scripts, with its headings as contents", async () => {
    const html = `<html lang="fr"><head><title>Doc</title><script>alert(1)</script></head><body>
      <h1>One</h1><p onclick="x()">a <a href="#two">to two</a> <a href="https://e.org">ext</a></p><img src="http://e.org/a.png"><h2 id="two">Two</h2></body></html>`;
    const book = await openBook("doc.html", enc(html));
    expect(book.info.title).toBe("Doc");
    expect(book.info.toc.map((t) => [t.label, t.fragment, t.depth])).toEqual([["One", "ez-h0", 0], ["Two", "two", 1]]);
    const ch = await book.chapter(0, new ResourceUrls());
    expect(ch.language).toBe("fr");
    expect(ch.body.querySelector("[onclick]")).toBeNull();
    expect(ch.body.querySelector("a")!.getAttribute("data-ez-target")).toBe("page#two");
    expect(ch.body.querySelectorAll("a")[1]!.getAttribute("data-ez-external")).toBe("https://e.org");
    expect(ch.body.querySelector("img")!.getAttribute("src")).toBe("");
  });
});
