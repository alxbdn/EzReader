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
}

export function menuLanguages(): { code: string; native: string }[] {
  const first = ["en", "fr"];
  const head = first.map((c) => LANGUAGES.find((l) => l.code === c)!).filter(Boolean);
  const rest = LANGUAGES.filter((l) => !first.includes(l.code));
  return [...head, ...rest].map(({ code, native }) => ({ code, native }));
}

export class WelcomePrefs {
  readonly root: HTMLElement;
  private readonly check: HTMLButtonElement;
  private readonly langBtn: HTMLButtonElement;
  private readonly menu: HTMLElement;
  private isDefault = false;
  private busy = false;

  constructor(host: HTMLElement, private readonly deps: WelcomePrefsDeps) {
    this.root = document.createElement("div");
    this.root.className = "welcome-footer";

    this.check = document.createElement("button");
    this.check.type = "button";
    this.check.className = "welcome-default";
    this.check.setAttribute("role", "checkbox");
    this.check.setAttribute("aria-checked", "false");
    this.check.hidden = true;
    this.check.innerHTML = `<span class="welcome-default-box" aria-hidden="true">${ICON_CHECK}</span><span class="welcome-default-label"></span>`;
    this.check.addEventListener("click", () => void this.toggleDefault());

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
    this.root.append(this.check, wrap);
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

    const label = this.check.querySelector(".welcome-default-label")!;
    label.textContent = t.welcomeDefaultReader ?? "Default PDF reader";
    this.check.title = t.welcomeDefaultReaderHint ?? "Open PDF files with EzReader";

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
    try {
      this.setChecked(await this.deps.isDefault());
      this.check.hidden = false;
    } catch {
      this.check.hidden = true;
    }
  }

  private setChecked(on: boolean): void {
    this.isDefault = on;
    this.check.classList.toggle("on", on);
    this.check.setAttribute("aria-checked", String(on));
  }

  private async toggleDefault(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.check.disabled = true;
    try {
      await this.deps.setDefault(!this.isDefault);
    } catch {
    } finally {
      this.busy = false;
      this.check.disabled = false;
      await this.refresh();
    }
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
