import {
  checkPdfAssociation,
  registerPdfHandler,
  unregisterPdfHandler,
  registerPrintVerb,
  openDefaultAppsSettings,
} from "./tauri-bridge";
import { getTranslations } from "./i18n";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ThemePref = "system" | "light" | "dark";

export interface AppSettings {
  language: string; // BCP-47 code, e.g. "fr"
  theme: ThemePref;
  /** Zoom applied when a document opens and by the reset-zoom button:
   *  a percentage ("100"), "fit-width" or "fit-page". */
  defaultZoom: string;
  /** CSS pixels per real inch on this screen, used by the 1:1 zoom. */
  pxPerInch: number;
}

export const ZOOM_CHOICES = ["fit-width", "fit-page", "50", "75", "100", "125", "150", "200"] as const;

// ── Persistence ───────────────────────────────────────────────────────────────

const STORAGE_KEY = "pdf-rider-settings";
const DEFAULTS: AppSettings = { language: "en", theme: "system", defaultZoom: "100", pxPerInch: 96 };

const CARD_W_MM = 85.6;
const CARD_H_MM = 53.98;

// ── Theme ─────────────────────────────────────────────────────────────────────

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

/** Sets the resolved theme ("light" or "dark") on <html data-theme>. */
export function applyTheme(pref: ThemePref): void {
  const dark = pref === "dark" || (pref === "system" && darkQuery.matches);
  document.documentElement.dataset["theme"] = dark ? "dark" : "light";
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    // ignore parse errors
  }
  return { ...DEFAULTS };
}

function saveSettings(s: AppSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

// ── Language list (20 most spoken) ────────────────────────────────────────────

export const LANGUAGES: { code: string; native: string; label: string }[] = [
  { code: "en", native: "English",          label: "English" },
  { code: "zh", native: "中文",              label: "Mandarin Chinese" },
  { code: "hi", native: "हिन्दी",             label: "Hindi" },
  { code: "es", native: "Español",          label: "Spanish" },
  { code: "fr", native: "Français",         label: "French" },
  { code: "ar", native: "العربية",           label: "Arabic" },
  { code: "bn", native: "বাংলা",              label: "Bengali" },
  { code: "ru", native: "Русский",           label: "Russian" },
  { code: "pt", native: "Português",        label: "Portuguese" },
  { code: "ur", native: "اردو",              label: "Urdu" },
  { code: "id", native: "Bahasa Indonesia", label: "Indonesian" },
  { code: "de", native: "Deutsch",          label: "German" },
  { code: "ja", native: "日本語",             label: "Japanese" },
  { code: "sw", native: "Kiswahili",        label: "Swahili" },
  { code: "mr", native: "मराठी",              label: "Marathi" },
  { code: "te", native: "తెలుగు",             label: "Telugu" },
  { code: "tr", native: "Türkçe",           label: "Turkish" },
  { code: "ta", native: "தமிழ்",              label: "Tamil" },
  { code: "vi", native: "Tiếng Việt",       label: "Vietnamese" },
  { code: "ko", native: "한국어",             label: "Korean" },
];

// ── Modal ─────────────────────────────────────────────────────────────────────

export class SettingsModal {
  private backdrop: HTMLElement;
  private settings: AppSettings;
  private changeHandlers: Array<(s: AppSettings) => void> = [];

  constructor() {
    this.settings = loadSettings();
    applyTheme(this.settings.theme);
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
  }
  close(): void { this.backdrop.classList.add("hidden"); }

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
      // Use translated strings if available, else fall back to English
      const translations = getTranslations(lang);
      if (isSet) {
        btn.textContent = translations.settingsRemoveDefault ?? "Remove as default";
        btn.dataset["state"] = "remove";
      } else {
        btn.textContent = translations.settingsSetDefault ?? "Set as default PDF viewer";
        btn.dataset["state"] = "set";
      }
    } catch {
      // Not running in Tauri (browser preview)
      btn.style.display = "none";
    }
  }

  private bind(): void {
    document.getElementById("settings-close-btn")!
      .addEventListener("click", () => this.close());

    // Close on backdrop click
    this.backdrop.addEventListener("click", (e) => {
      if (e.target === this.backdrop) this.close();
    });

    // Language selector
    const langSelect = document.getElementById("settings-lang") as HTMLSelectElement;
    langSelect.value = this.settings.language;
    langSelect.addEventListener("change", () => {
      this.set("language", langSelect.value);
    });

    // Theme selector
    const themeSelect = document.getElementById("settings-theme") as HTMLSelectElement;
    themeSelect.value = this.settings.theme;
    themeSelect.addEventListener("change", () => {
      const theme = themeSelect.value as ThemePref;
      applyTheme(theme);
      this.set("theme", theme);
    });

    // Default zoom
    const zoomSelect = document.getElementById("settings-zoom") as HTMLSelectElement;
    zoomSelect.value = (ZOOM_CHOICES as readonly string[]).includes(this.settings.defaultZoom)
      ? this.settings.defaultZoom : DEFAULTS.defaultZoom;
    zoomSelect.addEventListener("change", () => this.set("defaultZoom", zoomSelect.value));

    // Actual-size calibration: the card outline follows the slider live.
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

    // Default app button
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
      // ignore errors silently
    } finally {
      btn.disabled = false;
    }
  }
}
