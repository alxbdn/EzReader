// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateToast } from "../update-toast";

const text = { message: "EzReader 1.1.0 est prêt.", restart: "Redémarrer", later: "Plus tard" };

describe("update toast", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("shows the message with Later then Restart", () => {
    const toast = new UpdateToast();
    toast.show(text, () => {});
    const el = document.querySelector(".update-toast")!;
    expect(el.querySelector(".update-toast-text")!.textContent).toBe(text.message);
    expect([...el.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Plus tard", "Redémarrer"]);
  });

  it("restarts and closes on Restart", () => {
    const toast = new UpdateToast();
    const restart = vi.fn();
    toast.show(text, restart);
    (document.querySelector(".update-toast .btn-primary") as HTMLButtonElement).click();
    expect(restart).toHaveBeenCalledOnce();
    expect(toast.isOpen).toBe(false);
    expect(document.querySelector(".update-toast")).toBeNull();
  });

  it("closes without restarting on Later", () => {
    const toast = new UpdateToast();
    const restart = vi.fn();
    toast.show(text, restart);
    (document.querySelector(".update-toast .btn-ghost") as HTMLButtonElement).click();
    expect(restart).not.toHaveBeenCalled();
    expect(document.querySelector(".update-toast")).toBeNull();
  });

  it("never stacks two notes", () => {
    const toast = new UpdateToast();
    toast.show(text, () => {});
    toast.show(text, () => {});
    expect(document.querySelectorAll(".update-toast")).toHaveLength(1);
  });
});
