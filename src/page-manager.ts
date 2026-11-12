import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Translations } from "./i18n";
import { openPdfDialog, type PageSlot } from "./tauri-bridge";
import { ICON_DELETE, ICON_ROTATE_CW } from "./icons";
import { moveItems } from "./page-order";

/** Where a card's page comes from. */
type PageSource =
  | { kind: "original"; page: number }
  | { kind: "blank"; width: number; height: number }
  | { kind: "imported"; path: string; name: string; page: number; doc: PDFDocumentProxy };

interface PageItem {
  source: PageSource;
  rotation: number;
  /** Original pages are only marked (and can be restored); inserted ones are removed. */
  deleted: boolean;
  card: HTMLElement;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  item: PageItem;
  /** Set once the pointer moved far enough to count as a drag. */
  moving: PageItem[] | null;
  insertAt: number;
  ghost: HTMLElement | null;
  lastX: number;
  lastY: number;
  scrollRaf: number;
  /** A plain click on a card of a multi-selection selects only it on release. */
  collapseOnClick: boolean;
}

type ConfirmHandler = (slots: PageSlot[]) => void;
type ErrorHandler = (message: string) => void;

const RENDER_WIDTH_CSS = 800;
const THUMB_WIDTH_MIN = 120;
const THUMB_WIDTH_MAX = 800;
const THUMB_WIDTH_DEFAULT = 220;
const THUMB_WIDTH_STORAGE_KEY = "pdf-rider:page-manager-thumb-width";
const DRAG_THRESHOLD_PX = 5;
const AUTOSCROLL_EDGE_PX = 48;
const AUTOSCROLL_STEP_PX = 14;
/** A4 in PDF points, for a blank page when there is no page to copy the size of. */
const DEFAULT_PAGE_SIZE = { width: 595.28, height: 841.89 };

export class PageManagerModal {
  private backdrop: HTMLElement;
  private container: HTMLElement;
  private grid: HTMLElement;
  private zoomSlider: HTMLInputElement;
  private deletedCounter: HTMLElement;
  private dropIndicator: HTMLElement;
  private items: PageItem[] = [];
  private selected = new Set<PageItem>();
  private anchor: PageItem | null = null;
  private focused: PageItem | null = null;
  private pdfDoc: PDFDocumentProxy | null = null;
  private importedDocs: PDFDocumentProxy[] = [];
  private drag: DragState | null = null;
  private busy = false;
  private confirmHandlers: ConfirmHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];
  private _i18nText = new Map<HTMLElement, keyof Translations>();
  private _i18nTitle = new Map<HTMLElement, keyof Translations>();
  private _translations: Translations | null = null;
  private _keydownHandler = (e: KeyboardEvent) => this.handleKeydown(e);

  constructor() {
    const built = this.buildDOM();
    this.backdrop = built.backdrop;
    this.container = built.container;
    this.grid = built.grid;
    this.zoomSlider = built.zoomSlider;
    this.deletedCounter = built.deletedCounter;
    this.dropIndicator = built.dropIndicator;
    document.body.appendChild(this.backdrop);

    const initialWidth = this.readStoredWidth();
    this.applyThumbnailWidth(initialWidth);
    this.zoomSlider.value = String(initialWidth);
  }

  onConfirm(cb: ConfirmHandler): void {
    this.confirmHandlers.push(cb);
  }

  /** Called with a message to show when inserting a PDF fails. */
  onError(cb: ErrorHandler): void {
    this.errorHandlers.push(cb);
  }

  applyTranslations(t: Translations): void {
    this._translations = t;
    this._i18nText.forEach((key, el) => {
      const v = t[key];
      if (typeof v === "string") el.textContent = v;
    });
    this._i18nTitle.forEach((key, el) => {
      const v = t[key];
      if (typeof v === "string") el.title = v;
    });
    for (const item of this.items) this.refreshCardLabel(item);
    this.updateFooter();
  }

  async open(pdfDoc: PDFDocumentProxy, pageCount: number): Promise<void> {
    this.reset();
    this.pdfDoc = pdfDoc;
    this.backdrop.classList.remove("hidden");
    document.addEventListener("keydown", this._keydownHandler);

    for (let i = 1; i <= pageCount; i++) {
      const item = this.createItem({ kind: "original", page: i });
      this.items.push(item);
      this.grid.appendChild(item.card);
    }
    this.refreshPositions();
    this.updateFooter();
  }

  close(): void {
    this.backdrop.classList.add("hidden");
    document.removeEventListener("keydown", this._keydownHandler);
    this.reset();
  }

  private reset(): void {
    this.cancelDrag();
    this.grid.querySelectorAll(".page-thumbnail-card").forEach((c) => c.remove());
    this.items = [];
    this.selected.clear();
    this.anchor = null;
    this.focused = null;
    this.pdfDoc = null;
    for (const doc of this.importedDocs) void doc.destroy();
    this.importedDocs = [];
  }

  private t(key: keyof Translations, fallback: string): string {
    const v = this._translations?.[key];
    return typeof v === "string" ? v : fallback;
  }

  private buildDOM() {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop hidden";

    const container = document.createElement("div");
    container.className = "page-manager-container";

    // Header
    const header = document.createElement("div");
    header.className = "page-manager-header";

    const titleEl = document.createElement("span");
    titleEl.className = "page-manager-title";
    titleEl.textContent = "Manage Pages";
    this._i18nText.set(titleEl, "pmTitle");

    const addGroup = document.createElement("div");
    addGroup.className = "page-manager-add";

    const addBlankBtn = document.createElement("button");
    addBlankBtn.className = "btn";
    addBlankBtn.textContent = "+ Blank page";
    addBlankBtn.title = "Insert a blank page after the selection";
    this._i18nText.set(addBlankBtn, "pmAddBlank");
    this._i18nTitle.set(addBlankBtn, "pmAddBlankHint");
    addBlankBtn.addEventListener("click", () => void this.insertBlank());

    const addPdfBtn = document.createElement("button");
    addPdfBtn.className = "btn";
    addPdfBtn.textContent = "+ Insert PDF…";
    addPdfBtn.title = "Insert the pages of another PDF after the selection";
    this._i18nText.set(addPdfBtn, "pmInsertPdf");
    this._i18nTitle.set(addPdfBtn, "pmInsertPdfHint");
    addPdfBtn.addEventListener("click", () => void this.insertPdf());

    addGroup.append(addBlankBtn, addPdfBtn);

    // Zoom control
    const zoomGroup = document.createElement("div");
    zoomGroup.className = "page-manager-zoom";

    const zoomLabel = document.createElement("span");
    zoomLabel.className = "page-manager-zoom-label";
    zoomLabel.textContent = "Size";
    this._i18nText.set(zoomLabel, "pmZoom");

    const zoomSlider = document.createElement("input");
    zoomSlider.type = "range";
    zoomSlider.min = String(THUMB_WIDTH_MIN);
    zoomSlider.max = String(THUMB_WIDTH_MAX);
    zoomSlider.step = "10";
    zoomSlider.value = String(THUMB_WIDTH_DEFAULT);
    zoomSlider.className = "page-manager-zoom-slider";
    zoomSlider.addEventListener("input", () => {
      this.applyThumbnailWidth(Number(zoomSlider.value));
    });
    zoomSlider.addEventListener("change", () => {
      this.writeStoredWidth(Number(zoomSlider.value));
    });

    zoomGroup.append(zoomLabel, zoomSlider);

    const closeBtn = document.createElement("button");
    closeBtn.className = "icon-btn";
    closeBtn.innerHTML = "&times;";
    closeBtn.title = "Close";
    closeBtn.addEventListener("click", () => this.close());

    header.append(titleEl, addGroup, zoomGroup, closeBtn);

    // Grid
    const grid = document.createElement("div");
    grid.className = "page-manager-grid";
    grid.tabIndex = -1;
    grid.addEventListener("mousedown", (e) => {
      if (e.target === grid) this.clearSelection();
    });

    const dropIndicator = document.createElement("div");
    dropIndicator.className = "page-manager-drop-indicator hidden";

    // Footer
    const footer = document.createElement("div");
    footer.className = "page-manager-footer";

    const hint = document.createElement("span");
    hint.className = "page-manager-hint";
    hint.textContent = "Drag pages to reorder them";
    this._i18nText.set(hint, "pmDragHint");

    const deletedCounter = document.createElement("span");
    deletedCounter.className = "page-manager-deleted-counter";

    const footerButtons = document.createElement("div");
    footerButtons.className = "page-manager-footer-buttons";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn";
    cancelBtn.textContent = "Cancel";
    this._i18nText.set(cancelBtn, "pmCancel");
    cancelBtn.addEventListener("click", () => this.close());

    const applyBtn = document.createElement("button");
    applyBtn.className = "btn btn-primary";
    applyBtn.textContent = "Apply";
    this._i18nText.set(applyBtn, "pmApply");
    applyBtn.addEventListener("click", () => this.handleApply());

    footerButtons.append(cancelBtn, applyBtn);
    footer.append(hint, deletedCounter, footerButtons);
    container.append(header, grid, footer, dropIndicator);

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) this.close();
    });

    container.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        this.adjustZoom(e.deltaY < 0 ? 20 : -20);
      },
      { passive: false },
    );

    backdrop.appendChild(container);

    return { backdrop, container, grid, zoomSlider, deletedCounter, dropIndicator };
  }

  // ── Cards ───────────────────────────────────────────────────────────────

  private createItem(source: PageSource): PageItem {
    const card = document.createElement("div");
    card.className = "page-thumbnail-card";
    card.tabIndex = 0;
    if (source.kind !== "original") card.classList.add("inserted");

    const item: PageItem = { source, rotation: 0, deleted: false, card };

    const canvasWrapper = document.createElement("div");
    canvasWrapper.className = "page-thumbnail-canvas-wrapper";
    const canvas = document.createElement("canvas");
    canvasWrapper.appendChild(canvas);
    void this.renderThumbnail(source, canvas);

    canvasWrapper.addEventListener("pointerdown", (e) => this.handlePointerDown(item, e, canvasWrapper));
    canvasWrapper.addEventListener("pointermove", (e) => this.handlePointerMove(e));
    canvasWrapper.addEventListener("pointerup", (e) => this.handlePointerUp(e));
    canvasWrapper.addEventListener("pointercancel", () => this.cancelDrag());
    card.addEventListener("focus", () => {
      this.focused = item;
    });

    const label = document.createElement("div");
    label.className = "page-thumbnail-label";

    const controls = document.createElement("div");
    controls.className = "page-thumbnail-controls";

    const pageNum = document.createElement("span");
    pageNum.className = "page-number";

    const rotateBtn = document.createElement("button");
    rotateBtn.className = "icon-btn";
    rotateBtn.innerHTML = ICON_ROTATE_CW;
    rotateBtn.title = "Rotate page";
    this._i18nTitle.set(rotateBtn, "pmRotatePage");
    rotateBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.rotate(this.resolveTargets(item));
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "icon-btn delete-btn";
    deleteBtn.innerHTML = ICON_DELETE;
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleDelete(this.resolveTargets(item), item);
    });

    controls.append(pageNum, rotateBtn, deleteBtn);
    card.append(canvasWrapper, label, controls);
    this.refreshCardLabel(item);
    return item;
  }

  private async renderThumbnail(source: PageSource, canvas: HTMLCanvasElement): Promise<void> {
    if (source.kind === "blank") {
      const w = 200;
      const h = Math.round((w * source.height) / source.width);
      canvas.width = w;
      canvas.height = h;
      canvas.style.aspectRatio = `${w} / ${h}`;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
      }
      return;
    }
    const doc = source.kind === "original" ? this.pdfDoc : source.doc;
    if (!doc) return;
    try {
      const page = await doc.getPage(source.page);
      const dpr = window.devicePixelRatio || 1;
      const baseViewport = page.getViewport({ scale: 1.0 });
      const scale = (RENDER_WIDTH_CSS * dpr) / baseViewport.width;
      const viewport = page.getViewport({ scale });

      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.aspectRatio = `${viewport.width} / ${viewport.height}`;

      const ctx = canvas.getContext("2d")!;
      await page.render({ canvasContext: ctx, viewport }).promise;
    } catch {
      /* the modal was closed and the document destroyed meanwhile */
    }
  }

  /** Position number, origin tag and delete button title of a card. */
  private refreshCardLabel(item: PageItem): void {
    const label = item.card.querySelector(".page-thumbnail-label") as HTMLElement | null;
    if (label) {
      const s = item.source;
      if (s.kind === "blank") {
        label.textContent = this.t("pmBlankTag", "Blank page");
      } else if (s.kind === "imported") {
        label.textContent = `${s.name} · ${s.page}`;
        label.title = s.path;
      } else {
        label.textContent = "";
      }
    }
    const deleteBtn = item.card.querySelector(".delete-btn") as HTMLButtonElement | null;
    if (deleteBtn) {
      deleteBtn.title = item.deleted
        ? this.t("pmRestorePage", "Restore page")
        : this.t("pmDeletePage", "Delete page");
    }
  }

  /** Puts cards in `items` order and renumbers them. */
  private refreshPositions(): void {
    let n = 0;
    for (const item of this.items) {
      this.grid.appendChild(item.card);
      const num = item.card.querySelector(".page-number") as HTMLElement | null;
      if (num) num.textContent = item.deleted ? "–" : String(++n);
    }
  }

  // ── Sizing ──────────────────────────────────────────────────────────────

  private applyThumbnailWidth(width: number): void {
    const w = Math.max(THUMB_WIDTH_MIN, Math.min(THUMB_WIDTH_MAX, width));
    this.container.style.setProperty("--pm-thumb-width", `${w}px`);
  }

  private adjustZoom(delta: number): void {
    const current = Number(this.zoomSlider.value);
    const next = Math.max(THUMB_WIDTH_MIN, Math.min(THUMB_WIDTH_MAX, current + delta));
    if (next === current) return;
    this.zoomSlider.value = String(next);
    this.applyThumbnailWidth(next);
    this.writeStoredWidth(next);
  }

  private readStoredWidth(): number {
    try {
      const raw = localStorage.getItem(THUMB_WIDTH_STORAGE_KEY);
      if (!raw) return THUMB_WIDTH_DEFAULT;
      const n = Number(raw);
      if (!Number.isFinite(n)) return THUMB_WIDTH_DEFAULT;
      return Math.max(THUMB_WIDTH_MIN, Math.min(THUMB_WIDTH_MAX, n));
    } catch {
      return THUMB_WIDTH_DEFAULT;
    }
  }

  private writeStoredWidth(width: number): void {
    try {
      localStorage.setItem(THUMB_WIDTH_STORAGE_KEY, String(width));
    } catch {
      /* storage unavailable */
    }
  }

  // ── Selection ───────────────────────────────────────────────────────────

  private indexOf(item: PageItem): number {
    return this.items.indexOf(item);
  }

  private setSelection(items: PageItem[]): void {
    this.selected = new Set(items);
    this.refreshSelectionClasses();
  }

  private toggleSelection(item: PageItem): void {
    if (this.selected.has(item)) this.selected.delete(item);
    else this.selected.add(item);
    this.refreshSelectionClasses();
  }

  private selectRange(a: PageItem, b: PageItem): void {
    const i = this.indexOf(a);
    const j = this.indexOf(b);
    if (i < 0 || j < 0) return;
    this.setSelection(this.items.slice(Math.min(i, j), Math.max(i, j) + 1));
  }

  private clearSelection(): void {
    this.selected.clear();
    this.anchor = null;
    this.refreshSelectionClasses();
  }

  private refreshSelectionClasses(): void {
    for (const item of this.items) item.card.classList.toggle("selected", this.selected.has(item));
  }

  /** The selection in page order. */
  private selectedInOrder(): PageItem[] {
    return this.items.filter((i) => this.selected.has(i));
  }

  /** The whole selection if `item` is part of it, otherwise just `item`. */
  private resolveTargets(item: PageItem): PageItem[] {
    if (this.selected.has(item) && this.selected.size > 1) return this.selectedInOrder();
    return [item];
  }

  // ── Drag and drop ───────────────────────────────────────────────────────
  //
  // Pointer events rather than the HTML5 drag-and-drop API: Tauri's webview
  // on Windows intercepts native drags for file drops, which breaks it.

  private handlePointerDown(item: PageItem, e: PointerEvent, wrapper: HTMLElement): void {
    if (e.button !== 0 || this.busy) return;
    e.preventDefault();
    item.card.focus();

    let collapseOnClick = false;
    if (e.shiftKey && this.anchor) {
      this.selectRange(this.anchor, item);
    } else if (e.ctrlKey || e.metaKey) {
      this.toggleSelection(item);
      this.anchor = item;
    } else if (this.selected.has(item) && this.selected.size > 1) {
      // Keep the selection so it can be dragged as a whole.
      collapseOnClick = true;
      this.anchor = item;
    } else {
      this.setSelection([item]);
      this.anchor = item;
    }

    wrapper.setPointerCapture(e.pointerId);
    this.drag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      item,
      moving: null,
      insertAt: -1,
      ghost: null,
      lastX: e.clientX,
      lastY: e.clientY,
      scrollRaf: 0,
      collapseOnClick,
    };
  }

  private handlePointerMove(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;

    if (!drag.moving) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
      if (!this.selected.has(drag.item)) this.setSelection([drag.item]);
      drag.moving = this.selectedInOrder();
      for (const it of drag.moving) it.card.classList.add("dragging");
      drag.ghost = this.createGhost(drag.item, drag.moving.length);
      this.container.appendChild(drag.ghost);
      this.startAutoScroll(drag);
    }

    if (drag.ghost) {
      drag.ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
    }
    this.updateDropTarget(e.clientX, e.clientY);
  }

  private handlePointerUp(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (drag.moving) {
      const insertAt = drag.insertAt;
      const moving = drag.moving;
      this.cancelDrag();
      if (insertAt >= 0) this.moveTo(moving, insertAt);
    } else {
      if (drag.collapseOnClick) this.setSelection([drag.item]);
      this.cancelDrag();
    }
  }

  private cancelDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    cancelAnimationFrame(drag.scrollRaf);
    drag.ghost?.remove();
    for (const it of drag.moving ?? []) it.card.classList.remove("dragging");
    this.dropIndicator.classList.add("hidden");
  }

  private createGhost(item: PageItem, count: number): HTMLElement {
    const ghost = document.createElement("div");
    ghost.className = "page-manager-drag-ghost";
    const src = item.card.querySelector("canvas");
    if (src && src.width > 0) {
      const thumb = document.createElement("canvas");
      const w = 90;
      thumb.width = w;
      thumb.height = Math.round((w * src.height) / src.width);
      thumb.getContext("2d")?.drawImage(src, 0, 0, thumb.width, thumb.height);
      ghost.appendChild(thumb);
    }
    if (count > 1) {
      const badge = document.createElement("span");
      badge.className = "page-manager-drag-count";
      badge.textContent = String(count);
      ghost.appendChild(badge);
    }
    return ghost;
  }

  /** Finds the gap nearest to the pointer and shows the insertion bar there. */
  private updateDropTarget(x: number, y: number): void {
    const drag = this.drag;
    if (!drag || this.items.length === 0) return;

    let best = -1;
    let bestDist = Infinity;
    const rects = this.items.map((it) => it.card.getBoundingClientRect());
    rects.forEach((r, i) => {
      // Rows first: a card on the pointer's row always beats one above or below.
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      const dist = dy * 10000 + dx;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    if (best < 0) return;

    const r = rects[best];
    const after = x > r.left + r.width / 2;
    drag.insertAt = after ? best + 1 : best;

    const host = this.container.getBoundingClientRect();
    const gap = 8; // half of the grid gap
    const left = (after ? r.right + gap : r.left - gap) - host.left;
    const ind = this.dropIndicator;
    ind.style.left = `${left - 1.5}px`;
    ind.style.top = `${r.top - host.top}px`;
    ind.style.height = `${r.height}px`;
    ind.classList.remove("hidden");
  }

  private startAutoScroll(drag: DragState): void {
    const step = () => {
      if (this.drag !== drag) return;
      const r = this.grid.getBoundingClientRect();
      let delta = 0;
      if (drag.lastY < r.top + AUTOSCROLL_EDGE_PX) delta = -AUTOSCROLL_STEP_PX;
      else if (drag.lastY > r.bottom - AUTOSCROLL_EDGE_PX) delta = AUTOSCROLL_STEP_PX;
      if (delta !== 0) {
        const before = this.grid.scrollTop;
        this.grid.scrollTop += delta;
        // Keep the bar on the gap under the pointer while the grid scrolls.
        if (this.grid.scrollTop !== before) this.updateDropTarget(drag.lastX, drag.lastY);
      }
      drag.scrollRaf = requestAnimationFrame(step);
    };
    drag.scrollRaf = requestAnimationFrame(step);
  }

  /** Moves `moving` to the gap `insertAt` (in current order). */
  private moveTo(moving: PageItem[], insertAt: number): void {
    const indices = moving.map((it) => this.indexOf(it)).filter((i) => i >= 0);
    this.items = moveItems(this.items, indices, insertAt);
    this.refreshPositions();
    moving[0]?.card.focus();
    moving[0]?.card.scrollIntoView({ block: "nearest" });
  }

  /** Keyboard reorder: shifts the targets one place left or right. */
  private shiftTargets(delta: -1 | 1): void {
    const targets = this.targetsFromKeyboard();
    if (targets.length === 0) return;
    const indices = targets.map((t) => this.indexOf(t));
    const lo = Math.min(...indices);
    const hi = Math.max(...indices);
    if (delta < 0 && lo === 0) return;
    if (delta > 0 && hi === this.items.length - 1) return;
    // Gap index before the moved block's new place.
    this.moveTo(targets, delta < 0 ? lo - 1 : hi + 2);
  }

  // ── Insertion ───────────────────────────────────────────────────────────

  /** New pages go after the last selected (or focused) page, else at the end. */
  private insertionIndex(): number {
    const sel = this.selectedInOrder();
    const ref = sel.length > 0 ? sel[sel.length - 1] : this.focused;
    const i = ref ? this.indexOf(ref) : -1;
    return i >= 0 ? i + 1 : this.items.length;
  }

  private insertItems(items: PageItem[], at: number): void {
    this.items.splice(at, 0, ...items);
    this.refreshPositions();
    this.setSelection(items);
    this.anchor = items[0] ?? null;
    items[0]?.card.focus();
    items[0]?.card.scrollIntoView({ block: "nearest", behavior: "smooth" });
    this.updateFooter();
  }

  /** Displayed size, in PDF points, of the page a new blank page should match. */
  private async referenceSize(at: number): Promise<{ width: number; height: number }> {
    const ref = this.items[at - 1] ?? this.items[at];
    if (!ref) return DEFAULT_PAGE_SIZE;
    const s = ref.source;
    if (s.kind === "blank") return { width: s.width, height: s.height };
    const doc = s.kind === "original" ? this.pdfDoc : s.doc;
    if (!doc) return DEFAULT_PAGE_SIZE;
    try {
      const vp = (await doc.getPage(s.page)).getViewport({ scale: 1 });
      return { width: vp.width, height: vp.height };
    } catch {
      return DEFAULT_PAGE_SIZE;
    }
  }

  private async insertBlank(): Promise<void> {
    if (this.busy) return;
    const at = this.insertionIndex();
    const size = await this.referenceSize(at);
    this.insertItems([this.createItem({ kind: "blank", ...size })], at);
  }

  private async insertPdf(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const path = await openPdfDialog();
      if (!path) return;
      const at = this.insertionIndex();
      let doc: PDFDocumentProxy;
      try {
        doc = await pdfjs.getDocument({ url: convertFileSrc(path) + `?t=${Date.now()}` }).promise;
      } catch (err) {
        const isPassword = (err as { name?: string })?.name === "PasswordException";
        const tmpl = isPassword
          ? this.t("pmInsertEncrypted", "Password-protected PDFs cannot be inserted")
          : this.t("pmInsertFailed", "Could not insert the PDF: {err}");
        for (const cb of this.errorHandlers) cb(tmpl.replace("{err}", String(err)));
        return;
      }
      if (this.backdrop.classList.contains("hidden")) {
        void doc.destroy();
        return;
      }
      this.importedDocs.push(doc);
      const name = path.split(/[\\/]/).pop() ?? path;
      const items: PageItem[] = [];
      for (let p = 1; p <= doc.numPages; p++) {
        items.push(this.createItem({ kind: "imported", path, name, page: p, doc }));
      }
      this.insertItems(items, at);
    } finally {
      this.busy = false;
    }
  }

  // ── Rotate / delete ─────────────────────────────────────────────────────

  private rotate(targets: PageItem[]): void {
    for (const item of targets) {
      item.rotation = (item.rotation + 90) % 360;
      const wrapper = item.card.querySelector(".page-thumbnail-canvas-wrapper") as HTMLElement | null;
      if (wrapper) wrapper.style.transform = item.rotation ? `rotate(${item.rotation}deg)` : "";
    }
  }

  private aliveCount(): number {
    return this.items.filter((i) => !i.deleted).length;
  }

  /**
   * Deletes `targets`, or restores them when `reference` (the clicked card)
   * is already deleted. Inserted pages are removed outright; original pages
   * are only marked, so they can be restored until Apply.
   */
  private toggleDelete(targets: PageItem[], reference: PageItem): void {
    const goingToDelete = !reference.deleted;
    if (goingToDelete) {
      // Always keep at least one page.
      const wouldDelete = targets.filter((i) => !i.deleted).length;
      if (this.aliveCount() - wouldDelete < 1) return;
    }

    const removed = new Set<PageItem>();
    for (const item of targets) {
      if (goingToDelete && item.source.kind !== "original") {
        removed.add(item);
        continue;
      }
      item.deleted = goingToDelete;
      item.card.classList.toggle("deleted", goingToDelete);
      this.refreshCardLabel(item);
    }
    if (removed.size > 0) {
      const firstIndex = Math.min(...[...removed].map((r) => this.indexOf(r)));
      for (const r of removed) {
        r.card.remove();
        this.selected.delete(r);
      }
      this.items = this.items.filter((i) => !removed.has(i));
      const next = this.items[Math.min(firstIndex, this.items.length - 1)];
      if (this.focused && removed.has(this.focused)) this.focused = next ?? null;
      if (this.anchor && removed.has(this.anchor)) this.anchor = null;
      next?.card.focus();
    }
    this.refreshPositions();
    this.updateFooter();
  }

  // ── Keyboard ────────────────────────────────────────────────────────────

  private handleKeydown(e: KeyboardEvent): void {
    if (this.backdrop.classList.contains("hidden")) return;

    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
      return;
    }

    if (this.drag?.moving) {
      if (e.key === "Escape") {
        e.preventDefault();
        this.cancelDrag();
      }
      return;
    }

    const mod = e.ctrlKey || e.metaKey;
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        this.close();
        return;
      case "Enter":
        if (tag === "BUTTON") return;
        e.preventDefault();
        this.handleApply();
        return;
      case "Delete":
      case "Backspace": {
        e.preventDefault();
        const targets = this.targetsFromKeyboard();
        if (targets.length > 0) this.toggleDelete(targets, targets[0]);
        return;
      }
      case "r":
      case "R":
        if (mod || e.altKey) return;
        e.preventDefault();
        this.rotate(this.targetsFromKeyboard());
        return;
      case "a":
      case "A":
        if (mod) {
          e.preventDefault();
          this.setSelection([...this.items]);
        }
        return;
      case "+":
      case "=":
        if (mod) {
          e.preventDefault();
          this.adjustZoom(20);
        }
        return;
      case "-":
      case "_":
        if (mod) {
          e.preventDefault();
          this.adjustZoom(-20);
        }
        return;
      case "ArrowLeft":
        e.preventDefault();
        if (mod) this.shiftTargets(-1);
        else this.moveFocus(-1, e.shiftKey);
        return;
      case "ArrowRight":
        e.preventDefault();
        if (mod) this.shiftTargets(1);
        else this.moveFocus(1, e.shiftKey);
        return;
      case "ArrowUp":
        e.preventDefault();
        this.moveFocus(-this.computeRowSize(), e.shiftKey);
        return;
      case "ArrowDown":
        e.preventDefault();
        this.moveFocus(this.computeRowSize(), e.shiftKey);
        return;
      case "Home":
        e.preventDefault();
        this.focusIndex(0, e.shiftKey);
        return;
      case "End":
        e.preventDefault();
        this.focusIndex(this.items.length - 1, e.shiftKey);
        return;
    }
  }

  private targetsFromKeyboard(): PageItem[] {
    if (this.selected.size > 0) return this.selectedInOrder();
    if (this.focused && this.items.includes(this.focused)) return [this.focused];
    return [];
  }

  private moveFocus(delta: number, extend: boolean): void {
    if (this.items.length === 0) return;
    const base = this.focused ? Math.max(0, this.indexOf(this.focused)) : 0;
    this.focusIndex(Math.max(0, Math.min(this.items.length - 1, base + delta)), extend);
  }

  private focusIndex(index: number, extend: boolean): void {
    const item = this.items[index];
    if (!item) return;
    item.card.focus();
    this.focused = item;
    if (extend && this.anchor) {
      this.selectRange(this.anchor, item);
    } else {
      this.setSelection([item]);
      this.anchor = item;
    }
    item.card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  private computeRowSize(): number {
    if (this.items.length < 2) return 1;
    const firstTop = this.items[0].card.getBoundingClientRect().top;
    for (let i = 1; i < this.items.length; i++) {
      if (this.items[i].card.getBoundingClientRect().top !== firstTop) return i;
    }
    return this.items.length;
  }

  // ── Footer ──────────────────────────────────────────────────────────────

  private updateFooter(): void {
    const n = this.items.filter((i) => i.deleted).length;
    this.deletedCounter.textContent =
      n === 0 ? "" : this.t("pmWillDelete", "Will delete: {n}").replace("{n}", String(n));

    const alive = this.aliveCount();
    for (const item of this.items) {
      const btn = item.card.querySelector(".delete-btn") as HTMLButtonElement | null;
      if (btn) btn.disabled = !item.deleted && alive <= 1;
    }
  }

  private handleApply(): void {
    if (this.busy) return;
    const slots: PageSlot[] = [];
    for (const item of this.items) {
      if (item.deleted) continue;
      const s = item.source;
      const rotation = item.rotation;
      if (s.kind === "original") slots.push({ kind: "original", page: s.page, rotation });
      else if (s.kind === "blank") slots.push({ kind: "blank", width: s.width, height: s.height, rotation });
      else slots.push({ kind: "imported", path: s.path, page: s.page, rotation });
    }
    for (const cb of this.confirmHandlers) cb(slots);
    this.close();
  }
}
