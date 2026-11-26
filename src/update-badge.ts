import { ICON_CIRCLE_CHECK, ICON_CIRCLE_X, ICON_LOADER, ICON_ROTATE_CW } from "./icons";
import type { Translations } from "./i18n";
import type { UpdateChannel, UpdateOutcome, UpdatePrepared, UpdateStatus } from "./tauri-bridge";

export interface UpdateBadgeDeps {
  t(): Translations;
  check(): Promise<UpdateStatus>;
  install(): Promise<UpdateOutcome>;
  prepare(): Promise<UpdatePrepared>;
  notify(text: string, isError?: boolean): void;
  onReady?(status: UpdateStatus): void;
}

type State = "hidden" | "current" | "outdated" | "downloading" | "ready" | "installing";

const SILENT: ReadonlySet<UpdateChannel> = new Set(["installer", "portable", "homebrew", "dmg", "store"]);

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
    if (this.state === "outdated" && SILENT.has(this.status!.channel)) await this.prepare();
  }

  private async prepare(): Promise<void> {
    this.state = "downloading";
    this.render();
    try {
      this.state = (await this.deps.prepare()) === "ready" ? "ready" : "outdated";
    } catch {
      this.state = "outdated";
    }
    this.render();
    if (this.state === "ready" && this.status) this.deps.onReady?.(this.status);
  }

  restartNow(): Promise<void> {
    return this.onClick();
  }

  render(): void {
    const t = this.deps.t();
    const s = this.status;
    this.el.hidden = this.state === "hidden" || !s;
    this.el.dataset["state"] = this.state;
    this.el.disabled = this.state === "installing" || this.state === "downloading";
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
    } else if (this.state === "downloading") {
      icon = ICON_LOADER;
      label = fill(t.updateDownloading, "Downloading {v}…");
      hint = label;
    } else if (this.state === "ready") {
      icon = ICON_ROTATE_CW;
      label = t.updateReady ?? "Restart to update";
      hint = fill(t.updateReadyHint, "Version {v} is ready and installs when you close EzReader. Click to restart now.");
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
    if (this.state !== "outdated" && this.state !== "ready") return;
    const before = this.state;
    const t = this.deps.t();
    this.state = "installing";
    this.render();
    try {
      const outcome = await this.deps.install();
      if (outcome === "restarting") return;
      this.state = before;
      this.deps.notify(
        outcome === "otherWindows"
          ? t.updateOtherWindows ?? "Close your other EzReader windows first, then update"
          : t.updateOpened ?? "Finish the update in the window that just opened",
        outcome === "otherWindows",
      );
    } catch (err) {
      this.state = before;
      this.deps.notify((t.updateFailed ?? "Couldn't update: {err}").replace("{err}", String(err)), true);
    }
    this.render();
  }
}
