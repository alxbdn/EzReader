import { describe, expect, it } from "vitest";
import { bodySize, layoutPage, normalizeHeadings, textLength, type TextRun } from "../text-layout";

/** A run of `str` at (x, baseline y) in a font of `size`, ~0.5 em per character. */
const run = (str: string, x: number, y: number, size = 10): TextRun => ({ str, x, y, size, width: str.length * size * 0.5 });

describe("text layout", () => {
  it("groups runs into lines, top to bottom, left to right", () => {
    const page = layoutPage([run("world", 100, 100), run("Hello", 70, 100.5), run("Second", 70, 112)], 1, 595, 842, 10);
    expect(page.lines.map((l) => l.cells.map((c) => c.text))).toEqual([["Hello world"], ["Second"]]);
    expect(page.lines[1].paraStart).toBe(false);
  });

  it("joins runs that touch without adding a space", () => {
    const page = layoutPage([run("Hel", 70, 100), run("lo", 85, 100)], 1, 595, 842, 10);
    expect(page.lines[0].cells[0].text).toBe("Hello");
  });

  it("splits a line on wide gaps and lines the cells up in columns", () => {
    const page = layoutPage([
      run("Name", 70, 100), run("Qty", 250, 100), run("Price", 400, 100),
      run("Apples", 70, 112), run("3", 252, 112), run("1.50", 401, 112),
      run("Pears", 70, 124), run("2.00", 400, 124),
    ], 1, 595, 842, 10);
    expect(page.lines.map((l) => l.cells.map((c) => [c.text, c.col]))).toEqual([
      [["Name", 0], ["Qty", 1], ["Price", 2]],
      [["Apples", 0], ["3", 1], ["1.50", 2]],
      [["Pears", 0], ["2.00", 2]],
    ]);
  });

  it("splits tight tables whose columns line up over several rows", () => {
    const page = layoutPage([
      run("Region", 58, 220, 11), run("Q1", 96.5, 220, 11), run("Q2", 150, 220, 11),
      run("North", 58, 250, 11), run("1 234,50", 96.5, 250, 11), run("987", 150, 250, 11),
      run("South", 58, 280, 11), run("12", 96, 280, 11), run("3.5", 150.5, 280, 11),
    ], 1, 595, 842, 11);
    expect(page.lines.map((l) => l.cells.map((c) => c.text))).toEqual([
      ["Region", "Q1", "Q2"], ["North", "1 234,50", "987"], ["South", "12", "3.5"],
    ]);
    // Two lines lining up by chance are still prose.
    const prose = layoutPage([run("a word", 70, 100), run("next", 110, 100), run("b word", 70, 112), run("then", 110, 112)], 1, 595, 842, 10);
    expect(prose.lines.map((l) => l.cells.length)).toEqual([1, 1]);
  });

  it("starts a paragraph after a wider gap or a sentence that ends early", () => {
    const long = "x".repeat(90);
    const page = layoutPage([
      run(long, 70, 100), run("short end.", 70, 112), run(long, 70, 124), run(long, 70, 150),
    ], 1, 595, 842, 10);
    expect(page.lines.map((l) => l.paraStart)).toEqual([true, false, true, true]);
  });

  it("marks bigger text as titles", () => {
    const page = layoutPage([run("Big title", 70, 60, 20), run("Sub", 70, 90, 12.5), run("body", 70, 110)], 1, 595, 842, 10);
    expect(page.lines.map((l) => l.heading)).toEqual([1, 2, 0]);
  });

  it("makes the largest titles level 1 across the document", () => {
    const p1 = layoutPage([run("Chapter", 70, 60, 18), run("body", 70, 100)], 1, 595, 842, 10);
    const p2 = layoutPage([run("Section", 70, 60, 16), run("body", 70, 100)], 2, 595, 842, 10);
    normalizeHeadings([p1, p2]);
    expect([p1.lines[0].heading, p2.lines[0].heading, p2.lines[1].heading]).toEqual([1, 2, 0]);
  });

  it("finds the body size and the amount of text", () => {
    const runs = [run("Title", 0, 0, 24), run("a long line of body text", 0, 30, 10), run("more body", 0, 42, 10)];
    expect(bodySize(runs)).toBe(10);
    expect(bodySize([])).toBe(11);
    const page = layoutPage(runs, 1, 100, 100, 10);
    expect(textLength({ title: "", pages: [page] })).toBe(5 + 24 + 9);
    expect(textLength({ title: "", pages: [layoutPage([run("   ", 0, 0)], 1, 1, 1, 10)] })).toBe(0);
  });
});
