// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Toolbar, type ToolbarEvent } from "../toolbar";

function mount(): { toolbar: Toolbar; events: ToolbarEvent[]; refused: ReturnType<typeof vi.fn> } {
  document.body.innerHTML = `<div id="menubar-row"></div><div id="context-toolbar"></div>`;
  const toolbar = new Toolbar();
  const events: ToolbarEvent[] = [];
  toolbar.on((e) => events.push(e));
  const refused = vi.fn();
  toolbar.onReadOnlyRefused(refused);
  return { toolbar, events, refused };
}

function button(selector: string): HTMLButtonElement {
  const b = document.querySelector<HTMLButtonElement>(selector);
  if (!b) throw new Error(`no ${selector}`);
  return b;
}

describe("toolbar on a protected document", () => {
  beforeEach(() => { document.body.className = ""; });

  it("refuses Annotate and Edit, stays in Read mode and says why", () => {
    const { toolbar, events, refused } = mount();
    toolbar.setReadOnly(true);
    button('.mode-btn[data-mode="annotate"]').click();
    button('.mode-btn[data-mode="edit"]').click();
    expect(toolbar.currentMode).toBe("read");
    expect(refused).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === "mode-change")).toBe(false);
    expect(document.body.classList.contains("read-only")).toBe(true);
  });

  it("drops back to Read mode when the document becomes protected", () => {
    const { toolbar, events } = mount();
    button('.mode-btn[data-mode="annotate"]').click();
    expect(toolbar.currentMode).toBe("annotate");
    toolbar.setReadOnly(true);
    expect(toolbar.currentMode).toBe("read");
    expect(events.at(-1)).toEqual({ type: "mode-change", mode: "read" });
  });

  it("lets everything through again once the password is removed", () => {
    const { toolbar, refused } = mount();
    toolbar.setReadOnly(true);
    toolbar.setReadOnly(false);
    button('.mode-btn[data-mode="annotate"]').click();
    expect(toolbar.currentMode).toBe("annotate");
    expect(refused).not.toHaveBeenCalled();
    expect(document.body.classList.contains("read-only")).toBe(false);
  });
});
