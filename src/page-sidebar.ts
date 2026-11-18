import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { Translations } from "./i18n";
import { fmt } from "./i18n";

const THUMB_WIDTH_CSS = 132;
const PRERENDER_MARGIN = "600px 0px";
const VISIBLE_STORAGE_KEY = "pdf-rider:page-sidebar-visible";
const DRAG_THRESHOLD_PX = 5;
const AUTOSCROLL_EDGE_PX = 48;
const AUTOSCROLL_STEP_PX = 14;

const svg = (body: string, size = 12, stroke = 2.5): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON_ROTATE_LEFT = `<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.6 4.4A8 8 0 1 1 4.4 15.2" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M2.2 3.6v6.6h6.6z" fill="currentColor"/></svg>`;
const ICON_TRASH   = svg(`<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>`, 13, 2);
const ICON_OUTLINE = svg(`<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>`, 13, 2);
const ICON_PLUS_LG = svg(`<path d="M12 5v14"/><path d="M5 12h14"/>`, 22, 2);
const ICON_UP     = svg(`<path d="m18 15-6-6-6 6"/>`, 13, 2.5);
const ICON_DOWN   = svg(`<path d="m6 9 6 6 6-6"/>`, 13, 2.5);
const HOLD_DELAY_MS = 500;
const HOLD_REPEAT_MS = 45;

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
  moving: number[] | null;
  insertAt: number;
  lastY: number;
  zone: DragZone;
  ghost: HTMLElement | null;
  scrollRaf: number;
}

type DragZone = "list" | "tab" | "window";

type PagesHandler = (pages: number[]) => void;

function isOutsideWindow(e: PointerEvent): boolean {
  return e.clientX < 0 || e.clientY < 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight;
}

const TAB_ZONE_MARGIN_PX = 24;

export class PageSidebar {
  private root: HTMLElement;
  private list: HTMLElement;
  private dropIndicator: HTMLElement;
  private thumbs: Thumb[] = [];
  private selected = new Set<number>();
  private anchor: number | null = null;
  private current = 0;
  private doc: PDFDocumentProxy | null = null;
  private rotation = 0;
  private observer: IntersectionObserver;
  private _visible: boolean;
  private busy = false;
  private viewerBusy = false;
  private pendingThumbs = new Set<Thumb>();
  private renderingThumb = false;
  private renderGeneration = 0;
  private revealRaf = 0;
  private drag: DragState | null = null;
  private suppressClick = false;
  private translations: Translations | null = null;
  private i18nText = new Map<HTMLElement, [keyof Translations, string]>();
  private i18nTitle = new Map<HTMLElement, [keyof Translations, string]>();
  private goToHandlers: ((page: number, instant: boolean) => void)[] = [];
  private destHandlers: ((dest: unknown) => void)[] = [];
  private deleteHandlers: PagesHandler[] = [];
  private exportHandlers: PagesHandler[] = [];
  private rotateHandlers: ((pages: number[], quarterTurns: number) => void)[] = [];
  private moveHandlers: ((pages: number[], insertAt: number) => void)[] = [];
  private dragOutHandlers: ((pages: number[], screenX: number, screenY: number) => void)[] = [];
  private dragToTabHandlers: PagesHandler[] = [];
  private tabZoneHandlers: ((over: boolean) => void)[] = [];
  private insertBlankHandlers: ((after: number) => void)[] = [];
  private insertImagesHandlers: ((after: number) => void)[] = [];
  private insertPdfHandlers: ((after: number) => void)[] = [];
  private visibilityHandlers: ((visible: boolean) => void)[] = [];
  private selectionHandlers: ((pages: number[]) => void)[] = [];
  private addCard!: HTMLElement;
  private pageInput!: HTMLInputElement;
  private pageTotal!: HTMLElement;
  private selectAllBtn!: HTMLButtonElement;
  private selectAllLabel!: HTMLElement;
  private deleteBtn!: HTMLButtonElement;
  private outlineBtn!: HTMLButtonElement;
  private outlineList!: HTMLElement;
  private hintEl!: HTMLElement;
  private outlineMode = false;
  private outlineLoadedFor: PDFDocumentProxy | null = null;
  private navTarget = 0;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private holdInterval: ReturnType<typeof setInterval> | null = null;
  private onPointerMove = (e: PointerEvent) => this.handlePointerMove(e);
  private onPointerUp = (e: PointerEvent) => this.handlePointerUp(e);

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.classList.add("page-sidebar");

    const header = document.createElement("div");
    header.className = "page-sidebar-header";
    const titleRow = document.createElement("div");
    titleRow.className = "page-sidebar-title-row";
    const title = document.createElement("span");
    title.className = "page-sidebar-title";
    this.text(title, "sbTitle", "Pages");
    titleRow.append(title, this.buildPageNav());

    const pills = document.createElement("div");
    pills.className = "page-sidebar-pills";
    this.selectAllBtn = document.createElement("button");
    this.selectAllBtn.className = "sb-pill";
    const check = document.createElement("span");
    check.className = "sb-check";
    this.selectAllLabel = document.createElement("span");
    this.selectAllBtn.append(check, this.selectAllLabel);
    this.selectAllBtn.addEventListener("click", () => {
      if (this.allSelected()) this.clearSelection();
      else this.selectAll();
    });
    this.deleteBtn = document.createElement("button");
    this.deleteBtn.className = "sb-pill sb-icon-pill sb-delete";
    this.deleteBtn.innerHTML = ICON_TRASH;
    this.title(this.deleteBtn, "sbDeleteHint", "Delete the selected pages");
    this.deleteBtn.addEventListener("click", () => this.emitSelection(this.deleteHandlers));

    this.outlineBtn = document.createElement("button");
    this.outlineBtn.className = "sb-pill sb-icon-pill sb-outline";
    this.outlineBtn.innerHTML = ICON_OUTLINE;
    this.title(this.outlineBtn, "sbOutlineHint", "Document structure");
    this.outlineBtn.addEventListener("click", () => this.setOutlineMode(!this.outlineMode));

    pills.append(this.selectAllBtn, this.deleteBtn, this.outlineBtn);
    header.append(titleRow, pills);

    this.list = document.createElement("div");
    this.list.className = "page-sidebar-list";
    this.list.tabIndex = 0;
    this.list.addEventListener("keydown", (e) => this.handleKeydown(e));
    this.dropIndicator = document.createElement("div");
    this.dropIndicator.className = "page-sidebar-drop hidden";

    this.addCard = document.createElement("button");
    this.addCard.className = "page-sidebar-add";
    this.addCard.innerHTML = ICON_PLUS_LG;
    const addLabel = document.createElement("span");
    this.text(addLabel, "sbAppendPdf", "Add a PDF");
    this.addCard.append(addLabel);
    this.title(this.addCard, "sbAppendPdfHint", "Add the pages of another PDF at the end");
    this.addCard.addEventListener("click", () => {
      if (this.canAct()) for (const cb of this.insertPdfHandlers) cb(this.thumbs.length);
    });

    const hint = document.createElement("div");
    hint.className = "page-sidebar-hint";
    this.text(hint, "sbHint", "Drag pages to reorder them.");
    this.hintEl = hint;

    this.outlineList = document.createElement("div");
    this.outlineList.className = "page-sidebar-outline";
    this.outlineList.hidden = true;

    this.root.append(header, this.list, hint, this.outlineList);

    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), {
      root: this.list,
      rootMargin: PRERENDER_MARGIN,
    });

    this._visible = this.readVisible();
    this.root.classList.toggle("collapsed", !this._visible);
    window.addEventListener("pointerup", () => this.stopHold());
    window.addEventListener("blur", () => this.stopHold());
    this.updateHeader();
  }

  onGoTo(cb: (page: number, instant: boolean) => void): void { this.goToHandlers.push(cb); }
  onDestination(cb: (dest: unknown) => void): void { this.destHandlers.push(cb); }
  onDelete(cb: PagesHandler): void { this.deleteHandlers.push(cb); }
  onExport(cb: PagesHandler): void { this.exportHandlers.push(cb); }
  onRotate(cb: (pages: number[], quarterTurns: number) => void): void { this.rotateHandlers.push(cb); }
  onMove(cb: (pages: number[], insertAt: number) => void): void { this.moveHandlers.push(cb); }
  onDragOut(cb: (pages: number[], screenX: number, screenY: number) => void): void { this.dragOutHandlers.push(cb); }
  onDragToTab(cb: PagesHandler): void { this.dragToTabHandlers.push(cb); }
  onTabZone(cb: (over: boolean) => void): void { this.tabZoneHandlers.push(cb); }
  onInsertBlank(cb: (after: number) => void): void { this.insertBlankHandlers.push(cb); }
  onInsertPdf(cb: (after: number) => void): void { this.insertPdfHandlers.push(cb); }
  onInsertImages(cb: (after: number) => void): void { this.insertImagesHandlers.push(cb); }
  onVisibilityChange(cb: (visible: boolean) => void): void { this.visibilityHandlers.push(cb); }
  onSelectionChange(cb: (pages: number[]) => void): void { this.selectionHandlers.push(cb); }

  requestInsertBlank(): void { if (this.canAct()) for (const cb of this.insertBlankHandlers) cb(this.insertionPoint()); }
  requestInsertPdf(): void { if (this.canAct()) for (const cb of this.insertPdfHandlers) cb(this.insertionPoint()); }
  requestInsertImages(): void { if (this.canAct()) for (const cb of this.insertImagesHandlers) cb(this.insertionPoint()); }
  requestExportSelection(): void {
    if (!this.canAct()) return;
    const pages = this.selected.size > 0 ? this.sortedSelection() : (this.current ? [this.current] : []);
    if (pages.length > 0) for (const cb of this.exportHandlers) cb(pages);
  }

  get selection(): number[] { return this.sortedSelection(); }

  setHits(counts: Map<number, number>): void {
    for (const t of this.thumbs) {
      const n = counts.get(t.page) ?? 0;
      t.card.classList.toggle("has-hits", n > 0);
      const badge = t.card.querySelector(".page-sidebar-hits") as HTMLElement | null;
      if (badge) badge.textContent = n > 0 ? String(n) : "";
    }
  }

  get visible(): boolean { return this._visible; }

  toggle(): void { this.setVisible(!this._visible); }

  setVisible(visible: boolean): void {
    this._visible = visible;
    this.root.classList.toggle("collapsed", !visible);
    this.writeVisible(visible);
    if (visible) {
      this.scrollToCurrent();
      this.pumpThumbs();
    }
    for (const cb of this.visibilityHandlers) cb(visible);
  }

  setViewerBusy(busy: boolean): void {
    if (this.viewerBusy === busy) return;
    this.viewerBusy = busy;
    if (!busy) this.pumpThumbs();
  }

  focus(): void {
    if (!this._visible) this.setVisible(true);
    this.list.focus({ preventScroll: true });
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.root.classList.toggle("busy", busy);
    if (busy) { this.cancelDrag(); this.stopHold(); }
    this.updateHeader();
  }

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
    frag.appendChild(this.addCard);
    frag.appendChild(this.dropIndicator);
    this.list.appendChild(frag);
    for (const t of this.thumbs) this.observer.observe(t.card);
    this.list.scrollTop = scrollTop;
    if (this.outlineMode) void this.ensureOutline();
    this.updateHeader();
  }

  clear(): void {
    this.cancelDrag();
    this.stopHold();
    if (this.revealRaf) { cancelAnimationFrame(this.revealRaf); this.revealRaf = 0; }
    this.pendingThumbs.clear();
    this.observer.disconnect();
    for (const t of this.thumbs) t.task?.cancel();
    this.renderGeneration++;
    this.renderingThumb = false;
    this.thumbs = [];
    this.list.replaceChildren();
    this.outlineList.replaceChildren();
    this.outlineLoadedFor = null;
    this.selected.clear();
    this.anchor = null;
    this.current = 0;
    this.navTarget = 0;
    this.doc = null;
    this.root.classList.remove("selecting");
    this.updateHeader();
    for (const cb of this.selectionHandlers) cb([]);
  }

  setSelection(pages: number[]): void {
    this.selected = new Set(pages.filter((p) => p >= 1 && p <= this.thumbs.length));
    this.anchor = pages[0] ?? null;
    this.updateSelectionClasses();
  }

  setRotation(rotation: number, dims: { width: number; height: number }[]): void {
    if (rotation === this.rotation) return;
    this.rotation = rotation;
    this.pendingThumbs.clear();
    for (const t of this.thumbs) {
      t.task?.cancel();
      t.task = null;
      t.rendered = false;
      this.sizePlaceholder(t, dims[t.page - 1]);
      this.observer.unobserve(t.card);
      this.observer.observe(t.card);
    }
  }

  setCurrentPage(page: number, reveal = true): void {
    if (page === this.current) return;
    this.thumbs[this.current - 1]?.card.classList.remove("current");
    this.current = page;
    if (!this.holdInterval && !this.holdTimer) this.navTarget = page;
    this.updatePageInput();
    const t = this.thumbs[page - 1];
    if (!t) return;
    t.card.classList.add("current");
    if (reveal && this._visible && !this.drag) {
      if (this.revealRaf) cancelAnimationFrame(this.revealRaf);
      this.revealRaf = requestAnimationFrame(() => {
        this.revealRaf = 0;
        const cur = this.thumbs[this.current - 1];
        if (cur && this._visible && !this.drag) this.scrollIntoViewIfNeeded(cur.card);
      });
    }
  }

  applyTranslations(t: Translations): void {
    this.translations = t;
    this.i18nText.forEach(([key, fb], el) => { el.textContent = this.t(key, fb); });
    this.i18nTitle.forEach(([key, fb], el) => { el.title = this.t(key, fb); });
    for (const thumb of this.thumbs) this.labelThumb(thumb);
    this.updateHeader();
  }

  private buildPageNav(): HTMLElement {
    const pill = document.createElement("div");
    pill.className = "page-nav-pill";
    const prev = this.navArrow(ICON_UP, -1, "ttPagePrev", "Previous page (hold to scroll)");
    const next = this.navArrow(ICON_DOWN, 1, "ttPageNext", "Next page (hold to scroll)");
    this.pageInput = document.createElement("input");
    this.pageInput.className = "page-nav-input";
    this.pageInput.inputMode = "numeric";
    this.pageInput.autocomplete = "off";
    this.pageInput.spellcheck = false;
    this.title(this.pageInput, "ttPageInput", "Type a page number, then Enter");
    this.pageInput.addEventListener("focus", () => this.pageInput.select());
    this.pageInput.addEventListener("input", () => {
      this.pageInput.value = this.pageInput.value.replace(/[^0-9]/g, "").slice(0, 6);
      this.sizePageInput();
    });
    this.pageInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { this.commitPageInput(); this.pageInput.blur(); }
      else if (e.key === "Escape") { this.updatePageInput(); this.pageInput.blur(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); this.stepPage(-1, false); }
      else if (e.key === "ArrowDown") { e.preventDefault(); this.stepPage(1, false); }
    });
    this.pageInput.addEventListener("blur", () => this.updatePageInput());
    this.pageTotal = document.createElement("span");
    this.pageTotal.className = "page-nav-total";
    const mid = document.createElement("label");
    mid.className = "page-nav-mid";
    mid.append(this.pageInput, this.pageTotal);
    const sep = () => { const d = document.createElement("span"); d.className = "page-nav-sep"; return d; };
    pill.append(prev, sep(), mid, sep(), next);
    return pill;
  }

  private navArrow(icon: string, dir: 1 | -1, key: keyof Translations, fallback: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "page-nav-step";
    b.innerHTML = icon;
    this.title(b, key, fallback);
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.startHold(dir);
    });
    b.addEventListener("pointerleave", () => this.stopHold());
    b.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.stepPage(dir, false); }
    });
    return b;
  }

  private startHold(dir: 1 | -1): void {
    this.stopHold();
    this.navTarget = this.current || 1;
    this.stepPage(dir, false);
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      this.holdInterval = setInterval(() => this.stepPage(dir, true), HOLD_REPEAT_MS);
    }, HOLD_DELAY_MS);
  }

  private stopHold(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    if (this.holdInterval) clearInterval(this.holdInterval);
    this.holdTimer = null;
    this.holdInterval = null;
  }

  private stepPage(dir: 1 | -1, instant: boolean): void {
    const n = this.thumbs.length;
    if (n === 0) return;
    const from = this.navTarget || this.current || 1;
    const to = Math.min(n, Math.max(1, from + dir));
    if (to === from) { this.stopHold(); return; }
    this.navTarget = to;
    this.pageInput.value = String(to);
    this.sizePageInput();
    for (const cb of this.goToHandlers) cb(to, instant);
  }

  private commitPageInput(): void {
    const v = parseInt(this.pageInput.value, 10);
    const n = this.thumbs.length;
    if (!Number.isFinite(v) || n === 0) { this.updatePageInput(); return; }
    const to = Math.min(n, Math.max(1, v));
    this.navTarget = to;
    for (const cb of this.goToHandlers) cb(to, false);
  }

  private updatePageInput(): void {
    if (document.activeElement === this.pageInput) return;
    const n = this.thumbs.length;
    this.pageInput.value = n ? String(this.navTarget || this.current || 1) : "–";
    this.pageTotal.textContent = `/ ${n || "–"}`;
    this.sizePageInput();
  }

  private sizePageInput(): void {
    const digits = Math.max(String(this.thumbs.length || 1).length, this.pageInput.value.length, 1);
    this.pageInput.style.width = `${digits + 1}ch`;
  }

  private updateHeader(): void {
    if (!this.pageInput) return;
    this.updatePageInput();
    const all = this.allSelected();
    this.selectAllBtn.classList.toggle("on", all);
    this.selectAllLabel.textContent = all ? this.t("sbDeselectAll", "Deselect all") : this.t("sbSelectAll", "Select all");
    this.selectAllBtn.disabled = this.busy || this.thumbs.length === 0;
    const n = this.selected.size;
    this.deleteBtn.title = n > 0
      ? fmt(this.t("sbDeleteCount", "Delete ({n})"), { n })
      : this.t("sbDeleteHint", "Delete the selected pages");
    this.deleteBtn.disabled = this.busy || n === 0;
    this.outlineBtn.disabled = this.thumbs.length === 0;
  }

  private setOutlineMode(on: boolean): void {
    this.outlineMode = on;
    this.outlineBtn.classList.toggle("active", on);
    this.outlineBtn.setAttribute("aria-pressed", String(on));
    this.list.hidden = on;
    this.hintEl.hidden = on;
    this.outlineList.hidden = !on;
    if (on) {
      void this.ensureOutline();
    } else {
      this.scrollToCurrent();
      this.pumpThumbs();
    }
  }

  private async ensureOutline(): Promise<void> {
    const doc = this.doc;
    if (!doc) {
      this.outlineList.replaceChildren(this.buildOutlineEmpty());
      return;
    }
    if (this.outlineLoadedFor === doc) return;
    this.outlineLoadedFor = doc;

    type OutlineItem = { title?: string; dest?: unknown; page?: number; items?: OutlineItem[] };
    let items: OutlineItem[] | null = null;
    try {
      items = (await doc.getOutline()) as OutlineItem[] | null;
    } catch {
      items = null;
    }
    if (doc !== this.doc) return;

    if (!items || items.length === 0) {
      items = await this.scanHeadingOutline(doc);
      if (doc !== this.doc) return;
    }

    this.outlineList.replaceChildren();
    if (!items || items.length === 0) {
      this.outlineList.appendChild(this.buildOutlineEmpty());
      return;
    }

    const renderNodes = (nodes: OutlineItem[], container: HTMLElement, depth: number): void => {
      for (const node of nodes) {
        const hasChildren = Array.isArray(node.items) && node.items.length > 0;
        const wrap = document.createElement("div");
        wrap.className = "sb-outline-node";

        const row = document.createElement("div");
        row.className = "sb-outline-row";
        row.style.paddingLeft = `${6 + depth * 12}px`;

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = hasChildren ? "sb-outline-toggle" : "sb-outline-spacer";
        if (hasChildren) {
          toggle.textContent = "▾";
        } else {
          toggle.disabled = true;
        }

        const labelBtn = document.createElement("button");
        labelBtn.type = "button";
        labelBtn.className = "sb-outline-item";
        labelBtn.textContent = (node.title ?? "").trim() || "—";
        labelBtn.title = labelBtn.textContent;
        labelBtn.addEventListener("click", () => {
          if (typeof node.page === "number") {
            for (const cb of this.goToHandlers) cb(node.page, false);
          } else if (node.dest != null) {
            for (const cb of this.destHandlers) cb(node.dest);
          }
        });

        row.append(toggle, labelBtn);
        wrap.appendChild(row);

        if (hasChildren) {
          const childrenEl = document.createElement("div");
          childrenEl.className = "sb-outline-children";
          renderNodes(node.items!, childrenEl, depth + 1);
          wrap.appendChild(childrenEl);
          toggle.addEventListener("click", (e) => {
            e.stopPropagation();
            const collapsed = childrenEl.classList.toggle("collapsed");
            toggle.textContent = collapsed ? "▸" : "▾";
          });
        }
        container.appendChild(wrap);
      }
    };

    const frag = document.createDocumentFragment();
    const rootWrap = document.createElement("div");
    renderNodes(items, rootWrap, 0);
    frag.appendChild(rootWrap);
    this.outlineList.appendChild(frag);
  }

  private buildOutlineEmpty(): HTMLElement {
    const empty = document.createElement("div");
    empty.className = "sb-outline-empty";
    empty.textContent = this.t("sbOutlineEmpty", "No structure found in this document");
    return empty;
  }

  private async scanHeadingOutline(doc: PDFDocumentProxy): Promise<{ title: string; page: number }[]> {
    const maxPages = Math.min(doc.numPages, 80);
    const lines: { text: string; size: number; page: number }[] = [];
    const sizes: number[] = [];

    for (let p = 1; p <= maxPages; p++) {
      if (doc !== this.doc) return [];
      try {
        const page = await doc.getPage(p);
        const tc = await page.getTextContent();
        let curY = NaN;
        let curText = "";
        let curSize = 0;
        const flush = () => {
          const t = curText.replace(/\s+/g, " ").trim();
          if (t.length >= 3 && t.length <= 90 && /[A-Za-zÀ-ÿ]/.test(t)) {
            lines.push({ text: t, size: curSize, page: p });
            sizes.push(curSize);
          }
          curText = "";
          curSize = 0;
        };
        for (const raw of tc.items) {
          if (!("str" in raw) || !raw.str) continue;
          const tr = raw.transform as number[];
          const sz = Math.round(Math.hypot(tr[0] || 0, tr[1] || 0) * 10) / 10;
          const y = Math.round(tr[5] || 0);
          if (Number.isFinite(curY) && Math.abs(y - curY) > 3) flush();
          curY = y;
          curText += (curText && !curText.endsWith(" ") && !raw.str.startsWith(" ") ? " " : "") + raw.str;
          if (sz > curSize) curSize = sz;
        }
        flush();
      } catch {
      }
    }
    if (sizes.length < 4) return [];
    const sorted = [...sizes].sort((a, b) => a - b);
    const bodySize = sorted[Math.floor(sorted.length * 0.5)] || 10;
    const minHeading = bodySize * 1.18;
    const seen = new Set<string>();
    const result: { title: string; page: number }[] = [];
    for (const l of lines) {
      if (l.size >= minHeading) {
        const key = `${l.page}:${l.text}`;
        if (!seen.has(key)) {
          seen.add(key);
          result.push({ title: l.text, page: l.page });
          if (result.length >= 120) break;
        }
      }
    }
    return result;
  }

  private allSelected(): boolean {
    return this.thumbs.length > 0 && this.selected.size === this.thumbs.length;
  }

  private createThumb(page: number, dim: { width: number; height: number } | undefined): Thumb {
    const card = document.createElement("div");
    card.className = "page-sidebar-thumb";
    card.dataset.page = String(page);

    const frame = document.createElement("div");
    frame.className = "page-sidebar-frame";
    const canvas = document.createElement("canvas");
    frame.appendChild(canvas);
    const check = document.createElement("span");
    check.className = "page-sidebar-check";
    check.setAttribute("aria-hidden", "true");
    const hits = document.createElement("span");
    hits.className = "page-sidebar-hits";
    frame.append(check, hits);
    frame.addEventListener("click", (e) => this.handleClick(page, e));
    frame.addEventListener("pointerdown", (e) => this.handlePointerDown(page, e));

    const meta = document.createElement("div");
    meta.className = "page-sidebar-meta";
    const num = document.createElement("button");
    num.className = "page-sidebar-label";
    num.addEventListener("click", () => { for (const cb of this.goToHandlers) cb(page, false); });
    const rotate = document.createElement("button");
    rotate.className = "page-sidebar-rotate";
    rotate.innerHTML = ICON_ROTATE_LEFT;
    rotate.addEventListener("click", () => {
      if (!this.canAct()) return;
      const pages = this.selected.has(page) ? this.sortedSelection() : [page];
      for (const cb of this.rotateHandlers) cb(pages, -1);
    });
    meta.append(num, rotate);

    card.append(frame, meta);

    const thumb: Thumb = { page, card, canvas, rendered: false, task: null };
    this.sizePlaceholder(thumb, dim);
    this.labelThumb(thumb);
    return thumb;
  }

  private labelThumb(thumb: Thumb): void {
    const q = (sel: string) => thumb.card.querySelector(sel) as HTMLElement | null;
    const label = q(".page-sidebar-label");
    if (label) {
      label.textContent = String(thumb.page);
      label.title = this.t("sbShowPage", "Show this page");
    }
    const rotate = q(".page-sidebar-rotate");
    if (rotate) rotate.title = this.t("sbRotateLeft", "Rotate left");
    const frame = q(".page-sidebar-frame");
    if (frame) frame.title = this.t("sbToggleHint", "Click to show · check box or Ctrl+click to select");
  }

  private sizePlaceholder(thumb: Thumb, dim: { width: number; height: number } | undefined): void {
    const w = dim?.width ?? 595;
    const h = dim?.height ?? 842;
    const swap = this.rotation % 180 !== 0;
    thumb.canvas.style.aspectRatio = swap ? `${h} / ${w}` : `${w} / ${h}`;
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const page = Number((entry.target as HTMLElement).dataset.page);
      const thumb = this.thumbs[page - 1];
      if (!thumb) continue;
      if (entry.isIntersecting) {
        if (!thumb.rendered && !thumb.task) this.pendingThumbs.add(thumb);
      } else {
        this.pendingThumbs.delete(thumb);
        this.release(thumb);
      }
    }
    this.pumpThumbs();
  }

  private pumpThumbs(): void {
    if (this.renderingThumb || this.viewerBusy || !this._visible || !this.doc || this.pendingThumbs.size === 0) return;
    let best: Thumb | null = null;
    let bestDist = Infinity;
    const focus = this.current || 1;
    for (const t of this.pendingThumbs) {
      if (t.rendered || t.task) {
        this.pendingThumbs.delete(t);
        continue;
      }
      const dist = Math.abs(t.page - focus);
      if (dist < bestDist) {
        bestDist = dist;
        best = t;
      }
    }
    if (!best) return;
    this.pendingThumbs.delete(best);
    void this.render(best);
  }

  private release(thumb: Thumb): void {
    this.pendingThumbs.delete(thumb);
    thumb.task?.cancel();
    thumb.task = null;
    if (!thumb.rendered) return;
    thumb.canvas.width = thumb.canvas.height = 0;
    thumb.rendered = false;
  }

  private async render(thumb: Thumb): Promise<void> {
    const doc = this.doc;
    if (!doc) return;
    const generation = this.renderGeneration;
    this.renderingThumb = true;
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
      const task = page.render({ canvas: ctx.canvas, viewport });
      thumb.task = task;
      await task.promise;
      thumb.task = null;
      if (doc !== this.doc) return;
      canvas.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
      thumb.canvas.replaceWith(canvas);
      thumb.canvas = canvas;
      thumb.rendered = true;
      if (Math.abs(thumb.page - (this.current || 1)) > 5) {
        page.cleanup();
      }
    } catch {
      thumb.task = null;
    } finally {
      if (generation === this.renderGeneration) {
        this.renderingThumb = false;
        this.pumpThumbs();
      }
    }
  }

  private handleClick(page: number, e: MouseEvent): void {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    const box = (e.currentTarget as HTMLElement | null)?.querySelector(".page-sidebar-check")?.getBoundingClientRect();
    const pad = 6;
    const onCheck = !!box && e.clientX >= box.left - pad && e.clientX <= box.right + pad
      && e.clientY >= box.top - pad && e.clientY <= box.bottom + pad;
    if (!onCheck && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      for (const cb of this.goToHandlers) cb(page, false);
      return;
    }
    if (e.shiftKey && this.anchor !== null) {
      const [a, b] = this.anchor < page ? [this.anchor, page] : [page, this.anchor];
      for (let p = a; p <= b; p++) this.selected.add(p);
      this.updateSelectionClasses();
      return;
    }
    this.toggleSelected(page);
    this.anchor = page;
    this.updateSelectionClasses();
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

  selectAll(): void {
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

  private insertionPoint(): number {
    if (this.selected.size > 0) return Math.max(...this.selected);
    return this.current || this.thumbs.length;
  }

  private updateSelectionClasses(): void {
    for (const t of this.thumbs) {
      const on = this.selected.has(t.page);
      t.card.classList.toggle("selected", on);
      t.card.setAttribute("aria-selected", String(on));
    }
    this.root.classList.toggle("selecting", this.selected.size > 0);
    this.updateHeader();
    const pages = this.sortedSelection();
    for (const cb of this.selectionHandlers) cb(pages);
  }

  private canAct(): boolean {
    return !this.busy && this.doc !== null;
  }

  private emitSelection(handlers: PagesHandler[]): void {
    if (!this.canAct() || this.selected.size === 0) return;
    const pages = this.sortedSelection();
    for (const cb of handlers) cb(pages);
  }

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
      zone: "list",
      ghost: null,
      scrollRaf: 0,
    };
    try { (e.currentTarget as Element | null)?.setPointerCapture(e.pointerId); } catch {}
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
      document.body.appendChild(d.ghost);
      this.root.classList.add("dragging");
      this.startAutoscroll();
    }
    e.preventDefault();
    const zone = this.zoneOf(e);
    if (d.ghost && (zone !== d.zone || !d.ghost.textContent)) {
      d.ghost.classList.toggle("out", zone !== "list");
      d.ghost.textContent = zone === "window"
        ? this.t("sbDragOut", "Release to open in a new window")
        : zone === "tab"
          ? this.t("sbDragTab", "Release to open in a new tab")
          : d.moving.length === 1
            ? fmt(this.t("sbMovingOne", "Page {p}"), { p: d.moving[0] })
            : fmt(this.t("sbMovingMany", "{n} pages"), { n: d.moving.length });
    }
    if ((zone === "tab") !== (d.zone === "tab")) for (const cb of this.tabZoneHandlers) cb(zone === "tab");
    d.zone = zone;
    if (d.ghost) {
      const w = d.ghost.offsetWidth;
      const h = d.ghost.offsetHeight;
      const x = Math.min(Math.max(e.clientX + 12, 4), window.innerWidth - w - 4);
      const y = Math.min(Math.max(e.clientY + 12, 4), window.innerHeight - h - 4);
      d.ghost.style.left = `${x}px`;
      d.ghost.style.top = `${y}px`;
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
    this.suppressClick = true;
    setTimeout(() => { this.suppressClick = false; }, 0);
    const zone = this.zoneOf(e);
    if (zone === "window") {
      for (const cb of this.dragOutHandlers) cb(moving, e.screenX, e.screenY);
      return;
    }
    if (zone === "tab") {
      for (const cb of this.dragToTabHandlers) cb(moving);
      return;
    }
    if (insertAt < 0 || this.isNoOpMove(moving, insertAt)) return;
    for (const cb of this.moveHandlers) cb(moving, insertAt);
  }

  private zoneOf(e: PointerEvent): DragZone {
    if (isOutsideWindow(e)) return this.dragOutHandlers.length > 0 ? "window" : "list";
    if (this.dragToTabHandlers.length === 0) return "list";
    const r = this.root.getBoundingClientRect();
    const near = e.clientX >= r.left - TAB_ZONE_MARGIN_PX && e.clientX <= r.right + TAB_ZONE_MARGIN_PX
      && e.clientY >= r.top && e.clientY <= r.bottom;
    return near ? "list" : "tab";
  }

  private isNoOpMove(pages: number[], insertAt: number): boolean {
    const first = pages[0];
    const last = pages[pages.length - 1];
    const contiguous = last - first + 1 === pages.length;
    return contiguous && insertAt >= first - 1 && insertAt <= last;
  }

  private updateDropTarget(): void {
    const d = this.drag;
    if (!d) return;
    if (d.zone !== "list") {
      d.insertAt = -1;
      this.dropIndicator.classList.add("hidden");
      return;
    }
    d.insertAt = this.showGapAt(d.lastY);
  }

  externalDropAt(x: number, y: number): number | null {
    const r = this.root.getBoundingClientRect();
    if (this.root.hidden || this.thumbs.length === 0 || x < r.left || x > r.right || y < r.top || y > r.bottom) {
      this.dropIndicator.classList.add("hidden");
      return null;
    }
    return this.showGapAt(y);
  }

  hideExternalDrop(): void { this.dropIndicator.classList.add("hidden"); }

  private showGapAt(y: number): number {
    let at = this.thumbs.length;
    for (const t of this.thumbs) {
      const r = t.card.getBoundingClientRect();
      if (y < r.top + r.height / 2) {
        at = t.page - 1;
        break;
      }
    }
    this.placeDropLine(at);
    return at;
  }

  private placeDropLine(at: number): void {
    const gap = 7;
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
    if (d.zone === "tab") for (const cb of this.tabZoneHandlers) cb(false);
    for (const t of this.thumbs) t.card.classList.remove("dragging");
    this.dropIndicator.classList.add("hidden");
    this.root.classList.remove("dragging");
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    this.drag = null;
  }

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
    }
  }
}
