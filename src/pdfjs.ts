import type * as Pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

export type PdfjsLib = typeof Pdfjs;

let loading: Promise<PdfjsLib> | null = null;

/**
 * pdf.js, loaded on first use. It is a third of the app's code and the welcome screen needs
 * none of it, so it stays out of the bundle that has to run before the window shows anything.
 */
export function pdfjsLib(): Promise<PdfjsLib> {
  loading ??= import("pdfjs-dist").then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = workerUrl;
    return lib;
  });
  return loading;
}
