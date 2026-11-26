import { PageHistory, type DocState } from "./page-history";

export interface PageEditPort {
  ready(): boolean;
  refused(): boolean;
  current(): Promise<DocState>;
  show(path: string): Promise<void>;
  setDirty(dirty: boolean): void;
  goToPage(page: number): void;
  setBusy(busy: boolean): void;
  failed(kind: "pages" | "adjust", err: unknown): void;
}

export type PageTransform = (input: string) => Promise<string>;

export class PageEditor {
  readonly history = new PageHistory();
  private running = false;

  constructor(private readonly port: PageEditPort) {}

  get busy(): boolean { return this.running; }

  get canUndo(): boolean { return this.history.canUndo; }
  get canRedo(): boolean { return this.history.canRedo; }

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
