import type { ToolbarEvent } from "./toolbar";

const BLOCKED = new Set<ToolbarEvent["type"]>([
  "save", "save-as", "export", "compress", "watermark", "rotate", "rename", "split",
  "insert-blank", "insert-pdf", "insert-image", "insert-image-page", "extract-pages", "adjust", "image-browse",
  "signature", "signature-use", "draft-apply", "style-change", "layer-change",
  "undo", "redo", "duplicate",
]);

export function blockedWhileProtected(e: ToolbarEvent): boolean {
  if (e.type === "mode-change") return e.mode !== "read";
  if (e.type === "tool-change") return e.tool !== "select";
  return BLOCKED.has(e.type);
}
