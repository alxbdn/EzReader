import { invoke } from "@tauri-apps/api/core";
import { toCommandError } from "./errors";
import { listen } from "@tauri-apps/api/event";
import type { Mat3, TextRun } from "./page-adjustment";
import type { TextDoc } from "./text-layout";
import type { DocFormat } from "./export-modal";
import type { OcrLanguage, OcrResult } from "./ocr-modal";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toCommandError(e);
  }
}

import type { FormFieldValue, StoredAnnotation } from "./models";

export async function openPdfDialog(): Promise<string | null> {
  return call<string | null>("open_pdf_dialog");
}

export async function openDocumentDialog(): Promise<string | null> {
  return call<string | null>("open_document_dialog");
}

export async function picturesToNewPdf(imagePaths: string[], name: string): Promise<string> {
  return call<string>("pictures_to_new_pdf", { imagePaths, name });
}

export async function savePdfDialog(
  currentPath: string
): Promise<string | null> {
  return call<string | null>("save_pdf_dialog", {
    currentPath,
  });
}

export async function renameFile(from: string, to: string): Promise<void> {
  return call<void>("rename_file", { from, to });
}

export async function listSystemFonts(): Promise<string[]> {
  return call<string[]>("list_system_fonts", {});
}

export async function getPageCount(filePath: string): Promise<number> {
  return call<number>("get_page_count", { filePath });
}

export async function saveAnnotatedPdf(
  inputPath: string,
  outputPath: string,
  annotations: StoredAnnotation[],
  rotationDelta = 0,
  formFields: FormFieldValue[] = [],
): Promise<void> {
  return call<void>("save_annotated_pdf", {
    inputPath,
    outputPath,
    annotations,
    rotationDelta,
    formFields,
  });
}

export async function stripAnnotationStreams(
  inputPath: string,
  outputPath: string,
): Promise<boolean> {
  return call<boolean>("strip_annotation_streams", { inputPath, outputPath });
}

export async function readAnnotations(
  filePath: string
): Promise<StoredAnnotation[]> {
  return call<StoredAnnotation[]>("read_annotations", { filePath });
}

export interface StartupArgs {
  filePath: string | null;
  shouldPrint: boolean;
  unsaved?: boolean;
  savePath?: string | null;
  dirty?: boolean;
  password?: string | null;
  page?: number;
}

export async function openFileInNewWindow(path: string): Promise<void> {
  return call<void>("open_file_in_new_window", { path });
}

export async function getStartupArgs(): Promise<StartupArgs> {
  return call<StartupArgs>("get_startup_args");
}

export async function checkPdfAssociation(): Promise<boolean> {
  return call<boolean>("check_pdf_association");
}

export interface QuickLookState {
  available: boolean;
  enabled: boolean;
}

export async function quickLookState(): Promise<QuickLookState> {
  return call<QuickLookState>("quick_look_state");
}

export async function setQuickLook(enabled: boolean): Promise<void> {
  return call<void>("set_quick_look", { enabled });
}

export async function isDefaultPdfReader(): Promise<boolean> {
  return call<boolean>("is_default_pdf_reader");
}

export async function registerPdfHandler(): Promise<void> {
  return call<void>("register_pdf_handler");
}

export async function unregisterPdfHandler(): Promise<void> {
  return call<void>("unregister_pdf_handler");
}

export async function registerPrintVerb(): Promise<void> {
  return call<void>("register_print_verb");
}

export async function extractPdfPages(
  inputPath: string,
  outputPath: string,
  pages: number[],
): Promise<void> {
  return call<void>("extract_pdf_pages", { inputPath, outputPath, pages });
}

export interface SplitRange {
  start: number;
  end: number;
}

export async function splitPdf(
  inputPath: string,
  outputDir: string,
  baseName: string,
  ranges: SplitRange[],
): Promise<string[]> {
  return call<string[]>("split_pdf", { inputPath, outputDir, baseName, ranges });
}

export async function pickDirectoryDialog(): Promise<string | null> {
  return call<string | null>("pick_directory_dialog");
}

export interface PrinterList {
  printers: string[];
  defaultPrinter: string;
}

export async function listPrinters(): Promise<PrinterList> {
  return call<PrinterList>("list_printers");
}

export async function printPages(
  pagesB64: string[],
  printerName?: string,
  copies?: number,
  orientation?: string,
  fitMode?: string,
): Promise<void> {
  return call<void>("print_pages", {
    pagesB64,
    printerName: printerName ?? null,
    copies: copies ?? null,
    orientation: orientation ?? null,
    fitMode: fitMode ?? null,
  });
}

export async function openDefaultAppsSettings(): Promise<void> {
  return call<void>("open_default_apps_settings");
}

export async function openUrl(url: string): Promise<void> {
  return call<void>("open_url", { url });
}

export type UpdateChannel = "store" | "installer" | "portable" | "deb" | "homebrew" | "dmg" | "other";

export interface UpdateStatus {
  current: string;
  latest: string;
  upToDate: boolean;
  channel: UpdateChannel;
}

export type UpdateOutcome = "restarting" | "opened" | "otherWindows";

export async function checkForUpdate(): Promise<UpdateStatus> {
  return call<UpdateStatus>("check_for_update");
}

export async function installUpdate(): Promise<UpdateOutcome> {
  return call<UpdateOutcome>("install_update");
}

export type PageSlot =
  | { kind: "original"; page: number; rotation: number }
  | { kind: "blank"; width: number; height: number; rotation: number }
  | { kind: "imported"; path: string; page: number; rotation: number }
  | { kind: "image"; data: string; rotation: number };

export async function rearrangePages(
  inputPath: string,
  outputPath: string,
  slots: PageSlot[],
): Promise<void> {
  return call<void>("rearrange_pages", { inputPath, outputPath, slots });
}

export interface CompressResult {
  originalBytes: number;
  compressedBytes: number;
  reachedTarget: boolean;
}

export type CompressLevel = "lossless" | "balanced" | "maximum" | "target";

export async function compressPdf(
  inputPath: string,
  outputPath: string,
  level: CompressLevel,
  targetBytes?: number,
): Promise<CompressResult> {
  return call<CompressResult>("compress_pdf", { inputPath, outputPath, level, targetBytes: targetBytes ?? null });
}

export async function exportFlattenedPages(inputPath: string, outputPath: string, pages: number[]): Promise<void> {
  return call<void>("export_flattened_pages", { inputPath, outputPath, pages });
}

export async function cancelCompression(): Promise<void> {
  return call<void>("cancel_compression");
}

export async function onCompressProgress(cb: (share: number) => void): Promise<() => void> {
  return listen<number>("compress-progress", (e) => cb(e.payload));
}

export interface CompressEstimate {
  originalBytes: number;
  losslessBytes: number;
  balancedBytes: number;
  maximumBytes: number;
}

export async function estimateCompression(inputPath: string): Promise<CompressEstimate> {
  return call<CompressEstimate>("estimate_compression", { inputPath });
}

export interface RedactedPage {
  page: number;
  jpegBase64: string;
  widthPx: number;
  heightPx: number;
  view: [number, number, number, number];
}

export interface StraightenedPage extends RedactedPage {
  map: Mat3;
  text: TextRun[];
}

export async function straightenPages(inputPath: string, outputPath: string, pages: StraightenedPage[]): Promise<void> {
  return call<void>("straighten_pages", { inputPath, outputPath, pages });
}

export async function redactPages(
  inputPath: string,
  outputPath: string,
  pages: RedactedPage[],
): Promise<void> {
  return call<void>("redact_pages", { inputPath, outputPath, pages });
}

export async function openImageDialog(): Promise<string | null> {
  return call<string | null>("open_image_dialog");
}

export async function loadPictureFile(path: string): Promise<{ data: string; width: number; height: number }> {
  return call("load_picture", { path });
}

export interface PageAdjust {
  page: number;
  crop?: [number, number, number, number];
  flipH?: boolean;
  flipV?: boolean;
}

export async function adjustPages(inputPath: string, outputPath: string, pages: PageAdjust[]): Promise<void> {
  return call<void>("adjust_pages", { inputPath, outputPath, pages });
}

export async function encryptPdf(inputPath: string, outputPath: string, password: string): Promise<void> {
  return call<void>("encrypt_pdf", { inputPath, outputPath, password });
}

export async function decryptPdf(inputPath: string, outputPath: string, password: string): Promise<void> {
  return call<void>("decrypt_pdf", { inputPath, outputPath, password });
}

export async function openImagesDialog(): Promise<string[]> {
  return call<string[]>("open_images_dialog");
}

export async function imagesToPdf(imagePaths: string[], outputPath: string): Promise<void> {
  return call<void>("images_to_pdf", { imagePaths, outputPath });
}

export async function tempTag(): Promise<string> {
  return call<string>("temp_tag");
}

export async function existingFiles(paths: string[]): Promise<string[]> {
  return call<string[]>("existing_files", { paths });
}

export async function writeImageFile(path: string, data: string): Promise<void> {
  return call<void>("write_image_file", { path, data });
}

export async function convertText(doc: TextDoc, format: DocFormat, output: string): Promise<void> {
  return call<void>("convert_text", { doc, format, output });
}

export async function saveAsDialog(suggested: string, format: DocFormat): Promise<string | null> {
  return call<string | null>("save_as_dialog", { suggested, format });
}

export async function ocrLanguages(): Promise<OcrLanguage[]> {
  return call<OcrLanguage[]>("ocr_languages");
}

export async function ocrImage(data: string, language: string): Promise<OcrResult> {
  return call<OcrResult>("ocr_image", { data, language: language || null });
}

export async function openPagesInNewWindow(
  inputPath: string, pages: number[], name: string, x: number, y: number,
): Promise<void> {
  return call<void>("open_pages_in_new_window", { inputPath, pages, name, x, y });
}

export async function tabDragHover(x: number, y: number): Promise<boolean> {
  return call<boolean>("tab_drag_hover", { x, y });
}

export async function tabDragEnd(): Promise<void> {
  return call<void>("tab_drag_end");
}

export async function moveTab(
  x: number, y: number, tab: StartupArgs, name: string | null, allowNew: boolean,
): Promise<"merged" | "window" | "stayed"> {
  return call<"merged" | "window" | "stayed">("move_tab", { x, y, tab, name, allowNew });
}

export async function setLauncherRatioLock(locked: boolean): Promise<void> {
  return call<void>("set_launcher_ratio_lock", { locked });
}

export async function setResizeBorder(visible: boolean): Promise<void> {
  return call<void>("set_resize_border", { visible });
}
