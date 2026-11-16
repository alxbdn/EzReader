/**
 * The documents open in this window, one tab each.
 *
 * Only the active tab's document is loaded in the viewer: the others are
 * parked, their state (paths, pending edits, history, zoom, page) kept in
 * `parked`, and their PDF closed, so ten tabs cost about as much memory as
 * one. Switching back reloads the file and puts the state back.
 */
export interface DocTab<P> {
  readonly id: number;
  /** File name shown on the tab. */
  title: string;
  /** Unsaved changes: a dot on the tab, and a question before it closes. */
  dirty: boolean;
  /** The parked state, null while the tab is the active one. */
  parked: P | null;
}

export class DocTabs<P> {
  private list: DocTab<P>[] = [];
  private activeId: number | null = null;
  private nextId = 1;

  get tabs(): readonly DocTab<P>[] { return this.list; }
  get count(): number { return this.list.length; }
  get active(): DocTab<P> | null { return this.list.find((t) => t.id === this.activeId) ?? null; }

  get(id: number): DocTab<P> | null { return this.list.find((t) => t.id === id) ?? null; }

  /** A new tab, right after the active one, which it becomes. */
  add(title = ""): DocTab<P> {
    const tab: DocTab<P> = { id: this.nextId++, title, dirty: false, parked: null };
    const at = this.list.findIndex((t) => t.id === this.activeId);
    this.list.splice(at === -1 ? this.list.length : at + 1, 0, tab);
    this.activeId = tab.id;
    return tab;
  }

  /** Makes `id` the active tab (its parked state is the caller's to restore). */
  activate(id: number): DocTab<P> | null {
    const tab = this.get(id);
    if (tab) this.activeId = id;
    return tab;
  }

  /**
   * Removes `id`. Returns the tab to show next when it was the active one:
   * the one on its right, else on its left (null when none is left, or when
   * another tab stays active).
   */
  remove(id: number): DocTab<P> | null {
    const at = this.list.findIndex((t) => t.id === id);
    if (at === -1) return null;
    this.list.splice(at, 1);
    if (this.activeId !== id) return null;
    const next = this.list[Math.min(at, this.list.length - 1)] ?? null;
    this.activeId = next?.id ?? null;
    return next;
  }

  /** Puts `id` at `index` (dragging along the strip). */
  move(id: number, index: number): void {
    const at = this.list.findIndex((t) => t.id === id);
    if (at === -1) return;
    const [tab] = this.list.splice(at, 1);
    this.list.splice(Math.max(0, Math.min(index, this.list.length)), 0, tab);
  }

  /** The tab `step` places away from the active one, wrapping around (Ctrl+Tab). */
  neighbour(step: number): DocTab<P> | null {
    if (this.list.length < 2) return null;
    const at = this.list.findIndex((t) => t.id === this.activeId);
    const n = this.list.length;
    return this.list[(((at + step) % n) + n) % n];
  }

  /** True when a tab has unsaved changes. */
  get anyDirty(): boolean { return this.list.some((t) => t.dirty); }
}
