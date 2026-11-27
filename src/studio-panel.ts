import { slideIn } from "./motion";
import type { Annotation } from "./models";
import type { Translations } from "./i18n";
import {
  ICON_TOOL_TEXT,
  ICON_TOOL_PENCIL,
  ICON_TOOL_SHAPES,
  ICON_TOOL_NOTE,
  ICON_TOOL_HIGHLIGHT,
  ICON_TOOL_SIGN,
  ICON_SHAPE_ELLIPSE,
  ICON_SHAPE_ARROW,
  ICON_STYLE_STRAIGHT,
  ICON_REDACT_AREA,
  ICON_STAMP_CHECK,
  ICON_STAMP_CROSS,
  ICON_EDIT_TEXT,
  ICON_IMAGE_SMALL,
  ICON_TRASH,
  ICON_PANEL_RIGHT,
} from "./icons";

type Key = keyof Translations;

const COLLAPSED_KEY = "ezreader-studio-collapsed";
const ROW_PITCH = 33;
const ROWS_AROUND = 20;
const ROWS_WITHOUT_LAYOUT = 60;

type ListItem = { ann: Annotation; layer: number; count: number };

export function describeAnnotation(ann: Annotation): { icon: string; key: Key; fb: string; quote?: string } {
  switch (ann.kind) {
    case "text":
      return ann.cover
        ? { icon: ICON_EDIT_TEXT, key: "annEditedText", fb: "Edited text", quote: ann.content }
        : { icon: ICON_TOOL_TEXT, key: "annText", fb: "Text", quote: ann.content };
    case "note": return { icon: ICON_TOOL_NOTE, key: "annNote", fb: "Sticky note", quote: ann.content };
    case "ink":
      if (ann.arrow) return { icon: ICON_SHAPE_ARROW, key: "annArrow", fb: "Arrow" };
      if (ann.points.length === 2) return { icon: ICON_STYLE_STRAIGHT, key: "annLine", fb: "Line" };
      return { icon: ICON_TOOL_PENCIL, key: "annInk", fb: "Freehand" };
    case "rect": return { icon: ICON_TOOL_SHAPES, key: "annRect", fb: "Rectangle" };
    case "circle": return { icon: ICON_SHAPE_ELLIPSE, key: "annCircle", fb: "Ellipse" };
    case "highlight": return { icon: ICON_TOOL_HIGHLIGHT, key: "annHighlight", fb: "Highlight" };
    case "signature": return { icon: ICON_TOOL_SIGN, key: "annSignature", fb: "Signature" };
    case "image": return { icon: ICON_IMAGE_SMALL, key: "annImage", fb: "Picture" };
    case "stamp":
      return ann.mark === "cross"
        ? { icon: ICON_STAMP_CROSS, key: "annCross", fb: "Cross" }
        : { icon: ICON_STAMP_CHECK, key: "annCheck", fb: "Check mark" };
    case "redact": return { icon: ICON_REDACT_AREA, key: "annRedact", fb: "Redaction" };
  }
}

export interface StudioPanelHooks {
  list(): Annotation[];
  selected(): Annotation | null;
  pick(ann: Annotation): void;
  remove(ann: Annotation): void;
  reorder(ann: Annotation, index: number): void;
}

export function panelOrder(anns: Annotation[]): { ann: Annotation; layer: number; count: number }[] {
  const byPage = new Map<number, Annotation[]>();
  for (const a of anns) {
    let l = byPage.get(a.page);
    if (!l) byPage.set(a.page, (l = []));
    l.push(a);
  }
  return [...byPage.keys()].sort((a, b) => a - b).flatMap((p) => {
    const l = byPage.get(p)!;
    return l.map((ann, layer) => ({ ann, layer, count: l.length })).reverse();
  });
}

export class StudioPanel {
  readonly el: HTMLElement;
  private titleEl: HTMLElement;
  private collapseBtn: HTMLButtonElement;
  private expandBtn: HTMLButtonElement;
  private optionsHost: HTMLElement;
  private emptyEl: HTMLElement;
  private countEl: HTMLElement;
  private listEl: HTMLElement;
  private listLabel: HTMLElement;
  private noneEl: HTMLElement;

  private t: Translations = {} as Translations;
  private shown = false;
  private collapsed = false;
  private hasOptions = false;
  private title: string | null = null;
  private renderQueued = false;
  private rows = new Map<Annotation, HTMLElement>();
  private items: ListItem[] = [];
  private windowQueued = false;
  private anchor = 0;
  private spaceAbove = document.createElement("div");
  private spaceBelow = document.createElement("div");
  private drag: { ann: Annotation; row: HTMLElement; startY: number; moved: boolean; target: number; id: number } | null = null;
  private suppressClick = false;

  constructor(options: HTMLElement, private hooks: StudioPanelHooks) {
    this.el = document.createElement("aside");
    this.el.className = "studio-panel";
    this.el.hidden = true;

    const head = document.createElement("div");
    head.className = "studio-head";
    this.titleEl = document.createElement("span");
    this.titleEl.className = "studio-title";
    this.collapseBtn = this.iconBtn("studio-collapse");
    this.collapseBtn.addEventListener("click", () => this.setCollapsed(true));
    head.append(this.titleEl, this.collapseBtn);

    this.expandBtn = this.iconBtn("studio-expand");
    this.expandBtn.addEventListener("click", () => this.setCollapsed(false));

    const body = document.createElement("div");
    body.className = "studio-options";
    this.optionsHost = body;
    options.classList.remove("tb-row");
    body.append(options);
    this.emptyEl = document.createElement("p");
    this.emptyEl.className = "studio-empty";
    body.append(this.emptyEl);

    const listHead = document.createElement("div");
    listHead.className = "studio-list-head";
    this.listLabel = document.createElement("span");
    this.countEl = document.createElement("span");
    this.countEl.className = "studio-count";
    listHead.append(this.listLabel, this.countEl);
    this.listEl = document.createElement("div");
    this.listEl.className = "studio-list";
    this.listEl.setAttribute("role", "list");
    this.noneEl = document.createElement("p");
    this.noneEl.className = "studio-empty";

    const listWrap = document.createElement("div");
    listWrap.className = "studio-list-wrap";
    listWrap.append(listHead, this.listEl, this.noneEl);
    this.listEl.addEventListener("scroll", () => this.queueWindow(), { passive: true });
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => this.queueWindow()).observe(this.listEl);

    this.el.append(head, body, listWrap, this.expandBtn);

    try { this.collapsed = localStorage.getItem(COLLAPSED_KEY) === "1"; } catch {}
    this.sync();
  }

  setShown(shown: boolean): void {
    if (this.shown === shown) return;
    this.shown = shown;
    this.sync();
    if (shown) this.refresh();
  }

  setOptions(title: string | null): void {
    this.hasOptions = title !== null;
    this.title = title;
    this.sync();
  }

  applyTranslations(t: Translations): void {
    this.t = t;
    this.collapseBtn.title = this.tr("ttStudioHide", "Hide the panel");
    this.collapseBtn.setAttribute("aria-label", this.collapseBtn.title);
    this.expandBtn.title = this.tr("ttStudioShow", "Show the panel");
    this.expandBtn.setAttribute("aria-label", this.expandBtn.title);
    this.el.setAttribute("aria-label", this.tr("studioPanel", "Tool options and annotations"));
    this.emptyEl.textContent = this.tr("studioEmpty", "Pick a tool, or click an annotation to change it.");
    this.listLabel.textContent = this.tr("studioAnnotations", "Annotations");
    this.noneEl.textContent = this.tr("studioNoAnnotations", "No annotations yet.");
    this.sync();
    this.render();
  }

  refresh(): void {
    if (!this.shown || this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  setSelected(ann: Annotation | null): void {
    if (ann && !this.rows.has(ann)) {
      const index = this.items.findIndex((i) => i.ann === ann);
      if (index !== -1) {
        this.anchor = index;
        this.listEl.scrollTop = Math.max(0, index * ROW_PITCH - this.listEl.clientHeight / 2);
        this.renderWindow();
      }
    }
    for (const [a, row] of this.rows) {
      const on = a === ann;
      row.classList.toggle("on", on);
      row.setAttribute("aria-current", String(on));
      if (on) row.scrollIntoView?.({ block: "nearest" });
    }
  }

  onCollapse: ((collapsed: boolean) => void) | null = null;

  get isCollapsed(): boolean { return this.collapsed; }

  toggle(): boolean {
    if (!this.shown) return false;
    this.setCollapsed(!this.collapsed);
    return true;
  }

  setCollapsed(c: boolean): void {
    if (this.collapsed === c) return;
    const opening = this.collapsed && !c;
    this.collapsed = c;
    if (opening) slideIn(this.el);
    try { localStorage.setItem(COLLAPSED_KEY, c ? "1" : "0"); } catch {}
    this.sync();
    this.onCollapse?.(c);
  }

  private sync(): void {
    this.el.hidden = !this.shown;
    this.el.classList.toggle("collapsed", this.collapsed);
    this.titleEl.textContent = this.title ?? this.tr("studioTitle", "Options");
    this.emptyEl.hidden = this.hasOptions;
    this.optionsHost.classList.toggle("has-options", this.hasOptions);
  }

  private render(): void {
    if (!this.shown || this.drag) return;
    this.items = panelOrder(this.hooks.list());
    this.countEl.textContent = this.items.length ? String(this.items.length) : "";
    this.noneEl.hidden = this.items.length > 0;
    this.rows.clear();
    this.renderWindow();
  }

  private queueWindow(): void {
    if (this.windowQueued) return;
    this.windowQueued = true;
    requestAnimationFrame(() => {
      this.windowQueued = false;
      this.renderWindow();
    });
  }

  private renderWindow(): void {
    if (!this.shown || this.drag) return;
    const total = this.items.length;
    const height = this.listEl.clientHeight;
    const first = height > 0
      ? Math.max(0, Math.floor(this.listEl.scrollTop / ROW_PITCH) - ROWS_AROUND)
      : Math.max(0, Math.min(this.anchor - ROWS_WITHOUT_LAYOUT / 2, total - ROWS_WITHOUT_LAYOUT));
    const last = height > 0
      ? Math.min(total, Math.ceil((this.listEl.scrollTop + height) / ROW_PITCH) + ROWS_AROUND)
      : Math.min(total, first + ROWS_WITHOUT_LAYOUT);
    const selected = this.hooks.selected();
    const kept = new Map<Annotation, HTMLElement>();
    const rows = this.items.slice(first, last).map((item) => this.rows.get(item.ann) ?? this.buildRow(item));
    rows.forEach((row, i) => {
      const item = this.items[first + i];
      const on = item.ann === selected;
      row.classList.toggle("on", on);
      row.setAttribute("aria-current", String(on));
      kept.set(item.ann, row);
    });
    this.rows = kept;
    this.spaceAbove.style.height = `${Math.max(0, first * ROW_PITCH - 1)}px`;
    this.spaceBelow.style.height = `${Math.max(0, (total - last) * ROW_PITCH - 1)}px`;
    const wanted = [...(first > 0 ? [this.spaceAbove] : []), ...rows, ...(last < total ? [this.spaceBelow] : [])];
    this.placeChildren(wanted);
  }

  private placeChildren(wanted: HTMLElement[]): void {
    const keep = new Set<Node>(wanted);
    for (const child of [...this.listEl.children]) if (!keep.has(child)) child.remove();
    let cursor = this.listEl.firstChild;
    for (const node of wanted) {
      if (cursor === node) cursor = cursor.nextSibling;
      else this.listEl.insertBefore(node, cursor);
    }
  }

  private buildRow({ ann, layer, count }: ListItem): HTMLElement {
    const pageAbbr = this.tr("studioPageAbbr", "p. {n}");
    const moveHint = this.tr("ttReorderAnnotation", "Drag to bring forward or send backward");
    const d = describeAnnotation(ann);
    const name = this.tr(d.key, d.fb);
    const quote = d.quote?.replace(/\s+/g, " ").trim();
    const row = document.createElement("div");
    row.className = "studio-ann";
    row.setAttribute("role", "listitem");
    row.tabIndex = 0;
    row.dataset["page"] = String(ann.page);
    row.dataset["layer"] = String(layer);
    const label = document.createElement("span");
    label.className = "studio-ann-label";
    label.textContent = quote ? `${name} « ${quote} »` : name;
    label.title = count > 1 ? `${label.textContent}\n${moveHint}` : label.textContent;
    const page = document.createElement("span");
    page.className = "studio-ann-page";
    page.textContent = pageAbbr.replace("{n}", String(ann.page));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "studio-ann-del";
    del.innerHTML = ICON_TRASH;
    del.title = this.tr("ttDeleteAnnotation", "Delete this annotation");
    del.setAttribute("aria-label", del.title);
    del.addEventListener("click", (e) => { e.stopPropagation(); this.hooks.remove(ann); });
    row.insertAdjacentHTML("afterbegin", d.icon);
    row.append(label, page, del);
    row.addEventListener("click", () => {
      if (this.suppressClick) { this.suppressClick = false; return; }
      this.hooks.pick(ann);
    });
    row.addEventListener("keydown", (e) => {
      if (e.target !== row) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.hooks.pick(ann); }
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); e.stopPropagation(); this.hooks.remove(ann); }
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        e.stopPropagation();
        this.hooks.reorder(ann, layer + (e.key === "ArrowUp" ? 1 : -1));
        this.focusAfterRender(ann);
      }
    });
    if (count > 1) this.makeDraggable(row, ann);
    return row;
  }

  private focusAfterRender(ann: Annotation): void {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!this.rows.has(ann)) this.setSelected(ann);
      this.rows.get(ann)?.focus();
    }));
  }

  private makeDraggable(row: HTMLElement, ann: Annotation): void {
    row.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest(".studio-ann-del")) return;
      this.drag = { ann, row, startY: e.clientY, moved: false, target: Number(row.dataset["layer"]), id: e.pointerId };
    });
    row.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d || d.row !== row || e.pointerId !== d.id) return;
      if (!d.moved) {
        if (Math.abs(e.clientY - d.startY) < 4) return;
        d.moved = true;
        row.setPointerCapture(e.pointerId);
        row.classList.add("dragging");
        this.listEl.classList.add("reordering");
      }
      row.style.transform = `translateY(${e.clientY - d.startY}px)`;
      this.markDropTarget(e.clientY);
    });
    const end = (e: PointerEvent, commit: boolean) => {
      const d = this.drag;
      if (!d || d.row !== row || e.pointerId !== d.id) return;
      this.drag = null;
      if (!d.moved) return;
      this.suppressClick = true;
      setTimeout(() => { this.suppressClick = false; }, 0);
      row.classList.remove("dragging");
      row.style.transform = "";
      this.listEl.classList.remove("reordering");
      this.listEl.querySelectorAll(".drop-above, .drop-below").forEach((r) => r.classList.remove("drop-above", "drop-below"));
      if (commit && d.target !== Number(row.dataset["layer"])) {
        this.hooks.reorder(ann, d.target);
        this.focusAfterRender(ann);
      }
      this.render();
    };
    row.addEventListener("pointerup", (e) => end(e, true));
    row.addEventListener("pointercancel", (e) => end(e, false));
    row.addEventListener("lostpointercapture", (e) => end(e, true));
  }

  private markDropTarget(y: number): void {
    const d = this.drag!;
    const page = d.row.dataset["page"];
    const peers = [...this.listEl.querySelectorAll<HTMLElement>(`.studio-ann[data-page="${page}"]`)];
    peers.forEach((r) => r.classList.remove("drop-above", "drop-below"));
    const from = Number(d.row.dataset["layer"]);
    let target = from;
    let best = Infinity;
    for (const r of peers) {
      if (r === d.row) continue;
      const box = r.getBoundingClientRect();
      const mid = box.top + box.height / 2;
      const dist = Math.abs(y - mid);
      if (dist < best && Math.abs(y - mid) < box.height) { best = dist; target = Number(r.dataset["layer"]); }
    }
    d.target = target;
    if (target === from) return;
    const over = peers.find((r) => Number(r.dataset["layer"]) === target);
    over?.classList.add(target > from ? "drop-above" : "drop-below");
  }

  private iconBtn(cls: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `icon-btn ${cls}`;
    b.innerHTML = ICON_PANEL_RIGHT;
    return b;
  }

  private tr(key: Key, fb: string): string {
    const v = this.t[key];
    return typeof v === "string" ? v : fb;
  }
}
