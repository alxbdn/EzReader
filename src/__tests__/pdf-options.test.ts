import { describe, expect, it } from "vitest";
import { SAFE_PDF } from "../pdf-options";

const SOURCES = import.meta.glob("../*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("pdf.js hardening", () => {
  it("never compiles code from a PDF", () => {
    expect(SAFE_PDF.isEvalSupported).toBe(false);
  });

  it("every getDocument call starts from SAFE_PDF", () => {
    let calls = 0;
    for (const [file, text] of Object.entries(SOURCES)) {
      for (const line of text.split("\n")) {
        if (!line.includes("getDocument(")) continue;
        calls++;
        expect(line, `${file}: ${line.trim()}`).toContain("...SAFE_PDF");
      }
    }
    expect(calls).toBeGreaterThan(0);
  });

  it("never turns on pdf.js scripting (a PDF's JavaScript must not run)", () => {
    for (const [file, text] of Object.entries(SOURCES)) {
      expect(text, file).not.toMatch(/pdf\.sandbox|enableScripting\s*:\s*true|scripting_api/);
    }
  });
});
