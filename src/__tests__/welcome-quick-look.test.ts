// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { showQuickLookCard } from "../welcome-quick-look";

describe("quick look card", () => {
  const card = () => {
    const el = document.createElement("div");
    el.hidden = true;
    return el;
  };

  it("shows when quick look exists", async () => {
    const el = card();
    await showQuickLookCard(async () => ({ available: true }), el);
    expect(el.hidden).toBe(false);
  });

  it("stays hidden where quick look does not exist", async () => {
    const el = card();
    await showQuickLookCard(async () => ({ available: false }), el);
    expect(el.hidden).toBe(true);
  });

  it("stays hidden when the state cannot be read", async () => {
    const el = card();
    await showQuickLookCard(async () => { throw new Error("no backend"); }, el);
    expect(el.hidden).toBe(true);
  });
});
