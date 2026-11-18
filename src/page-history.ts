export interface DocState {
  path: string;
  page: number;
  dirty: boolean;
}

export class PageHistory {
  static readonly MAX = 20;
  private undoStack: DocState[] = [];
  private redoStack: DocState[] = [];

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  record(before: DocState): void {
    this.undoStack.push(before);
    if (this.undoStack.length > PageHistory.MAX) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(current: DocState): DocState | null {
    const target = this.undoStack.pop();
    if (!target) return null;
    this.redoStack.push(current);
    return target;
  }

  redo(current: DocState): DocState | null {
    const target = this.redoStack.pop();
    if (!target) return null;
    this.undoStack.push(current);
    return target;
  }

  clearRedo(): void { this.redoStack = []; }

  snapshot(): { undo: DocState[]; redo: DocState[] } {
    return { undo: [...this.undoStack], redo: [...this.redoStack] };
  }

  restore(s: { undo: DocState[]; redo: DocState[] }): void {
    this.undoStack = [...s.undo];
    this.redoStack = [...s.redo];
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
