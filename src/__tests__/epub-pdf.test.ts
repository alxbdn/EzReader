// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { findPage, planBookmarks, printableHtml } from "../epub-pdf";
import type { BookInfo, Chapter } from "../epub-book";

const info: BookInfo = {
  title: "Livre",
  author: "A",
  language: "fr",
  spine: ["c0.xhtml", "c1.xhtml", "c2.xhtml"],
  toc: [
    { label: "Premier", path: "c0.xhtml", fragment: "", depth: 0 },
    { label: "La forêt profonde", path: "c0.xhtml", fragment: "s2", depth: 1 },
    { label: "Introuvable", path: "c0.xhtml", fragment: "s3", depth: 1 },
    { label: "Dernier", path: "c2.xhtml", fragment: "", depth: 0 },
  ],
};

describe("EPUB to PDF", () => {
  it("finds a section title across line breaks and punctuation", () => {
    const pages = ["Premier\nIl était une fois", "texte", "LA FORÊT\nprofonde. Le chemin"];
    expect(findPage(pages, "La forêt profonde")).toBe(2);
    expect(findPage(pages, "La forêt profonde", 3)).toBe(-1);
    expect(findPage(pages, "ab")).toBe(-1);
  });

  it("points chapters to their first page and sections to the page of their title", async () => {
    const texts: Record<number, string[]> = { 0: ["Premier", "…", "La forêt profonde"] };
    const marks = await planBookmarks(info, [1, 4, 9], async (ch) => texts[ch] ?? []);
    expect(marks).toEqual([
      { title: "Premier", page: 1, depth: 0 },
      { title: "La forêt profonde", page: 3, depth: 1 },
      { title: "Introuvable", page: 3, depth: 1 },
      { title: "Dernier", page: 9, depth: 0 },
    ]);
  });

  it("makes a standalone page with nothing active and no links", () => {
    const body = new DOMParser().parseFromString(
      `<body><h1>Un</h1><p><a href="#" data-ez-target="c1.xhtml#x">lien</a><img src="data:image/png;base64,AA=="/></p></body>`,
      "text/html").body;
    const chapter: Chapter = { path: "c0.xhtml", language: "fr", bodyClass: "chap", styles: ["h1 { color: red }"], body };
    const html = printableHtml(chapter, "Livre");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain(`<meta charset="utf-8">`);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("h1 { color: red }");
    expect(html).toContain(`<body class="chap">`);
    expect(html).toContain(`<a>lien</a>`);
    expect(html).toContain(`src="data:image/png;base64,AA=="`);
    expect(html.indexOf("default-src")).toBeLessThan(html.indexOf("<style>"));
  });
});
