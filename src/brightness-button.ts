import { ICON_SUN } from "./icons";

/** Lowest page brightness offered, in percent. */
export const MIN_BRIGHTNESS = 40;

/**
 * The toolbar's page brightness button: a click opens a slider under it.
 * Moving the slider reports each value (`onInput`); letting go reports the
 * one to keep (`onCommit`). The button is highlighted while pages are dimmed.
 */
export class BrightnessButton {
  readonly el: HTMLElement;
  readonly button: HTMLButtonElement;
  private readonly pop: HTMLElement;
  private readonly range: HTMLInputElement;
  private readonly label: HTMLElement;
  private inputHandlers: ((v: number) => void)[] = [];
  private commitHandlers: ((v: number) => void)[] = [];

  constructor(value = 100) {
    this.el = document.createElement("div");
    this.el.className = "brightness-wrap";

    this.button = document.createElement("button");
    this.button.className = "icon-btn";
    this.button.innerHTML = ICON_SUN;
    this.button.title = "Page brightness";
    this.button.setAttribute("aria-haspopup", "true");
    this.button.setAttribute("aria-expanded", "false");

    this.pop = document.createElement("div");
    this.pop.className = "brightness-pop";
    this.range = document.createElement("input");
    this.range.type = "range";
    this.range.className = "settings-range";
    this.range.min = String(MIN_BRIGHTNESS);
    this.range.max = "100";
    this.range.step = "1";
    this.label = document.createElement("span");
    this.label.className = "brightness-val";
    this.pop.append(this.range, this.label);
    this.el.append(this.button, this.pop);

    this.button.addEventListener("click", () => this.toggle());
    this.range.addEventListener("input", () => {
      this.show(Number(this.range.value));
      this.inputHandlers.forEach((h) => h(this.value));
    });
    this.range.addEventListener("change", () => this.commitHandlers.forEach((h) => h(this.value)));
    // Double-click the percentage: back to full brightness.
    this.label.addEventListener("dblclick", () => {
      this.value = 100;
      this.inputHandlers.forEach((h) => h(100));
      this.commitHandlers.forEach((h) => h(100));
    });
    document.addEventListener("mousedown", (e) => {
      if (this.isOpen && !this.el.contains(e.target as Node)) this.close();
    }, true);
    document.addEventListener("keydown", (e) => {
      if (this.isOpen && e.key === "Escape") { this.close(); this.button.focus(); }
    });

    this.value = value;
  }

  get value(): number {
    return Number(this.range.value);
  }

  set value(v: number) {
    const c = Number.isFinite(v) ? Math.min(100, Math.max(MIN_BRIGHTNESS, v)) : 100;
    this.range.value = String(c);
    this.show(Number(this.range.value));
  }

  get isOpen(): boolean {
    return this.pop.classList.contains("open");
  }

  /** Sets the tooltip (translated). */
  setTitle(title: string): void {
    this.button.title = title;
    this.range.setAttribute("aria-label", title);
  }

  onInput(h: (v: number) => void): void { this.inputHandlers.push(h); }
  onCommit(h: (v: number) => void): void { this.commitHandlers.push(h); }

  toggle(): void {
    if (this.isOpen) this.close(); else this.open();
  }

  open(): void {
    this.pop.classList.add("open");
    this.button.setAttribute("aria-expanded", "true");
    this.range.focus();
  }

  close(): void {
    this.pop.classList.remove("open");
    this.button.setAttribute("aria-expanded", "false");
  }

  private show(v: number): void {
    this.label.textContent = `${v} %`;
    this.button.classList.toggle("active", v < 100);
  }
}
