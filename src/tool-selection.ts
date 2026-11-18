import { defaultToolState, type ActiveToolState, type Annotation, type ToolKind } from "./models";

export interface SelectionOwner {
  selectionLost(): void;
}

export class ToolSelection {
  readonly state: ActiveToolState = defaultToolState();
  private _selected: Annotation | null = null;
  private owner: SelectionOwner | null = null;
  private selectHandlers: ((ann: Annotation | null) => void)[] = [];

  onSelect(h: (ann: Annotation | null) => void): void { this.selectHandlers.push(h); }

  get tool(): ToolKind { return this.state.tool; }

  setTool(tool: ToolKind): void {
    this.state.tool = tool;
  }

  setStyle(style: Partial<ActiveToolState>): void {
    Object.assign(this.state, style);
  }

  get selected(): Annotation | null { return this._selected; }

  select(ann: Annotation | null, owner: SelectionOwner | null = null): void {
    const next = ann ? owner : null;
    if (ann === this._selected && next === this.owner) return;
    const prev = this.owner;
    this._selected = ann;
    this.owner = next;
    if (prev && prev !== next) prev.selectionLost();
    this.selectHandlers.forEach((h) => h(ann));
  }

  deselectOnPage(page: number): void {
    if (this._selected?.page === page) this.select(null);
  }
}
