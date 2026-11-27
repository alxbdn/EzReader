import type { Annotation } from "./models";

function redactionsOf(anns: Annotation[]): string {
  return JSON.stringify(anns.filter((a) => a.kind === "redact"));
}

type State = string[];

export interface Snapshot {
  annotations: State;
  redactions: string;
  dirty: boolean;
}

export interface AnnotationSessionOptions {
  gateEnabled?: () => boolean;
  isDirty?: () => boolean;
}

export interface AnnotationSnapshot {
  pages: Map<number, Annotation[]>;
  undo: State[];
  redo: State[];
  draft: Snapshot | null;
}

export class AnnotationSession {
  private static readonly MAX_HISTORY = 50;

  private pages = new Map<number, Annotation[]>();
  private undoStack: State[] = [];
  private redoStack: State[] = [];
  private draft: Snapshot | null = null;
  private candidate: Snapshot | null = null;
  private depth = 0;

  private changeHandlers: (() => void)[] = [];
  private pendingHandlers: ((pending: boolean) => void)[] = [];
  private contentHandlers: (() => void)[] = [];

  constructor(private readonly opts: AnnotationSessionOptions = {}) {}

  forPage(page: number): readonly Annotation[] {
    return this.pages.get(page) ?? [];
  }

  all(): Annotation[] {
    const result: Annotation[] = [];
    for (const list of this.pages.values()) result.push(...list);
    return result;
  }

  has(ann: Annotation): boolean {
    return this.pages.get(ann.page)?.includes(ann) ?? false;
  }

  isEmpty(): boolean {
    return this.pages.size === 0;
  }

  get pending(): boolean {
    return this.draft !== null;
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  onChange(h: () => void): void { this.changeHandlers.push(h); }
  onPendingChange(h: (pending: boolean) => void): void { this.pendingHandlers.push(h); }
  onContentChange(h: () => void): void { this.contentHandlers.push(h); }

  change(fn: () => void): void {
    if (this.depth === 0) this.begin();
    this.depth++;
    try {
      fn();
    } finally {
      this.depth--;
    }
    if (this.depth === 0) this.finish();
  }

  add(ann: Annotation): void {
    this.change(() => {
      let list = this.pages.get(ann.page);
      if (!list) this.pages.set(ann.page, (list = []));
      list.push(ann);
    });
  }

  remove(ann: Annotation): boolean {
    const list = this.pages.get(ann.page);
    const idx = list?.indexOf(ann) ?? -1;
    if (!list || idx === -1) return false;
    this.change(() => {
      list.splice(idx, 1);
      if (list.length === 0) this.pages.delete(ann.page);
    });
    return true;
  }

  moveLayer(ann: Annotation, step: 1 | -1): boolean {
    const list = this.pages.get(ann.page);
    const idx = list?.indexOf(ann) ?? -1;
    const to = idx + step;
    if (!list || idx === -1 || to < 0 || to >= list.length) return false;
    this.change(() => {
      [list[idx], list[to]] = [list[to], list[idx]];
    });
    return true;
  }

  moveTo(ann: Annotation, index: number): boolean {
    const list = this.pages.get(ann.page);
    const idx = list?.indexOf(ann) ?? -1;
    if (!list || idx === -1) return false;
    const to = Math.max(0, Math.min(list.length - 1, index));
    if (to === idx) return false;
    this.change(() => {
      list.splice(idx, 1);
      list.splice(to, 0, ann);
    });
    return true;
  }

  beginEdit(): void {
    this.begin();
  }

  relocate(ann: Annotation, page: number): void {
    if (ann.page === page) return;
    const from = this.pages.get(ann.page);
    const idx = from?.indexOf(ann) ?? -1;
    if (!from || idx === -1) return;
    from.splice(idx, 1);
    if (from.length === 0) this.pages.delete(ann.page);
    ann.page = page;
    let to = this.pages.get(page);
    if (!to) this.pages.set(page, (to = []));
    to.push(ann);
  }

  settle(): void {
    if (!this.candidate || this.draft) return;
    if (redactionsOf(this.all()) === this.candidate.redactions) return;
    this.draft = this.candidate;
    this.candidate = null;
    this.emitPending(true);
  }

  edited(): void {
    this.settle();
    this.emitChange();
  }

  undo(): boolean {
    return this.step(this.undoStack, this.redoStack);
  }

  redo(): boolean {
    return this.step(this.redoStack, this.undoStack);
  }

  apply(): void {
    if (!this.draft) return;
    this.draft = null;
    this.emitPending(false);
  }

  discard(): boolean | null {
    const draft = this.draft;
    if (!draft) return null;
    this.pushUndo();
    this.redoStack = [];
    this.restore(draft.annotations);
    this.draft = null;
    this.candidate = null;
    this.emitPending(false);
    return draft.dirty;
  }

  load(anns: Annotation[]): void {
    this.setAll(anns);
    this.undoStack = [];
    this.redoStack = [];
    this.candidate = null;
    if (this.draft) {
      this.draft = null;
      this.emitPending(false);
    }
  }

  snapshot(): AnnotationSnapshot {
    const pages = new Map<number, Annotation[]>();
    for (const [n, list] of this.pages) pages.set(n, [...list]);
    return { pages, undo: [...this.undoStack], redo: [...this.redoStack], draft: this.draft };
  }

  restoreParked(s: AnnotationSnapshot): void {
    this.pages = new Map([...s.pages].map(([n, list]) => [n, [...list]]));
    this.emitContent();
    this.undoStack = [...s.undo];
    this.redoStack = [...s.redo];
    this.candidate = null;
    this.depth = 0;
    const was = this.draft !== null;
    this.draft = s.draft;
    if (was !== (s.draft !== null)) this.emitPending(s.draft !== null);
  }

  clear(): void {
    this.load([]);
  }

  private begin(): void {
    const before = this.encode();
    this.pushUndo(before);
    this.redoStack = [];
    this.candidate = null;
    if (this.draft || this.opts.gateEnabled?.() === false) return;
    this.candidate = {
      annotations: before,
      redactions: redactionsOf(this.all()),
      dirty: this.opts.isDirty?.() ?? false,
    };
  }

  private finish(): void {
    this.settle();
    this.emitChange();
  }

  private encode(): State {
    const previous = this.undoStack[this.undoStack.length - 1] ?? this.redoStack[this.redoStack.length - 1];
    const known = new Map((previous ?? []).map((json) => [json, json]));
    return this.all().map((ann) => {
      const json = JSON.stringify(ann);
      return known.get(json) ?? json;
    });
  }

  private pushUndo(state = this.encode()): void {
    this.undoStack.push(state);
    if (this.undoStack.length > AnnotationSession.MAX_HISTORY) this.undoStack.shift();
  }

  private step(from: State[], to: State[]): boolean {
    const state = from.pop();
    if (state === undefined) return false;
    to.push(this.encode());
    this.restore(state);
    this.candidate = null;
    if (this.draft && redactionsOf(this.all()) === this.draft.redactions) this.apply();
    return true;
  }

  private restore(state: State): void {
    this.setAll(state.map((json) => JSON.parse(json) as Annotation));
  }

  private setAll(anns: Annotation[]): void {
    this.pages.clear();
    for (const ann of anns) {
      let list = this.pages.get(ann.page);
      if (!list) this.pages.set(ann.page, (list = []));
      list.push(ann);
    }
    this.emitContent();
  }

  private emitChange(): void { this.changeHandlers.forEach((h) => h()); this.emitContent(); }
  private emitContent(): void { this.contentHandlers.forEach((h) => h()); }
  private emitPending(p: boolean): void { this.pendingHandlers.forEach((h) => h(p)); }
}
