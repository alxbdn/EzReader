import { describe, it, expect } from "vitest";
import { blockedWhileProtected } from "../read-only";
import type { ToolbarEvent } from "../toolbar";

describe("blockedWhileProtected", () => {
  it.each<ToolbarEvent>([
    { type: "save" },
    { type: "save-as" },
    { type: "export" },
    { type: "compress" },
    { type: "split" },
    { type: "extract-pages" },
    { type: "insert-pdf" },
    { type: "rotate" },
    { type: "rename", stem: "x" },
    { type: "adjust", kind: "crop" },
    { type: "signature-use", id: "s" },
    { type: "undo" },
    { type: "mode-change", mode: "annotate" },
    { type: "mode-change", mode: "edit" },
    { type: "tool-change", tool: "rect" },
  ])("refuses $type that changes or copies the document", (e) => {
    expect(blockedWhileProtected(e)).toBe(true);
  });

  it.each<ToolbarEvent>([
    { type: "open" },
    { type: "password" },
    { type: "print" },
    { type: "info" },
    { type: "zoom-in" },
    { type: "toggle-sidebar" },
    { type: "settings" },
    { type: "images-to-pdf" },
    { type: "mode-change", mode: "read" },
    { type: "tool-change", tool: "select" },
  ])("allows $type, which only reads", (e) => {
    expect(blockedWhileProtected(e)).toBe(false);
  });
});
