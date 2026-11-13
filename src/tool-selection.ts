import { defaultToolState, type ActiveToolState, type Annotation, type ToolKind } from "./models";

/** An overlay that draws the selection; told when the selection moves elsewhere. */
export interface SelectionOwner {
  selectionLost(): void;
}

/**
 * The active tool with its style presets, and the one selected annotation
 * across all pages. Every page overlay reads the same state, so selecting an
 * annotation on one page deselects whatever was selected on another.
 */
export class ToolSelection {
  /** The tool and the style new annotations get. Shared: read it, change it through the methods. */
  readonly state: ActiveToolState = defaultToolState();
  private _selected: Annotation | null = null;
  private owner: SelectionOwner | null = null;

  get tool(): ToolKind { return this.state.tool; }

  setTool(tool: ToolKind): void {
    this.state.tool = tool;
  }

  setStyle(style: Partial<ActiveToolState>): void {
    Object.assign(this.state, style);
  }

  /** The selected annotation, on whatever page; null when none is. */
  get selected(): Annotation | null { return this._selected; }

  /**
   * Selects `ann` (null: nothing), drawn by `owner`. The previous owner, if
   * another, is told so it can stop drawing its selection box.
   */
  select(ann: Annotation | null, owner: SelectionOwner | null = null): void {
    const next = ann ? owner : null;
    if (ann === this._selected && next === this.owner) return;
    const prev = this.owner;
    this._selected = ann;
    this.owner = next;
    if (prev && prev !== next) prev.selectionLost();
  }

  /** Clears the selection when it is on 1-based `page`. */
  deselectOnPage(page: number): void {
    if (this._selected?.page === page) this.select(null);
  }
}
