// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { Presentation, presentActionForKey, stepPage } from "../presentation";

const labels = { prev: "Previous page", next: "Next page", exit: "Stop presenting (Esc)" };

const open: Presentation[] = [];

function setup(count = 5, start = 2) {
  const rendered: number[] = [];
  const onExit = vi.fn();
  const p = new Presentation({
    pageCount: count,
    render: async (n) => { rendered.push(n); const c = document.createElement("canvas"); c.dataset["page"] = String(n); return c; },
    onExit,
  }, start, labels);
  p.open();
  open.push(p);
  return { p, rendered, onExit };
}

const key = (k: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => { open.splice(0).forEach((p) => p.close()); document.body.innerHTML = ""; });

describe("presentActionForKey", () => {
  it("maps the usual presenter keys", () => {
    for (const k of ["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"]) expect(presentActionForKey(k)).toBe("next");
    for (const k of ["ArrowLeft", "ArrowUp", "PageUp", "Backspace"]) expect(presentActionForKey(k)).toBe("prev");
    expect(presentActionForKey("Home")).toBe("first");
    expect(presentActionForKey("End")).toBe("last");
    expect(presentActionForKey("Escape")).toBe("exit");
    expect(presentActionForKey("a")).toBeNull();
  });
});

describe("stepPage", () => {
  it("stays within the document", () => {
    expect(stepPage(5, 5, "next")).toBe(5);
    expect(stepPage(1, 5, "prev")).toBe(1);
    expect(stepPage(3, 5, "first")).toBe(1);
    expect(stepPage(3, 5, "last")).toBe(5);
    expect(stepPage(3, 5, "next")).toBe(4);
  });
});

describe("Presentation", () => {
  it("starts on the given page and preloads its neighbours", async () => {
    const { p, rendered } = setup(5, 2);
    await flush();
    expect(p.currentPage).toBe(2);
    expect(document.querySelector(".presentation-counter")!.textContent).toBe("2 / 5");
    expect((document.querySelector(".presentation-stage canvas") as HTMLElement).dataset["page"]).toBe("2");
    expect(rendered).toEqual(expect.arrayContaining([1, 2, 3]));
  });

  it("turns pages with keys and swallows them from the app", async () => {
    const { p } = setup(5, 2);
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    key("ArrowRight"); key("ArrowRight");
    expect(p.currentPage).toBe(4);
    key("Home");
    expect(p.currentPage).toBe(1);
    key("End");
    expect(p.currentPage).toBe(5);
    expect(behind).not.toHaveBeenCalled();
    window.removeEventListener("keydown", behind);
  });

  it("left click goes forward, right click goes back, the bar does not turn pages", () => {
    const { p } = setup(5, 2);
    const el = document.querySelector(".presentation")!;
    el.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    expect(p.currentPage).toBe(3);
    el.dispatchEvent(new MouseEvent("mousedown", { button: 2, bubbles: true }));
    expect(p.currentPage).toBe(2);
    document.querySelector(".presentation-counter")!.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    expect(p.currentPage).toBe(2);
  });

  it("Escape ends it once and reports the last page", () => {
    const { onExit } = setup(5, 2);
    key("ArrowRight");
    key("Escape");
    key("Escape");
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(3);
    expect(document.querySelector(".presentation")).toBeNull();
  });

  it("the ✕ button ends it and the arrows are disabled at the ends", async () => {
    const { onExit } = setup(3, 1);
    await flush();
    expect((document.querySelector(".pres-prev") as HTMLButtonElement).disabled).toBe(true);
    (document.querySelector(".pres-exit") as HTMLButtonElement).click();
    expect(onExit).toHaveBeenCalledWith(1);
  });
});
