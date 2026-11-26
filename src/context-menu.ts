/** One entry of a right-click menu, or a separator. */
export type ContextItem =
  | { label: string; shortcut?: string; disabled?: boolean; danger?: boolean; run: () => void }
  | "sep";

/** The right-click menu: built for what was clicked, and only when there is something to offer. */
export class ContextMenu {
  readonly el: HTMLElement;

  constructor(host: HTMLElement = document.body) {
    this.el = document.createElement("div");
    this.el.className = "ctx-menu hidden";
    this.el.setAttribute("role", "menu");
    host.append(this.el);
    document.addEventListener("mousedown", (e) => {
      if (this.isOpen && !this.el.contains(e.target as Node)) this.hide();
    }, true);
    window.addEventListener("blur", () => this.hide());
    window.addEventListener("resize", () => this.hide());
    document.addEventListener("scroll", () => this.hide(), true);
    this.el.addEventListener("keydown", (e) => this.onKey(e));
  }

  get isOpen(): boolean { return !this.el.classList.contains("hidden"); }

  /** Opens at a point (client pixels). Leading, trailing and doubled separators are dropped;
   *  with no entry left, nothing opens. */
  show(x: number, y: number, items: readonly ContextItem[]): boolean {
    const clean = tidy(items);
    if (clean.length === 0) { this.hide(); return false; }
    this.el.replaceChildren(...clean.map((item) => this.entry(item)));
    this.el.classList.remove("hidden");
    const { width, height } = this.el.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - width - 4));
    const top = y + height > window.innerHeight - 4 ? Math.max(4, y - height) : y;
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
    return true;
  }

  hide(): void {
    if (!this.isOpen) return;
    this.el.classList.add("hidden");
    this.el.replaceChildren();
  }

  private entry(item: ContextItem): HTMLElement {
    if (item === "sep") {
      const sep = document.createElement("div");
      sep.className = "menu-sep";
      sep.setAttribute("role", "separator");
      return sep;
    }
    const b = document.createElement("button");
    b.type = "button";
    b.className = `menu-entry${item.danger ? " danger" : ""}`;
    b.setAttribute("role", "menuitem");
    b.disabled = !!item.disabled;
    const label = document.createElement("span");
    label.textContent = item.label;
    b.append(label);
    if (item.shortcut) {
      const k = document.createElement("span");
      k.className = "shortcut";
      k.textContent = item.shortcut;
      b.append(k);
    }
    b.addEventListener("click", () => { this.hide(); item.run(); });
    return b;
  }

  private onKey(e: KeyboardEvent): void {
    const entries = Array.from(this.el.querySelectorAll<HTMLButtonElement>(".menu-entry:not(:disabled)"));
    const at = entries.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") { e.preventDefault(); this.hide(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); entries[(at + 1) % entries.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); entries[(at - 1 + entries.length) % entries.length]?.focus(); }
  }
}

function tidy(items: readonly ContextItem[]): ContextItem[] {
  const out: ContextItem[] = [];
  for (const item of items) {
    if (item === "sep" && (out.length === 0 || out[out.length - 1] === "sep")) continue;
    out.push(item);
  }
  while (out[out.length - 1] === "sep") out.pop();
  return out;
}
