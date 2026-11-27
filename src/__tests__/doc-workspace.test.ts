import { describe, it, expect } from "vitest";
import { DocWorkspace, type ShownDocument } from "../doc-workspace";

type Doc = { file: string; dirty: boolean; unsaved?: boolean };

function setup() {
  const state = {
    shown: null as Doc | null,
    allowed: true,
    answers: [] as boolean[],
    asked: [] as string[],
    renders: 0,
    closed: 0,
  };
  const doc: ShownDocument<Doc> = {
    isOpen: () => state.shown !== null,
    title: () => state.shown?.file ?? null,
    isDirty: () => state.shown?.dirty ?? false,
    canLeave: () => state.allowed,
    canOpen: () => state.allowed,
    fileOf: (p) => { const d = p ?? state.shown; return d && !d.unsaved ? d.file : null; },
    park: () => (state.shown ? { ...state.shown } : null),
    show: async (p) => { await Promise.resolve(); if (p.file === "broken") return false; state.shown = p; return true; },
    clear: () => { state.shown = null; },
    close: async () => { state.shown = null; state.closed++; },
    settleUnsaved: async () => {
      state.asked.push(state.shown!.file);
      const saved = state.answers.shift() ?? true;
      if (saved) state.shown!.dirty = false;
      return saved;
    },
  };
  const ws = new DocWorkspace<Doc>(doc, { render: () => { state.renders++; }, dirtyChanged: () => {} }, (a, b) => a === b);
  const open = (file: string, dirty = false) => ws.inNewTab(async () => { state.shown = { file, dirty }; ws.sync(); });
  return { state, ws, open };
}

describe("DocWorkspace", () => {
  it("opens documents in tabs and switches between them", async () => {
    const { state, ws, open } = setup();
    await open("a.pdf");
    await open("b.pdf");
    expect(ws.list.map((t) => t.title)).toEqual(["a.pdf", "b.pdf"]);
    expect(ws.showing("a.pdf")).toBe(ws.list[0]);
    await ws.switchTo(ws.list[0].id);
    expect(state.shown?.file).toBe("a.pdf");
    expect(ws.list[1].parked?.file).toBe("b.pdf");
  });

  it("drops the new tab and brings the previous one back when opening fails", async () => {
    const { state, ws, open } = setup();
    await open("a.pdf");
    await ws.inNewTab(async () => {});
    expect(ws.count).toBe(1);
    expect(state.shown?.file).toBe("a.pdf");
  });

  it("names the new tab while its document is still loading", async () => {
    const { ws } = setup();
    let during = "";
    await ws.inNewTab(async () => { during = ws.list[0]!.title; }, "a.pdf");
    expect(during).toBe("a.pdf");
  });

  it("waits for a tab that is still loading before switching away from it", async () => {
    const { state, ws, open } = setup();
    await open("a.pdf");
    let finish = () => {};
    const loading = ws.inNewTab(async () => {
      await new Promise<void>((r) => { finish = r; });
      state.shown = { file: "b.pdf", dirty: false };
      ws.sync();
    }, "b.pdf");
    const switching = ws.switchTo(ws.list[0]!.id);
    await Promise.resolve();
    finish();
    await Promise.all([loading, switching]);
    expect(ws.list.map((t) => t.title)).toEqual(["a.pdf", "b.pdf"]);
    expect(state.shown?.file).toBe("a.pdf");
    expect(ws.list[1]!.parked?.file).toBe("b.pdf");
  });

  it("refuses to switch while the document cannot be left", async () => {
    const { state, ws, open } = setup();
    await open("a.pdf");
    await open("b.pdf");
    state.allowed = false;
    await ws.switchTo(ws.list[0].id);
    expect(state.shown?.file).toBe("b.pdf");
  });

  it("runs one switch at a time", async () => {
    const { state, ws, open } = setup();
    await open("a.pdf");
    await open("b.pdf");
    await open("c.pdf");
    const [a, b] = ws.list;
    await Promise.all([ws.switchTo(a.id), ws.switchTo(b.id)]);
    expect(state.shown?.file).toBe("b.pdf");
    expect(ws.list.filter((t) => t.parked).map((t) => t.parked!.file).sort()).toEqual(["a.pdf", "c.pdf"]);
  });

  it("closes a clean background tab without asking, and a dirty one after asking", async () => {
    const { state, ws, open } = setup();
    await open("a.pdf");
    await open("b.pdf", true);
    await open("c.pdf");
    await ws.close(ws.list[0].id);
    expect(state.asked).toEqual([]);
    expect(ws.list.map((t) => t.title)).toEqual(["b.pdf", "c.pdf"]);
    state.answers = [false];
    await ws.close(ws.list[0].id);
    expect(state.asked).toEqual(["b.pdf"]);
    expect(ws.count).toBe(2);
    await ws.close(ws.list[0].id);
    expect(ws.list.map((t) => t.title)).toEqual(["c.pdf"]);
    expect(state.shown?.file).toBe("c.pdf");
  });

  it("shows the welcome screen when the last tab closes", async () => {
    const { state, ws, open } = setup();
    await open("a.pdf");
    await ws.close(ws.active!.id);
    expect(ws.count).toBe(0);
    expect(state.closed).toBe(1);
  });

  it("skips a tab that can no longer be loaded", async () => {
    const { state, ws, open } = setup();
    await open("a.pdf");
    await open("b.pdf");
    ws.list[0].parked = { file: "broken", dirty: false };
    await ws.switchTo(ws.list[0].id);
    expect(ws.count).toBe(1);
    expect(state.shown?.file).toBe("b.pdf");
  });

  it("asks about every unsaved tab before the window closes", async () => {
    const { state, ws, open } = setup();
    await open("a.pdf", true);
    await open("b.pdf");
    await open("c.pdf", true);
    expect(await ws.settleAll()).toBe(true);
    expect(state.asked).toEqual(["a.pdf", "c.pdf"]);
    expect(ws.anyDirty).toBe(false);
  });

  it("stops at the first cancelled save", async () => {
    const { state, ws, open } = setup();
    await open("a.pdf", true);
    await open("b.pdf", true);
    state.answers = [false];
    expect(await ws.settleAll()).toBe(false);
    expect(state.asked).toEqual(["a.pdf"]);
  });

  it("does not match an unsaved copy by its source file", async () => {
    const { ws, state, open } = setup();
    await open("a.pdf");
    state.shown!.unsaved = true;
    expect(ws.showing("a.pdf")).toBeNull();
  });
});
