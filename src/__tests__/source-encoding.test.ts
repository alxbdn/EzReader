import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = ["src", "src-tauri/src"];
const EXTENSIONS = /\.(ts|css|html|rs)$/;
const DOCUMENTED_EXAMPLES = ['"Ã©" for "é"'];
const MOJIBAKE = /Ã[\u0080-¿]|â€|â”|Â[ -¿]|�/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" || name === "target" ? [] : files(path);
    return EXTENSIONS.test(name) ? [path] : [];
  });
}

describe("source encoding", () => {
  it("has no text garbled by a Windows-1252 round trip", () => {
    const garbled = ROOTS.flatMap(files).filter((path) => {
      const text = DOCUMENTED_EXAMPLES.reduce((t, example) => t.split(example).join(""), readFileSync(path, "utf8"));
      return MOJIBAKE.test(text);
    });
    expect(garbled).toEqual([]);
  });
});
