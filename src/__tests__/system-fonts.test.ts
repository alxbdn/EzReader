import { describe, it, expect } from "vitest";
import { fontCss, SYSTEM_FONTS } from "../models";

const RUST = Object.values(import.meta.glob("../../src-tauri/src/pdf/sysfont.rs", { query: "?raw", import: "default", eager: true }))[0] as string;

describe("system fonts", () => {
  it("are the 30 fonts the PDF writer looks for, in the same order", () => {
    const rust = RUST;
    const block = rust.slice(rust.indexOf("pub const FAMILIES"), rust.indexOf("];", rust.indexOf("pub const FAMILIES")));
    const names = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(SYSTEM_FONTS.map((f) => f.name)).toEqual(names);
    expect(names).toHaveLength(30);
  });

  it("show the font first, then the standard one that stands in for it", () => {
    expect(fontCss("times", "Georgia")).toBe(`"Georgia", "Times New Roman", Times, serif`);
    expect(fontCss("courier")).toBe(`"Courier New", Courier, monospace`);
    expect(fontCss("helvetica", 'Bad"Name')).toMatch(/^"BadName", /);
  });
});
