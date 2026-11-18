export interface DocTab<P> {
  readonly id: number;
  title: string;
  dirty: boolean;
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

  add(title = ""): DocTab<P> {
    const tab: DocTab<P> = { id: this.nextId++, title, dirty: false, parked: null };
    const at = this.list.findIndex((t) => t.id === this.activeId);
    this.list.splice(at === -1 ? this.list.length : at + 1, 0, tab);
    this.activeId = tab.id;
    return tab;
  }

  activate(id: number): DocTab<P> | null {
    const tab = this.get(id);
    if (tab) this.activeId = id;
    return tab;
  }

  remove(id: number): DocTab<P> | null {
    const at = this.list.findIndex((t) => t.id === id);
    if (at === -1) return null;
    this.list.splice(at, 1);
    if (this.activeId !== id) return null;
    const next = this.list[Math.min(at, this.list.length - 1)] ?? null;
    this.activeId = next?.id ?? null;
    return next;
  }

  move(id: number, index: number): void {
    const at = this.list.findIndex((t) => t.id === id);
    if (at === -1) return;
    const [tab] = this.list.splice(at, 1);
    this.list.splice(Math.max(0, Math.min(index, this.list.length)), 0, tab);
  }

  neighbour(step: number): DocTab<P> | null {
    if (this.list.length < 2) return null;
    const at = this.list.findIndex((t) => t.id === this.activeId);
    const n = this.list.length;
    return this.list[(((at + step) % n) + n) % n];
  }

  get anyDirty(): boolean { return this.list.some((t) => t.dirty); }
}
