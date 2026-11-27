// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

type FakeTask = {
  promise: Promise<unknown>;
  destroy: ReturnType<typeof vi.fn>;
  open: (pages: number) => void;
};

const tasks: FakeTask[] = [];

function fakeTask(): FakeTask {
  let open!: (pages: number) => void;
  const task = {} as FakeTask;
  task.destroy = vi.fn(async () => {});
  task.promise = new Promise((resolve) => {
    open = (pages) => resolve({
      numPages: pages,
      loadingTask: task,
      getPage: async () => ({ getViewport: () => ({ width: 600, height: 800 }) }),
    });
  });
  task.open = open;
  return task;
}

vi.mock("../pdfjs", () => ({
  pdfjsLib: async () => ({
    getDocument: () => {
      const task = fakeTask();
      tasks.push(task);
      return task;
    },
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
  invoke: vi.fn(),
}));

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("PdfViewer opening", () => {
  beforeEach(() => {
    tasks.length = 0;
    document.body.innerHTML = `<div id="viewer-scroll"></div>`;
    vi.stubGlobal("IntersectionObserver", NoopObserver);
    vi.stubGlobal("ResizeObserver", NoopObserver);
  });

  async function viewer() {
    const { PdfViewer } = await import("../pdf-viewer");
    return new PdfViewer();
  }

  it("keeps the newest document when an older open finishes last", async () => {
    const v = await viewer();
    const older = v.load("a.pdf");
    await settle();
    const newer = v.load("b.pdf");
    await settle();
    expect(tasks).toHaveLength(2);
    tasks[1]!.open(7);
    await newer;
    tasks[0]!.open(3);
    await older;
    expect(v.pageCount).toBe(7);
    expect(tasks[0]!.destroy).toHaveBeenCalled();
    expect(tasks[1]!.destroy).not.toHaveBeenCalled();
  });

  it("drops a document still loading when the viewer closes", async () => {
    const v = await viewer();
    const opening = v.load("a.pdf");
    await settle();
    await v.close();
    tasks[0]!.open(4);
    await opening;
    expect(v.isLoaded()).toBe(false);
    expect(v.pageCount).toBe(0);
    expect(tasks[0]!.destroy).toHaveBeenCalled();
  });
});
