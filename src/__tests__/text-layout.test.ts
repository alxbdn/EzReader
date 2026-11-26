import { describe, expect, it } from "vitest";
import { bodySize, columnFor, layoutPage, looksNumeric, normalizeHeadings, tableColumns, textLength, type TextRun } from "../text-layout";

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

describe("tables for Excel", () => {
  const right = (str: string, end: number, y: number): TextRun => run(str, end - str.length * 5, y);

  it("puts right-aligned amounts in their own columns, with no empty columns between", () => {
    const page = layoutPage([
      run("Date", 50, 100), run("Description", 110, 100), right("Debit", 400, 100), right("Credit", 470, 100), right("Balance", 545, 100),
      run("01/03", 50, 114), run("Opening balance", 110, 114), right("1 250,00", 545, 114),
      run("02/03", 50, 128), run("Card payment", 110, 128), right("45,20", 400, 128), right("1 204,80", 545, 128),
      run("03/03", 50, 142), run("Salary", 110, 142), right("2 300,00", 470, 142), right("3 504,80", 545, 142),
      run("12/03", 50, 156), run("Interest", 110, 156), right("1,05", 470, 156), right("3 505,85", 545, 156),
    ], 1, 595, 842, 10);
    expect(page.lines.map((l) => l.cells.map((c) => `${c.col}:${c.text}`))).toEqual([
      ["0:Date", "1:Description", "2:Debit", "3:Credit", "4:Balance"],
      ["0:01/03", "1:Opening balance", "4:1 250,00"],
      ["0:02/03", "1:Card payment", "2:45,20", "4:1 204,80"],
      ["0:03/03", "1:Salary", "3:2 300,00", "4:3 504,80"],
      ["0:12/03", "1:Interest", "3:1,05", "4:3 505,85"],
    ]);
  });

  it("folds a description that wraps back into its row", () => {
    const page = layoutPage([
      run("05/03", 50, 100), run("Direct debit", 110, 100), right("89,99", 400, 100), right("3 414,81", 545, 100),
      run("contract 998877", 110, 111),
      run("07/03", 50, 125), run("Card payment", 110, 125), right("123,40", 400, 125), right("3 291,41", 545, 125),
    ], 1, 595, 842, 10);
    expect(page.lines.map((l) => l.cells.map((c) => c.text))).toEqual([
      ["05/03", "Direct debit contract 998877", "89,99", "3 414,81"],
      ["07/03", "Card payment", "123,40", "3 291,41"],
    ]);
  });

  it("does not let a header over two columns glue them together", () => {
    const columns = tableColumns([
      [{ x: 50, right: 80 }, { x: 200, right: 300 }],
      [{ x: 200, right: 215 }, { x: 270, right: 300 }],
      [{ x: 50, right: 90 }, { x: 205, right: 215 }, { x: 280, right: 300 }],
    ]);
    expect(columns).toEqual([[50, 90], [200, 215], [270, 300]]);
    expect(columnFor({ x: 200, right: 300 }, columns)).toBe(1);
    expect(columnFor({ x: 120, right: 130 }, columns)).toBe(0);
  });

  it("splits two numbers apart even when the gap is narrow", () => {
    const page = layoutPage([
      run("Bolt", 50, 100), run("250", 120, 100), run("0.10", 142, 100),
    ], 1, 595, 842, 10);
    expect(page.lines[0].cells.map((c) => c.text)).toEqual(["Bolt", "250", "0.10"]);
  });

  it("knows what an amount looks like", () => {
    for (const s of ["12", "-3.5", "1 234,50", "(12.00)", "€ 4,99", "15 %", "1'234.50"]) expect(looksNumeric(s)).toBe(true);
    for (const s of ["Total", "Q1", "12 apples", "", "A-12"]) expect(looksNumeric(s)).toBe(false);
  });
});
