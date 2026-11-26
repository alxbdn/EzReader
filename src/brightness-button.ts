import { brightnessIcon } from "./icons";

/** Which of the three lit levels the icon shows for a brightness. */
export function brightnessLevel(v: number): 1 | 2 | 3 {
  return v >= 85 ? 3 : v >= 60 ? 2 : 1;
}

export const MIN_BRIGHTNESS = 40;

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
    this.button.innerHTML = brightnessIcon(3);
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

    // A mouse click leaves the focus on the button, so no focus ring flashes
    // around the slider; the keyboard (detail 0) moves it to the slider.
    this.button.addEventListener("click", (e) => this.toggle(e.detail === 0));
    this.range.addEventListener("input", () => {
      this.show(Number(this.range.value));
      this.inputHandlers.forEach((h) => h(this.value));
    });
    this.range.addEventListener("change", () => this.commitHandlers.forEach((h) => h(this.value)));
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

  setTitle(title: string): void {
    this.button.title = title;
    this.range.setAttribute("aria-label", title);
  }

  onInput(h: (v: number) => void): void { this.inputHandlers.push(h); }
  onCommit(h: (v: number) => void): void { this.commitHandlers.push(h); }

  toggle(focusSlider = true): void {
    if (this.isOpen) this.close(); else this.open(focusSlider);
  }

  open(focusSlider = true): void {
    this.pop.classList.add("open");
    this.button.setAttribute("aria-expanded", "true");
    if (focusSlider) this.range.focus();
  }

  close(): void {
    this.pop.classList.remove("open");
    this.button.setAttribute("aria-expanded", "false");
  }

  private show(v: number): void {
    this.label.textContent = `${v} %`;
    const level = brightnessLevel(v);
    if (this.button.dataset["level"] !== String(level)) {
      this.button.dataset["level"] = String(level);
      this.button.innerHTML = brightnessIcon(level);
    }
  }
}
