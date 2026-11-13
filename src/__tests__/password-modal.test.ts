// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { PasswordModal } from "../password-modal";

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

function inputs(modal: PasswordModal): HTMLInputElement[] {
  return [...modal.box.querySelectorAll<HTMLInputElement>("input.ez-input")];
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("password dialog", () => {
  it("protects only once the confirmation matches", async () => {
    document.body.innerHTML = "";
    const modal = new PasswordModal();
    const result = modal.askNew();
    const [pw, confirm] = inputs(modal);
    type(pw, "turtle-orange-jumps-7");
    expect(modal.okBtn.disabled).toBe(true);
    type(confirm, "turtle-orange-jumps-8");
    expect(modal.okBtn.disabled).toBe(true);
    type(confirm, "turtle-orange-jumps-7");
    expect(modal.okBtn.disabled).toBe(false);
    modal.okBtn.click();
    expect(await result).toBe("turtle-orange-jumps-7");
  });

  it("keeps asking for the current password until it is right", async () => {
    document.body.innerHTML = "";
    const modal = new PasswordModal();
    const result = modal.askCurrent((pw) => pw === "secret");
    const [pw] = inputs(modal);
    type(pw, "nope");
    modal.okBtn.click();
    await flush();
    expect(modal.isOpen).toBe(true);
    expect(modal.box.querySelector<HTMLElement>(".ez-error")!.hidden).toBe(false);
    type(pw, "secret");
    modal.okBtn.click();
    expect(await result).toBe(true);
    expect(modal.isOpen).toBe(false);
  });

  it("resolves false when cancelled", async () => {
    document.body.innerHTML = "";
    const modal = new PasswordModal();
    const result = modal.askCurrent(() => true);
    modal.cancelBtn.click();
    expect(await result).toBe(false);
  });
});
