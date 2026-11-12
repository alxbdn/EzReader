import type { Translations } from "./i18n";
import { ICON_SEARCH_MIRRORED, ICON_CHEVRON_UP, ICON_CHEVRON_DOWN, ICON_X_CIRCLE } from "./icons";

const SEARCH_DEBOUNCE_MS = 250;

/**
 * Search field of the main toolbar: a round magnifier that widens into a
 * pill holding the query, the "n / total" counter, previous / next chevrons
 * and a clear button. Escape (or leaving it empty) folds it back.
 */
export class SearchPill {
  readonly el: HTMLElement;
  private input: HTMLInputElement;
  private status: HTMLElement;
  private toggleBtn: HTMLButtonElement;
  private prevBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private clearBtn: HTMLButtonElement;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private searchHandlers: ((query: string) => void)[] = [];
  private stepHandlers: ((dir: 1 | -1) => void)[] = [];

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "search-pill";

    this.toggleBtn = this.button("search-pill-toggle", ICON_SEARCH_MIRRORED);
    this.toggleBtn.addEventListener("click", () => {
      if (this.isOpen && !this.input.value) this.close();
      else this.open();
    });

    this.input = document.createElement("input");
    this.input.className = "search-pill-input";
    this.input.type = "text";
    this.input.spellcheck = false;
    this.input.autocomplete = "off";
    this.input.tabIndex = -1;
    this.input.addEventListener("input", () => this.schedule());
    this.input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        // A search still waiting to run jumps to its first match by itself.
        if (this.timer) this.flush();
        else this.step(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });
    this.input.addEventListener("blur", () => {
      // Fold back when left empty (but not when focus moves to its own buttons).
      setTimeout(() => {
        if (!this.input.value && !this.el.contains(document.activeElement)) this.close();
      }, 0);
    });

    this.status = document.createElement("span");
    this.status.className = "search-pill-status";

    this.prevBtn = this.button("search-pill-step", ICON_CHEVRON_UP);
    this.prevBtn.addEventListener("click", () => this.step(-1));
    this.nextBtn = this.button("search-pill-step", ICON_CHEVRON_DOWN);
    this.nextBtn.addEventListener("click", () => this.step(1));
    this.clearBtn = this.button("search-pill-clear", ICON_X_CIRCLE);
    this.clearBtn.addEventListener("click", () => {
      this.input.value = "";
      this.flush();
      this.input.focus();
    });

    const body = document.createElement("div");
    body.className = "search-pill-body";
    body.append(this.input, this.status, this.prevBtn, this.nextBtn, this.clearBtn);
    this.el.append(this.toggleBtn, body);
    this.applyTranslations({} as Translations);
  }

  get isOpen(): boolean { return this.el.classList.contains("open"); }
  get query(): string { return this.input.value.trim(); }

  onSearch(cb: (query: string) => void): void { this.searchHandlers.push(cb); }
  onStep(cb: (dir: 1 | -1) => void): void { this.stepHandlers.push(cb); }

  open(): void {
    this.el.classList.add("open");
    this.input.tabIndex = 0;
    this.input.focus();
    this.input.select();
  }

  /** Folds the pill and clears the search. */
  close(): void {
    const had = this.input.value !== "";
    this.input.value = "";
    if (had || this.timer) this.flush();
    this.el.classList.remove("open");
    this.input.tabIndex = -1;
    if (this.el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }

  /** "3 / 12", "No results", a progress percentage, or nothing. */
  setStatus(text: string, empty = false): void {
    this.status.textContent = text;
    this.status.classList.toggle("empty", empty);
    this.el.classList.toggle("has-query", this.input.value !== "");
  }

  applyTranslations(t: Translations): void {
    this.toggleBtn.title = t.ttSearch ?? "Search (Ctrl+F)";
    this.input.placeholder = t.sbSearchPlaceholder ?? "Search in the document…";
    this.prevBtn.title = t.sbSearchPrev ?? "Previous match (Shift+Enter)";
    this.nextBtn.title = t.sbSearchNext ?? "Next match (Enter)";
    this.clearBtn.title = t.ttSearchClear ?? "Clear the search";
    for (const b of [this.toggleBtn, this.prevBtn, this.nextBtn, this.clearBtn]) b.setAttribute("aria-label", b.title);
    this.input.setAttribute("aria-label", this.input.placeholder);
  }

  private button(cls: string, icon: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.innerHTML = icon;
    return b;
  }

  private step(dir: 1 | -1): void {
    if (!this.query) return;
    for (const cb of this.stepHandlers) cb(dir);
  }

  private schedule(): void {
    this.el.classList.toggle("has-query", this.input.value !== "");
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SEARCH_DEBOUNCE_MS);
  }

  private flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.el.classList.toggle("has-query", this.input.value !== "");
    const q = this.query;
    for (const cb of this.searchHandlers) cb(q);
  }
}
