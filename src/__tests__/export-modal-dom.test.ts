// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ExportModal, type ExportRequest } from "../export-modal";

function open(): { modal: ExportModal; requests: ExportRequest[] } {
  document.body.innerHTML = "";
  const modal = new ExportModal();
  const requests: ExportRequest[] = [];
  modal.onExport((r) => requests.push(r));
  modal.open(4, "report", "pdf");
  return { modal, requests };
}

const card = (modal: ExportModal, label: string): HTMLButtonElement =>
  [...modal.box.querySelectorAll<HTMLButtonElement>(".ez-card")].find((b) => b.querySelector(".ez-card-label")?.textContent === label)!;

describe("export dialog: convert", () => {
  it("offers Word, Excel, RTF, HTML, Text and XML next to the pictures", () => {
    const { modal } = open();
    const labels = [...modal.box.querySelectorAll(".ez-card-label")].map((e) => e.textContent);
    expect(labels).toEqual(["PNG", "JPEG", "PDF", "Word", "Excel", "RTF", "HTML", "Text", "XML"]);
  });

  it("converts the text of the chosen pages, without picture options", () => {
    const { modal, requests } = open();
    card(modal, "Word").click();
    const summary = modal.box.querySelector(".ez-summary")!.textContent!;
    expect(summary).toContain("report.docx");
    expect(summary).toContain("4 page(s)");
    const dpi = modal.box.querySelector("select")!.closest("label")!;
    expect(dpi.hidden).toBe(true);
    expect(modal.box.querySelector<HTMLElement>(".ez-check")!.hidden).toBe(true);
    modal.box.querySelector<HTMLInputElement>(".ez-input")!.value = "2-3";
    modal.okBtn.click();
    expect(requests).toEqual([{ kind: "pages", format: "docx", pages: [2, 3], dpi: 300, annotations: false }]);
  });

  it("brings the picture options back for PNG", () => {
    const { modal } = open();
    card(modal, "Excel").click();
    card(modal, "PNG").click();
    expect(modal.box.querySelector("select")!.closest("label")!.hidden).toBe(false);
    expect(modal.box.querySelector<HTMLElement>(".ez-check")!.hidden).toBe(false);
  });
});
