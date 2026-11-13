// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { confirmDialog } from "../confirm-dialog";

const open = () => confirmDialog({ title: "Unsaved changes", text: "Close without saving?", yes: "Yes", no: "No" });
const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".confirm-dialog button"));
const key = (k: string) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

describe("confirmDialog", () => {
  it("has No chosen by default: Enter answers no", async () => {
    const answer = open();
    const [, no] = buttons();
    expect(document.activeElement).toBe(no);
    key("Enter");
    expect(await answer).toBe(false);
    expect(document.querySelector(".confirm-dialog")).toBeNull();
  });

  it("Escape answers no", async () => {
    const answer = open();
    key("Escape");
    expect(await answer).toBe(false);
  });

  it("Yes needs a click, or Tab then Enter", async () => {
    let answer = open();
    buttons()[0].click();
    expect(await answer).toBe(true);
    answer = open();
    key("Tab");
    expect(document.activeElement).toBe(buttons()[0]);
    key("Enter");
    expect(await answer).toBe(true);
  });
});
