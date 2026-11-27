import {
  checkPdfAssociation,
  registerPdfHandler,
  unregisterPdfHandler,
  registerPrintVerb,
  openDefaultAppsSettings,
  quickLookState,
  setQuickLook,
} from "./tauri-bridge";
import { getTranslations } from "./i18n";
import { LANGUAGES } from "./languages";

export type ThemePref = "system" | "light" | "dark";

export interface AppSettings {
  language: string;
  theme: ThemePref;
  defaultZoom: string;
  pxPerInch: number;
  pageBrightness: number;
  outlineExpanded: boolean;
  spellcheck: boolean;
}

export const ZOOM_CHOICES = ["fit-width", "fit-page", "50", "75", "100", "125", "150", "200"] as const;

const STORAGE_KEY = "pdf-rider-settings";
const DEFAULTS: AppSettings = { language: "en", theme: "system", defaultZoom: "100", pxPerInch: 96, pageBrightness: 100, outlineExpanded: false, spellcheck: true };

const CARD_W_MM = 85.6;
const CARD_H_MM = 53.98;

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

export function applyPageBrightness(pct: number): void {
  const v = Number.isFinite(pct) ? Math.min(100, Math.max(40, pct)) : 100;
  document.documentElement.style.setProperty("--page-brightness", String(v / 100));
  document.documentElement.classList.toggle("dim-pages", v < 100);
}

export function applySpellcheck(enabled: boolean): void {
  const writingArea = document.getElementById("viewer-scroll");
  if (writingArea) writingArea.spellcheck = enabled !== false;
}

export function applyTheme(pref: ThemePref): void {
  const dark = pref === "dark" || (pref === "system" && darkQuery.matches);
  document.documentElement.dataset["theme"] = dark ? "dark" : "light";
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
  }
  return { ...DEFAULTS };
}

function saveSettings(s: AppSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

export { LANGUAGES } from "./languages";

export class SettingsModal {
  private backdrop: HTMLElement;
  private settings: AppSettings;
  private changeHandlers: Array<(s: AppSettings) => void> = [];

  constructor() {
    this.settings = loadSettings();
    applyTheme(this.settings.theme);
    applyPageBrightness(this.settings.pageBrightness);
    applySpellcheck(this.settings.spellcheck);
    darkQuery.addEventListener("change", () => applyTheme(this.settings.theme));
    this.backdrop = document.getElementById("settings-modal")!;
    this.populateLangSelect();
    this.bind();
  }

  getSettings(): AppSettings {
    return { ...this.settings };
  }

  onChange(cb: (s: AppSettings) => void): void {
    this.changeHandlers.push(cb);
  }

  open(): void {
    this.backdrop.classList.remove("hidden");
    void this.refreshDefaultBtn();
    void this.refreshQuickLook();
  }
  close(): void { this.backdrop.classList.add("hidden"); }

  setLanguage(code: string): void {
    const sel = document.getElementById("settings-lang") as HTMLSelectElement | null;
    if (sel) sel.value = code;
    if (code !== this.settings.language) this.set("language", code);
  }

  setTheme(theme: ThemePref): void {
    const sel = document.getElementById("settings-theme") as HTMLSelectElement | null;
    if (sel) sel.value = theme;
    applyTheme(theme);
    if (theme !== this.settings.theme) this.set("theme", theme);
  }

  setPageBrightness(pct: number): void {
    this.showBrightness(pct);
    if (pct !== this.settings.pageBrightness) this.set("pageBrightness", pct);
  }

  private showBrightness(pct: number): void {
    const input = document.getElementById("settings-brightness") as HTMLInputElement | null;
    const label = document.getElementById("settings-brightness-val");
    if (input) input.value = String(pct);
    if (label) label.textContent = `${pct} %`;
    applyPageBrightness(pct);
  }

  private set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    this.settings[key] = value;
    saveSettings(this.settings);
    this.changeHandlers.forEach(h => h({ ...this.settings }));
  }

  private populateLangSelect(): void {
    const sel = document.getElementById("settings-lang") as HTMLSelectElement;
    for (const lang of LANGUAGES) {
      const opt = document.createElement("option");
      opt.value = lang.code;
      opt.textContent = lang.native === lang.label ? lang.native : `${lang.native} — ${lang.label}`;
      sel.appendChild(opt);
    }
  }

  private async refreshDefaultBtn(): Promise<void> {
    const btn = document.getElementById("settings-default-btn") as HTMLButtonElement;
    if (!btn) return;
    try {
      const isSet = await checkPdfAssociation();
      const t = this.getSettings();
      const lang = t.language;
      const translations = getTranslations(lang);
      if (isSet) {
        btn.textContent = translations.settingsRemoveDefault ?? "Remove as default";
        btn.dataset["state"] = "remove";
      } else {
        btn.textContent = translations.settingsSetDefault ?? "Set as default PDF viewer";
        btn.dataset["state"] = "set";
      }
    } catch {
      btn.style.display = "none";
    }
  }

  private async refreshQuickLook(): Promise<void> {
    const section = document.getElementById("settings-quick-look-section");
    const box = document.getElementById("settings-quick-look") as HTMLInputElement | null;
    if (!section || !box) return;
    try {
      const state = await quickLookState();
      section.classList.toggle("hidden", !state.available);
      box.checked = state.enabled;
    } catch {
      section.classList.add("hidden");
    }
  }

  private async handleQuickLook(box: HTMLInputElement): Promise<void> {
    const hint = document.getElementById("settings-quick-look-hint");
    const t = getTranslations(this.settings.language);
    box.disabled = true;
    try {
      await setQuickLook(box.checked);
      if (hint) hint.textContent = t.settingsQuickLookHint ?? hint.textContent;
    } catch (e) {
      box.checked = !box.checked;
      const blocked = e instanceof Error && e.message === "startup-blocked";
      if (hint && blocked) hint.textContent = t.settingsQuickLookBlocked ?? hint.textContent;
    } finally {
      box.disabled = false;
    }
  }

  private bind(): void {
    document.getElementById("settings-close-btn")!
      .addEventListener("click", () => this.close());

    this.backdrop.addEventListener("click", (e) => {
      if (e.target === this.backdrop) this.close();
    });

    const langSelect = document.getElementById("settings-lang") as HTMLSelectElement;
    langSelect.value = this.settings.language;
    langSelect.addEventListener("change", () => {
      this.set("language", langSelect.value);
    });

    const themeSelect = document.getElementById("settings-theme") as HTMLSelectElement;
    themeSelect.value = this.settings.theme;
    themeSelect.addEventListener("change", () => {
      const theme = themeSelect.value as ThemePref;
      applyTheme(theme);
      this.set("theme", theme);
    });

    const zoomSelect = document.getElementById("settings-zoom") as HTMLSelectElement;
    zoomSelect.value = (ZOOM_CHOICES as readonly string[]).includes(this.settings.defaultZoom)
      ? this.settings.defaultZoom : DEFAULTS.defaultZoom;
    zoomSelect.addEventListener("change", () => this.set("defaultZoom", zoomSelect.value));

    const ppiInput = document.getElementById("settings-ppi") as HTMLInputElement;
    const card = document.getElementById("settings-calib-card") as HTMLElement;
    const drawCard = (ppi: number) => {
      card.style.width  = `${(CARD_W_MM / 25.4) * ppi}px`;
      card.style.height = `${(CARD_H_MM / 25.4) * ppi}px`;
    };
    const ppi0 = Number.isFinite(this.settings.pxPerInch) ? this.settings.pxPerInch : DEFAULTS.pxPerInch;
    ppiInput.value = String(ppi0);
    drawCard(ppi0);
    ppiInput.addEventListener("input", () => drawCard(parseFloat(ppiInput.value)));
    ppiInput.addEventListener("change", () => this.set("pxPerInch", parseFloat(ppiInput.value)));

    const brightInput = document.getElementById("settings-brightness") as HTMLInputElement | null;
    if (brightInput) {
      this.showBrightness(this.settings.pageBrightness);
      brightInput.addEventListener("input", () => this.showBrightness(Number(brightInput.value)));
      brightInput.addEventListener("change", () => this.set("pageBrightness", Number(brightInput.value)));
    }

    const outlineBox = document.getElementById("settings-outline-expanded") as HTMLInputElement | null;
    if (outlineBox) {
      outlineBox.checked = this.settings.outlineExpanded;
      outlineBox.addEventListener("change", () => this.set("outlineExpanded", outlineBox.checked));
    }

    const spellBox = document.getElementById("settings-spellcheck") as HTMLInputElement | null;
    if (spellBox) {
      spellBox.checked = this.settings.spellcheck !== false;
      spellBox.addEventListener("change", () => {
        applySpellcheck(spellBox.checked);
        this.set("spellcheck", spellBox.checked);
      });
    }

    const quickLook = document.getElementById("settings-quick-look") as HTMLInputElement | null;
    quickLook?.addEventListener("change", () => void this.handleQuickLook(quickLook));

    const defaultBtn = document.getElementById("settings-default-btn") as HTMLButtonElement;
    defaultBtn?.addEventListener("click", () => void this.handleDefaultBtn());
  }

  private async handleDefaultBtn(): Promise<void> {
    const btn = document.getElementById("settings-default-btn") as HTMLButtonElement;
    btn.disabled = true;
    try {
      if (btn.dataset["state"] === "set") {
        await registerPdfHandler();
        await registerPrintVerb();
        void openDefaultAppsSettings();
      } else {
        await unregisterPdfHandler();
      }
      await this.refreshDefaultBtn();
    } catch {
    } finally {
      btn.disabled = false;
    }
  }
}
