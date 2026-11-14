import { describe, expect, it } from "vitest";
import { fitWithin, isImagePath, openKind, picturesDocument } from "../pictures";

describe("pictures", () => {
  it("recognises picture files", () => {
    expect(isImagePath("C:\\Photos\\Scan.JPG")).toBe(true);
    expect(isImagePath("/tmp/logo.webp")).toBe(true);
    expect(isImagePath("/tmp/report.pdf")).toBe(false);
  });

  it("opens PDFs as they are and pictures as a new document", () => {
    expect(openKind("C:\\Docs\\Report.PDF")).toBe("pdf");
    expect(openKind("C:\\Photos\\Scan.png")).toBe("pictures");
    expect(openKind("/home/me/photo.jpeg")).toBe("pictures");
    expect(openKind("/home/me/notes.txt")).toBeNull();
  });

  it("names a picture's new document after it, in its folder", () => {
    expect(picturesDocument(["C:\\Photos\\Scan 1.jpg"])).toEqual({ name: "Scan 1.pdf", suggested: "C:\\Photos\\Scan 1.pdf" });
    expect(picturesDocument(["/pics/a.b.png", "/pics/c.png"])).toEqual({ name: "a.b.pdf", suggested: "/pics/a.b.pdf" });
  });

  it("scales down to fit, never up", () => {
    expect(fitWithin(800, 400, 400, 400)).toEqual({ width: 400, height: 200 });
    expect(fitWithin(100, 50, 400, 400)).toEqual({ width: 100, height: 50 });
    expect(fitWithin(300, 900, 600, 300)).toEqual({ width: 100, height: 300 });
  });
});
