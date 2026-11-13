import type { ToolbarEvent } from "./toolbar";

/**
 * A password-protected document is read-only: it can be read, searched,
 * zoomed and printed, but nothing may change it or write a copy of it until
 * its password is removed. A copy written from it (export, compress, extract,
 * split, a new window) would leave the file without its protection.
 */
const BLOCKED = new Set<ToolbarEvent["type"]>([
  "save", "save-as", "export", "compress", "rotate", "rename", "split",
  "insert-blank", "insert-pdf", "extract-pages", "adjust", "image-browse",
  "signature", "signature-use", "draft-apply", "style-change", "layer-change",
  "undo", "redo",
]);

/** True when `e` must be refused while the open document is protected. */
export function blockedWhileProtected(e: ToolbarEvent): boolean {
  if (e.type === "mode-change") return e.mode !== "read";
  if (e.type === "tool-change") return e.tool !== "select";
  return BLOCKED.has(e.type);
}
