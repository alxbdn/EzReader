import { describe, expect, it, vi } from "vitest";
import { PageEditor, type PageEditPort } from "../page-editor";

function fakeDoc(opts: { refused?: boolean } = {}) {
  const state = { path: "a.pdf", page: 3, dirty: false, busy: [] as boolean[], failures: [] as string[] };
  const port: PageEditPort = {
    ready: () => true,
    refused: () => opts.refused ?? false,
    current: async () => ({ path: state.path, page: state.page, dirty: state.dirty }),
    show: async (path) => { state.path = path; },
    setDirty: (d) => { state.dirty = d; },
    goToPage: (p) => { state.page = p; },
    setBusy: (b) => { state.busy.push(b); },
    failed: (kind) => { state.failures.push(kind); },
  };
  return { state, port };
}

describe("PageEditor", () => {
  it("shows the edited file, marks the document changed and can undo and redo it", async () => {
    const { state, port } = fakeDoc();
    const editor = new PageEditor(port);
    expect(await editor.apply(async (input) => `${input}+rotated`)).toBe(true);
    expect(state.path).toBe("a.pdf+rotated");
    expect(state.dirty).toBe(true);

    state.page = 7;
    expect(await editor.step(false)).toBe(true);
    expect(state).toMatchObject({ path: "a.pdf", page: 3, dirty: false });
    expect(await editor.step(true)).toBe(true);
    expect(state).toMatchObject({ path: "a.pdf+rotated", page: 7, dirty: true });
  });

  it("runs one edit at a time and refuses undo and other edits meanwhile", async () => {
    const { port } = fakeDoc();
    const editor = new PageEditor(port);
    let finish!: (path: string) => void;
    const first = editor.apply(() => new Promise((r) => { finish = r; }));
    await Promise.resolve();
    expect(editor.busy).toBe(true);
    const second = vi.fn(async (input: string) => input);
    expect(await editor.apply(second)).toBe(false);
    expect(await editor.step(false)).toBe(false);
    expect(second).not.toHaveBeenCalled();
    finish("b.pdf");
    expect(await first).toBe(true);
    expect(editor.busy).toBe(false);
  });

  it("reports a failed edit, keeps the history and releases the busy flag", async () => {
    const { state, port } = fakeDoc();
    const editor = new PageEditor(port);
    expect(await editor.apply(async () => { throw new Error("broken"); }, { kind: "adjust" })).toBe(false);
    expect(state.failures).toEqual(["adjust"]);
    expect(editor.canUndo).toBe(false);
    expect(state.busy).toEqual([true, false]);
  });

  it("does not start when the document refuses edits, unless the edit is not guarded", async () => {
    const { port } = fakeDoc({ refused: true });
    const editor = new PageEditor(port);
    const edit = vi.fn(async (input: string) => input);
    expect(await editor.apply(edit)).toBe(false);
    expect(edit).not.toHaveBeenCalled();
    expect(await editor.apply(edit, { guarded: false })).toBe(true);
  });
});
