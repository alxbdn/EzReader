import type { Annotation } from "./models";

/** The redactions among `anns`, as text to compare. */
function redactionsOf(anns: Annotation[]): string {
  return JSON.stringify(anns.filter((a) => a.kind === "redact"));
}

interface Snapshot {
  /** Every annotation, as JSON. */
  annotations: string;
  /** The redactions among them, as JSON (to see whether a change touched one). */
  redactions: string;
  /** The document's dirty flag at that moment. */
  dirty: boolean;
}

export interface AnnotationSessionOptions {
  /** False while redactions must not wait for ✓ / ✕ (read mode). */
  gateEnabled?: () => boolean;
  /** The document's dirty flag, restored when pending redactions are thrown away. */
  isDirty?: () => boolean;
}

/**
 * The annotations of the open document: the one list every page draws from,
 * its undo / redo history, and the ✓ / ✕ gate that holds back redactions.
 *
 * Every change is one undo step. Most changes apply at once; a change that
 * adds, moves or removes a redaction (which destroys content when saved)
 * opens the gate until it is applied (✓) or discarded (✕).
 *
 * Changes made by the user notify `onChange`; restoring a state (undo, redo,
 * discard, load) does not — the caller redraws and sets the dirty flag.
 */
export class AnnotationSession {
  private static readonly MAX_HISTORY = 50;

  private pages = new Map<number, Annotation[]>();
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  /** State before the redactions waiting for ✓ / ✕; null when none wait. */
  private draft: Snapshot | null = null;
  /** State before the change in progress, while it may still open the gate. */
  private candidate: Snapshot | null = null;
  /** Depth of nested `change()` calls: only the outermost records history. */
  private depth = 0;

  private changeHandlers: (() => void)[] = [];
  private pendingHandlers: ((pending: boolean) => void)[] = [];

  constructor(private readonly opts: AnnotationSessionOptions = {}) {}

  // ── Reading ────────────────────────────────────────────────────────────────

  /** The annotations of 1-indexed `page`, bottom layer first. Do not mutate the array. */
  forPage(page: number): readonly Annotation[] {
    return this.pages.get(page) ?? [];
  }

  /** Every annotation, page by page. */
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

  /** Redactions are waiting for ✓ / ✕. */
  get pending(): boolean {
    return this.draft !== null;
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  onChange(h: () => void): void { this.changeHandlers.push(h); }
  onPendingChange(h: (pending: boolean) => void): void { this.pendingHandlers.push(h); }

  // ── Changes (one undo step each) ───────────────────────────────────────────

  /** Runs `fn` as one undo step: the mutations inside it record no history of their own. */
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

  /** Moves `ann` one layer up (+1, drawn later) or down (-1) on its page. */
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

  /**
   * Opens an undo step for an annotation about to be changed in place
   * (moved, resized, restyled, retyped). Call `settle()` after each partial
   * change of a drag, and `edited()` when it is done.
   */
  beginEdit(): void {
    this.begin();
  }

  /**
   * Moves `ann` to 1-indexed `page` (on top of its annotations), as part of
   * the in-place change opened by `beginEdit()`: no undo step of its own.
   */
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

  /** Re-checks the ✓ / ✕ gate after an in-place change (a drag step). */
  settle(): void {
    if (!this.candidate || this.draft) return;
    if (redactionsOf(this.all()) === this.candidate.redactions) return;
    this.draft = this.candidate;
    this.candidate = null;
    this.emitPending(true);
  }

  /** An in-place change opened by `beginEdit()` is done. */
  edited(): void {
    this.settle();
    this.emitChange();
  }

  // ── Undo / redo ────────────────────────────────────────────────────────────

  /** Restores the state before the last change. False when there is none. */
  undo(): boolean {
    return this.step(this.undoStack, this.redoStack);
  }

  /** Re-applies the last undone change. False when there is none. */
  redo(): boolean {
    return this.step(this.redoStack, this.undoStack);
  }

  // ── ✓ / ✕ gate ─────────────────────────────────────────────────────────────

  /** ✓: the pending redactions are kept. */
  apply(): void {
    if (!this.draft) return;
    this.draft = null;
    this.emitPending(false);
  }

  /**
   * ✕: the pending redactions (and everything changed since) are thrown away;
   * Ctrl+Z brings them back. Returns the dirty flag the document had before
   * them, or null when nothing was pending.
   */
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

  // ── Whole-document ─────────────────────────────────────────────────────────

  /** A freshly opened document: these annotations, no history, nothing pending. */
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

  /** Forgets every annotation (and the history). */
  clear(): void {
    this.load([]);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private begin(): void {
    const before = JSON.stringify(this.all());
    this.pushUndo(before);
    this.redoStack = [];
    this.candidate = null;
    if (this.draft || this.opts.gateEnabled?.() === false) return;
    const anns = JSON.parse(before) as Annotation[];
    this.candidate = {
      annotations: before,
      redactions: redactionsOf(anns),
      dirty: this.opts.isDirty?.() ?? false,
    };
  }

  private finish(): void {
    this.settle();
    this.emitChange();
  }

  private pushUndo(state = JSON.stringify(this.all())): void {
    this.undoStack.push(state);
    if (this.undoStack.length > AnnotationSession.MAX_HISTORY) this.undoStack.shift();
  }

  private step(from: string[], to: string[]): boolean {
    const state = from.pop();
    if (state === undefined) return false;
    to.push(JSON.stringify(this.all()));
    this.restore(state);
    this.candidate = null;
    // Undoing every pending redaction leaves nothing to validate.
    if (this.draft && redactionsOf(this.all()) === this.draft.redactions) this.apply();
    return true;
  }

  private restore(json: string): void {
    this.setAll(JSON.parse(json) as Annotation[]);
  }

  private setAll(anns: Annotation[]): void {
    this.pages.clear();
    for (const ann of anns) {
      let list = this.pages.get(ann.page);
      if (!list) this.pages.set(ann.page, (list = []));
      list.push(ann);
    }
  }

  private emitChange(): void { this.changeHandlers.forEach((h) => h()); }
  private emitPending(p: boolean): void { this.pendingHandlers.forEach((h) => h(p)); }
}
