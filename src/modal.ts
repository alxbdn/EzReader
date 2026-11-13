import type { Translations } from "./i18n";

export type Key = keyof Translations;

/**
 * A dialog built in code: title, body, Cancel and a main button. Escape or
 * a click outside closes it. Texts are registered once and follow the
 * interface language.
 */
export class Modal {
  readonly backdrop: HTMLElement;
  readonly box: HTMLElement;
  readonly head: HTMLElement;
  readonly body: HTMLElement;
  readonly footer: HTMLElement;
  readonly cancelBtn: HTMLButtonElement;
  readonly okBtn: HTMLButtonElement;
  protected t: Translations = {} as Translations;
  private texts: [HTMLElement, Key, string][] = [];
  private titles: [HTMLElement, Key, string][] = [];
  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); this.close(); }
  };

  constructor(cls: string, titleKey: Key, titleFb: string, okKey: Key, okFb: string, icon = "") {
    this.backdrop = document.createElement("div");
    this.backdrop.className = "modal-backdrop hidden";
    this.box = document.createElement("div");
    this.box.className = `modal-box ez-modal ${cls}`;
    this.box.setAttribute("role", "dialog");
    this.box.setAttribute("aria-modal", "true");

    this.head = document.createElement("div");
    this.head.className = "modal-header";
    const title = document.createElement("span");
    title.className = "ez-modal-title";
    if (icon) {
      const ic = document.createElement("span");
      ic.className = "ez-modal-icon";
      ic.innerHTML = icon;
      title.append(ic);
    }
    const label = document.createElement("span");
    this.text(label, titleKey, titleFb);
    title.append(label);
    const x = document.createElement("button");
    x.type = "button";
    x.className = "icon-btn";
    x.textContent = "✕";
    this.title(x, "dlgClose", "Close");
    x.addEventListener("click", () => this.close());
    this.head.append(title, x);

    this.body = document.createElement("div");
    this.body.className = "ez-modal-body";

    this.footer = document.createElement("div");
    this.footer.className = "modal-footer";
    this.cancelBtn = document.createElement("button");
    this.cancelBtn.type = "button";
    this.cancelBtn.className = "btn";
    this.text(this.cancelBtn, "dlgCancel", "Cancel");
    this.cancelBtn.addEventListener("click", () => this.close());
    this.okBtn = document.createElement("button");
    this.okBtn.type = "button";
    this.okBtn.className = "btn btn-primary";
    this.text(this.okBtn, okKey, okFb);
    this.footer.append(this.cancelBtn, this.okBtn);

    this.box.append(this.head, this.body, this.footer);
    this.backdrop.append(this.box);
    this.backdrop.addEventListener("mousedown", (e) => { if (e.target === this.backdrop) this.close(); });
    document.body.append(this.backdrop);
  }

  get isOpen(): boolean { return !this.backdrop.classList.contains("hidden"); }

  protected show(): void {
    this.backdrop.classList.remove("hidden");
    window.addEventListener("keydown", this.onKey, true);
  }

  close(): void {
    this.backdrop.classList.add("hidden");
    window.removeEventListener("keydown", this.onKey, true);
  }

  applyTranslations(t: Translations): void {
    this.t = t;
    for (const [el, key, fb] of this.texts) el.textContent = this.tr(key, fb);
    for (const [el, key, fb] of this.titles) { el.title = this.tr(key, fb); el.setAttribute("aria-label", el.title); }
    this.refresh();
  }

  /** Redraws what depends on the state (and the language). */
  protected refresh(): void {}

  protected tr(key: Key, fb: string): string {
    const v = this.t[key];
    return typeof v === "string" ? v : fb;
  }

  protected text(el: HTMLElement, key: Key, fb: string): HTMLElement {
    el.textContent = fb;
    this.texts.push([el, key, fb]);
    return el;
  }

  protected title(el: HTMLElement, key: Key, fb: string): void {
    el.title = fb;
    el.setAttribute("aria-label", fb);
    this.titles.push([el, key, fb]);
  }

  protected el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", key?: Key, fb = ""): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (key) this.text(e, key, fb);
    return e;
  }

  /** A selectable card: bold label, small line under it, optional right part. */
  protected card(labelKey: Key, labelFb: string, subKey: Key | null, subFb: string, onPick: () => void): HTMLButtonElement {
    const b = this.el("button", "ez-card");
    b.type = "button";
    const main = this.el("span", "ez-card-main");
    main.append(this.el("b", "ez-card-label", labelKey, labelFb));
    if (subKey) main.append(this.el("span", "ez-card-sub", subKey, subFb));
    b.append(main);
    b.addEventListener("click", onPick);
    return b;
  }

  /** A checkbox row with a label and a line under it. */
  protected check(labelKey: Key, labelFb: string, subKey: Key, subFb: string): { row: HTMLLabelElement; input: HTMLInputElement } {
    const row = this.el("label", "ez-check");
    const input = this.el("input");
    input.type = "checkbox";
    const txt = this.el("span", "ez-check-text");
    txt.append(this.el("span", "", labelKey, labelFb), this.el("span", "ez-card-sub", subKey, subFb));
    row.append(input, txt);
    return { row, input };
  }
}
