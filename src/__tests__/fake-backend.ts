import { vi } from "vitest";
import type { Backend, Feedback } from "../backend";
import type { TextDoc } from "../text-layout";

/** An in-memory Backend: every dialog answers what `answers` says, every command is a spy. */
export function fakeBackend(answers: { savePath?: string | null; dir?: string | null; existing?: string[] } = {}) {
  const written = new Map<string, string>();
  const backend: Backend = {
    savePdfDialog: vi.fn(async () => (answers.savePath === undefined ? "/out/saved.pdf" : answers.savePath)),
    saveAsDialog: vi.fn(async (suggested: string) => (answers.savePath === undefined ? `/out/${suggested}` : answers.savePath)),
    pickDirectory: vi.fn(async () => (answers.dir === undefined ? "/out" : answers.dir)),
    pickImages: vi.fn(async () => ["/pics/a.png"]),
    existingFiles: vi.fn(async (paths: string[]) => paths.filter((p) => answers.existing?.includes(p))),
    writeImageFile: vi.fn(async (path: string, data: string) => { written.set(path, data); }),
    imagesToPdf: vi.fn(async () => {}),
    exportFlattenedPages: vi.fn(async () => {}),
    extractText: vi.fn(async (): Promise<TextDoc> => ({ title: "t", pages: [] })),
    convertText: vi.fn(async () => {}),
    estimateCompression: vi.fn(async () => ({ originalBytes: 2_097_152, losslessBytes: 2e6, balancedBytes: 1e6, maximumBytes: 5e5 })),
    compress: vi.fn(async () => ({ originalBytes: 2_097_152, compressedBytes: 1_048_576, reachedTarget: true })),
    cancelCompression: vi.fn(async () => {}),
    onCompressProgress: vi.fn(async () => () => {}),
  };
  return { backend, written };
}

/** Feedback that records the toasts and answers every question with `yes`. */
export function fakeFeedback(yes = true) {
  const toasts: { text: string; isError: boolean }[] = [];
  const ui: Feedback = {
    notify: (text, isError = false) => { toasts.push({ text, isError }); },
    ask: vi.fn(async () => yes),
  };
  return { ui, toasts };
}
