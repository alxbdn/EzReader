import type { Backend } from "./backend";
import { extractText } from "./text-extract";
import {
  cancelCompression, compressPdf, convertText, estimateCompression, existingFiles, exportFlattenedPages,
  onCompressProgress, pickDirectoryDialog, saveAsDialog, savePdfDialog, writeImageFile,
} from "./tauri-bridge";

export const tauriBackend: Backend = {
  savePdfDialog,
  saveAsDialog,
  pickDirectory: pickDirectoryDialog,
  existingFiles,
  writeImageFile,
  exportFlattenedPages,
  extractText,
  convertText,
  estimateCompression,
  compress: compressPdf,
  cancelCompression,
  onCompressProgress,
};
