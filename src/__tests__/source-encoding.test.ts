import { describe, expect, it } from "vitest";

const SOURCES: Record<string, string> = {
  ...import.meta.glob(["../**/*.{ts,css,html}", "!../__tests__/**"], { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../src-tauri/src/**/*.rs", { query: "?raw", import: "default", eager: true }),
};
const DOCUMENTED_EXAMPLES = ['"Ã©" for "é"'];
const MOJIBAKE = /Ã[\u0080-¿]|â€|â”|Â[ -¿]|�/;

describe("source encoding", () => {
  it("reads the sources", () => {
    expect(Object.keys(SOURCES).some((p) => p.endsWith("/main.ts"))).toBe(true);
    expect(Object.keys(SOURCES).some((p) => p.endsWith("/lib.rs"))).toBe(true);
  });

  it("has no text garbled by a Windows-1252 round trip", () => {
    const garbled = Object.entries(SOURCES)
      .filter(([, text]) => MOJIBAKE.test(DOCUMENTED_EXAMPLES.reduce((t, example) => t.split(example).join(""), text)))
      .map(([path]) => path);
    expect(garbled).toEqual([]);
  });
});
