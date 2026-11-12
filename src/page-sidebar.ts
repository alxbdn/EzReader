import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { Translations } from "./i18n";
import { fmt } from "./i18n";

/** Width of a thumbnail in CSS pixels. */
const THUMB_WIDTH_CSS = 132;
/** How far outside the visible area thumbnails are rendered ahead of time. */
const PRERENDER_MARGIN = "600px 0px";
const VISIBLE_STORAGE_KEY = "pdf-rider:page-sidebar-visible";

interface Thumb {
  page: number;
  card: HTMLElement;
  canvas: HTMLCanvasElement;
  rendered: boolean;
  task: RenderTask | null;
}

type PagesHandler = (pages: number[]) => void;

/**
 * Scrollable column of page thumbnails beside the viewer. A click goes to the
 * page, the cross on a thumbnail deletes it, and Ctrl/Shift-click (or the
 * check box) builds a selection that can be exported or deleted at once.
 */
export class PageSidebar {
  private root: HTMLElement;
  private list: HTMLElement;
  private footer: HTMLElement;
  private countEl: HTMLElement;
  private exportBtn: HTMLButtonElement;
  private deleteBtn: HTMLButtonElement;
  private thumbs: Thumb[] = [];
  private selected = new Set<number>();
  private anchor: number | null = null;
  private current = 0;
  private doc: PDFDocumentProxy | null = null;
  private rotation = 0;
  private observer: IntersectionObserver;
  private _visible: boolean;
  private busy = false;
  private translations: Translations | null = null;
  private i18nText = new Map<HTMLElement, [keyof Translations, string]>();
  private i18nTitle = new Map<HTMLElement, [keyof Translations, string]>();
  private goToHandlers: ((page: number) => void)[] = [];
  private deleteHandlers: PagesHandler[] = [];
  private exportHandlers: PagesHandler[] = [];
  private visibilityHandlers: ((visible: boolean) => void)[] = [];

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.classList.add("page-sidebar");

    const header = document.createElement("div");
    header.className = "page-sidebar-header";
    const title = document.createElement("span");
    title.className = "page-sidebar-title";
    this.text(title, "sbTitle", "Pages");
    const selectAll = document.createElement("button");
    selectAll.className = "btn btn-ghost btn-sm";
    this.text(selectAll, "sbSelectAll", "Select all");
    selectAll.addEventListener("click", () => this.selectAll());
    header.append(title, selectAll);

    this.list = document.createElement("div");
    this.list.className = "page-sidebar-list";
    this.list.tabIndex = 0;
    this.list.addEventListener("keydown", (e) => this.handleKeydown(e));

    this.footer = document.createElement("div");
    this.footer.className = "page-sidebar-footer hidden";
    this.countEl = document.createElement("span");
    this.countEl.className = "page-sidebar-count";
    const clearBtn = document.createElement("button");
    clearBtn.className = "btn btn-ghost btn-sm";
    this.text(clearBtn, "sbClear", "Clear");
    clearBtn.addEventListener("click", () => this.clearSelection());
    this.exportBtn = document.createElement("button");
    this.exportBtn.className = "btn btn-primary btn-sm";
    this.text(this.exportBtn, "sbExport", "Export");
    this.title(this.exportBtn, "sbExportHint", "Save the selected pages as a new PDF");
    this.exportBtn.addEventListener("click", () => this.emitSelection(this.exportHandlers));
    this.deleteBtn = document.createElement("button");
    this.deleteBtn.className = "btn btn-sm page-sidebar-delete";
    this.text(this.deleteBtn, "sbDelete", "Delete");
    this.title(this.deleteBtn, "sbDeleteHint", "Delete the selected pages");
    this.deleteBtn.addEventListener("click", () => this.emitSelection(this.deleteHandlers));
    const actions = document.createElement("div");
    actions.className = "page-sidebar-actions";
    actions.append(this.deleteBtn, this.exportBtn);
    const countRow = document.createElement("div");
    countRow.className = "page-sidebar-count-row";
    countRow.append(this.countEl, clearBtn);
    this.footer.append(countRow, actions);

    this.root.append(header, this.list, this.footer);

    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), {
      root: this.list,
      rootMargin: PRERENDER_MARGIN,
    });

    this._visible = this.readVisible();
    this.root.classList.toggle("collapsed", !this._visible);
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  onGoTo(cb: (page: number) => void): void { this.goToHandlers.push(cb); }
  /** Called with the 1-based pages to delete, in ascending order. */
  onDelete(cb: PagesHandler): void { this.deleteHandlers.push(cb); }
  /** Called with the 1-based pages to export, in ascending order. */
  onExport(cb: PagesHandler): void { this.exportHandlers.push(cb); }
  onVisibilityChange(cb: (visible: boolean) => void): void { this.visibilityHandlers.push(cb); }

  // ── Public API ──────────────────────────────────────────────────────────────

  get visible(): boolean { return this._visible; }

  toggle(): void { this.setVisible(!this._visible); }

  setVisible(visible: boolean): void {
    this._visible = visible;
    this.root.classList.toggle("collapsed", !visible);
    this.writeVisible(visible);
    if (visible) this.scrollToCurrent();
    for (const cb of this.visibilityHandlers) cb(visible);
  }

  /** Disables the actions while a delete or export runs. */
  setBusy(busy: boolean): void {
    this.busy = busy;
    this.root.classList.toggle("busy", busy);
    this.updateFooter();
  }

  /**
   * Shows the thumbnails of `doc`. `dims` are the page sizes at scale 1 (used
   * to size the placeholders before a thumbnail is drawn).
   */
  load(doc: PDFDocumentProxy, dims: { width: number; height: number }[], rotation: number): void {
    this.clear();
    this.doc = doc;
    this.rotation = rotation;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < dims.length; i++) {
      const thumb = this.createThumb(i + 1, dims[i]);
      this.thumbs.push(thumb);
      frag.appendChild(thumb.card);
    }
    this.list.appendChild(frag);
    for (const t of this.thumbs) this.observer.observe(t.card);
    this.list.scrollTop = 0;
    this.updateFooter();
  }

  /** Forgets the document (on close / before reload). */
  clear(): void {
    this.observer.disconnect();
    for (const t of this.thumbs) t.task?.cancel();
    this.thumbs = [];
    this.list.replaceChildren();
    this.selected.clear();
    this.anchor = null;
    this.current = 0;
    this.doc = null;
    this.updateFooter();
  }

  /** Redraws every thumbnail with a new view rotation. */
  setRotation(rotation: number, dims: { width: number; height: number }[]): void {
    if (rotation === this.rotation) return;
    this.rotation = rotation;
    for (const t of this.thumbs) {
      t.task?.cancel();
      t.task = null;
      t.rendered = false;
      this.sizePlaceholder(t, dims[t.page - 1]);
      this.observer.unobserve(t.card);
      this.observer.observe(t.card);
    }
  }

  /** Highlights the page shown in the viewer and keeps it in view. */
  setCurrentPage(page: number): void {
    if (page === this.current) return;
    this.thumbs[this.current - 1]?.card.classList.remove("current");
    this.current = page;
    const t = this.thumbs[page - 1];
    if (!t) return;
    t.card.classList.add("current");
    if (this._visible) this.scrollIntoViewIfNeeded(t.card);
  }

  applyTranslations(t: Translations): void {
    this.translations = t;
    this.i18nText.forEach(([key, fb], el) => { el.textContent = this.t(key, fb); });
    this.i18nTitle.forEach(([key, fb], el) => { el.title = this.t(key, fb); });
    for (const thumb of this.thumbs) this.labelThumb(thumb);
    this.updateFooter();
  }

  // ── Thumbnails ──────────────────────────────────────────────────────────────

  private createThumb(page: number, dim: { width: number; height: number } | undefined): Thumb {
    const card = document.createElement("div");
    card.className = "page-sidebar-thumb";
    card.dataset.page = String(page);

    const frame = document.createElement("div");
    frame.className = "page-sidebar-frame";
    const canvas = document.createElement("canvas");
    frame.appendChild(canvas);

    const check = document.createElement("button");
    check.className = "page-sidebar-check";
    check.setAttribute("aria-pressed", "false");
    check.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;
    check.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleSelected(page);
      this.anchor = page;
      this.updateSelectionClasses();
    });

    const del = document.createElement("button");
    del.className = "page-sidebar-remove";
    del.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.busy) return;
      for (const cb of this.deleteHandlers) cb([page]);
    });

    frame.append(check, del);

    const label = document.createElement("span");
    label.className = "page-sidebar-label";

    card.append(frame, label);
    card.addEventListener("click", (e) => this.handleClick(page, e));

    const thumb: Thumb = { page, card, canvas, rendered: false, task: null };
    this.sizePlaceholder(thumb, dim);
    this.labelThumb(thumb);
    return thumb;
  }

  private labelThumb(thumb: Thumb): void {
    const label = thumb.card.querySelector(".page-sidebar-label") as HTMLElement | null;
    if (label) label.textContent = String(thumb.page);
    const check = thumb.card.querySelector(".page-sidebar-check") as HTMLElement | null;
    if (check) check.title = this.t("sbSelectPage", "Select page");
    const del = thumb.card.querySelector(".page-sidebar-remove") as HTMLElement | null;
    if (del) del.title = this.t("pmDeletePage", "Delete page");
  }

  private sizePlaceholder(thumb: Thumb, dim: { width: number; height: number } | undefined): void {
    const w = dim?.width ?? 595;
    const h = dim?.height ?? 842;
    const swap = this.rotation % 180 !== 0;
    thumb.canvas.style.aspectRatio = swap ? `${h} / ${w}` : `${w} / ${h}`;
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const page = Number((entry.target as HTMLElement).dataset.page);
      const thumb = this.thumbs[page - 1];
      if (thumb && !thumb.rendered && !thumb.task) void this.render(thumb);
    }
  }

  private async render(thumb: Thumb): Promise<void> {
    const doc = this.doc;
    if (!doc) return;
    try {
      const page = await doc.getPage(thumb.page);
      if (doc !== this.doc) return;
      const rotation = (page.rotate + this.rotation) % 360;
      const base = page.getViewport({ scale: 1, rotation });
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: (THUMB_WIDTH_CSS * dpr) / base.width, rotation });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const task = page.render({ canvasContext: ctx, viewport });
      thumb.task = task;
      await task.promise;
      thumb.task = null;
      if (doc !== this.doc) return;
      // Swap in the finished canvas so a half-drawn one is never shown.
      canvas.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
      thumb.canvas.replaceWith(canvas);
      thumb.canvas = canvas;
      thumb.rendered = true;
    } catch {
      // Cancelled, or the document was replaced meanwhile.
      thumb.task = null;
    }
  }

  // ── Selection ───────────────────────────────────────────────────────────────

  private handleClick(page: number, e: MouseEvent): void {
    if (e.shiftKey && this.anchor !== null) {
      const [a, b] = this.anchor < page ? [this.anchor, page] : [page, this.anchor];
      if (!(e.ctrlKey || e.metaKey)) this.selected.clear();
      for (let p = a; p <= b; p++) this.selected.add(p);
      this.updateSelectionClasses();
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      this.toggleSelected(page);
      this.anchor = page;
      this.updateSelectionClasses();
      return;
    }
    this.anchor = page;
    for (const cb of this.goToHandlers) cb(page);
  }

  private handleKeydown(e: KeyboardEvent): void {
    const count = this.thumbs.length;
    if (count === 0) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      e.stopPropagation();
      this.selectAll();
    } else if (e.key === "Escape" && this.selected.size > 0) {
      e.stopPropagation();
      this.clearSelection();
    } else if (e.key === "Delete" && this.selected.size > 0) {
      e.preventDefault();
      e.stopPropagation();
      this.emitSelection(this.deleteHandlers);
    }
  }

  private toggleSelected(page: number): void {
    if (this.selected.has(page)) this.selected.delete(page);
    else this.selected.add(page);
  }

  private selectAll(): void {
    for (const t of this.thumbs) this.selected.add(t.page);
    this.updateSelectionClasses();
  }

  clearSelection(): void {
    this.selected.clear();
    this.anchor = null;
    this.updateSelectionClasses();
  }

  private updateSelectionClasses(): void {
    for (const t of this.thumbs) {
      const on = this.selected.has(t.page);
      t.card.classList.toggle("selected", on);
      t.card.querySelector(".page-sidebar-check")?.setAttribute("aria-pressed", String(on));
    }
    this.root.classList.toggle("selecting", this.selected.size > 0);
    this.updateFooter();
  }

  private updateFooter(): void {
    const n = this.selected.size;
    this.footer.classList.toggle("hidden", n === 0);
    this.countEl.textContent = fmt(
      n === 1 ? this.t("sbSelectedOne", "1 page selected") : this.t("sbSelectedMany", "{n} pages selected"),
      { n },
    );
    this.exportBtn.disabled = this.busy || n === 0;
    this.deleteBtn.disabled = this.busy || n === 0;
  }

  private emitSelection(handlers: PagesHandler[]): void {
    if (this.busy || this.selected.size === 0) return;
    const pages = [...this.selected].sort((a, b) => a - b);
    for (const cb of handlers) cb(pages);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private scrollToCurrent(): void {
    const t = this.thumbs[this.current - 1];
    if (t) this.scrollIntoViewIfNeeded(t.card);
  }

  private scrollIntoViewIfNeeded(el: HTMLElement): void {
    const list = this.list.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < list.top || r.bottom > list.bottom) {
      el.scrollIntoView({ block: "nearest" });
    }
  }

  private t(key: keyof Translations, fallback: string): string {
    const v = this.translations?.[key];
    return typeof v === "string" ? v : fallback;
  }

  private text(el: HTMLElement, key: keyof Translations, fallback: string): void {
    el.textContent = fallback;
    this.i18nText.set(el, [key, fallback]);
  }

  private title(el: HTMLElement, key: keyof Translations, fallback: string): void {
    el.title = fallback;
    this.i18nTitle.set(el, [key, fallback]);
  }

  private readVisible(): boolean {
    try {
      return localStorage.getItem(VISIBLE_STORAGE_KEY) !== "0";
    } catch {
      return true;
    }
  }

  private writeVisible(visible: boolean): void {
    try {
      localStorage.setItem(VISIBLE_STORAGE_KEY, visible ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  }
}
