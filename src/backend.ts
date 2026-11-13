import type { DocFormat } from "./export-modal";
import type { TextDoc } from "./text-layout";
import type { CompressEstimate, CompressLevel, CompressResult } from "./tauri-bridge";

/**
 * What the dialog flows (Export, Compress) need from outside the page: file
 * dialogs and the PDF commands of the Rust side. The app passes
 * `tauriBackend()`; tests pass an in-memory fake.
 */
export interface Backend {
  // ── Dialogs ──
  savePdfDialog(suggested: string): Promise<string | null>;
  saveAsDialog(suggested: string, format: DocFormat): Promise<string | null>;
  pickDirectory(): Promise<string | null>;
  pickImages(): Promise<string[]>;

  // ── Files ──
  existingFiles(paths: string[]): Promise<string[]>;
  writeImageFile(path: string, data: string): Promise<void>;

  // ── PDF commands ──
  imagesToPdf(paths: string[], output: string): Promise<void>;
  exportFlattenedPages(input: string, output: string, pages: number[]): Promise<void>;
  extractText(path: string, pages: number[], title: string): Promise<TextDoc>;
  convertText(doc: TextDoc, format: DocFormat, output: string): Promise<void>;
  estimateCompression(input: string): Promise<CompressEstimate>;
  compress(input: string, output: string, level: CompressLevel, targetBytes?: number): Promise<CompressResult>;
  cancelCompression(): Promise<void>;
  onCompressProgress(cb: (share: number) => void): Promise<() => void>;
}

/** How a flow talks to the user: toasts and yes / no questions. */
export interface Feedback {
  notify(text: string, isError?: boolean): void;
  ask(text: string, title?: string): Promise<boolean>;
}
