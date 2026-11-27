// @vitest-environment jsdom
import indexHtml from "../../index.html?raw";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

vi.mock("../tauri-bridge", () => ({
  quickLookState: vi.fn(async () => ({ available: false, enabled: false })),
  setQuickLook: vi.fn(),
  checkPdfAssociation: vi.fn(async () => false),
  registerPdfHandler: vi.fn(),
  unregisterPdfHandler: vi.fn(),
  registerPrintVerb: vi.fn(),
  openDefaultAppsSettings: vi.fn(),
}));

import { SettingsModal, loadSettings } from "../settings";

function mount(): SettingsModal {
  const start = indexHtml.indexOf('<div id="settings-modal"');
  const end = indexHtml.indexOf('<div id="toast"');
  document.body.innerHTML = `<div id="viewer-scroll"></div>${indexHtml.slice(start, end)}`;
  return new SettingsModal();
}

const viewer = () => document.getElementById("viewer-scroll")!;
const box = () => document.getElementById("settings-spellcheck") as HTMLInputElement;

describe("spell checking setting", () => {
  beforeEach(() => localStorage.clear());

  it("keeps the interface out of spell checking", () => {
    expect(indexHtml).toContain('<html lang="en" spellcheck="false">');
  });

  it("checks what is typed on the pages by default", () => {
    mount();
    expect(box().checked).toBe(true);
    expect(viewer().spellcheck).toBe(true);
  });

  it("turns off and remembers the choice", () => {
    mount();
    box().checked = false;
    box().dispatchEvent(new Event("change"));
    expect(viewer().spellcheck).toBe(false);
    expect(loadSettings().spellcheck).toBe(false);
    mount();
    expect(box().checked).toBe(false);
    expect(viewer().spellcheck).toBe(false);
  });
});
