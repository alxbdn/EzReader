/** The document as it was at one moment: the file that holds it, the page shown, its dirty flag. */
export interface DocState {
  path: string;
  page: number;
  dirty: boolean;
}

/**
 * Undo / redo of page edits (delete, move, rotate, insert, crop, straighten).
 * A page edit writes a new working file, so undoing it means showing the
 * file from before again. Annotation changes keep their own history
 * (AnnotationSession), which comes first: page edits are undone once it is
 * empty.
 */
export class PageHistory {
  static readonly MAX = 20;
  private undoStack: DocState[] = [];
  private redoStack: DocState[] = [];

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  /** A page edit was made; `before` is the document just before it. */
  record(before: DocState): void {
    this.undoStack.push(before);
    if (this.undoStack.length > PageHistory.MAX) this.undoStack.shift();
    this.redoStack = [];
  }

  /** The state to go back to, `current` kept for redo; null when there is none. */
  undo(current: DocState): DocState | null {
    const target = this.undoStack.pop();
    if (!target) return null;
    this.redoStack.push(current);
    return target;
  }

  /** The state to go forward to again, `current` kept for undo; null when there is none. */
  redo(current: DocState): DocState | null {
    const target = this.redoStack.pop();
    if (!target) return null;
    this.undoStack.push(current);
    return target;
  }

  /** Something else changed: the undone page edits can't be redone. */
  clearRedo(): void { this.redoStack = []; }

  /** Another document: no history. */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
