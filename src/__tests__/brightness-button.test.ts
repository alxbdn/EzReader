// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { BrightnessButton } from "../brightness-button";

function mount(value = 100) {
  document.body.innerHTML = "";
  const b = new BrightnessButton(value);
  document.body.append(b.el);
  const range = b.el.querySelector<HTMLInputElement>("input[type=range]")!;
  return { b, range };
}

describe("BrightnessButton", () => {
  it("opens its slider on click and closes on a click elsewhere or Escape", () => {
    const { b } = mount();
    b.button.click();
    expect(b.isOpen).toBe(true);
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(b.isOpen).toBe(false);
    b.button.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(b.isOpen).toBe(false);
  });

  it("reports values while sliding and the kept one on release", () => {
    const { b, range } = mount();
    const input = vi.fn<(v: number) => void>(), commit = vi.fn<(v: number) => void>();
    b.onInput(input); b.onCommit(commit);
    range.value = "70";
    range.dispatchEvent(new Event("input"));
    expect(input).toHaveBeenLastCalledWith(70);
    expect(commit).not.toHaveBeenCalled();
    range.dispatchEvent(new Event("change"));
    expect(commit).toHaveBeenLastCalledWith(70);
  });

  it("is highlighted while pages are dimmed, and keeps values in range", () => {
    const { b } = mount(80);
    expect(b.button.classList.contains("active")).toBe(true);
    b.value = 100;
    expect(b.button.classList.contains("active")).toBe(false);
    b.value = 10;
    expect(b.value).toBe(40);
    b.value = Number.NaN;
    expect(b.value).toBe(100);
  });
});
