import { describe, expect, it } from "vitest";
import { macShortcuts } from "../platform";
import { accelerator } from "../mac-menu";

describe("macOS shortcuts", () => {
  it("writes shortcuts the Mac way", () => {
    expect(macShortcuts("Undo (Ctrl+Z)")).toBe("Undo (⌘Z)");
    expect(macShortcuts("Redo (Ctrl+Y)")).toBe("Redo (⇧⌘Z)");
    expect(macShortcuts("Save as (Ctrl+Shift+S)")).toBe("Save as (⇧⌘S)");
    expect(macShortcuts("Zoom in (Ctrl++)")).toBe("Zoom in (⌘+)");
    expect(macShortcuts("Select page (Ctrl+click)")).toBe("Select page (⌘-click)");
    expect(macShortcuts("Sélectionner la page (Ctrl+clic)")).toBe("Sélectionner la page (⌘-clic)");
    expect(macShortcuts("No shortcut here")).toBe("No shortcut here");
  });

  it("turns menu shortcuts into native accelerators", () => {
    expect(accelerator("Ctrl+O")).toBe("CmdOrCtrl+O");
    expect(accelerator("Ctrl+Shift+S")).toBe("CmdOrCtrl+Shift+S");
    expect(accelerator("Ctrl++")).toBe("CmdOrCtrl+=");
    expect(accelerator("Ctrl+Y")).toBe("CmdOrCtrl+Shift+Z");
    expect(accelerator("F11")).toBe("Ctrl+Cmd+F");
    expect(accelerator("F5")).toBe("F5");
    expect(accelerator(undefined)).toBeUndefined();
  });
});
