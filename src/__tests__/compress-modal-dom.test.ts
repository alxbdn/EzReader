// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { CompressModal } from "../compress-modal";

const estimate = { originalBytes: 1000, losslessBytes: 1100, balancedBytes: 600, maximumBytes: 400 };

function open(): CompressModal {
  document.body.innerHTML = "";
  const modal = new CompressModal();
  modal.open(1000);
  modal.setEstimate(estimate);
  return modal;
}

function card(modal: CompressModal, n: number): HTMLButtonElement {
  return modal.box.querySelectorAll<HTMLButtonElement>(".ez-radio-card")[n];
}

describe("compress dialog", () => {
  it("warns only for a level that won't shrink the file", () => {
    const modal = open();
    const warn = modal.box.querySelector(".ez-warn")!;
    expect(warn.classList.contains("hidden")).toBe(true); // balanced
    card(modal, 0).click(); // lossless: 1100 > 1000
    expect(warn.classList.contains("hidden")).toBe(false);
    expect(modal.wontShrink()).toBe(true);
  });

  it("stays open while running: Cancel stops instead of closing", () => {
    const modal = open();
    const confirmed = vi.fn();
    modal.onConfirm(confirmed);
    modal.okBtn.click();
    expect(confirmed).toHaveBeenCalledWith("balanced", undefined);
    expect(modal.isOpen).toBe(true);

    const stop = vi.fn();
    modal.startRunning(stop);
    expect(modal.okBtn.disabled).toBe(true);
    modal.setProgress(0.42);
    expect(modal.box.querySelector(".ez-progress")!.textContent).toContain("42");

    modal.cancelBtn.click();
    expect(stop).toHaveBeenCalledOnce();
    expect(modal.isOpen).toBe(true);

    modal.finishRunning();
    expect(modal.isOpen).toBe(false);
  });
});
