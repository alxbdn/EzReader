import { ICON_CLOSE } from "./icons";
import type { DocTab } from "./doc-tabs";

/** Pixels the pointer moves before a press on a tab becomes a drag. */
const DRAG_THRESHOLD_PX = 5;
/** How far below the title bar a dragged tab tears off (like a browser). */
const TEAR_OFF_PX = 40;

export interface TabStripLabels {
  close: string;
  /** Ghost of a tab dragged out over nothing: a new window opens. */
  dragNew: string;
  /** Ghost of a tab dragged over another EzReader window: it moves there. */
  dragMerge: string;
}

export interface TabStripHandlers {
  activate(id: number): void;
  close(id: number): void;
  /** The tab was dragged to `index` along the strip. */
  move(id: number, index: number): void;
  /**
   * The tab is dragged out of the strip, the pointer at (`screenX`,
   * `screenY`): resolves true when another EzReader window is under it.
   */
  hover(screenX: number, screenY: number): Promise<boolean>;
  /** The drag ended without a drop outside (back on the strip, cancelled). */
  hoverEnd(): void;
  /** The tab was dropped outside the strip, at (`screenX`, `screenY`). */
  detach(id: number, screenX: number, screenY: number): void;
}

interface Drag {
  id: number;
  el: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
  outside: boolean;
  overWindow: boolean;
  ghost: HTMLElement | null;
  /** Hover question in flight, and the latest point waiting for an answer. */
  asking: boolean;
  pending: { x: number; y: number } | null;
}

/**
 * The tabs of the documents open in the window, in the middle of the title
 * bar. With one document it is just the file name, as before tabs; with
 * more, one quiet chip per document. The active one holds the toolbar's
 * file name (click to rename, dot while unsaved).
 *
 * A tab can be dragged along the strip to reorder it, down off the title
 * bar or out of the window to open it in a window of its own, or onto
 * another EzReader window to move it there.
 */
export class TabStrip {
  readonly el: HTMLElement;
  private labels: TabStripLabels = {
    close: "Close tab (Ctrl+W)",
    dragNew: "Release to open in a new window",
    dragMerge: "Release to move it to that window",
  };
  private drag: Drag | null = null;
  private suppressClick = false;
  private tabs: readonly DocTab<unknown>[] = [];

  constructor(
    private readonly bar: HTMLElement,
    /** The file name of the active document (from the toolbar). */
    private readonly title: HTMLElement,
    private readonly on: TabStripHandlers,
  ) {
    this.el = document.createElement("div");
    this.el.className = "doc-tabs single";
    this.el.setAttribute("role", "tablist");
    title.replaceWith(this.el);
    this.el.append(title);
    // A click that ends a drag must not also start a rename.
    this.el.addEventListener("click", (e) => {
      if (!this.suppressClick) return;
      e.stopPropagation();
      e.preventDefault();
    }, true);
    this.el.addEventListener("dblclick", (e) => e.stopPropagation());
  }

  applyTranslations(labels: Partial<TabStripLabels>): void {
    this.labels = { ...this.labels, ...Object.fromEntries(Object.entries(labels).filter(([, v]) => v)) };
    this.render(this.tabs, this.activeId);
  }

  private activeId: number | null = null;

  /** Shows `tabs`, `activeId` holding the file name. */
  render(tabs: readonly DocTab<unknown>[], activeId: number | null): void {
    this.tabs = tabs;
    this.activeId = activeId;
    if (this.drag?.dragging) return; // redrawn when the drag ends
    const multi = tabs.length > 1;
    this.el.classList.toggle("single", !multi);
    const items: HTMLElement[] = [];
    for (const tab of tabs) {
      const active = tab.id === activeId;
      const item = document.createElement("div");
      item.className = `doc-tab${active ? " active" : ""}${tab.dirty ? " dirty" : ""}`;
      item.dataset["tab"] = String(tab.id);
      item.setAttribute("role", "tab");
      item.setAttribute("aria-selected", String(active));
      if (active) {
        item.append(this.title);
      } else {
        const name = document.createElement("span");
        name.className = "doc-tab-name";
        name.textContent = tab.title;
        name.title = tab.title;
        const dot = document.createElement("span");
        dot.className = "doc-tab-dirty";
        item.append(name, dot);
      }
      if (multi) {
        const close = document.createElement("button");
        close.className = "doc-tab-close";
        close.innerHTML = ICON_CLOSE;
        close.title = this.labels.close;
        close.setAttribute("aria-label", this.labels.close);
        close.tabIndex = -1;
        close.addEventListener("pointerdown", (e) => e.stopPropagation());
        close.addEventListener("click", (e) => { e.stopPropagation(); this.on.close(tab.id); });
        item.append(close);
      }
      item.addEventListener("pointerdown", (e) => this.press(e, tab.id, item));
      // Middle click closes, as in a browser.
      item.addEventListener("auxclick", (e) => {
        if (e.button === 1 && multi) { e.preventDefault(); this.on.close(tab.id); }
      });
      items.push(item);
    }
    if (tabs.length === 0) items.push(this.title);
    this.el.replaceChildren(...items);
    this.el.querySelector(".doc-tab.active")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  /** Another window's tab is dragged over this window: show where it lands. */
  setDropTarget(on: boolean): void {
    this.bar.classList.toggle("tab-drop-target", on);
  }

  // ── Dragging ───────────────────────────────────────────────────────────────

  private press(e: PointerEvent, id: number, el: HTMLElement): void {
    if (e.button !== 0 || this.drag) return;
    if ((e.target as Element).closest("input, .doc-title.renaming")) return;
    if (id !== this.activeId) this.on.activate(id);
    this.drag = {
      id, el, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY,
      dragging: false, outside: false, overWindow: false, ghost: null, asking: false, pending: null,
    };
    // Keeps the events coming when the pointer leaves the window.
    try { el.setPointerCapture(e.pointerId); } catch { /* not supported */ }
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    window.addEventListener("pointercancel", this.onUp);
    window.addEventListener("keydown", this.onKey, true);
  }

  private readonly onMove = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.dragging) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD_PX) return;
      d.dragging = true;
      d.el.classList.add("dragging");
      document.body.classList.add("tab-dragging");
    }
    e.preventDefault();
    const outside = this.isOutside(e);
    if (outside !== d.outside) {
      d.outside = outside;
      d.el.classList.toggle("torn", outside);
      if (outside) {
        d.ghost = document.createElement("div");
        d.ghost.className = "tab-ghost";
        d.ghost.innerHTML = `<span class="tab-ghost-name"></span><span class="tab-ghost-hint"></span>`;
        d.ghost.querySelector(".tab-ghost-name")!.textContent = this.tabs.find((t) => t.id === d.id)?.title ?? "";
        document.body.append(d.ghost);
        this.updateGhost();
      } else {
        d.ghost?.remove();
        d.ghost = null;
        d.overWindow = false;
        this.on.hoverEnd();
      }
    }
    if (d.outside) {
      this.placeGhost(e);
      this.askHover(e.screenX, e.screenY);
    } else {
      this.slide(e.clientX);
    }
  };

  private readonly onUp = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.endDrag();
    if (!d.dragging) return;
    this.suppressClick = true;
    setTimeout(() => { this.suppressClick = false; }, 0);
    if (e.type === "pointercancel") { this.on.hoverEnd(); return; }
    if (d.outside) {
      // A lone tab only moves into another window: dropped on nothing, it stays.
      if (this.tabs.length > 1 || d.overWindow) this.on.detach(d.id, e.screenX, e.screenY);
      else this.on.hoverEnd();
      return;
    }
    const index = [...this.el.children].indexOf(d.el);
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
    if (dragging) { this.on.hoverEnd(); this.render(this.tabs, this.activeId); }
  };

  private endDrag(): void {
    const d = this.drag;
    if (!d) return;
    try { d.el.releasePointerCapture(d.pointerId); } catch { /* already released */ }
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    window.removeEventListener("pointercancel", this.onUp);
    window.removeEventListener("keydown", this.onKey, true);
    d.el.classList.remove("dragging", "torn");
    d.el.style.transform = "";
    d.ghost?.remove();
    document.body.classList.remove("tab-dragging");
    this.drag = null;
  }

  /** Past the window's edge, or pulled well below the title bar. */
  private isOutside(e: PointerEvent): boolean {
    if (e.clientX < 0 || e.clientY < 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) return true;
    if (this.tabs.length < 2) return false;
    return e.clientY > this.bar.getBoundingClientRect().bottom + TEAR_OFF_PX;
  }

  /** Follows the pointer along the strip, swapping places with the tabs it passes. */
  private slide(x: number): void {
    const d = this.drag!;
    if (this.tabs.length < 2) return;
    const others = [...this.el.children].filter((c) => c !== d.el) as HTMLElement[];
    let index = others.length;
    for (let i = 0; i < others.length; i++) {
      const r = others[i].getBoundingClientRect();
      if (x < r.left + r.width / 2) { index = i; break; }
    }
    const current = [...this.el.children].indexOf(d.el);
    if (index !== current) {
      const ref = others[index] ?? null;
      this.el.insertBefore(d.el, ref);
    }
    const r = d.el.getBoundingClientRect();
    const shift = d.el.style.transform ? parseFloat(d.el.style.transform.slice(11)) || 0 : 0;
    const home = r.left - shift + r.width / 2;
    d.el.style.transform = `translateX(${Math.round(x - home)}px)`;
  }

  private placeGhost(e: PointerEvent): void {
    const g = this.drag?.ghost;
    if (!g) return;
    // Outside the window the ghost waits at the edge the pointer crossed.
    const x = Math.min(Math.max(e.clientX + 12, 4), window.innerWidth - g.offsetWidth - 4);
    const y = Math.min(Math.max(e.clientY + 12, 4), window.innerHeight - g.offsetHeight - 4);
    g.style.left = `${x}px`;
    g.style.top = `${y}px`;
  }

  private updateGhost(): void {
    const d = this.drag;
    const hint = d?.ghost?.querySelector(".tab-ghost-hint");
    if (!d || !hint) return;
    const lone = this.tabs.length < 2;
    hint.textContent = d.overWindow ? this.labels.dragMerge : lone ? "" : this.labels.dragNew;
    d.ghost!.classList.toggle("merge", d.overWindow);
  }

  /** Asks which window is under the pointer, one question at a time. */
  private askHover(x: number, y: number): void {
    const d = this.drag!;
    if (d.asking) { d.pending = { x, y }; return; }
    d.asking = true;
    void this.on.hover(x, y).catch(() => false).then((over) => {
      if (this.drag !== d) return;
      d.asking = false;
      if (d.outside && over !== d.overWindow) { d.overWindow = over; this.updateGhost(); }
      const next = d.pending;
      d.pending = null;
      if (next && d.outside) this.askHover(next.x, next.y);
    });
  }
}
