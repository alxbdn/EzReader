import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { Translations } from "./i18n";
import { fmt } from "./i18n";

/** Width of a thumbnail in CSS pixels. */
const THUMB_WIDTH_CSS = 132;
/** How far outside the visible area thumbnails are rendered ahead of time. */
const PRERENDER_MARGIN = "600px 0px";
const VISIBLE_STORAGE_KEY = "pdf-rider:page-sidebar-visible";
const DRAG_THRESHOLD_PX = 5;
const AUTOSCROLL_EDGE_PX = 48;
const AUTOSCROLL_STEP_PX = 14;

const svg = (body: string, size = 12, stroke = 2.5): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON_CHECK  = svg(`<path d="M20 6 9 17l-5-5"/>`, 12, 3);
const ICON_X      = svg(`<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`);
const ICON_ROTATE = svg(`<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>`);
const ICON_PLUS   = svg(`<path d="M12 5v14"/><path d="M5 12h14"/>`, 14, 2);

interface Thumb {
  page: number;
  card: HTMLElement;
  canvas: HTMLCanvasElement;
  rendered: boolean;
  task: RenderTask | null;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  page: number;
  /** Pages being moved, set once the pointer moved far enough to count as a drag. */
  moving: number[] | null;
  insertAt: number;
  lastY: number;
  ghost: HTMLElement | null;
  scrollRaf: number;
}

type PagesHandler = (pages: number[]) => void;

/**
 * Page panel beside the viewer: a scrollable column of thumbnails to go to,
 * select, reorder (drag and drop), rotate, delete and export pages, and to
 * insert blank pages or the pages of another PDF.
 *
 * The panel only reports what the user asked for; the caller rewrites the
 * document and calls `load()` again with the result.
 */
export class PageSidebar {
  private root: HTMLElement;
  private list: HTMLElement;
  private dropIndicator: HTMLElement;
  private footer: HTMLElement;
  private countEl: HTMLElement;
  private actionBtns: HTMLButtonElement[] = [];
  private thumbs: Thumb[] = [];
  private selected = new Set<number>();
  private anchor: number | null = null;
  private current = 0;
  private doc: PDFDocumentProxy | null = null;
  private rotation = 0;
  private observer: IntersectionObserver;
  private _visible: boolean;
  private busy = false;
  private drag: DragState | null = null;
  private suppressClick = false;
  private translations: Translations | null = null;
  private i18nText = new Map<HTMLElement, [keyof Translations, string]>();
  private i18nTitle = new Map<HTMLElement, [keyof Translations, string]>();
  private goToHandlers: ((page: number) => void)[] = [];
  private deleteHandlers: PagesHandler[] = [];
  private exportHandlers: PagesHandler[] = [];
  private rotateHandlers: PagesHandler[] = [];
  private moveHandlers: ((pages: number[], insertAt: number) => void)[] = [];
  private insertBlankHandlers: ((after: number) => void)[] = [];
  private insertPdfHandlers: ((after: number) => void)[] = [];
  private visibilityHandlers: ((visible: boolean) => void)[] = [];
  private onPointerMove = (e: PointerEvent) => this.handlePointerMove(e);
  private onPointerUp = (e: PointerEvent) => this.handlePointerUp(e);

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.classList.add("page-sidebar");

    // Header: title, select all, insert buttons
    const header = document.createElement("div");
    header.className = "page-sidebar-header";
    const titleRow = document.createElement("div");
    titleRow.className = "page-sidebar-title-row";
    const title = document.createElement("span");
    title.className = "page-sidebar-title";
    this.text(title, "sbTitle", "Pages");
    const selectAll = document.createElement("button");
    selectAll.className = "btn btn-ghost btn-sm";
    this.text(selectAll, "sbSelectAll", "Select all");
    selectAll.addEventListener("click", () => this.selectAll());
    titleRow.append(title, selectAll);

    const insertRow = document.createElement("div");
    insertRow.className = "page-sidebar-insert-row";
    const addBlank = this.labeledBtn(ICON_PLUS, "sbAddBlank", "Blank page", "pmAddBlankHint", "Insert a blank page after the selection");
    addBlank.addEventListener("click", () => {
      if (this.canAct()) for (const cb of this.insertBlankHandlers) cb(this.insertionPoint());
    });
    const addPdf = this.labeledBtn(ICON_PLUS, "sbInsertPdf", "Insert PDF", "pmInsertPdfHint", "Insert the pages of another PDF after the selection");
    addPdf.addEventListener("click", () => {
      if (this.canAct()) for (const cb of this.insertPdfHandlers) cb(this.insertionPoint());
    });
    insertRow.append(addBlank, addPdf);
    header.append(titleRow, insertRow);

    // Thumbnails
    this.list = document.createElement("div");
    this.list.className = "page-sidebar-list";
    this.list.tabIndex = 0;
    this.list.addEventListener("keydown", (e) => this.handleKeydown(e));
    this.list.addEventListener("mousedown", (e) => {
      if (e.target === this.list) this.clearSelection();
    });
    this.dropIndicator = document.createElement("div");
    this.dropIndicator.className = "page-sidebar-drop hidden";

    // Footer, shown while pages are selected
    this.footer = document.createElement("div");
    this.footer.className = "page-sidebar-footer hidden";
    this.countEl = document.createElement("span");
    this.countEl.className = "page-sidebar-count";
    const clearBtn = document.createElement("button");
    clearBtn.className = "btn btn-ghost btn-sm";
    this.text(clearBtn, "sbClear", "Clear");
    clearBtn.addEventListener("click", () => this.clearSelection());
    const countRow = document.createElement("div");
    countRow.className = "page-sidebar-count-row";
    countRow.append(this.countEl, clearBtn);

    const rotateBtn = document.createElement("button");
    rotateBtn.className = "btn btn-sm page-sidebar-icon-action";
    rotateBtn.innerHTML = ICON_ROTATE;
    this.title(rotateBtn, "sbRotateHint", "Rotate the selected pages");
    rotateBtn.addEventListener("click", () => this.emitSelection(this.rotateHandlers));
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn btn-sm page-sidebar-delete";
    this.text(deleteBtn, "sbDelete", "Delete");
    this.title(deleteBtn, "sbDeleteHint", "Delete the selected pages");
    deleteBtn.addEventListener("click", () => this.emitSelection(this.deleteHandlers));
    const exportBtn = document.createElement("button");
    exportBtn.className = "btn btn-primary btn-sm";
    this.text(exportBtn, "sbExport", "Export");
    this.title(exportBtn, "sbExportHint", "Save the selected pages as a new PDF");
    exportBtn.addEventListener("click", () => this.emitSelection(this.exportHandlers));
    this.actionBtns = [rotateBtn, deleteBtn, exportBtn];
    const actions = document.createElement("div");
    actions.className = "page-sidebar-actions";
    actions.append(rotateBtn, deleteBtn, exportBtn);
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
  /** Pages (1-based, ascending) to delete. */
  onDelete(cb: PagesHandler): void { this.deleteHandlers.push(cb); }
  /** Pages (1-based, ascending) to save as a new PDF. */
  onExport(cb: PagesHandler): void { this.exportHandlers.push(cb); }
  /** Pages (1-based, ascending) to turn a quarter clockwise. */
  onRotate(cb: PagesHandler): void { this.rotateHandlers.push(cb); }
  /** Pages (1-based, ascending) to move to the gap `insertAt` (0 = before page 1). */
  onMove(cb: (pages: number[], insertAt: number) => void): void { this.moveHandlers.push(cb); }
  /** A blank page is wanted after page `after` (0 = at the start). */
  onInsertBlank(cb: (after: number) => void): void { this.insertBlankHandlers.push(cb); }
  /** Another PDF's pages are wanted after page `after` (0 = at the start). */
  onInsertPdf(cb: (after: number) => void): void { this.insertPdfHandlers.push(cb); }
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

  /** Shows the panel and moves keyboard focus into it. */
  focus(): void {
    if (!this._visible) this.setVisible(true);
    this.list.focus({ preventScroll: true });
  }

  /** Disables the actions while the document is being rewritten. */
  setBusy(busy: boolean): void {
    this.busy = busy;
    this.root.classList.toggle("busy", busy);
    if (busy) this.cancelDrag();
    this.updateFooter();
  }

  /**
   * Shows the thumbnails of `doc`. `dims` are the page sizes at scale 1 (used
   * to size the placeholders before a thumbnail is drawn).
   */
  load(doc: PDFDocumentProxy, dims: { width: number; height: number }[], rotation: number): void {
    const scrollTop = this.doc ? this.list.scrollTop : 0;
    this.clear();
    this.doc = doc;
    this.rotation = rotation;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < dims.length; i++) {
      const thumb = this.createThumb(i + 1, dims[i]);
      this.thumbs.push(thumb);
      frag.appendChild(thumb.card);
    }
    frag.appendChild(this.dropIndicator);
    this.list.appendChild(frag);
    for (const t of this.thumbs) this.observer.observe(t.card);
    // A reload of the same document (after an edit) keeps the panel where it was.
    this.list.scrollTop = scrollTop;
    this.updateFooter();
  }

  /** Forgets the document (on close / before reload). */
  clear(): void {
    this.cancelDrag();
    this.observer.disconnect();
    for (const t of this.thumbs) t.task?.cancel();
    this.thumbs = [];
    this.list.replaceChildren();
    this.selected.clear();
    this.anchor = null;
    this.current = 0;
    this.doc = null;
    this.root.classList.remove("selecting");
    this.updateFooter();
  }

  /** Selects exactly `pages` (after an edit, to keep the moved/rotated pages selected). */
  setSelection(pages: number[]): void {
    this.selected = new Set(pages.filter((p) => p >= 1 && p <= this.thumbs.length));
    this.anchor = pages[0] ?? null;
    this.updateSelectionClasses();
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
    if (this._visible && !this.drag) this.scrollIntoViewIfNeeded(t.card);
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

    const check = this.overlayBtn("page-sidebar-check", ICON_CHECK, () => {
      this.toggleSelected(page);
      this.anchor = page;
      this.updateSelectionClasses();
    });
    check.setAttribute("aria-pressed", "false");

    const tools = document.createElement("div");
    tools.className = "page-sidebar-tools";
    const rotate = this.overlayBtn("page-sidebar-rotate", ICON_ROTATE, () => {
      if (this.canAct()) for (const cb of this.rotateHandlers) cb([page]);
    });
    const del = this.overlayBtn("page-sidebar-remove", ICON_X, () => {
      if (this.canAct()) for (const cb of this.deleteHandlers) cb([page]);
    });
    tools.append(rotate, del);
    frame.append(check, tools);

    const label = document.createElement("span");
    label.className = "page-sidebar-label";

    card.append(frame, label);
    card.addEventListener("click", (e) => this.handleClick(page, e));
    card.addEventListener("pointerdown", (e) => this.handlePointerDown(page, e));

    const thumb: Thumb = { page, card, canvas, rendered: false, task: null };
    this.sizePlaceholder(thumb, dim);
    this.labelThumb(thumb);
    return thumb;
  }

  private overlayBtn(cls: string, icon: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = `page-sidebar-overlay-btn ${cls}`;
    b.innerHTML = icon;
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  private labelThumb(thumb: Thumb): void {
    const q = (sel: string) => thumb.card.querySelector(sel) as HTMLElement | null;
    const label = q(".page-sidebar-label");
    if (label) label.textContent = String(thumb.page);
    const check = q(".page-sidebar-check");
    if (check) check.title = this.t("sbSelectPage", "Select page (Ctrl+click)");
    const rotate = q(".page-sidebar-rotate");
    if (rotate) rotate.title = this.t("pmRotatePage", "Rotate page");
    const del = q(".page-sidebar-remove");
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
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
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
    if (this.thumbs.length === 0) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === "a") {
      e.preventDefault();
      e.stopPropagation();
      this.selectAll();
    } else if (e.key === "Escape" && (this.selected.size > 0 || this.drag)) {
      e.stopPropagation();
      if (this.drag) this.cancelDrag();
      else this.clearSelection();
    } else if (e.key === "Delete" && this.selected.size > 0) {
      e.preventDefault();
      e.stopPropagation();
      this.emitSelection(this.deleteHandlers);
    } else if (ctrl && (e.key === "ArrowUp" || e.key === "ArrowDown") && this.selected.size > 0) {
      // Keyboard reordering: move the selection one place up or down.
      e.preventDefault();
      e.stopPropagation();
      if (!this.canAct()) return;
      const pages = this.sortedSelection();
      const insertAt = e.key === "ArrowUp" ? pages[0] - 2 : pages[pages.length - 1] + 1;
      if (insertAt < 0 || insertAt > this.thumbs.length) return;
      for (const cb of this.moveHandlers) cb(pages, insertAt);
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

  private sortedSelection(): number[] {
    return [...this.selected].sort((a, b) => a - b);
  }

  /** Where inserted pages go: after the selection, else after the page shown. */
  private insertionPoint(): number {
    if (this.selected.size > 0) return Math.max(...this.selected);
    return this.current || this.thumbs.length;
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
    for (const b of this.actionBtns) b.disabled = this.busy || n === 0;
  }

  private canAct(): boolean {
    return !this.busy && this.doc !== null;
  }

  private emitSelection(handlers: PagesHandler[]): void {
    if (!this.canAct() || this.selected.size === 0) return;
    const pages = this.sortedSelection();
    for (const cb of handlers) cb(pages);
  }

  // ── Drag and drop reordering ────────────────────────────────────────────────

  private handlePointerDown(page: number, e: PointerEvent): void {
    if (e.button !== 0 || !this.canAct() || e.shiftKey || e.ctrlKey || e.metaKey) return;
    this.cancelDrag();
    this.drag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      page,
      moving: null,
      insertAt: -1,
      lastY: e.clientY,
      ghost: null,
      scrollRaf: 0,
    };
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
  }

  private handlePointerMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    d.lastY = e.clientY;
    if (!d.moving) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD_PX) return;
      d.moving = this.selected.has(d.page) ? this.sortedSelection() : [d.page];
      for (const p of d.moving) this.thumbs[p - 1]?.card.classList.add("dragging");
      d.ghost = document.createElement("div");
      d.ghost.className = "page-sidebar-ghost";
      d.ghost.textContent = d.moving.length === 1
        ? fmt(this.t("sbMovingOne", "Page {p}"), { p: d.moving[0] })
        : fmt(this.t("sbMovingMany", "{n} pages"), { n: d.moving.length });
      document.body.appendChild(d.ghost);
      this.root.classList.add("dragging");
      this.startAutoscroll();
    }
    e.preventDefault();
    if (d.ghost) {
      d.ghost.style.left = `${e.clientX + 12}px`;
      d.ghost.style.top = `${e.clientY + 12}px`;
    }
    this.updateDropTarget();
  }

  private handlePointerUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    const moving = d.moving;
    const insertAt = d.insertAt;
    this.cancelDrag();
    if (!moving || e.type === "pointercancel") return;
    // The click that ends a drag must not also navigate.
    this.suppressClick = true;
    setTimeout(() => { this.suppressClick = false; }, 0);
    if (insertAt < 0 || this.isNoOpMove(moving, insertAt)) return;
    for (const cb of this.moveHandlers) cb(moving, insertAt);
  }

  /** True when dropping `pages` at `insertAt` leaves the order unchanged. */
  private isNoOpMove(pages: number[], insertAt: number): boolean {
    const first = pages[0];
    const last = pages[pages.length - 1];
    const contiguous = last - first + 1 === pages.length;
    // Gaps first-1 .. last (0-based gap indices) all sit inside or next to the block.
    return contiguous && insertAt >= first - 1 && insertAt <= last;
  }

  /** Gap index under the pointer, and the line showing it. */
  private updateDropTarget(): void {
    const d = this.drag;
    if (!d) return;
    let at = this.thumbs.length;
    for (const t of this.thumbs) {
      const r = t.card.getBoundingClientRect();
      if (d.lastY < r.top + r.height / 2) {
        at = t.page - 1;
        break;
      }
    }
    d.insertAt = at;
    const gap = 7; // half of the list's row gap
    const ref = this.thumbs[at] ?? this.thumbs[at - 1];
    if (!ref) return;
    const top = at < this.thumbs.length
      ? ref.card.offsetTop - gap
      : ref.card.offsetTop + ref.card.offsetHeight + gap;
    this.dropIndicator.style.top = `${top - 1}px`;
    this.dropIndicator.classList.remove("hidden");
  }

  private startAutoscroll(): void {
    const step = () => {
      const d = this.drag;
      if (!d?.moving) return;
      const r = this.list.getBoundingClientRect();
      let dy = 0;
      if (d.lastY < r.top + AUTOSCROLL_EDGE_PX) dy = -AUTOSCROLL_STEP_PX;
      else if (d.lastY > r.bottom - AUTOSCROLL_EDGE_PX) dy = AUTOSCROLL_STEP_PX;
      if (dy !== 0) {
        this.list.scrollTop += dy;
        this.updateDropTarget();
      }
      d.scrollRaf = requestAnimationFrame(step);
    };
    if (this.drag) this.drag.scrollRaf = requestAnimationFrame(step);
  }

  private cancelDrag(): void {
    const d = this.drag;
    if (!d) return;
    cancelAnimationFrame(d.scrollRaf);
    d.ghost?.remove();
    for (const t of this.thumbs) t.card.classList.remove("dragging");
    this.dropIndicator.classList.add("hidden");
    this.root.classList.remove("dragging");
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    this.drag = null;
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

  private labeledBtn(
    icon: string,
    key: keyof Translations,
    fallback: string,
    titleKey: keyof Translations,
    titleFallback: string,
  ): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "btn btn-sm";
    b.innerHTML = icon;
    const span = document.createElement("span");
    this.text(span, key, fallback);
    b.append(span);
    this.title(b, titleKey, titleFallback);
    return b;
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
