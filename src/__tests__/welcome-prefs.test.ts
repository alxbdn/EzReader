// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WelcomePrefs, menuLanguages, type WelcomePrefsDeps } from "../welcome-prefs";
import { flagFor } from "../flags";
import { getTranslations } from "../i18n";
import { LANGUAGES } from "../languages";

function setUp(over: Partial<WelcomePrefsDeps> = {}) {
  document.body.innerHTML = `<div id="welcome-screen"></div>`;
  let lang = "fr";
  let isDefault = false;
  const deps: WelcomePrefsDeps = {
    language: () => lang,
    setLanguage: vi.fn((c: string) => { lang = c; }),
    t: () => getTranslations(lang),
    isDefault: vi.fn(async () => isDefault),
    setDefault: vi.fn(async (on: boolean) => { isDefault = on; }),
    ...over,
  };
  const prefs = new WelcomePrefs(document.getElementById("welcome-screen")!, deps);
  const check = () => document.querySelector<HTMLButtonElement>(".welcome-default")!;
  const langBtn = () => document.querySelector<HTMLButtonElement>(".lang-btn")!;
  const menu = () => document.querySelector<HTMLElement>(".lang-menu")!;
  return { prefs, deps, check, langBtn, menu };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("language picker", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("shows the current language with its flag", () => {
    const { langBtn } = setUp();
    expect(langBtn().textContent).toContain("Français");
    expect(langBtn().querySelector(".lang-flag svg")).not.toBeNull();
  });

  it("lists English and French first, then every other language once", () => {
    const codes = menuLanguages().map((l) => l.code);
    expect(codes.slice(0, 2)).toEqual(["en", "fr"]);
    expect([...codes].sort()).toEqual(LANGUAGES.map((l) => l.code).sort());
  });

  it("opens, ticks the current language and applies a new one", () => {
    const { langBtn, menu, deps, prefs } = setUp();
    expect(menu().classList.contains("hidden")).toBe(true);
    langBtn().click();
    expect(menu().classList.contains("hidden")).toBe(false);
    expect(langBtn().getAttribute("aria-expanded")).toBe("true");
    const ticked = menu().querySelector('[aria-checked="true"]') as HTMLElement;
    expect(ticked.dataset["lang"]).toBe("fr");

    (menu().querySelector('[data-lang="en"]') as HTMLElement).click();
    expect(deps.setLanguage).toHaveBeenCalledWith("en");
    expect(menu().classList.contains("hidden")).toBe(true);
    prefs.render();
    expect(langBtn().textContent).toContain("English");
  });

  it("closes on Escape without changing anything", () => {
    const { langBtn, menu, deps } = setUp();
    langBtn().click();
    menu().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu().classList.contains("hidden")).toBe(true);
    expect(document.activeElement).toBe(langBtn());
    expect(deps.setLanguage).not.toHaveBeenCalled();
  });

  it("gives Arabic and Swahili a globe instead of a flag", () => {
    expect(flagFor("ar")).toBeNull();
    expect(flagFor("sw")).toBeNull();
    expect(flagFor("fr")).not.toBeNull();
  });
});

describe("default reader checkbox", () => {
  it("is labelled in the current language", () => {
    const { check } = setUp();
    expect(check().textContent).toContain("Lecteur PDF par défaut");
  });

  it("stays hidden outside the app", async () => {
    const { prefs, check } = setUp({ isDefault: async () => { throw new Error("no tauri"); } });
    await prefs.refresh();
    expect(check().hidden).toBe(true);
  });

  it("shows the state, and asks to become the default when clicked", async () => {
    const { prefs, check, deps } = setUp();
    await prefs.refresh();
    expect(check().hidden).toBe(false);
    expect(check().getAttribute("aria-checked")).toBe("false");

    check().click();
    await flush();
    expect(deps.setDefault).toHaveBeenCalledWith(true);
    expect(check().getAttribute("aria-checked")).toBe("true");
    expect(check().classList.contains("on")).toBe(true);
  });

  it("shows what the system says even if the user backed out", async () => {
    const { prefs, check } = setUp({ setDefault: async () => { /* user closed Windows settings */ } });
    await prefs.refresh();
    check().click();
    await flush();
    expect(check().getAttribute("aria-checked")).toBe("false");
  });
});
