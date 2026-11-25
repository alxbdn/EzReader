import { DocTabs, type DocTab } from "./doc-tabs";

/**
 * What the workspace needs from the one document the window shows. A tab that is not shown keeps
 * its document "parked": `P` is whatever the app needs to show it again.
 */
export interface ShownDocument<P> {
  isOpen(): boolean;
  /** The shown document's name and unsaved state, for its tab. */
  title(): string | null;
  isDirty(): boolean;
  /** Whether the shown document can be left now (no page edit running, no dialog in the way). */
  canLeave(): boolean;
  /** Whether a document can be opened now (no dialog in the way). */
  canOpen(): boolean;
  /** The file a document reads from (the shown one for `null`), or null for an unsaved copy. */
  fileOf(parked: P | null): string | null;
  /** Takes the shown document's state out of the window; null when there is nothing to keep. */
  park(): P | null;
  /** Shows a parked document again; false when it could not be loaded. */
  show(parked: P): Promise<boolean>;
  /** Empties the window for a document about to open in a new tab. */
  clear(): void;
  /** Closes the shown document and shows the welcome screen. */
  close(): Promise<void>;
  /** Offers to save the shown document's changes; false when the person cancelled. */
  settleUnsaved(): Promise<boolean>;
}

export interface WorkspaceView<P> {
  render(tabs: readonly DocTab<P>[], activeId: number | null): void;
  /** Some tab's unsaved state may have changed (the window's close guard follows it). */
  dirtyChanged(): void;
}

/**
 * The window's documents: one tab per document, one of them shown. Switching, opening in a new
 * tab, closing and closing everything all go through here, one at a time, so a tab is never
 * parked twice or shown while another switch is still loading.
 */
export class DocWorkspace<P> {
  private readonly tabs = new DocTabs<P>();
  private switching: Promise<void> | null = null;

  constructor(
    private readonly doc: ShownDocument<P>,
    private readonly view: WorkspaceView<P>,
    private readonly samePath: (a: string, b: string) => boolean,
  ) {}

  get active(): DocTab<P> | null { return this.tabs.active; }
  get count(): number { return this.tabs.count; }
  get anyDirty(): boolean { return this.tabs.anyDirty; }
  get list(): readonly DocTab<P>[] { return this.tabs.tabs; }

  /** Waits for any tab switch in progress. */
  async settled(): Promise<void> {
    while (this.switching) await this.switching;
  }

  /** Brings the active tab's title and unsaved mark in line with the shown document. */
  sync(): void {
    if (this.doc.isOpen() && !this.tabs.active) this.tabs.add();
    const tab = this.tabs.active;
    if (tab && this.doc.isOpen()) {
      tab.title = this.doc.title() ?? "";
      tab.dirty = this.doc.isDirty();
    }
    this.render();
  }

  render(): void {
    this.view.render(this.tabs.tabs, this.tabs.active?.id ?? null);
  }

  move(id: number, index: number): void {
    this.tabs.move(id, index);
    this.render();
  }

  /** The tab to the left (`-1`) or right (`1`) of the active one, wrapping around. */
  neighbour(step: number): DocTab<P> | null { return this.tabs.neighbour(step); }

  /** The tab that already shows `path` as itself (not as an unsaved copy). */
  showing(path: string): DocTab<P> | null {
    return this.tabs.tabs.find((t) => {
      const file = this.doc.fileOf(t.parked);
      return !!file && this.samePath(file, path);
    }) ?? null;
  }

  async switchTo(id: number): Promise<void> {
    // Checked again after waking: a second click can wake in the same turn as the first one and
    // must then wait for the switch the first one has just started.
    do await this.settled(); while (this.switching);
    const tab = this.tabs.get(id);
    if (!tab || tab === this.tabs.active || !this.doc.canLeave()) { this.render(); return; }
    const run = (async () => {
      this.park();
      await this.show(tab);
    })();
    this.switching = run;
    try { await run; } finally { this.switching = null; this.render(); }
  }

  /**
   * Opens a document in a new tab next to the active one. When `open` leaves nothing open
   * (cancelled, failed), the tab goes away and the one before comes back. `title` names the tab
   * while the document loads, so the list never shows a blank row.
   */
  async inNewTab(open: () => Promise<void>, title = ""): Promise<void> {
    await this.settled();
    if (!this.doc.canOpen()) return;
    const before = this.doc.isOpen() ? this.tabs.active : null;
    if (before) this.park();
    const tab = this.tabs.add(title);
    this.doc.clear();
    this.render();
    try {
      await open();
    } finally {
      if (!this.doc.isOpen()) {
        this.tabs.remove(tab.id);
        if (before) await this.show(before);
        else this.render();
      }
    }
  }

  /** Closes a tab, offering to save it first when it has changes. */
  async close(id: number): Promise<void> {
    await this.settled();
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (tab !== this.tabs.active) {
      if (!tab.dirty) { this.tabs.remove(id); this.render(); this.view.dirtyChanged(); return; }
      await this.switchTo(id);
      if (this.tabs.active !== tab) return;
    }
    if (!await this.doc.settleUnsaved()) return;
    await this.dropActive();
  }

  /** Closes the active tab without asking, and shows its neighbour or the welcome screen. */
  async dropActive(): Promise<void> {
    const tab = this.tabs.active;
    if (!tab) return;
    const next = this.tabs.remove(tab.id);
    if (next) await this.show(next);
    else await this.doc.close();
  }

  /** Offers to save every tab with changes, one after the other; false when one was cancelled. */
  async settleAll(): Promise<boolean> {
    await this.settled();
    for (const tab of [...this.tabs.tabs]) {
      if (!tab.dirty) continue;
      if (tab !== this.tabs.active) {
        await this.switchTo(tab.id);
        if (this.tabs.active !== tab) return false;
      }
      if (!await this.doc.settleUnsaved()) return false;
      tab.dirty = false;
    }
    return true;
  }

  private park(): void {
    const tab = this.tabs.active;
    if (!tab || !this.doc.isOpen()) return;
    const parked = this.doc.park();
    if (!parked) return;
    tab.title = this.doc.title() ?? tab.title;
    tab.dirty = this.doc.isDirty();
    tab.parked = parked;
  }

  private async show(tab: DocTab<P>): Promise<void> {
    this.tabs.activate(tab.id);
    const parked = tab.parked;
    if (!parked) return;
    tab.parked = null;
    if (await this.doc.show(parked)) return;
    const next = this.tabs.remove(tab.id);
    if (next) await this.show(next);
    else await this.doc.close();
  }
}
