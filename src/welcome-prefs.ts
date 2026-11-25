import { ICON_CHECK, ICON_CHEVRON_DOWN } from "./icons";
import { flagMarkup } from "./flags";
import { LANGUAGES } from "./languages";
import type { Translations } from "./i18n";

export interface WelcomePrefsDeps {
  language(): string;
  setLanguage(code: string): void;
  t(): Translations;
  isDefault(): Promise<boolean>;
  setDefault(on: boolean): Promise<void>;
  quickLook?(): Promise<{ available: boolean; enabled: boolean }>;
  setQuickLook?(on: boolean): Promise<void>;
}

class PrefToggle {
  readonly el: HTMLButtonElement;
  private on = false;
  private busy = false;

  constructor(
    private readonly read: () => Promise<boolean | null>,
    private readonly write: (on: boolean) => Promise<void>,
  ) {
    this.el = document.createElement("button");
    this.el.type = "button";
    this.el.className = "welcome-default";
    this.el.setAttribute("role", "checkbox");
    this.el.setAttribute("aria-checked", "false");
    this.el.hidden = true;
    this.el.innerHTML = `<span class="welcome-default-box" aria-hidden="true">${ICON_CHECK}</span><span class="welcome-default-label"></span>`;
    this.el.addEventListener("click", () => void this.toggle());
  }

  label(text: string, hint: string): void {
    this.el.querySelector(".welcome-default-label")!.textContent = text;
    this.el.title = hint;
  }

  async refresh(): Promise<void> {
    try {
      const on = await this.read();
      if (on === null) {
        this.el.hidden = true;
        return;
      }
      this.on = on;
      this.el.classList.toggle("on", on);
      this.el.setAttribute("aria-checked", String(on));
      this.el.hidden = false;
    } catch {
      this.el.hidden = true;
    }
  }

  private async toggle(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.el.disabled = true;
    try {
      await this.write(!this.on);
    } catch {
    } finally {
      this.busy = false;
      this.el.disabled = false;
      await this.refresh();
    }
  }
}

export function menuLanguages(): { code: string; native: string }[] {
  const first = ["en", "fr"];
  const head = first.map((c) => LANGUAGES.find((l) => l.code === c)!).filter(Boolean);
  const rest = LANGUAGES.filter((l) => !first.includes(l.code));
  return [...head, ...rest].map(({ code, native }) => ({ code, native }));
}

export class WelcomePrefs {
  readonly root: HTMLElement;
  private readonly check: PrefToggle;
  private readonly quick: PrefToggle | null;
  private readonly langBtn: HTMLButtonElement;
  private readonly menu: HTMLElement;

  constructor(host: HTMLElement, private readonly deps: WelcomePrefsDeps) {
    this.root = document.createElement("div");
    this.root.className = "welcome-footer";

    this.check = new PrefToggle(() => deps.isDefault(), (on) => deps.setDefault(on));
    const { quickLook, setQuickLook } = deps;
    this.quick = quickLook && setQuickLook
      ? new PrefToggle(async () => {
          const s = await quickLook();
          return s.available ? s.enabled : null;
        }, (on) => setQuickLook(on))
      : null;
    this.quick?.el.classList.add("welcome-quick-look");

    const wrap = document.createElement("div");
    wrap.className = "lang-picker";

    this.langBtn = document.createElement("button");
    this.langBtn.type = "button";
    this.langBtn.className = "lang-btn";
    this.langBtn.setAttribute("aria-haspopup", "menu");
    this.langBtn.setAttribute("aria-expanded", "false");
    this.langBtn.addEventListener("click", () => this.toggleMenu());

    this.menu = document.createElement("div");
    this.menu.className = "lang-menu hidden";
    this.menu.setAttribute("role", "menu");
    this.menu.addEventListener("keydown", (e) => this.onMenuKey(e));

    wrap.append(this.langBtn, this.menu);
    const toggles = document.createElement("div");
    toggles.className = "welcome-toggles";
    toggles.append(this.check.el, ...(this.quick ? [this.quick.el] : []));
    this.root.append(toggles, wrap);
    host.appendChild(this.root);

    document.addEventListener("pointerdown", (e) => {
      if (!this.menu.classList.contains("hidden") && !wrap.contains(e.target as Node)) this.closeMenu(false);
    });

    this.render();
  }

  render(): void {
    const t = this.deps.t();
    const lang = this.deps.language();
    const current = LANGUAGES.find((l) => l.code === lang) ?? LANGUAGES[0]!;

    this.check.label(t.welcomeDefaultReader ?? "Default PDF reader", t.welcomeDefaultReaderHint ?? "Open PDF files with EzReader");
    this.quick?.label(
      t.welcomeQuickLook ?? "Quick look",
      t.settingsQuickLookHint ?? "Select a PDF in File Explorer and press Space to preview it.",
    );

    this.langBtn.innerHTML =
      `${flagMarkup(current.code)}<span class="lang-btn-name">${escapeHtml(current.native)}</span>` +
      `<span class="lang-btn-chevron">${ICON_CHEVRON_DOWN}</span>`;
    this.langBtn.title = t.settingsLanguage;
    this.langBtn.setAttribute("aria-label", `${t.settingsLanguage}: ${current.native}`);

    this.menu.innerHTML = "";
    menuLanguages().forEach((l, i) => {
      if (i === 2) {
        const sep = document.createElement("div");
        sep.className = "lang-menu-sep";
        sep.setAttribute("role", "separator");
        this.menu.appendChild(sep);
      }
      const item = document.createElement("button");
      item.type = "button";
      item.className = "lang-menu-item";
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-checked", String(l.code === lang));
      item.dataset["lang"] = l.code;
      item.innerHTML =
        `${flagMarkup(l.code)}<span class="lang-menu-name">${escapeHtml(l.native)}</span>` +
        (l.code === lang ? `<span class="lang-menu-tick">${ICON_CHECK}</span>` : "");
      item.addEventListener("click", () => this.pick(l.code));
      this.menu.appendChild(item);
    });
  }

  async refresh(): Promise<void> {
    await Promise.all([this.check.refresh(), this.quick?.refresh()]);
  }

  private toggleMenu(): void {
    if (this.menu.classList.contains("hidden")) this.openMenu();
    else this.closeMenu(true);
  }

  private openMenu(): void {
    this.menu.classList.remove("hidden");
    this.langBtn.classList.add("open");
    this.langBtn.setAttribute("aria-expanded", "true");
    const current = this.menu.querySelector<HTMLElement>('[aria-checked="true"]') ?? this.items()[0];
    current?.scrollIntoView?.({ block: "nearest" });
    current?.focus();
  }

  private closeMenu(focusButton: boolean): void {
    this.menu.classList.add("hidden");
    this.langBtn.classList.remove("open");
    this.langBtn.setAttribute("aria-expanded", "false");
    if (focusButton) this.langBtn.focus();
  }

  private items(): HTMLElement[] {
    return Array.from(this.menu.querySelectorAll<HTMLElement>(".lang-menu-item"));
  }

  private onMenuKey(e: KeyboardEvent): void {
    const items = this.items();
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      this.closeMenu(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
      items[next]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      items[e.key === "Home" ? 0 : items.length - 1]?.focus();
    }
  }

  private pick(code: string): void {
    this.closeMenu(true);
    if (code !== this.deps.language()) this.deps.setLanguage(code);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
