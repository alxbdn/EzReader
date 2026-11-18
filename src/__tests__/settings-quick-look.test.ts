// @vitest-environment jsdom
import indexHtml from "../../index.html?raw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandError } from "../errors";

vi.hoisted(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

const bridge = vi.hoisted(() => ({
  quickLookState: vi.fn(),
  setQuickLook: vi.fn(),
  checkPdfAssociation: vi.fn(async () => false),
  registerPdfHandler: vi.fn(),
  unregisterPdfHandler: vi.fn(),
  registerPrintVerb: vi.fn(),
  openDefaultAppsSettings: vi.fn(),
}));

vi.mock("../tauri-bridge", () => bridge);

import { SettingsModal } from "../settings";

function mount(): SettingsModal {
  const html = indexHtml;
  const start = html.indexOf('<div id="settings-modal"');
  const end = html.indexOf('<div id="toast"');
  document.body.innerHTML = html.slice(start, end);
  return new SettingsModal();
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe("quick look setting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("stays hidden where the helper is not installed", async () => {
    bridge.quickLookState.mockResolvedValue({ available: false, enabled: false });
    mount().open();
    await flush();
    expect(document.getElementById("settings-quick-look-section")!.classList.contains("hidden")).toBe(true);
  });

  it("shows the current state and turns it on", async () => {
    bridge.quickLookState.mockResolvedValue({ available: true, enabled: false });
    bridge.setQuickLook.mockResolvedValue(undefined);
    mount().open();
    await flush();
    const section = document.getElementById("settings-quick-look-section")!;
    const box = document.getElementById("settings-quick-look") as HTMLInputElement;
    expect(section.classList.contains("hidden")).toBe(false);
    expect(box.checked).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await flush();
    expect(bridge.setQuickLook).toHaveBeenCalledWith(true);
    expect(box.checked).toBe(true);
  });

  it("goes back and explains when Windows blocks the startup helper", async () => {
    bridge.quickLookState.mockResolvedValue({ available: true, enabled: false });
    bridge.setQuickLook.mockRejectedValue(new CommandError("other", "startup-blocked"));
    mount().open();
    await flush();
    const box = document.getElementById("settings-quick-look") as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await flush();
    expect(box.checked).toBe(false);
    expect(document.getElementById("settings-quick-look-hint")!.textContent).toContain("Task Manager");
  });
});
