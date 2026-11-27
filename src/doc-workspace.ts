import { DocTabs, type DocTab } from "./doc-tabs";

export interface ShownDocument<P> {
  isOpen(): boolean;
  title(): string | null;
  isDirty(): boolean;
  canLeave(): boolean;
  canOpen(): boolean;
  fileOf(parked: P | null): string | null;
  park(): P | null;
  show(parked: P): Promise<boolean>;
  clear(): void;
  close(): Promise<void>;
  settleUnsaved(): Promise<boolean>;
}

export interface WorkspaceView<P> {
  render(tabs: readonly DocTab<P>[], activeId: number | null): void;
  dirtyChanged(): void;
}

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

  async settled(): Promise<void> {
    while (this.switching) await this.switching;
  }

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

  neighbour(step: number): DocTab<P> | null { return this.tabs.neighbour(step); }

  showing(path: string): DocTab<P> | null {
    return this.tabs.tabs.find((t) => {
      const file = this.doc.fileOf(t.parked);
      return !!file && this.samePath(file, path);
    }) ?? null;
  }

  async switchTo(id: number): Promise<void> {
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

  async inNewTab(open: () => Promise<void>, title = ""): Promise<void> {
    await this.settled();
    if (!this.doc.canOpen()) return;
    const before = this.doc.isOpen() ? this.tabs.active : null;
    if (before) this.park();
    const tab = this.tabs.add(title);
    this.doc.clear();
    this.render();
    const run = (async () => {
      try {
        await open();
      } finally {
        if (!this.doc.isOpen()) {
          this.tabs.remove(tab.id);
          if (before) await this.show(before);
          else this.render();
        }
      }
    })();
    this.switching = run;
    try { await run; } finally { if (this.switching === run) this.switching = null; }
  }

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

  async dropActive(): Promise<void> {
    const tab = this.tabs.active;
    if (!tab) return;
    const next = this.tabs.remove(tab.id);
    if (next) await this.show(next);
    else await this.doc.close();
  }

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
