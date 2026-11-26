import type * as Pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

export type PdfjsLib = typeof Pdfjs;

let loading: Promise<PdfjsLib> | null = null;

export function pdfjsLib(): Promise<PdfjsLib> {
  loading ??= import("pdfjs-dist").then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = workerUrl;
    return lib;
  });
  return loading;
}
