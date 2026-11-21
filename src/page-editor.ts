import { PageHistory, type DocState } from "./page-history";

/** What a page edit needs from the open document and the interface around it. */
export interface PageEditPort {
  /** A document is open and shown. */
  ready(): boolean;
  /** True, after telling the user why, when this document must not be edited now (protected, a draft pending). */
  refused(): boolean;
  /** The current file with every pending edit written into it, and where the reader is. */
  current(): Promise<DocState>;
  /** Shows `path` as the document's new working copy, keeping the scroll position. */
  show(path: string): Promise<void>;
  setDirty(dirty: boolean): void;
  goToPage(page: number): void;
  /** Blocks page actions (sidebar, tabs) while an edit runs. */
  setBusy(busy: boolean): void;
  /** Reports an edit that failed; `kind` picks the message. */
  failed(kind: "pages" | "adjust", err: unknown): void;
}

/** Writes the edited document from `input` and returns the path it wrote. */
export type PageTransform = (input: string) => Promise<string>;

/**
 * Edits that rewrite the document's pages (rearrange, rotate, insert, delete, crop, straighten)
 * and their undo and redo.
 *
 * One edit runs at a time, whatever starts it: while one runs, `busy` is true and every other
 * edit, undo or redo is refused. Each edit writes a new working copy, so undo shows the previous
 * file again; the history keeps those files, the page the reader was on and whether the document
 * had unsaved changes.
 */
export class PageEditor {
  readonly history = new PageHistory();
  private running = false;

  constructor(private readonly port: PageEditPort) {}

  /** An edit, undo or redo is running: switching or closing the document must wait. */
  get busy(): boolean { return this.running; }

  get canUndo(): boolean { return this.history.canUndo; }
  get canRedo(): boolean { return this.history.canRedo; }

  /**
   * Runs `transform` on the current file and shows the result. False when it could not start
   * (nothing open, another edit running, refused) or failed; the failure is reported.
   */
  async apply(transform: PageTransform, opts: { kind?: "pages" | "adjust"; guarded?: boolean } = {}): Promise<boolean> {
    const { kind = "pages", guarded = true } = opts;
    if (this.running || !this.port.ready()) return false;
    if (guarded && this.port.refused()) return false;
    return this.run(kind, async () => {
      const before = await this.port.current();
      const out = await transform(before.path);
      await this.port.show(out);
      this.history.record(before);
      this.port.setDirty(true);
      return true;
    });
  }

  /** Shows the file before the last edit (or after, for redo). False when there is none or it is busy. */
  async step(redo: boolean): Promise<boolean> {
    if (this.running || !(redo ? this.canRedo : this.canUndo)) return false;
    return this.run("pages", async () => {
      const current = await this.port.current();
      const target = redo ? this.history.redo(current) : this.history.undo(current);
      if (!target) return false;
      await this.port.show(target.path);
      this.port.setDirty(target.dirty);
      this.port.goToPage(target.page);
      return true;
    });
  }

  private async run(kind: "pages" | "adjust", body: () => Promise<boolean>): Promise<boolean> {
    this.running = true;
    this.port.setBusy(true);
    try {
      return await body();
    } catch (err) {
      this.port.failed(kind, err);
      return false;
    } finally {
      this.running = false;
      this.port.setBusy(false);
    }
  }
}
