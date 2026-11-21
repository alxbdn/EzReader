// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateBadge, type UpdateBadgeDeps } from "../update-badge";
import { getTranslations } from "../i18n";
import type { UpdateStatus } from "../tauri-bridge";

const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  current: "1.0.0", latest: "1.1.0", upToDate: false, channel: "installer", ...over,
});

function setUp(over: Partial<UpdateBadgeDeps> = {}) {
  document.body.innerHTML = `<div class="welcome-footer"><button class="welcome-default"></button><div class="lang-picker"></div></div>`;
  const deps: UpdateBadgeDeps = {
    t: () => getTranslations("fr"),
    check: vi.fn(async () => status()),
    install: vi.fn(async () => "restarting" as const),
    prepare: vi.fn(async () => "manual" as const),
    notify: vi.fn(),
    ...over,
  };
  const badge = new UpdateBadge(document.querySelector(".welcome-footer")!, deps);
  return { badge, deps, el: badge.el };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("update badge", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("sits left of the language picker and stays hidden until checked", () => {
    const { el } = setUp();
    expect(el.nextElementSibling?.className).toBe("lang-picker");
    expect(el.hidden).toBe(true);
  });

  it("shows a green check and the version when up to date", async () => {
    const { badge, el } = setUp({ check: async () => status({ current: "1.1.0", upToDate: true }) });
    await badge.refresh();
    expect(el.hidden).toBe(false);
    expect(el.dataset["state"]).toBe("current");
    expect(el.textContent).toBe("v1.1.0");
    expect(el.title).toContain("1.1.0");
  });

  it("shows a red cross and the new version when outdated", async () => {
    const { badge, el } = setUp();
    await badge.refresh();
    expect(el.dataset["state"]).toBe("outdated");
    expect(el.textContent).toBe("Mettre à jour vers 1.1.0");
    expect(el.title).toContain("vous avez 1.0.0");
  });

  it("stays hidden offline", async () => {
    const { badge, el } = setUp({ check: async () => { throw new Error("offline"); } });
    await badge.refresh();
    expect(el.hidden).toBe(true);
  });

  it("installs on click and shows progress", async () => {
    let finish!: (v: "restarting") => void;
    const { badge, el, deps } = setUp({ install: vi.fn(() => new Promise<"restarting">((r) => { finish = r; })) });
    await badge.refresh();
    el.click();
    expect(deps.install).toHaveBeenCalledOnce();
    expect(el.dataset["state"]).toBe("installing");
    expect(el.disabled).toBe(true);
    finish("restarting");
    await flush();
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it("asks to close other windows first", async () => {
    const { badge, el, deps } = setUp({ install: async () => "otherWindows" });
    await badge.refresh();
    el.click();
    await flush();
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("autres fenêtres"), true);
    expect(el.dataset["state"]).toBe("outdated");
  });

  it("says what failed", async () => {
    const { badge, el, deps } = setUp({ install: async () => { throw "download failed"; } });
    await badge.refresh();
    el.click();
    await flush();
    expect(deps.notify).toHaveBeenCalledWith("Impossible de mettre à jour : download failed", true);
  });

  it("checks again when clicked while up to date", async () => {
    const check = vi.fn(async () => status({ current: "1.1.0", upToDate: true }));
    const { badge, el, deps } = setUp({ check });
    await badge.refresh();
    el.click();
    await flush();
    expect(check).toHaveBeenCalledTimes(2);
    expect(deps.install).not.toHaveBeenCalled();
  });

  it("downloads the update at launch and offers a restart", async () => {
    let done!: (v: "ready") => void;
    const prepare = vi.fn(() => new Promise<"ready">((r) => { done = r; }));
    const { badge, el, deps } = setUp({ prepare });
    const refreshed = badge.refresh();
    await flush();
    expect(prepare).toHaveBeenCalledOnce();
    expect(el.dataset["state"]).toBe("downloading");
    expect(el.disabled).toBe(true);
    expect(el.textContent).toBe("Téléchargement de 1.1.0…");
    done("ready");
    await refreshed;
    expect(el.dataset["state"]).toBe("ready");
    expect(el.textContent).toBe("Redémarrer pour mettre à jour");
    expect(el.title).toContain("fermeture");
    el.click();
    expect(deps.install).toHaveBeenCalledOnce();
  });

  it("keeps the install button when the download fails", async () => {
    const { badge, el } = setUp({ prepare: async () => { throw "offline"; } });
    await badge.refresh();
    expect(el.dataset["state"]).toBe("outdated");
  });

  it("stays ready when another window is still open", async () => {
    const { badge, el, deps } = setUp({ prepare: async () => "ready", install: async () => "otherWindows" });
    await badge.refresh();
    el.click();
    await flush();
    expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("autres fenêtres"), true);
    expect(el.dataset["state"]).toBe("ready");
  });

  it.each(["deb", "other"] as const)("leaves %s updates to a click", async (channel) => {
    const { badge, el, deps } = setUp({ check: async () => status({ channel }) });
    await badge.refresh();
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(el.dataset["state"]).toBe("outdated");
  });

  it("does not download when up to date", async () => {
    const { badge, deps } = setUp({ check: async () => status({ upToDate: true }) });
    await badge.refresh();
    expect(deps.prepare).not.toHaveBeenCalled();
  });
});
