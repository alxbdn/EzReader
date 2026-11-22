import { EpubBook, ResourceUrls, tocIndexFor, type Chapter } from "./epub-book";
import type { Translations } from "./i18n";
import { ICON_CHEVRON_LEFT, ICON_CHEVRON_RIGHT, ICON_CLOSE, ICON_TEXT_LARGER, ICON_TEXT_SMALLER, ICON_TOC } from "./icons";

export interface EpubReaderDeps {
  openUrl(url: string): void;
  /** The book's title while one is open, null once it is closed. */
  titleChanged(title: string | null): void;
  closeRequested(): void;
  /** Keys the reader doesn't use, typed while the book has the focus (menu shortcuts…). */
  forwardKey(e: KeyboardEvent): void;
}

const SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2];
const SCALE_KEY = "ezreader.epub.scale";
const TOC_KEY = "ezreader.epub.toc";
const POS_KEY = "ezreader.epub.pos:";

function load(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function store(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

/** Colors and fonts of the app, handed to the book's frame as variables. */
const TOKENS: [string, string][] = [
  ["--ez-bg", "--viewer"], ["--ez-dot", "--viewer-dot"], ["--ez-card", "--card"], ["--ez-fg", "--foreground"],
  ["--ez-muted", "--muted-foreground"], ["--ez-border", "--border"], ["--ez-hover", "--accent"],
  ["--ez-shadow", "--page-shadow"], ["--ez-font", "--font"],
];

/** Defaults the book's own styles can change. */
const BASE_CSS = `
html { font-family: Georgia, "Iowan Old Style", "Palatino Linotype", Cambria, serif; line-height: 1.6; }
img, svg, video { max-width: 100%; }
img { height: auto; }
`;

/** What the reader keeps whatever the book says: its page, the text size and the theme. */
const READER_CSS = `
html {
  font-size: calc(var(--ez-scale) * 100%) !important;
  background-color: var(--ez-bg) !important;
  background-image: radial-gradient(circle, var(--ez-dot) 1px, transparent 1.6px) !important;
  background-size: 22px 22px !important;
  background-attachment: fixed !important;
  color: var(--ez-fg);
  padding: 0 16px !important;
  margin: 0 !important;
  min-height: 100%;
  -webkit-text-size-adjust: none;
}
body {
  box-sizing: border-box !important;
  width: auto !important;
  max-width: 46em !important;
  min-height: 0 !important;
  margin: 24px auto 0 !important;
  padding: clamp(24px, 6vw, 64px) !important;
  background: var(--ez-card) !important;
  box-shadow: var(--ez-shadow);
  color: var(--ez-fg) !important;
  overflow-wrap: break-word;
  position: static !important;
  columns: auto !important;
}
img { max-width: 100% !important; }
a { color: inherit; text-decoration-color: var(--ez-muted); text-underline-offset: 2px; }
a[data-ez-target], a[data-ez-external] { cursor: pointer; }
html.ez-dark body *:not(img):not(svg):not(svg *) {
  color: inherit !important;
  background-color: transparent !important;
  border-color: var(--ez-border) !important;
}
.ez-end { display: flex; justify-content: center; margin: 16px auto 40px; }
.ez-end:empty { margin-bottom: 24px; }
.ez-end button {
  height: 32px; padding: 0 14px;
  font: 500 13px var(--ez-font); color: var(--ez-fg);
  background: var(--ez-card); border: 1px solid var(--ez-border); border-radius: 6px;
  cursor: pointer; box-shadow: 0 1px 2px rgba(0,0,0,.04);
}
.ez-end button:hover { background: var(--ez-hover); }
::-webkit-scrollbar { width: 14px; height: 14px; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--ez-muted) 35%, transparent);
  border: 4px solid transparent; border-radius: 999px; background-clip: content-box; min-height: 32px;
}
::-webkit-scrollbar-thumb:hover { border-width: 2px; background-color: color-mix(in srgb, var(--ez-muted) 60%, transparent); }
`;

function button(cls: string, icon: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.innerHTML = icon;
  return b;
}

/** Reads an EPUB: one chapter at a time, in a page that follows the app's theme and the chosen text size. */
export class EpubReader {
  private book: EpubBook | null = null;
  private path = "";
  private urls = new ResourceUrls();
  private chapterIndex = 0;
  private scale = Number(load(SCALE_KEY)) || 1;
  private loadSeq = 0;
  private saveTimer = 0;
  private t: Translations | null = null;

  private readonly bar: HTMLElement;
  private readonly tocBtn: HTMLButtonElement;
  private readonly prevBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly position: HTMLElement;
  private readonly smallerBtn: HTMLButtonElement;
  private readonly largerBtn: HTMLButtonElement;
  private readonly scaleLabel: HTMLElement;
  private readonly closeBtn: HTMLButtonElement;
  private readonly toc: HTMLElement;
  private readonly tocTitle: HTMLElement;
  private readonly tocList: HTMLElement;
  private readonly frame: HTMLIFrameElement;

  constructor(private readonly root: HTMLElement, private readonly deps: EpubReaderDeps) {
    root.classList.add("epub-reader");
    root.hidden = true;

    this.bar = document.createElement("div");
    this.bar.className = "epub-bar";
    const left = document.createElement("div");
    left.className = "epub-bar-side";
    this.tocBtn = button("icon-btn tb-square", ICON_TOC);
    left.append(this.tocBtn);

    const pill = document.createElement("div");
    pill.className = "page-nav-pill epub-nav";
    this.prevBtn = button("page-nav-step", ICON_CHEVRON_LEFT);
    this.nextBtn = button("page-nav-step", ICON_CHEVRON_RIGHT);
    this.position = document.createElement("span");
    this.position.className = "page-nav-mid epub-position";
    const sep = () => { const s = document.createElement("span"); s.className = "page-nav-sep"; return s; };
    pill.append(this.prevBtn, sep(), this.position, sep(), this.nextBtn);

    const right = document.createElement("div");
    right.className = "epub-bar-side epub-bar-right";
    this.smallerBtn = button("icon-btn", ICON_TEXT_SMALLER);
    this.largerBtn = button("icon-btn", ICON_TEXT_LARGER);
    this.scaleLabel = document.createElement("span");
    this.scaleLabel.className = "epub-scale";
    this.closeBtn = button("icon-btn", ICON_CLOSE);
    const divider = document.createElement("span");
    divider.className = "epub-divider";
    right.append(this.smallerBtn, this.scaleLabel, this.largerBtn, divider, this.closeBtn);
    this.bar.append(left, pill, right);

    const body = document.createElement("div");
    body.className = "epub-body";
    this.toc = document.createElement("aside");
    this.toc.className = "epub-toc";
    this.tocTitle = document.createElement("div");
    this.tocTitle.className = "epub-toc-title";
    this.tocList = document.createElement("nav");
    this.tocList.className = "epub-toc-list";
    this.toc.append(this.tocTitle, this.tocList);
    this.frame = document.createElement("iframe");
    this.frame.className = "epub-frame";
    this.frame.setAttribute("referrerpolicy", "no-referrer");
    body.append(this.toc, this.frame);
    root.append(this.bar, body);

    this.tocBtn.addEventListener("click", () => this.setTocOpen(this.toc.hidden === true));
    this.prevBtn.addEventListener("click", () => void this.step(-1));
    this.nextBtn.addEventListener("click", () => void this.step(1));
    this.smallerBtn.addEventListener("click", () => this.zoom(-1));
    this.largerBtn.addEventListener("click", () => this.zoom(1));
    this.closeBtn.addEventListener("click", () => this.deps.closeRequested());
    this.tocList.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
      if (!a || !this.book) return;
      const entry = this.book.info.toc[Number(a.dataset["index"])];
      if (entry) void this.goTo(entry.path, entry.fragment);
    });
    new MutationObserver(() => this.refreshTheme()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => this.refreshTheme());
    this.setTocOpen(load(TOC_KEY) === "1");
    this.showScale();
  }

  get isOpen(): boolean { return this.book !== null; }
  get title(): string { return this.book?.info.title || this.path.split(/[\\/]/).pop() || ""; }

  applyTranslations(t: Translations): void {
    this.t = t;
    this.tocBtn.title = t.ttEpubToc ?? "Contents";
    this.prevBtn.title = t.ttEpubPrev ?? "Previous chapter (←)";
    this.nextBtn.title = t.ttEpubNext ?? "Next chapter (→)";
    this.smallerBtn.title = t.ttEpubSmaller ?? "Smaller text (Ctrl+-)";
    this.largerBtn.title = t.ttEpubLarger ?? "Larger text (Ctrl++)";
    this.closeBtn.title = t.ttEpubClose ?? "Close book (Ctrl+W)";
    this.tocTitle.textContent = t.epubToc ?? "Contents";
    for (const b of [this.tocBtn, this.prevBtn, this.nextBtn, this.smallerBtn, this.largerBtn, this.closeBtn]) b.setAttribute("aria-label", b.title);
    const end = this.frame.contentDocument?.querySelector(".ez-end button");
    if (end) end.textContent = this.nextLabel();
  }

  /** Opens the book; throws an `EpubError` when it can't be read. */
  async open(path: string, bytes: Uint8Array): Promise<void> {
    const book = await EpubBook.open(bytes);
    this.close();
    this.book = book;
    this.path = path;
    this.root.hidden = false;
    this.renderToc();
    this.tocBtn.hidden = book.info.toc.length === 0;
    this.toc.classList.toggle("empty", book.info.toc.length === 0);
    this.deps.titleChanged(this.title);
    const saved = (load(POS_KEY + path) ?? "").split(":").map(Number);
    const chapter = Math.min(Math.max(0, saved[0] || 0), book.info.spine.length - 1);
    await this.show(chapter, { fraction: saved[1] || 0 });
  }

  close(): void {
    if (!this.book) return;
    this.savePosition();
    this.book = null;
    this.loadSeq++;
    this.frame.removeAttribute("srcdoc");
    this.frame.src = "about:blank";
    void this.urls.revokeAll();
    this.urls = new ResourceUrls();
    this.root.hidden = true;
    this.deps.titleChanged(null);
  }

  /** The theme changed: hands the new colors to the open chapter. */
  refreshTheme(): void {
    const d = this.frame.contentDocument;
    if (d && this.book) this.paint(d);
  }

  /** Reader keys, from the app window or from the book's frame. Returns true when used. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.book) return false;
    const ctrl = e.ctrlKey || e.metaKey;
    const win = this.frame.contentWindow;
    if (ctrl && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "+" || k === "=") { this.zoom(1); return true; }
      if (k === "-" || k === "_") { this.zoom(-1); return true; }
      if (k === "0") { this.setScale(1); return true; }
      if (k === "w" && !e.shiftKey) { this.deps.closeRequested(); return true; }
      return false;
    }
    if (e.altKey) return false;
    if (e.key === "ArrowRight") { void this.step(1); return true; }
    if (e.key === "ArrowLeft") { void this.step(-1); return true; }
    if (!win) return false;
    const atEnd = win.scrollY + win.innerHeight >= win.document.documentElement.scrollHeight - 2;
    const atTop = win.scrollY <= 0;
    if ((e.key === "PageDown" || (e.key === " " && !e.shiftKey)) && atEnd) { void this.step(1); return true; }
    if ((e.key === "PageUp" || (e.key === " " && e.shiftKey)) && atTop && this.chapterIndex > 0) {
      void this.show(this.chapterIndex - 1, { fraction: 1 });
      return true;
    }
    const target = e.target as Node | null;
    if (target === win.document || target?.ownerDocument === win.document) return false;
    // Keys typed in the app window still scroll the book.
    const page = win.innerHeight * 0.9;
    const by: Record<string, number> = { ArrowDown: 40, ArrowUp: -40, PageDown: page, PageUp: -page, " ": e.shiftKey ? -page : page };
    if (e.key in by) {
      win.scrollBy({ top: by[e.key]!, behavior: "instant" as ScrollBehavior });
      return true;
    }
    if (e.key === "Home" || e.key === "End") {
      win.scrollTo({ top: e.key === "Home" ? 0 : win.document.documentElement.scrollHeight, behavior: "instant" as ScrollBehavior });
      return true;
    }
    return false;
  }

  private async step(by: number): Promise<void> {
    if (!this.book) return;
    const to = this.chapterIndex + by;
    if (to < 0 || to >= this.book.info.spine.length) return;
    await this.show(to);
  }

  private async goTo(path: string, fragment: string): Promise<void> {
    if (!this.book) return;
    const index = this.book.info.spine.indexOf(path);
    if (index < 0) return;
    if (index === this.chapterIndex && this.frame.contentDocument?.body) this.scrollToFragment(fragment);
    else await this.show(index, { fragment });
  }

  private async show(index: number, at: { fraction?: number; fragment?: string } = {}): Promise<void> {
    const book = this.book;
    if (!book) return;
    this.savePosition();
    const seq = ++this.loadSeq;
    let chapter: Chapter;
    try {
      chapter = await book.chapter(index, this.urls);
    } catch {
      return;
    }
    if (seq !== this.loadSeq) return;
    this.chapterIndex = index;
    this.updateNav();

    await new Promise<void>((resolve) => {
      this.frame.addEventListener("load", () => resolve(), { once: true });
      this.frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"></head><body></body></html><!--${seq}-->`;
    });
    const d = this.frame.contentDocument;
    if (seq !== this.loadSeq || !d) return;
    this.fill(d, chapter);
    if (at.fragment) this.scrollToFragment(at.fragment);
    else if (at.fraction) {
      const w = this.frame.contentWindow!;
      // Pictures change the height as they load: wait for them before going back to the place.
      await Promise.race([
        Promise.all(Array.from(d.images).map((img) => img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))),
        new Promise((r) => setTimeout(r, 800)),
      ]);
      if (seq !== this.loadSeq) return;
      w.scrollTo({ top: at.fraction * (d.documentElement.scrollHeight - w.innerHeight), behavior: "instant" as ScrollBehavior });
    }
  }

  private fill(d: Document, chapter: Chapter): void {
    d.documentElement.lang = chapter.language;
    const style = (css: string) => { const s = d.createElement("style"); s.textContent = css; d.head.append(s); };
    style(BASE_CSS);
    chapter.styles.forEach(style);
    style(READER_CSS);
    if (chapter.bodyClass) d.body.className = chapter.bodyClass;
    for (const node of Array.from(chapter.body.childNodes)) d.body.append(d.importNode(node, true));
    const end = d.createElement("div");
    end.className = "ez-end";
    if (this.book && this.chapterIndex < this.book.info.spine.length - 1) {
      const next = d.createElement("button");
      next.type = "button";
      next.textContent = this.nextLabel();
      next.addEventListener("click", () => void this.step(1));
      end.append(next);
    }
    d.documentElement.append(end);
    this.paint(d);

    d.addEventListener("click", (e) => this.onClick(e));
    d.addEventListener("keydown", (e) => {
      if (this.handleKey(e)) e.preventDefault();
      else if (e.ctrlKey || e.metaKey || e.altKey || e.key === "Escape" || e.key.startsWith("F")) this.deps.forwardKey(e);
    });
    d.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.zoom(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    this.frame.contentWindow?.addEventListener("scroll", () => this.schedulePositionSave(), { passive: true });
  }

  private paint(d: Document): void {
    const cs = getComputedStyle(document.documentElement);
    const html = d.documentElement;
    for (const [to, from] of TOKENS) html.style.setProperty(to, cs.getPropertyValue(from).trim());
    html.style.setProperty("--ez-scale", String(this.scale));
    const dark = isDark();
    html.classList.toggle("ez-dark", dark);
    html.style.colorScheme = dark ? "dark" : "light";
  }

  private onClick(e: MouseEvent): void {
    const a = (e.target as Element | null)?.closest?.("a");
    if (!a) return;
    e.preventDefault();
    const external = a.getAttribute("data-ez-external");
    if (external) { this.deps.openUrl(external); return; }
    const target = a.getAttribute("data-ez-target");
    if (!target) return;
    const hash = target.indexOf("#");
    void this.goTo(target.slice(0, hash), target.slice(hash + 1));
  }

  private scrollToFragment(fragment: string): void {
    const d = this.frame.contentDocument;
    if (!d) return;
    if (!fragment) { this.frame.contentWindow?.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }); return; }
    const el = d.getElementById(fragment) ?? d.getElementsByName(fragment)[0];
    el?.scrollIntoView({ block: "start", behavior: "instant" as ScrollBehavior });
  }

  private renderToc(): void {
    this.tocList.replaceChildren();
    const toc = this.book?.info.toc ?? [];
    toc.forEach((entry, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "epub-toc-entry";
      b.dataset["index"] = String(i);
      b.style.setProperty("--depth", String(Math.min(entry.depth, 4)));
      b.textContent = entry.label;
      b.title = entry.label;
      this.tocList.append(b);
    });
  }

  private updateNav(): void {
    const book = this.book;
    if (!book) return;
    const total = book.info.spine.length;
    this.position.textContent = `${this.chapterIndex + 1} / ${total}`;
    this.prevBtn.disabled = this.chapterIndex === 0;
    this.nextBtn.disabled = this.chapterIndex >= total - 1;
    const current = tocIndexFor(book.info, this.chapterIndex);
    for (const el of Array.from(this.tocList.children) as HTMLElement[]) {
      const on = Number(el.dataset["index"]) === current;
      el.classList.toggle("current", on);
      if (on) el.setAttribute("aria-current", "true");
      else el.removeAttribute("aria-current");
      if (on && !this.toc.hidden) el.scrollIntoView({ block: "nearest" });
    }
  }

  private setTocOpen(open: boolean): void {
    this.toc.hidden = !open;
    this.tocBtn.classList.toggle("active", open);
    this.tocBtn.setAttribute("aria-pressed", String(open));
    store(TOC_KEY, open ? "1" : "0");
    if (open) this.tocList.querySelector(".current")?.scrollIntoView({ block: "nearest" });
  }

  private zoom(dir: 1 | -1): void {
    const i = SCALES.findIndex((s) => s >= this.scale - 1e-6);
    const at = i < 0 ? SCALES.length - 1 : i;
    this.setScale(SCALES[Math.min(SCALES.length - 1, Math.max(0, at + dir))]!);
  }

  private setScale(scale: number): void {
    const w = this.frame.contentWindow;
    const d = this.frame.contentDocument;
    const fraction = w && d ? w.scrollY / Math.max(1, d.documentElement.scrollHeight - w.innerHeight) : 0;
    this.scale = scale;
    store(SCALE_KEY, String(scale));
    this.showScale();
    if (d && this.book) {
      d.documentElement.style.setProperty("--ez-scale", String(scale));
      w?.scrollTo({ top: fraction * (d.documentElement.scrollHeight - w.innerHeight), behavior: "instant" as ScrollBehavior });
    }
  }

  private showScale(): void {
    this.scaleLabel.textContent = `${Math.round(this.scale * 100)} %`;
    this.smallerBtn.disabled = this.scale <= SCALES[0]! + 1e-6;
    this.largerBtn.disabled = this.scale >= SCALES[SCALES.length - 1]! - 1e-6;
  }

  private nextLabel(): string { return this.t?.epubNextChapter ?? "Next chapter"; }

  private schedulePositionSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.savePosition(), 400);
  }

  private savePosition(): void {
    clearTimeout(this.saveTimer);
    const w = this.frame.contentWindow;
    const d = this.frame.contentDocument;
    if (!this.book || !w || !d?.body?.childNodes.length) return;
    const fraction = w.scrollY / Math.max(1, d.documentElement.scrollHeight - w.innerHeight);
    store(POS_KEY + this.path, `${this.chapterIndex}:${Math.min(1, Math.max(0, fraction)).toFixed(4)}`);
  }
}

function isDark(): boolean {
  const theme = document.documentElement.dataset["theme"];
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return matchMedia("(prefers-color-scheme: dark)").matches;
}
