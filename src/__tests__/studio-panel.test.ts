// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { StudioPanel, describeAnnotation } from "../studio-panel";
import { AnnotationSession } from "../annotation-session";
import { ToolSelection } from "../tool-selection";
import { ColorRow, hsvToRgb, parseHex, rgbToHsv } from "../color-row";
import { brushOf, BRUSHES } from "../tool-row";
import type { Annotation, InkAnnotation, RectAnnotation, TextAnnotation } from "../models";

const black = { r: 0, g: 0, b: 0 };
const rect = (page: number): RectAnnotation => ({ page, kind: "rect", x: 0, y: 0, width: 10, height: 10, color: black, strokeWidth: 1 });
const ink = (points: [number, number][], arrow = false): InkAnnotation => ({
  page: 1, kind: "ink", x: 0, y: 0, points, color: black, strokeWidth: 2, ...(arrow ? { arrow } : {}),
} as InkAnnotation);
const text = (content: string): TextAnnotation => ({
  page: 2, kind: "text", x: 0, y: 0, width: 50, content, color: black, fontSize: 12, bold: false, italic: false, underline: false,
} as TextAnnotation);

function flush(): void { vi.runAllTimers(); }

describe("describeAnnotation", () => {
  it("names each kind, and quotes the words of text and notes", () => {
    expect(describeAnnotation(text("Bonjour")).fb).toBe("Text");
    expect(describeAnnotation(text("Bonjour")).quote).toBe("Bonjour");
    expect(describeAnnotation(rect(1)).fb).toBe("Rectangle");
    expect(describeAnnotation(ink([[0, 0], [1, 1], [2, 0]])).fb).toBe("Freehand");
    expect(describeAnnotation(ink([[0, 0], [5, 5]])).fb).toBe("Line");
    expect(describeAnnotation(ink([[0, 0], [5, 5]], true)).fb).toBe("Arrow");
  });
});

describe("parseHex", () => {
  it("reads six or three digits, with or without #", () => {
    expect(parseHex("#1D4ED8")).toEqual({ r: 29, g: 78, b: 216 });
    expect(parseHex("1d4ed8")).toEqual({ r: 29, g: 78, b: 216 });
    expect(parseHex("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex("#12345")).toBeNull();
    expect(parseHex("blue")).toBeNull();
  });

  it("a typed code picks the colour; a wrong one puts the old one back", () => {
    const onPick = vi.fn();
    const row = new ColorRow({ icon: "", title: "Ink", presets: [["#000000", "Black"]], customTitle: "Custom", onPick });
    row.set(black);
    const input = row.el.querySelector<HTMLInputElement>(".color-hex input")!;
    expect(input.value).toBe("#000000");
    input.value = "#dc2626";
    input.dispatchEvent(new Event("change"));
    expect(onPick).toHaveBeenCalledWith({ r: 220, g: 38, b: 38 });
    input.value = "nope";
    input.dispatchEvent(new Event("change"));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("#DC2626");
  });
});

describe("brushes", () => {
  it("are ten, and a thickness and opacity name one back", () => {
    expect(BRUSHES).toHaveLength(10);
    for (const b of BRUSHES) expect(brushOf(b.width, b.opacity)).toBe(b.id);
    expect(brushOf(7, 1)).toBeNull();
  });
});

describe("StudioPanel", () => {
  function mount() {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame"] });
    const session = new AnnotationSession();
    const tools = new ToolSelection();
    const pick = vi.fn();
    const remove = vi.fn((a: Annotation) => session.remove(a));
    const reorder = vi.fn((a: Annotation, i: number) => { session.moveTo(a, i); });
    const panel = new StudioPanel(document.createElement("div"), {
      list: () => session.all(), selected: () => tools.selected, pick, remove, reorder,
    });
    session.onContentChange(() => panel.refresh());
    tools.onSelect((a) => panel.setSelected(a));
    panel.setShown(true);
    return { session, tools, panel, pick, remove };
  }

  it("lists every annotation by page, and follows undo", () => {
    const { session, panel } = mount();
    session.add(text("Northwind"));
    session.add(rect(1));
    flush();
    const rows = [...panel.el.querySelectorAll(".studio-ann-label")].map((e) => e.textContent);
    expect(rows).toEqual(["Rectangle", "Text « Northwind »"]);
    session.undo();
    flush();
    expect(panel.el.querySelectorAll(".studio-ann")).toHaveLength(1);
  });

  it("a click picks the annotation, the trash removes it, the selection is marked", () => {
    const { session, tools, panel, pick, remove } = mount();
    const a = rect(1);
    session.add(a);
    flush();
    const row = panel.el.querySelector<HTMLElement>(".studio-ann")!;
    row.click();
    expect(pick).toHaveBeenCalledWith(a);
    tools.select(a, { selectionLost() {} });
    expect(row.classList.contains("on")).toBe(true);
    row.querySelector<HTMLButtonElement>(".studio-ann-del")!.click();
    expect(remove).toHaveBeenCalledWith(a);
    flush();
    expect(panel.el.querySelectorAll(".studio-ann")).toHaveLength(0);
  });

  it("lists the topmost annotation first and Alt+Up brings one forward", () => {
    const { session, panel } = mount();
    const a = rect(1), b = rect(1), c = rect(1);
    session.add(a); session.add(b); session.add(c);
    flush();
    const rows = () => [...panel.el.querySelectorAll<HTMLElement>(".studio-ann")];
    expect(rows().map((r) => r.dataset["layer"])).toEqual(["2", "1", "0"]);
    rows()[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }));
    expect(session.forPage(1)).toEqual([b, a, c]);
    session.moveTo(a, 2);
    expect(session.forPage(1)).toEqual([b, c, a]);
    session.undo();
    expect(session.forPage(1)).toEqual([b, a, c]);
  });

  it("builds rows only for a window of a long list, and brings a picked one into it", () => {
    const { session, tools, panel } = mount();
    const all = Array.from({ length: 2000 }, (_, i) => rect(1 + Math.floor(i / 10)));
    for (const a of all) session.add(a);
    flush();
    expect(panel.el.querySelector(".studio-count")!.textContent).toBe("2000");
    expect(panel.el.querySelectorAll(".studio-ann").length).toBeLessThanOrEqual(60);
    const far = all[1789]!;
    tools.select(far, { selectionLost() {} });
    const on = panel.el.querySelector<HTMLElement>(".studio-ann.on");
    expect(on?.dataset["page"]).toBe(String(far.page));
  });

  it("keeps keyboard focus on a row while the list scrolls around it", () => {
    const { session, panel } = mount();
    document.body.append(panel.el);
    for (let i = 0; i < 2000; i++) session.add(rect(1 + Math.floor(i / 10)));
    flush();
    const list = panel.el.querySelector<HTMLElement>(".studio-list")!;
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 330 });
    list.dispatchEvent(new Event("scroll"));
    flush();
    const rows = [...list.querySelectorAll<HTMLElement>(".studio-ann")];
    const focused = rows[25]!;
    focused.focus();
    expect(document.activeElement).toBe(focused);
    Object.defineProperty(list, "scrollTop", { configurable: true, value: 30 * 33 });
    list.dispatchEvent(new Event("scroll"));
    flush();
    expect(list.querySelector(".studio-ann")).not.toBe(rows[0]);
    expect(focused.isConnected).toBe(true);
    expect(document.activeElement).toBe(focused);
    panel.el.remove();
  });

  it("sizes the scroll space from the rows as laid out, not a fixed height", () => {
    const pitch = 40;
    const offsetTop = vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("studio-ann") ? [...this.parentElement!.children].indexOf(this) * pitch : 0;
    });
    const { session, panel } = mount();
    document.body.append(panel.el);
    for (let i = 0; i < 2000; i++) session.add(rect(1 + Math.floor(i / 10)));
    flush();
    const list = panel.el.querySelector<HTMLElement>(".studio-list")!;
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(list, "scrollTop", { configurable: true, value: 100 * pitch });
    list.dispatchEvent(new Event("scroll"));
    flush();
    const spaceAbove = list.firstElementChild as HTMLElement;
    expect(spaceAbove.classList.contains("studio-ann")).toBe(false);
    expect(spaceAbove.style.height).toBe(`${80 * pitch - 1}px`);
    offsetTop.mockRestore();
    panel.el.remove();
  });

  it("folds away and remembers it", () => {
    const { panel } = mount();
    panel.el.querySelector<HTMLButtonElement>(".studio-collapse")!.click();
    expect(panel.el.classList.contains("collapsed")).toBe(true);
    expect(localStorage.getItem("ezreader-studio-collapsed")).toBe("1");
    panel.el.querySelector<HTMLButtonElement>(".studio-expand")!.click();
    expect(panel.el.classList.contains("collapsed")).toBe(false);
  });
});

describe("custom colour picker", () => {
  it("opens from the rainbow swatch and picks a colour from hue, saturation and brightness", () => {
    const onPick = vi.fn();
    const row = new ColorRow({ icon: "", title: "Ink", presets: [["#000000", "Black"]], customTitle: "Custom", onPick });
    const pop = row.el.querySelector<HTMLElement>(".color-picker-pop")!;
    expect(pop.hidden).toBe(true);
    row.el.querySelector<HTMLButtonElement>(".color-swatch.custom")!.click();
    expect(pop.hidden).toBe(false);
    const hue = pop.querySelector<HTMLInputElement>(".cp-hue")!;
    hue.value = "240";
    hue.dispatchEvent(new Event("input"));
    expect(onPick).toHaveBeenLastCalledWith({ r: 0, g: 0, b: 255 });
    row.el.querySelector<HTMLButtonElement>(".color-swatch:not(.custom)")!.click();
    expect(pop.hidden).toBe(true);
  });

  it("converts between rgb and hsv both ways", () => {
    for (const c of [{ r: 220, g: 38, b: 38 }, { r: 29, g: 78, b: 216 }, { r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }]) {
      const [h, s, v] = rgbToHsv(c);
      expect(hsvToRgb(h, s, v)).toEqual(c);
    }
  });
});
