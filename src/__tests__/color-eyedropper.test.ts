// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ColorRow } from "../color-row";

function setup() {
  const onPick = vi.fn();
  const row = new ColorRow({ icon: "", title: "Background", presets: [["#ffffff", "White"]], noneTitle: "None", customTitle: "Custom", onPick });
  document.body.append(row.el);
  (row.el.querySelector(".color-swatch.custom") as HTMLButtonElement).click();
  const dropper = row.el.querySelector(".cp-dropper") as HTMLButtonElement;
  const target = document.createElement("div");
  target.style.backgroundColor = "rgb(10, 20, 30)";
  document.body.append(target);
  return { onPick, dropper, target };
}

const down = (el: Element, button = 0) =>
  el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button, clientX: 5, clientY: 5 }));

describe("color picker eyedropper", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; document.documentElement.className = ""; });

  it("shows it is armed, samples the clicked color and applies it", async () => {
    const { onPick, dropper, target } = setup();
    document.elementsFromPoint = () => [target, document.body];
    dropper.click();
    vi.runAllTimers();
    expect(dropper.classList.contains("on")).toBe(true);
    expect(dropper.getAttribute("aria-pressed")).toBe("true");
    expect(document.documentElement.classList.contains("eyedropping")).toBe(true);

    const pageClick = vi.fn();
    target.addEventListener("click", pageClick);
    down(target);
    target.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.runAllTimersAsync();

    expect(onPick).toHaveBeenCalledWith({ r: 10, g: 20, b: 30 });
    expect(pageClick).not.toHaveBeenCalled();
    expect(dropper.classList.contains("on")).toBe(false);
    expect(document.documentElement.classList.contains("eyedropping")).toBe(false);

    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(pageClick).toHaveBeenCalledTimes(1);
  });

  it("cancels on Escape without picking", async () => {
    const { onPick, dropper } = setup();
    dropper.click();
    vi.runAllTimers();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    await vi.runAllTimersAsync();
    expect(onPick).not.toHaveBeenCalled();
    expect(dropper.classList.contains("on")).toBe(false);
    expect(document.documentElement.classList.contains("eyedropping")).toBe(false);
  });

  it("cancels when the dropper button is clicked again", async () => {
    const { onPick, dropper } = setup();
    dropper.click();
    vi.runAllTimers();
    down(dropper);
    dropper.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    await vi.runAllTimersAsync();
    expect(onPick).not.toHaveBeenCalled();
    expect(dropper.classList.contains("on")).toBe(false);
  });
});
