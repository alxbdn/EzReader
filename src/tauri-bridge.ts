import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FormFieldValue, StoredAnnotation } from "./models";

/** Opens a file-picker dialog filtered to PDF files. Returns the path or null. */
export async function openPdfDialog(): Promise<string | null> {
  return invoke<string | null>("open_pdf_dialog");
}

/** Opens a Save As dialog. Returns the chosen path or null. */
export async function savePdfDialog(
  currentPath: string
): Promise<string | null> {
  return invoke<string | null>("save_pdf_dialog", {
    currentPath,
  });
}

/**
 * Renames a file in place. Rejects with "exists" when another file already
 * has that name, or "invalid" for an unusable name.
 */
export async function renameFile(from: string, to: string): Promise<void> {
  return invoke<void>("rename_file", { from, to });
}

/** Returns the number of pages in the PDF at `filePath`. */
export async function getPageCount(filePath: string): Promise<number> {
  return invoke<number>("get_page_count", { filePath });
}

/**
 * Stores `annotations` as JSON metadata in the PDF at `inputPath` and saves
 * the result to `outputPath`. Annotations are NOT burned into the content
 * stream, so they remain fully editable when the file is reopened.
 */
export async function saveAnnotatedPdf(
  inputPath: string,
  outputPath: string,
  annotations: StoredAnnotation[],
  rotationDelta = 0,
  formFields: FormFieldValue[] = [],
): Promise<void> {
  return invoke<void>("save_annotated_pdf", {
    inputPath,
    outputPath,
    annotations,
    rotationDelta,
    formFields,
  });
}

/** Creates a copy of the PDF with annotation content streams emptied (display use).
 *  CCAnnot metadata is preserved. Returns true if streams were found and cleared. */
export async function stripAnnotationStreams(
  inputPath: string,
  outputPath: string,
): Promise<boolean> {
  return invoke<boolean>("strip_annotation_streams", { inputPath, outputPath });
}

/**
 * Reads editable annotations stored in the PDF's CCAnnot catalog entry.
 * Returns an empty array if the file has no stored annotations.
 */
export async function readAnnotations(
  filePath: string
): Promise<StoredAnnotation[]> {
  return invoke<StoredAnnotation[]>("read_annotations", { filePath });
}

export interface StartupArgs {
  filePath: string | null;
  shouldPrint: boolean;
  /** A temp copy never saved (pages dragged out to this window). */
  unsaved?: boolean;
}

/** Returns the CLI arguments parsed at startup (file path and print flag). */
export async function getStartupArgs(): Promise<StartupArgs> {
  return invoke<StartupArgs>("get_startup_args");
}

/** Returns true if our ProgID is already registered in HKCU. */
export async function checkPdfAssociation(): Promise<boolean> {
  return invoke<boolean>("check_pdf_association");
}

/** Writes ProgID and .pdf association into HKCU (no admin required). */
export async function registerPdfHandler(): Promise<void> {
  return invoke<void>("register_pdf_handler");
}

/** Removes all HKCU registry entries created by registerPdfHandler. */
export async function unregisterPdfHandler(): Promise<void> {
  return invoke<void>("unregister_pdf_handler");
}

/** Registers the print verb under both ProgIDs. */
export async function registerPrintVerb(): Promise<void> {
  return invoke<void>("register_print_verb");
}

/** Extracts selected pages from a PDF into a new file, preserving vector text. */
export async function extractPdfPages(
  inputPath: string,
  outputPath: string,
  pages: number[],
): Promise<void> {
  return invoke<void>("extract_pdf_pages", { inputPath, outputPath, pages });
}

export interface SplitRange {
  /** 1-based inclusive */
  start: number;
  /** 1-based inclusive */
  end: number;
}

/** Splits a PDF into one output file per range. Returns the list of created paths. */
export async function splitPdf(
  inputPath: string,
  outputDir: string,
  baseName: string,
  ranges: SplitRange[],
): Promise<string[]> {
  return invoke<string[]>("split_pdf", { inputPath, outputDir, baseName, ranges });
}

/** Opens a folder-picker dialog. Returns the chosen path or null. */
export async function pickDirectoryDialog(): Promise<string | null> {
  return invoke<string | null>("pick_directory_dialog");
}

export interface PrinterList {
  printers: string[];
  defaultPrinter: string;
}

/** Returns the list of available printers and the default printer name. */
export async function listPrinters(): Promise<PrinterList> {
  return invoke<PrinterList>("list_printers");
}

/** Sends pre-rendered page images (base64 JPEG) to a printer. */
export async function printPages(
  pagesB64: string[],
  printerName?: string,
  copies?: number,
  orientation?: string,
  fitMode?: string,
): Promise<void> {
  return invoke<void>("print_pages", {
    pagesB64,
    printerName: printerName ?? null,
    copies: copies ?? null,
    orientation: orientation ?? null,
    fitMode: fitMode ?? null,
  });
}

/** Opens Windows Settings → Default Apps. */
export async function openDefaultAppsSettings(): Promise<void> {
  return invoke<void>("open_default_apps_settings");
}

/** Opens an http/https URL in the system default browser. */
export async function openUrl(url: string): Promise<void> {
  return invoke<void>("open_url", { url });
}

/** One page of the document built by `rearrangePages`, in output order. */
export type PageSlot =
  | { kind: "original"; page: number; rotation: number }
  | { kind: "blank"; width: number; height: number; rotation: number }
  | { kind: "imported"; path: string; page: number; rotation: number }
  | { kind: "image"; data: string; rotation: number };

/**
 * Writes `inputPath` with its pages replaced by `slots` (reordered, rotated,
 * deleted, blank or taken from other PDFs) to `outputPath`, as an
 * incremental update.
 */
export async function rearrangePages(
  inputPath: string,
  outputPath: string,
  slots: PageSlot[],
): Promise<void> {
  return invoke<void>("rearrange_pages", { inputPath, outputPath, slots });
}

export interface CompressResult {
  originalBytes: number;
  compressedBytes: number;
  /** False when a target size could not be reached (the smallest result was written). */
  reachedTarget: boolean;
}

export type CompressLevel = "lossless" | "balanced" | "maximum" | "target";

/**
 * Compresses `inputPath` into `outputPath`: "lossless" recompresses streams,
 * "balanced" / "maximum" also re-encode pictures (150 dpi JPEG 75 / 96 dpi
 * JPEG 55), "target" keeps the best quality that fits in `targetBytes`.
 */
export async function compressPdf(
  inputPath: string,
  outputPath: string,
  level: CompressLevel,
  targetBytes?: number,
): Promise<CompressResult> {
  return invoke<CompressResult>("compress_pdf", { inputPath, outputPath, level, targetBytes: targetBytes ?? null });
}

/**
 * Writes `pages` (1-based) of `inputPath` to `outputPath` as a flattened
 * copy: annotations and form fields are drawn into the pages and nothing
 * stays editable (links excepted).
 */
export async function exportFlattenedPages(inputPath: string, outputPath: string, pages: number[]): Promise<void> {
  return invoke<void>("export_flattened_pages", { inputPath, outputPath, pages });
}

/** Stops the compression in progress: `compressPdf` then fails with "cancelled". */
export async function cancelCompression(): Promise<void> {
  return invoke<void>("cancel_compression");
}

/** Calls `cb` with the share of the running compression done (0 to 1). */
export async function onCompressProgress(cb: (share: number) => void): Promise<() => void> {
  return listen<number>("compress-progress", (e) => cb(e.payload));
}

export interface CompressEstimate {
  originalBytes: number;
  losslessBytes: number;
  balancedBytes: number;
  maximumBytes: number;
}

/** Sizes the three levels would give, computed without writing anything. */
export async function estimateCompression(inputPath: string): Promise<CompressEstimate> {
  return invoke<CompressEstimate>("estimate_compression", { inputPath });
}

/** A page rendered with its redacted areas blacked out, ready to replace the original. */
export interface RedactedPage {
  /** 1-based page number. */
  page: number;
  /** Base64 JPEG of the page's visible area (pdf.js `page.view`), unrotated. */
  jpegBase64: string;
  widthPx: number;
  heightPx: number;
  /** The area the image covers, in PDF user space: [x0, y0, x1, y1]. */
  view: [number, number, number, number];
}

/**
 * Replaces each page's content with its image and rewrites the whole file
 * so the original content (text, images, links, form fields) of those pages
 * is gone, not just hidden.
 */
export async function redactPages(
  inputPath: string,
  outputPath: string,
  pages: RedactedPage[],
): Promise<void> {
  return invoke<void>("redact_pages", { inputPath, outputPath, pages });
}

/** Opens a file picker for pictures; null if cancelled. */
export async function openImageDialog(): Promise<string | null> {
  return invoke<string | null>("open_image_dialog");
}

/** The bytes of the picture at `path`, as base64. */
export async function readImageFile(path: string): Promise<string> {
  return invoke<string>("read_image_file", { path });
}

/** How one page is cropped and flipped (see `adjust_pages`). */
export interface PageAdjust {
  /** 1-based page number. */
  page: number;
  /** Visible area kept, in PDF user space: [x0, y0, x1, y1]. */
  crop?: [number, number, number, number];
  flipH?: boolean;
  flipV?: boolean;
}

/** Crops and flips pages, as an incremental update (the content stays vector). */
export async function adjustPages(inputPath: string, outputPath: string, pages: PageAdjust[]): Promise<void> {
  return invoke<void>("adjust_pages", { inputPath, outputPath, pages });
}

/** Writes `inputPath` to `outputPath` protected by `password` (AES-256). */
export async function encryptPdf(inputPath: string, outputPath: string, password: string): Promise<void> {
  return invoke<void>("encrypt_pdf", { inputPath, outputPath, password });
}

/** Writes `inputPath` to `outputPath` without its password; rejects with "wrong password". */
export async function decryptPdf(inputPath: string, outputPath: string, password: string): Promise<void> {
  return invoke<void>("decrypt_pdf", { inputPath, outputPath, password });
}

/** Opens a file picker for several pictures; empty if cancelled. */
export async function openImagesDialog(): Promise<string[]> {
  return invoke<string[]>("open_images_dialog");
}

/** Makes a PDF with one page per picture. */
export async function imagesToPdf(imagePaths: string[], outputPath: string): Promise<void> {
  return invoke<void>("images_to_pdf", { imagePaths, outputPath });
}

/** Which of `paths` already exist. */
export async function existingFiles(paths: string[]): Promise<string[]> {
  return invoke<string[]>("existing_files", { paths });
}

/** Writes a PNG or JPEG picture (base64, or a data: URL) to `path`. */
export async function writeImageFile(path: string, data: string): Promise<void> {
  return invoke<void>("write_image_file", { path, data });
}

/** Opens `pages` of `inputPath` as a new document `name` in a new window near the screen point. */
export async function openPagesInNewWindow(
  inputPath: string, pages: number[], name: string, x: number, y: number,
): Promise<void> {
  return invoke<void>("open_pages_in_new_window", { inputPath, pages, name, x, y });
}
