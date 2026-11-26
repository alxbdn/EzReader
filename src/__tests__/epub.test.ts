// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ZipArchive, resolveHref } from "../epub-zip";
import { EpubBook, EpubError, ResourceUrls, sanitize, tocIndexFor } from "../epub-book";
import { openKind } from "../pictures";

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(data); c.close(); } });
  const out = source.pipeThrough(new CompressionStream("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  const chunks: Uint8Array[] = [];
  for (const reader = out.getReader(); ;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return all;
}

async function zip(files: Record<string, string | Uint8Array>, deflate = true): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === "string" ? enc.encode(content) : content;
    const packed = deflate && name !== "mimetype" ? await deflateRaw(data) : data;
    const method = packed === data ? 0 : 8;
    const n = enc.encode(name);
    const local = new Uint8Array(30 + n.length + packed.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, packed.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, n.length, true);
    local.set(n, 30);
    local.set(packed, 30 + n.length);
    const cd = new Uint8Array(46 + n.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, packed.length, true);
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

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>  Le   Petit Livre </dc:title>
    <dc:creator>Alex</dc:creator>
    <dc:language>fr</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch%202.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style/book.css" media-type="text/css"/>
    <item id="img" href="images/cover.png" media-type="image/png"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`;

const NAV = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
  <nav epub:type="toc"><ol>
    <li><a href="text/ch1.xhtml">Chapitre 1</a>
      <ol><li><a href="text/ch1.xhtml#s2">Section 2</a></li></ol></li>
    <li><a href="text/ch%202.xhtml">Chapitre 2</a></li>
  </ol></nav>
</body></html>`;

const CH1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="fr"><head>
  <link rel="stylesheet" href="../style/book.css"/>
  <script>alert(1)</script>
</head><body class="chapter">
  <h1 onclick="alert(2)">Un</h1>
  <a id="empty"/>
  <p><img src="../images/cover.png" alt=""/></p>
  <p><a href="ch%202.xhtml#top">suite</a> · <a href="https://example.org/">site</a> · <a href="javascript:alert(3)">x</a></p>
  <iframe src="https://example.org/"></iframe>
  <h2 id="s2">Deux</h2>
</body></html>`;

const CH2 = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>2</title></head><body><p id="top">Fin.</p></body></html>`;

function book(extra: Record<string, string> = {}): Promise<Uint8Array> {
  return zip({
    mimetype: "application/epub+zip",
    "META-INF/container.xml": CONTAINER,
    "OEBPS/content.opf": OPF,
    "OEBPS/nav.xhtml": NAV,
    "OEBPS/text/ch1.xhtml": CH1,
    "OEBPS/text/ch 2.xhtml": CH2,
    "OEBPS/style/book.css": `@import "more.css"; body { background: url(../images/cover.png) } h1 { color: red }`,
    "OEBPS/style/more.css": `p { margin: 0 }`,
    "OEBPS/images/cover.png": "\x89PNG",
    ...extra,
  });
}

class FakeUrls extends ResourceUrls {
  override get(path: string): Promise<string> { return Promise.resolve(`blob:${path}`); }
}

describe("EPUB zip", () => {
  it("reads stored and deflated entries", async () => {
    const z = ZipArchive.open(await zip({ mimetype: "application/epub+zip", "a/b.txt": "bonjour ".repeat(50) }));
    expect(z.names).toEqual(["mimetype", "a/b.txt"]);
    expect(await z.text("mimetype")).toBe("application/epub+zip");
    expect(await z.text("a/b.txt")).toBe("bonjour ".repeat(50));
  });

  it("refuses what isn't a zip", () => {
    expect(() => ZipArchive.open(new TextEncoder().encode("%PDF-1.7 not a zip at all, sorry"))).toThrow();
  });

  it("resolves links inside the book", () => {
    expect(resolveHref("OEBPS/text/ch1.xhtml", "../images/a%20b.png")).toEqual({ path: "OEBPS/images/a b.png", fragment: "" });
    expect(resolveHref("OEBPS/text/ch1.xhtml", "#note")).toEqual({ path: "OEBPS/text/ch1.xhtml", fragment: "note" });
    expect(resolveHref("OEBPS/content.opf", "./text/ch1.xhtml?x=1#s")).toEqual({ path: "OEBPS/text/ch1.xhtml", fragment: "s" });
  });
});

describe("EPUB book", () => {
  it("reads the title, the reading order and the table of contents", async () => {
    const b = await EpubBook.open(await book());
    expect(b.info.title).toBe("Le Petit Livre");
    expect(b.info.author).toBe("Alex");
    expect(b.info.spine).toEqual(["OEBPS/text/ch1.xhtml", "OEBPS/text/ch 2.xhtml"]);
    expect(b.info.toc.map((t) => [t.label, t.depth, t.fragment])).toEqual([
      ["Chapitre 1", 0, ""], ["Section 2", 1, "s2"], ["Chapitre 2", 0, ""],
    ]);
    expect(tocIndexFor(b.info, 0)).toBe(0);
    expect(tocIndexFor(b.info, 1)).toBe(2);
  });

  it("falls back to the EPUB 2 table of contents", async () => {
    const ncx = `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
      <navPoint id="a"><navLabel><text>Premier</text></navLabel><content src="text/ch1.xhtml"/></navPoint>
    </navMap></ncx>`;
    const opf = OPF.replace(' properties="nav"', "").replace("<spine>", '<spine toc="ncx">')
      .replace("</manifest>", '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest>');
    const b = await EpubBook.open(await book({ "OEBPS/content.opf": opf, "OEBPS/toc.ncx": ncx }));
    expect(b.info.toc.map((t) => t.label)).toEqual(["Premier"]);
  });

  it("turns a chapter into safe content with the book's pictures and styles", async () => {
    const b = await EpubBook.open(await book());
    const ch = await b.chapter(0, new FakeUrls());
    expect(ch.language).toBe("fr");
    expect(ch.bodyClass).toBe("chapter");
    const html = ch.body.innerHTML;
    expect(html).not.toMatch(/script|iframe|onclick|javascript:/i);
    expect(ch.body.querySelector("img")!.getAttribute("src")).toBe("blob:OEBPS/images/cover.png");
    const links = Array.from(ch.body.querySelectorAll("a[href]"));
    expect(links[0]!.getAttribute("data-ez-target")).toBe("OEBPS/text/ch 2.xhtml#top");
    expect(links[1]!.getAttribute("data-ez-external")).toBe("https://example.org/");
    expect(links.every((a) => a.getAttribute("href") === "#")).toBe(true);
    expect(ch.styles.join("\n")).toContain("p { margin: 0 }");
    expect(ch.styles.join("\n")).toContain('url("blob:OEBPS/images/cover.png")');
    expect(ch.styles.join("\n")).not.toContain("@import");
  });

  it("refuses books locked by DRM, but not obfuscated fonts", async () => {
    const enc = (algo: string) => `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
      <enc:EncryptedData><enc:EncryptionMethod Algorithm="${algo}"/><enc:CipherData><enc:CipherReference URI="OEBPS/text/ch1.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>`;
    await expect(EpubBook.open(await book({ "META-INF/encryption.xml": enc("http://www.w3.org/2001/04/xmlenc#aes128-cbc") })))
      .rejects.toMatchObject({ kind: "drm" });
    await expect(EpubBook.open(await book({ "META-INF/rights.xml": "<rights/>" }))).rejects.toMatchObject({ kind: "drm" });
    await expect(EpubBook.open(await book({ "META-INF/encryption.xml": enc("http://www.idpf.org/2008/embedding") }))).resolves.toBeInstanceOf(EpubBook);
  });

  it("says when a file isn't an EPUB", async () => {
    await expect(EpubBook.open(await zip({ "readme.txt": "hi" }))).rejects.toBeInstanceOf(EpubError);
    await expect(EpubBook.open(new Uint8Array(10))).rejects.toMatchObject({ kind: "invalid" });
  });

  it("removes active content", () => {
    const doc = new DOMParser().parseFromString(
      `<body><form action="x"><input></form><a href=" JavaScript:alert(1)" onmouseover="x()">a</a><svg><script>1</script></svg><object data="x"></object></body>`,
      "text/html");
    sanitize(doc);
    expect(doc.body.innerHTML).toBe(`<a>a</a><svg></svg>`);
  });

  it("opens .epub files as books", () => {
    expect(openKind("C:\\Livres\\Roman.EPUB")).toBe("epub");
  });
});
