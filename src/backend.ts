import type { DocFormat } from "./export-modal";
import type { TextDoc } from "./text-layout";
import type { CompressEstimate, CompressLevel, CompressResult } from "./tauri-bridge";

export interface Backend {
  savePdfDialog(suggested: string): Promise<string | null>;
  saveAsDialog(suggested: string, format: DocFormat): Promise<string | null>;
  pickDirectory(): Promise<string | null>;
  pickImages(): Promise<string[]>;

  existingFiles(paths: string[]): Promise<string[]>;
  writeImageFile(path: string, data: string): Promise<void>;

  imagesToPdf(paths: string[], output: string): Promise<void>;
  exportFlattenedPages(input: string, output: string, pages: number[]): Promise<void>;
  extractText(path: string, pages: number[], title: string): Promise<TextDoc>;
  convertText(doc: TextDoc, format: DocFormat, output: string): Promise<void>;
  estimateCompression(input: string): Promise<CompressEstimate>;
  compress(input: string, output: string, level: CompressLevel, targetBytes?: number): Promise<CompressResult>;
  cancelCompression(): Promise<void>;
  onCompressProgress(cb: (share: number) => void): Promise<() => void>;
}

export interface Feedback {
  notify(text: string, isError?: boolean): void;
  ask(text: string, title?: string): Promise<boolean>;
}
