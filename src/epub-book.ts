import { ZipArchive, ZipError, resolveHref } from "./epub-zip";

export class EpubError extends Error {
  constructor(readonly kind: "invalid" | "drm", detail: string) {
    super(detail);
  }
}

export interface TocEntry {
  label: string;
  path: string;
  fragment: string;
  depth: number;
}

export interface BookInfo {
  title: string;
  author: string;
  language: string;
  spine: string[];
  toc: TocEntry[];
}

interface ManifestItem { href: string; type: string; props: string[] }

const FONT_OBFUSCATION = new Set([
  "http://www.idpf.org/2008/embedding",
  "http://ns.adobe.com/pdf/enc#RC",
]);

const XHTML_TYPES = new Set(["application/xhtml+xml", "text/html", "application/x-dtbook+xml"]);

function xml(text: string): Document {
  const doc = new DOMParser().parseFromString(text.replace(/^﻿/, ""), "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) throw new EpubError("invalid", "malformed XML");
  return doc;
}

function byTag(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagNameNS("*", name));
}

function clean(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

export class EpubBook implements Book, ContentSource {
  private constructor(
    private readonly zip: ZipArchive,
    readonly info: BookInfo,
    private readonly types: Map<string, string>,
  ) {}

  static async open(bytes: Uint8Array): Promise<EpubBook> {
    let zip: ZipArchive;
    try {
      zip = ZipArchive.open(bytes);
    } catch (e) {
      throw new EpubError("invalid", String(e));
    }
    try {
      return await EpubBook.parse(zip);
    } catch (e) {
      if (e instanceof EpubError) throw e;
      throw new EpubError(e instanceof ZipError && /encrypted/.test(e.message) ? "drm" : "invalid", String(e));
    }
  }

  private static async parse(zip: ZipArchive): Promise<EpubBook> {
    if (zip.has("META-INF/rights.xml") || zip.has("META-INF/license.lcpl")) throw new EpubError("drm", "rights management");
    if (zip.has("META-INF/encryption.xml")) {
      const enc = xml(await zip.text("META-INF/encryption.xml"));
      for (const data of byTag(enc, "EncryptedData")) {
        const algo = byTag(data, "EncryptionMethod")[0]?.getAttribute("Algorithm") ?? "";
        if (!FONT_OBFUSCATION.has(algo)) throw new EpubError("drm", `encrypted with ${algo}`);
      }
    }
    if (!zip.has("META-INF/container.xml")) throw new EpubError("invalid", "no container.xml");
    const container = xml(await zip.text("META-INF/container.xml"));
    const opfPath = byTag(container, "rootfile")[0]?.getAttribute("full-path");
    if (!opfPath || !zip.has(opfPath)) throw new EpubError("invalid", "no package document");
    const opf = xml(await zip.text(opfPath));

    const manifest = new Map<string, ManifestItem>();
    const types = new Map<string, string>();
    for (const item of byTag(opf, "item")) {
      const id = item.getAttribute("id");
      const href = item.getAttribute("href");
      if (!id || !href) continue;
      const entry = {
        href: resolveHref(opfPath, href).path,
        type: (item.getAttribute("media-type") ?? "").toLowerCase(),
        props: (item.getAttribute("properties") ?? "").split(/\s+/),
      };
      manifest.set(id, entry);
      types.set(entry.href, entry.type);
    }

    const spineEl = byTag(opf, "spine")[0];
    const spine: string[] = [];
    for (const ref of spineEl ? byTag(spineEl, "itemref") : []) {
      const item = manifest.get(ref.getAttribute("idref") ?? "");
      if (item && XHTML_TYPES.has(item.type) && zip.has(item.href) && !spine.includes(item.href)) spine.push(item.href);
    }
    if (spine.length === 0) throw new EpubError("invalid", "empty spine");

    const meta = (name: string) => clean(byTag(opf, name)[0]?.textContent);
    const info: BookInfo = {
      title: meta("title"),
      author: meta("creator"),
      language: meta("language"),
      spine,
      toc: [],
    };

    const nav = [...manifest.values()].find((m) => m.props.includes("nav"));
    if (nav && zip.has(nav.href)) info.toc = navToc(await zip.text(nav.href), nav.href);
    if (info.toc.length === 0) {
      const ncx = manifest.get(spineEl?.getAttribute("toc") ?? "") ?? [...manifest.values()].find((m) => m.type === "application/x-dtbncx+xml");
      if (ncx && zip.has(ncx.href)) {
        try { info.toc = ncxToc(await zip.text(ncx.href), ncx.href); } catch {}
      }
    }
    info.toc = info.toc.filter((t) => spine.includes(t.path));
    return new EpubBook(zip, info, types);
  }

  async chapter(index: number, urls: ResourceUrls): Promise<Chapter> {
    const path = this.info.spine[index];
    if (path === undefined) throw new EpubError("invalid", "no such chapter");
    const text = (await this.zip.text(path)).replace(/^\uFEFF/, "");
    let doc = new DOMParser().parseFromString(text, "application/xhtml+xml");
    if (doc.getElementsByTagName("parsererror").length > 0 || !doc.body) doc = new DOMParser().parseFromString(text, "text/html");
    return prepareChapter(doc, path, this.info.language, this, urls);
  }

  resolve(from: string, href: string): { path: string; fragment: string } | null {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
    return resolveHref(from, href);
  }

  async resource(path: string): Promise<Blob | null> {
    if (!this.zip.has(path)) return null;
    return new Blob([await this.zip.read(path) as BlobPart], { type: this.types.get(path) || guessType(path) });
  }

  async stylesheet(path: string): Promise<string | null> {
    return this.zip.has(path) ? this.zip.text(path) : null;
  }
}

export interface Book {
  readonly info: BookInfo;
  chapter(index: number, urls: ResourceUrls): Promise<Chapter>;
}

export interface ContentSource {
  resolve(from: string, href: string): { path: string; fragment: string } | null | Promise<{ path: string; fragment: string } | null>;
  resource(path: string): Promise<Blob | null>;
  stylesheet(path: string): Promise<string | null>;
}

export async function prepareChapter(doc: Document, path: string, language: string, src: ContentSource, urls: ResourceUrls): Promise<Chapter> {
  sanitize(doc);
  const url = async (from: string, href: string): Promise<string> => {
    if (/^data:image\//i.test(href)) return href;
    const to = await src.resolve(from, href);
    if (!to) return "";
    return urls.get(to.path, async () => {
      const blob = await src.resource(to.path);
      if (!blob) throw new Error("missing");
      return blob;
    });
  };
  const rewriteCss = async (css: string, from: string, depth: number): Promise<string> => {
    let out = "";
    let last = 0;
    const imports = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?[^;]*;/gi;
    for (const m of css.matchAll(imports)) {
      out += css.slice(last, m.index);
      last = m.index! + m[0].length;
      const to = depth < 3 ? await src.resolve(from, m[1]!) : null;
      const text = to ? await src.stylesheet(to.path) : null;
      if (to && text !== null) out += await rewriteCss(text, to.path, depth + 1);
    }
    out += css.slice(last);
    const parts: string[] = [];
    last = 0;
    for (const m of out.matchAll(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi)) {
      parts.push(out.slice(last, m.index), `url("${await url(from, m[2]!.trim())}")`);
      last = m.index! + m[0].length;
    }
    parts.push(out.slice(last));
    return parts.join("");
  };

  const styles: string[] = [];
  for (const el of Array.from(doc.querySelectorAll("link, style"))) {
    if (el.localName === "style") styles.push(await rewriteCss(el.textContent ?? "", path, 0));
    else if (/\bstylesheet\b/i.test(el.getAttribute("rel") ?? "")) {
      const to = await src.resolve(path, el.getAttribute("href") ?? "");
      const text = to ? await src.stylesheet(to.path) : null;
      if (to && text !== null) styles.push(await rewriteCss(text, to.path, 0));
    }
    el.remove();
  }

  for (const el of Array.from(doc.querySelectorAll("img[src], source[src]"))) {
    el.setAttribute("src", await url(path, el.getAttribute("src")!));
    el.removeAttribute("srcset");
  }
  for (const el of Array.from(doc.getElementsByTagNameNS("http://www.w3.org/2000/svg", "image"))) {
    const v = el.getAttribute("href") ?? el.getAttributeNS("http://www.w3.org/1999/xlink", "href");
    if (v === null) continue;
    const u = await url(path, v);
    el.setAttribute("href", u);
    el.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", u);
  }
  for (const el of Array.from(doc.querySelectorAll("[style]"))) {
    el.setAttribute("style", await rewriteCss(el.getAttribute("style") ?? "", path, 3));
  }
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href")!;
    if (/^(https?|mailto):/i.test(href)) a.setAttribute("data-ez-external", href);
    else {
      const to = await src.resolve(path, href);
      if (to) a.setAttribute("data-ez-target", `${to.path}#${to.fragment}`);
    }
    a.setAttribute("href", "#");
  }

  return {
    path,
    language: doc.documentElement.getAttribute("xml:lang") ?? doc.documentElement.getAttribute("lang") ?? language,
    bodyClass: doc.body?.getAttribute("class") ?? "",
    styles,
    body: doc.body ?? doc.documentElement,
  };
}

export interface Chapter {
  path: string;
  language: string;
  bodyClass: string;
  styles: string[];
  body: Element;
  picture?: boolean;
}

export class ResourceUrls {
  private readonly made = new Map<string, Promise<string>>();

  get(path: string, blob: () => Promise<Blob>): Promise<string> {
    let url = this.made.get(path);
    if (!url) {
      url = blob().then((b) => this.toUrl(b)).catch(() => "");
      this.made.set(path, url);
    }
    return url;
  }

  protected toUrl(b: Blob): Promise<string> { return Promise.resolve(URL.createObjectURL(b)); }

  async revokeAll(): Promise<void> {
    const all = [...this.made.values()];
    this.made.clear();
    for (const u of await Promise.all(all)) if (u.startsWith("blob:")) URL.revokeObjectURL(u);
  }
}

export class DataUrls extends ResourceUrls {
  protected override toUrl(b: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(b);
    });
  }
}

export function guessType(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" } as Record<string, string>)[ext] ?? "application/octet-stream";
}

const ACTIVE = "script, iframe, frame, frameset, object, embed, applet, base, meta, form, input, button, textarea, select, audio, video, noscript, template, portal";

export function sanitize(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll(ACTIVE))) el.remove();
  for (const el of Array.from(doc.getElementsByTagNameNS("http://www.w3.org/2000/svg", "script"))) el.remove();
  for (const el of Array.from(doc.getElementsByTagNameNS("http://www.w3.org/2000/svg", "foreignObject"))) el.remove();
  for (const el of Array.from(doc.getElementsByTagName("*"))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith("on") || name === "formaction" || name === "srcdoc" || name === "ping") el.removeAttributeNode(attr);
      else if (/(^|:)(href|src|action|data|poster|xlink:href)$/.test(name) && /^(javascript|vbscript|data:text|file):/.test(value)) el.removeAttributeNode(attr);
    }
  }
}

function navToc(text: string, from: string): TocEntry[] {
  const doc = new DOMParser().parseFromString(text.replace(/^﻿/, ""), "application/xhtml+xml");
  if (doc.getElementsByTagName("parsererror").length > 0) return [];
  const navs = byTag(doc, "nav");
  const toc = navs.find((n) => /\btoc\b/.test(n.getAttributeNS("http://www.idpf.org/2007/ops", "type") ?? n.getAttribute("epub:type") ?? "")) ?? navs[0];
  const list = toc && Array.from(toc.children).find((c) => c.localName === "ol");
  const out: TocEntry[] = [];
  const walk = (ol: Element, depth: number) => {
    for (const li of Array.from(ol.children).filter((c) => c.localName === "li")) {
      const a = Array.from(li.children).find((c) => c.localName === "a" || c.localName === "span");
      const href = a?.getAttribute("href");
      const label = clean(a?.textContent);
      if (href && label) out.push({ label, ...resolveHref(from, href), depth });
      const sub = Array.from(li.children).find((c) => c.localName === "ol");
      if (sub) walk(sub, href ? depth + 1 : depth);
    }
  };
  if (list) walk(list, 0);
  return out;
}

function ncxToc(text: string, from: string): TocEntry[] {
  const doc = xml(text);
  const out: TocEntry[] = [];
  const walk = (parent: Element, depth: number) => {
    for (const p of Array.from(parent.children).filter((c) => c.localName === "navPoint")) {
      const label = clean(byTag(p, "text")[0]?.textContent);
      const src = Array.from(p.children).find((c) => c.localName === "content")?.getAttribute("src");
      if (src && label) out.push({ label, ...resolveHref(from, src), depth });
      walk(p, depth + 1);
    }
  };
  const map = byTag(doc, "navMap")[0];
  if (map) walk(map, 0);
  return out;
}

export function tocIndexFor(info: BookInfo, chapter: number): number {
  let best = -1;
  let bestAt = -1;
  info.toc.forEach((t, i) => {
    const at = info.spine.indexOf(t.path);
    if (at <= chapter && at > bestAt) { best = i; bestAt = at; }
  });
  return best;
}
