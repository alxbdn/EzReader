import { ICON_CIRCLE_CHECK, ICON_CIRCLE_X, ICON_LOADER } from "./icons";
import type { Translations } from "./i18n";
import type { UpdateOutcome, UpdateStatus } from "./tauri-bridge";

export interface UpdateBadgeDeps {
  t(): Translations;
  check(): Promise<UpdateStatus>;
  install(): Promise<UpdateOutcome>;
  notify(text: string, isError?: boolean): void;
}

type State = "hidden" | "current" | "outdated" | "installing";

export class UpdateBadge {
  readonly el: HTMLButtonElement;
  private state: State = "hidden";
  private status: UpdateStatus | null = null;

  constructor(footer: HTMLElement, private readonly deps: UpdateBadgeDeps) {
    this.el = document.createElement("button");
    this.el.type = "button";
    this.el.className = "update-badge";
    this.el.hidden = true;
    this.el.addEventListener("click", () => void this.onClick());
    footer.insertBefore(this.el, footer.querySelector(".lang-picker"));
  }

  async refresh(): Promise<void> {
    try {
      this.status = await this.deps.check();
      this.state = this.status.upToDate ? "current" : "outdated";
    } catch {
      this.status = null;
      this.state = "hidden";
    }
    this.render();
  }

  render(): void {
    const t = this.deps.t();
    const s = this.status;
    this.el.hidden = this.state === "hidden" || !s;
    this.el.dataset["state"] = this.state;
    this.el.disabled = this.state === "installing";
    if (!s) return;
    const fill = (text: string | undefined, fallback: string) =>
      (text ?? fallback).replace("{v}", s.latest).replace("{cur}", s.current);

    let icon = ICON_CIRCLE_CHECK;
    let label = `v${s.current}`;
    let hint = fill(t.updateUpToDateHint, "Up to date: {v} is the latest version");
    if (this.state === "outdated") {
      icon = ICON_CIRCLE_X;
      label = fill(t.updateAvailable, "Update to {v}");
      hint = s.channel === "store"
        ? fill(t.updateStoreHint, "Version {v} is out (you have {cur}). Click to open the Microsoft Store.")
        : fill(t.updateAvailableHint, "Version {v} is out (you have {cur}). Click to install it.");
    } else if (this.state === "installing") {
      icon = ICON_LOADER;
      label = t.updateInstalling ?? "Updating…";
    }
    this.el.innerHTML = `<span class="update-badge-icon">${icon}</span><span class="update-badge-label"></span>`;
    this.el.querySelector(".update-badge-label")!.textContent = label;
    this.el.title = hint;
    this.el.setAttribute("aria-label", this.state === "current" ? hint : label);
  }

  private async onClick(): Promise<void> {
    if (this.state === "current") {
      await this.refresh();
      return;
    }
    if (this.state !== "outdated") return;
    const t = this.deps.t();
    this.state = "installing";
    this.render();
    try {
      const outcome = await this.deps.install();
      if (outcome === "restarting") return;
      this.state = "outdated";
      this.deps.notify(
        outcome === "otherWindows"
          ? t.updateOtherWindows ?? "Close your other EzReader windows first, then update"
          : t.updateOpened ?? "Finish the update in the window that just opened",
        outcome === "otherWindows",
      );
    } catch (err) {
      this.state = "outdated";
      this.deps.notify((t.updateFailed ?? "Couldn't update: {err}").replace("{err}", String(err)), true);
    }
    this.render();
  }
}
