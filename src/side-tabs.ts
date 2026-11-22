import { ICON_CLOSE, ICON_PLUS } from "./icons";
import type { DocTab } from "./doc-tabs";

const DRAG_THRESHOLD_PX = 5;
const ICON_DOC = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>`;

export interface SideTabsLabels {
  close: string;
  open: string;
  openHint: string;
}

export interface SideTabsHandlers {
  activate(id: number): void;
  close(id: number): void;
  move(id: number, index: number): void;
  detach(id: number, screenX: number, screenY: number): void;
  open(): void;
}

/** The open documents, listed on top of the page panel, with an "Open a PDF" entry
 *  that also takes dropped files. */
export class SideTabs {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private openBtn: HTMLButtonElement;
  private openLabel: HTMLElement;
  private labels: SideTabsLabels = { close: "Close tab (Ctrl+W)", open: "Open a PDF", openHint: "Open PDFs, or drop them here (Ctrl+O)" };
  private tabs: readonly DocTab<unknown>[] = [];
  private activeId: number | null = null;
  private drag: { id: number; el: HTMLElement; pointerId: number; startY: number; dragging: boolean; outside: boolean } | null = null;
  private suppressClick = false;

  constructor(private readonly on: SideTabsHandlers) {
    this.el = document.createElement("nav");
    this.el.className = "side-tabs";
    this.list = document.createElement("div");
    this.list.className = "side-tabs-list";
    this.list.setAttribute("role", "tablist");
    this.list.setAttribute("aria-orientation", "vertical");
    this.openBtn = document.createElement("button");
    this.openBtn.type = "button";
    this.openBtn.className = "side-tab side-tab-open";
    this.openBtn.innerHTML = `<span class="side-tab-icon">${ICON_PLUS}</span>`;
    this.openLabel = document.createElement("span");
    this.openLabel.className = "side-tab-name";
    this.openBtn.append(this.openLabel);
    this.openBtn.addEventListener("click", () => this.on.open());
    this.el.append(this.list, this.openBtn);
    this.el.addEventListener("click", (e) => {
      if (!this.suppressClick) return;
      e.stopPropagation();
      e.preventDefault();
    }, true);
    this.applyTranslations({});
  }

  applyTranslations(labels: Partial<SideTabsLabels>): void {
    this.labels = { ...this.labels, ...Object.fromEntries(Object.entries(labels).filter(([, v]) => v)) };
    this.openLabel.textContent = this.labels.open;
    this.openBtn.title = this.labels.openHint;
    this.render(this.tabs, this.activeId);
  }

  /** Lights the list up while files are dragged over it. */
  setDropTarget(on: boolean): void {
    this.el.classList.toggle("drop-target", on);
  }

  /** True when a point (client pixels) falls on the list or the open entry. */
  contains(x: number, y: number): boolean {
    if (this.el.offsetParent === null) return false;
    const r = this.el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  render(tabs: readonly DocTab<unknown>[], activeId: number | null): void {
    this.tabs = tabs;
    this.activeId = activeId;
    if (this.drag?.dragging) return;
    this.el.hidden = tabs.length === 0;
    const items = tabs.map((tab) => {
      const active = tab.id === activeId;
      const item = document.createElement("div");
      item.className = `side-tab${active ? " active" : ""}${tab.dirty ? " dirty" : ""}`;
      item.dataset["tab"] = String(tab.id);
      item.setAttribute("role", "tab");
      item.setAttribute("aria-selected", String(active));
      item.tabIndex = active ? 0 : -1;
      item.title = tab.title;
      const icon = document.createElement("span");
      icon.className = "side-tab-icon";
      icon.innerHTML = ICON_DOC;
      const name = document.createElement("span");
      name.className = "side-tab-name";
      name.textContent = tab.title;
      const close = document.createElement("button");
      close.type = "button";
      close.className = "side-tab-close";
      close.innerHTML = ICON_CLOSE;
      close.title = this.labels.close;
      close.setAttribute("aria-label", this.labels.close);
      close.tabIndex = -1;
      close.addEventListener("pointerdown", (e) => e.stopPropagation());
      close.addEventListener("click", (e) => { e.stopPropagation(); this.on.close(tab.id); });
      item.append(icon, name, close);
      item.addEventListener("pointerdown", (e) => this.press(e, tab.id, item));
      item.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); this.on.close(tab.id); } });
      item.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const at = tabs.findIndex((t) => t.id === tab.id);
        const next = tabs[at + (e.key === "ArrowDown" ? 1 : -1)];
        if (next) { this.on.activate(next.id); requestAnimationFrame(() => this.focusActive()); }
      });
      return item;
    });
    this.list.replaceChildren(...items);
    this.list.querySelector(".side-tab.active")?.scrollIntoView?.({ block: "nearest" });
  }

  private focusActive(): void {
    this.list.querySelector<HTMLElement>(".side-tab.active")?.focus();
  }

  private press(e: PointerEvent, id: number, el: HTMLElement): void {
    if (e.button !== 0 || this.drag) return;
    if (id !== this.activeId) this.on.activate(id);
    this.drag = { id, el, pointerId: e.pointerId, startY: e.clientY, dragging: false, outside: false };
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    window.addEventListener("pointercancel", this.onUp);
    window.addEventListener("keydown", this.onKey, true);
  }

  private readonly onMove = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.dragging) {
      if (Math.abs(e.clientY - d.startY) < DRAG_THRESHOLD_PX) return;
      d.dragging = true;
      try { d.el.setPointerCapture(d.pointerId); } catch {}
      d.el.classList.add("dragging");
      document.body.classList.add("tab-dragging");
    }
    e.preventDefault();
    d.outside = e.clientX < 0 || e.clientY < 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight;
    d.el.classList.toggle("torn", d.outside);
    if (!d.outside) this.slide(e.clientY);
  };

  private readonly onUp = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.endDrag();
    if (!d.dragging) return;
    this.suppressClick = true;
    setTimeout(() => { this.suppressClick = false; }, 0);
    if (e.type === "pointercancel") { this.render(this.tabs, this.activeId); return; }
    if (d.outside) {
      if (this.tabs.length > 1) this.on.detach(d.id, e.screenX, e.screenY);
      this.render(this.tabs, this.activeId);
      return;
    }
    const index = [...this.list.children].indexOf(d.el);
    const before = this.tabs.findIndex((t) => t.id === d.id);
    if (index !== -1 && index !== before) this.on.move(d.id, index);
    else this.render(this.tabs, this.activeId);
  };

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !this.drag) return;
    e.preventDefault();
    e.stopPropagation();
    const dragging = this.drag.dragging;
    this.endDrag();
    if (dragging) this.render(this.tabs, this.activeId);
  };

  private endDrag(): void {
    const d = this.drag;
    if (!d) return;
    try { d.el.releasePointerCapture(d.pointerId); } catch {}
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    window.removeEventListener("pointercancel", this.onUp);
    window.removeEventListener("keydown", this.onKey, true);
    d.el.classList.remove("dragging", "torn");
    d.el.style.transform = "";
    document.body.classList.remove("tab-dragging");
    this.drag = null;
  }

  private slide(y: number): void {
    const d = this.drag!;
    if (this.tabs.length < 2) return;
    const others = [...this.list.children].filter((c) => c !== d.el) as HTMLElement[];
    let index = others.length;
    for (let i = 0; i < others.length; i++) {
      const r = others[i]!.getBoundingClientRect();
      if (y < r.top + r.height / 2) { index = i; break; }
    }
    const current = [...this.list.children].indexOf(d.el);
    if (index !== current) this.list.insertBefore(d.el, others[index] ?? null);
    d.el.style.transform = "";
    const r = d.el.getBoundingClientRect();
    d.el.style.transform = `translateY(${Math.round(y - (r.top + r.height / 2))}px)`;
  }
}
