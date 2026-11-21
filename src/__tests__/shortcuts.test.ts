import { describe, it, expect } from "vitest";
import { matchesShortcut, type KeyPress } from "../shortcuts";

const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress =>
  ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

describe("matchesShortcut", () => {
  it("takes Ctrl or Cmd for Ctrl", () => {
    expect(matchesShortcut("Ctrl+O", press("o", { ctrlKey: true }))).toBe(true);
    expect(matchesShortcut("Ctrl+O", press("o", { metaKey: true }))).toBe(true);
    expect(matchesShortcut("Ctrl+O", press("o"))).toBe(false);
  });

  it("needs Shift to match exactly", () => {
    expect(matchesShortcut("Ctrl+S", press("S", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(matchesShortcut("Ctrl+Shift+S", press("S", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matchesShortcut("Ctrl+Shift+S", press("s", { ctrlKey: true }))).toBe(false);
  });

  it("reads Ctrl++ as the plus key, with or without Shift, and = too", () => {
    expect(matchesShortcut("Ctrl++", press("+", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matchesShortcut("Ctrl++", press("=", { ctrlKey: true }))).toBe(true);
    expect(matchesShortcut("Ctrl++", press("-", { ctrlKey: true }))).toBe(false);
    expect(matchesShortcut("Ctrl+-", press("-", { ctrlKey: true }))).toBe(true);
  });

  it("matches function keys only without modifiers", () => {
    expect(matchesShortcut("F5", press("F5"))).toBe(true);
    expect(matchesShortcut("F5", press("F5", { ctrlKey: true }))).toBe(false);
    expect(matchesShortcut("F11", press("F11", { shiftKey: true }))).toBe(false);
  });

  it("never matches with Alt held", () => {
    expect(matchesShortcut("Ctrl+O", press("o", { ctrlKey: true, altKey: true }))).toBe(false);
  });

  it("matches punctuation and digits", () => {
    expect(matchesShortcut("Ctrl+,", press(",", { ctrlKey: true }))).toBe(true);
    expect(matchesShortcut("Ctrl+0", press("0", { metaKey: true }))).toBe(true);
  });
});
