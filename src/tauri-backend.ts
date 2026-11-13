import type { Backend } from "./backend";
import { extractText } from "./text-extract";
import {
  cancelCompression, compressPdf, convertText, estimateCompression, existingFiles, exportFlattenedPages,
  imagesToPdf, onCompressProgress, openImagesDialog, pickDirectoryDialog, saveAsDialog, savePdfDialog, writeImageFile,
} from "./tauri-bridge";

/** The app's `Backend`: Tauri commands and dialogs, and pdf.js for text. */
export const tauriBackend: Backend = {
  savePdfDialog,
  saveAsDialog,
  pickDirectory: pickDirectoryDialog,
  pickImages: openImagesDialog,
  existingFiles,
  writeImageFile,
  imagesToPdf,
  exportFlattenedPages,
  extractText,
  convertText,
  estimateCompression,
  compress: compressPdf,
  cancelCompression,
  onCompressProgress,
};
