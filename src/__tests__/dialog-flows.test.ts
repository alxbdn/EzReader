import { describe, expect, it, vi } from "vitest";
import { setUpCompress } from "../compress-flow";
import { setUpExport } from "../export-flow";
import { createMessages } from "../messages";
import { CommandError } from "../errors";
import type { CompressModal } from "../compress-modal";
import type { ExportModal, ExportRequest } from "../export-modal";
import type { CompressLevel } from "../tauri-bridge";
import { fakeBackend, fakeFeedback } from "./fake-backend";

const messages = createMessages(() => "en");

function fakeSession(over: Partial<{ isOpen: boolean; sourcePath: string | null; saveTarget: string | null }> = {}) {
  return {
    isOpen: true,
    sourcePath: "/docs/report.pdf",
    saveTarget: "/docs/report.pdf",
    ...over,
    materialize: vi.fn(async (opts?: { annotations?: boolean }) => (opts?.annotations === false ? "/tmp/bare.pdf" : "/tmp/current.pdf")),
  };
}

// ── Compress ──────────────────────────────────────────────────────────────────

function compressModal(wontShrink = false) {
  let confirm: ((level: CompressLevel, target?: number) => Promise<void>) | null = null;
  const modal = {
    isOpen: false,
    onConfirm: (cb: typeof confirm) => { confirm = cb; },
    wontShrink: () => wontShrink,
    open: vi.fn(),
    setEstimate: vi.fn(),
    setProgress: vi.fn(),
    startRunning: vi.fn(),
    finishRunning: vi.fn(),
    size: (n: number) => `${n} B`,
  };
  return { modal: modal as unknown as CompressModal & typeof modal, confirm: (l: CompressLevel, t?: number) => confirm!(l, t) };
}

describe("Compress flow", () => {
  it("estimates the shown document, then compresses it where the user saves", async () => {
    const { backend } = fakeBackend();
    const { ui, toasts } = fakeFeedback();
    const session = fakeSession();
    const { modal, confirm } = compressModal();
    const open = setUpCompress({ session, modal, refuse: () => false, messages, ui, backend });

    await open();
    expect(backend.estimateCompression).toHaveBeenCalledWith("/tmp/current.pdf");
    expect(modal.setEstimate).toHaveBeenCalled();

    await confirm("balanced");
    expect(backend.savePdfDialog).toHaveBeenCalledWith("/docs/report.pdf");
    expect(backend.compress).toHaveBeenCalledWith("/tmp/current.pdf", "/out/saved.pdf", "balanced", undefined);
    expect(modal.finishRunning).toHaveBeenCalled();
    expect(toasts).toEqual([{ text: messages.msg("msgCompressed", { from: "2.0", to: "1.0", pct: 50 }), isError: false }]);
  });

  it("does not open on a protected document", async () => {
    const { backend } = fakeBackend();
    const { modal } = compressModal();
    const open = setUpCompress({ session: fakeSession(), modal, refuse: () => true, messages, ui: fakeFeedback().ui, backend });
    await open();
    expect(modal.open).not.toHaveBeenCalled();
    expect(backend.estimateCompression).not.toHaveBeenCalled();
  });

  it("asks first when compressing would not shrink the file, and stops on no", async () => {
    const { backend } = fakeBackend();
    const { ui } = fakeFeedback(false);
    const { modal, confirm } = compressModal(true);
    setUpCompress({ session: fakeSession(), modal, refuse: () => false, messages, ui, backend });
    await confirm("lossless");
    expect(ui.ask).toHaveBeenCalled();
    expect(backend.compress).not.toHaveBeenCalled();
  });

  it("says when it was cancelled", async () => {
    const { backend } = fakeBackend();
    vi.mocked(backend.compress).mockRejectedValueOnce(new CommandError("cancelled", "cancelled"));
    const { ui, toasts } = fakeFeedback();
    const { modal, confirm } = compressModal();
    setUpCompress({ session: fakeSession(), modal, refuse: () => false, messages, ui, backend });
    await confirm("maximum");
    expect(toasts).toEqual([{ text: messages.msg("msgCompressCancelled"), isError: false }]);
  });
});

// ── Export ────────────────────────────────────────────────────────────────────

function exportModal() {
  let run: ((req: ExportRequest) => void) | null = null;
  const modal = {
    onPickImages: vi.fn(),
    onExport: (cb: typeof run) => { run = cb; },
    open: vi.fn(),
  };
  return { modal: modal as unknown as ExportModal & typeof modal, run: (req: ExportRequest) => run!(req) };
}

const viewer = {
  isLoaded: () => true,
  pageCount: 3,
  renderFilePages: vi.fn(async (_path: string, pages: number[], _dpi: number, _type: string, write: (d: string) => Promise<void>) => {
    for (const n of pages) await write(`data-${n}`);
  }),
};

/** Lets the flow's fire-and-forget run finish. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("Export flow", () => {
  it("names exports after the pending rename, else the file", () => {
    const { backend } = fakeBackend();
    const { modal } = exportModal();
    let rename: string | null = null;
    const flow = setUpExport({ session: fakeSession(), viewer, modal, pendingRename: () => rename, messages, ui: fakeFeedback().ui, backend });
    expect(flow.docStem()).toBe("report");
    rename = "Q3 summary.pdf";
    expect(flow.docStem()).toBe("Q3 summary");
  });

  it("writes a flattened PDF of the chosen pages, with or without annotations", async () => {
    const { backend } = fakeBackend();
    const { ui, toasts } = fakeFeedback();
    const session = fakeSession();
    const { modal, run } = exportModal();
    setUpExport({ session, viewer, modal, pendingRename: () => null, messages, ui, backend });
    run({ kind: "pages", format: "pdf", pages: [1, 3], dpi: 150, annotations: false });
    await settle();
    expect(session.materialize).toHaveBeenCalledWith({ annotations: false });
    expect(backend.exportFlattenedPages).toHaveBeenCalledWith("/tmp/bare.pdf", "/out/saved.pdf", [1, 3]);
    expect(toasts.map((t) => t.text)).toEqual([messages.msg("msgPdfSaved")]);
  });

  it("writes one picture per page, and asks before overwriting", async () => {
    const { backend, written } = fakeBackend({ existing: ["/out/report-p02.png"] });
    const { ui } = fakeFeedback(true);
    const { modal, run } = exportModal();
    setUpExport({ session: fakeSession(), viewer, modal, pendingRename: () => null, messages, ui, backend });
    run({ kind: "pages", format: "png", pages: [1, 2], dpi: 96, annotations: true });
    await settle();
    expect(ui.ask).toHaveBeenCalledTimes(1);
    expect([...written.entries()]).toEqual([["/out/report-p01.png", "data-1"], ["/out/report-p02.png", "data-2"]]);
  });

  it("does not convert a document without text", async () => {
    const { backend } = fakeBackend();
    const { ui, toasts } = fakeFeedback();
    const { modal, run } = exportModal();
    setUpExport({ session: fakeSession(), viewer, modal, pendingRename: () => null, messages, ui, backend });
    run({ kind: "pages", format: "docx", pages: [1], dpi: 96, annotations: true });
    await settle();
    expect(backend.extractText).toHaveBeenCalledWith("/tmp/bare.pdf", [1], "report");
    expect(backend.convertText).not.toHaveBeenCalled();
    expect(toasts).toEqual([{ text: messages.msg("msgNoTextFound"), isError: true }]);
  });

  it("turns pictures into a new PDF", async () => {
    const { backend } = fakeBackend();
    const { ui } = fakeFeedback();
    const { modal, run } = exportModal();
    setUpExport({ session: fakeSession(), viewer, modal, pendingRename: () => null, messages, ui, backend });
    run({ kind: "images", paths: ["/pics/scan.jpg"] });
    await settle();
    expect(backend.savePdfDialog).toHaveBeenCalledWith("scan.pdf");
    expect(backend.imagesToPdf).toHaveBeenCalledWith(["/pics/scan.jpg"], "/out/saved.pdf");
  });
});
