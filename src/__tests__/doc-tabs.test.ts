// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { DocTabs } from "../doc-tabs";
import { DocumentSession } from "../document-session";
import { AnnotationSession } from "../annotation-session";
import { PageHistory } from "../page-history";
import type { Annotation } from "../models";

describe("DocTabs", () => {
  it("opens a new tab right after the active one, which it becomes", () => {
    const tabs = new DocTabs<string>();
    const a = tabs.add("a");
    const b = tabs.add("b");
    tabs.activate(a.id);
    const c = tabs.add("c");
    expect(tabs.tabs.map((t) => t.title)).toEqual(["a", "c", "b"]);
    expect(tabs.active).toBe(c);
    expect(b.parked).toBeNull();
  });

  it("shows the tab on the right of a closed active tab, else the one on its left", () => {
    const tabs = new DocTabs<string>();
    const a = tabs.add("a");
    const b = tabs.add("b");
    const c = tabs.add("c");
    tabs.activate(b.id);
    expect(tabs.remove(b.id)).toBe(c);
    expect(tabs.remove(c.id)).toBe(a);
    expect(tabs.remove(a.id)).toBeNull();
    expect(tabs.active).toBeNull();
  });

  it("keeps the active tab when a background one closes", () => {
    const tabs = new DocTabs<string>();
    const a = tabs.add("a");
    const b = tabs.add("b");
    expect(tabs.remove(a.id)).toBeNull();
    expect(tabs.active).toBe(b);
  });

  it("moves a tab and steps through them, wrapping around", () => {
    const tabs = new DocTabs<string>();
    const a = tabs.add("a");
    tabs.add("b");
    const c = tabs.add("c");
    tabs.move(a.id, 2);
    expect(tabs.tabs.map((t) => t.title)).toEqual(["b", "c", "a"]);
    expect(tabs.neighbour(1)).toBe(a);
    tabs.activate(a.id);
    expect(tabs.neighbour(1)?.title).toBe("b");
    expect(tabs.neighbour(-1)).toBe(c);
  });

  it("knows when a tab has unsaved changes", () => {
    const tabs = new DocTabs<string>();
    tabs.add("a");
    const b = tabs.add("b");
    expect(tabs.anyDirty).toBe(false);
    b.dirty = true;
    expect(tabs.anyDirty).toBe(true);
  });
});

describe("parking a document", () => {
  const rect = (page: number) => ({ kind: "rect", page, x: 1, y: 1, w: 2, h: 2 }) as unknown as Annotation;

  it("brings the session back as it was", () => {
    const io = { saveAnnotated: vi.fn(), redact: vi.fn(), tempPath: vi.fn(), encrypt: vi.fn() };
    const session = new DocumentSession({ annotations: () => [], formFields: () => [], rotation: () => 0 }, io);
    session.opened("/docs/a.pdf", "/tmp/display-a.pdf");
    session.rename("Renamed");
    session.markDirty(true);
    const parked = session.snapshot();
    session.opened("/docs/b.pdf", null);
    expect(session.sourcePath).toBe("/docs/b.pdf");
    session.restore(parked);
    expect(session.sourcePath).toBe("/docs/a.pdf");
    expect(session.basePath).toBe("/tmp/display-a.pdf");
    expect(session.displayName).toBe("Renamed.pdf");
    expect(session.isDirty).toBe(true);
    session.restore(null);
    expect(session.isOpen).toBe(false);
  });

  it("saves a document moved from another window back to its own file", () => {
    const io = { saveAnnotated: vi.fn(), redact: vi.fn(), tempPath: vi.fn(), encrypt: vi.fn() };
    const session = new DocumentSession({ annotations: () => [], formFields: () => [], rotation: () => 0 }, io);
    session.opened("/tmp/ezreader-x/annotated.pdf", null);
    session.adoptSavePath("/docs/Report.pdf");
    expect(session.saveTarget).toBe("/docs/Report.pdf");
    expect(session.displayName).toBe("Report.pdf");
    expect(session.basePath).toBe("/tmp/ezreader-x/annotated.pdf");
    expect(session.planSave(false)).toEqual({ dialog: null, renameTo: null });
  });

  it("keeps the annotations and their history apart from the next document", () => {
    const anns = new AnnotationSession();
    anns.load([rect(1)]);
    anns.change(() => anns.add(rect(2)));
    const parked = anns.snapshot();
    anns.load([]);
    anns.change(() => anns.add(rect(5)));
    anns.restoreParked(parked);
    expect(anns.all().map((a) => a.page)).toEqual([1, 2]);
    expect(anns.undo()).toBe(true);
    expect(anns.all().map((a) => a.page)).toEqual([1]);
  });

  it("keeps the page history", () => {
    const h = new PageHistory();
    h.record({ path: "/tmp/1.pdf", page: 1, dirty: false });
    const parked = h.snapshot();
    h.clear();
    expect(h.canUndo).toBe(false);
    h.restore(parked);
    expect(h.undo({ path: "/tmp/2.pdf", page: 2, dirty: true })?.path).toBe("/tmp/1.pdf");
  });
});
