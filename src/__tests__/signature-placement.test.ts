// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SignaturePlacement, signatureSize, type SignaturePlacementDeps, type SignatureTarget } from "../signature-placement";

describe("signatureSize", () => {
  it("caps the height at 75 and keeps the ratio", () => {
    expect(signatureSize(1)).toEqual({ width: 75, height: 75 });
    expect(signatureSize(0.25)).toEqual({ width: 150, height: 37.5 });
  });
  it("falls back to a wide signature when the ratio is unknown", () => {
    expect(signatureSize(0)).toEqual({ width: 150, height: 60 });
  });
});

describe("SignaturePlacement", () => {
  let scrollEl: HTMLElement;
  let page: HTMLElement;
  let placeSignature: ReturnType<typeof vi.fn<SignatureTarget["placeSignature"]>>;
  let deps: SignaturePlacementDeps & Record<"started" | "ended" | "placed", ReturnType<typeof vi.fn<() => void>>>;
  let placement: SignaturePlacement;

  const preview = () => document.querySelector<HTMLImageElement>(".sig-preview")!;
  const clickPage = (x: number, y: number) => page.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));

  beforeEach(() => {
    document.body.innerHTML = "";
    scrollEl = document.createElement("div");
    page = document.createElement("div");
    page.className = "page-wrapper";
    page.dataset.page = "2";
    page.getBoundingClientRect = () => ({ left: 100, top: 50 }) as DOMRect;
    scrollEl.appendChild(page);
    document.body.appendChild(scrollEl);
    placeSignature = vi.fn<SignatureTarget["placeSignature"]>();
    deps = {
      scrollEl,
      overlayOf: (n) => (n === 2 ? { placeSignature } : null),
      started: vi.fn<() => void>(),
      ended: vi.fn<() => void>(),
      placed: vi.fn<() => void>(),
    };
    placement = new SignaturePlacement(deps);
  });

  it("shows a preview that follows the mouse while placing", () => {
    placement.start("AAAA");
    expect(placement.active).toBe(true);
    expect(preview().style.display).toBe("block");
    expect(scrollEl.style.cursor).toBe("none");
    expect(deps.started).toHaveBeenCalledOnce();
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 12, clientY: 34 }));
    expect(preview().style.left).toBe("12px");
    expect(preview().style.top).toBe("34px");
  });

  it("places the signature where the page is clicked, sized by the ink ratio, then stops", () => {
    const vector = { w: 200, h: 50, segs: [] };
    placement.start("AAAA", vector);
    clickPage(130, 70);
    expect(placeSignature).toHaveBeenCalledWith(30, 20, "AAAA", 150, 37.5, vector);
    expect(placement.active).toBe(false);
    expect(preview().style.display).toBe("none");
    expect(scrollEl.style.cursor).toBe("");
    expect(deps.ended).toHaveBeenCalledOnce();
    expect(deps.placed).toHaveBeenCalledOnce();
  });

  it("ignores clicks when not placing or outside a known page", () => {
    clickPage(130, 70);
    page.dataset.page = "9";
    placement.start("AAAA");
    clickPage(130, 70);
    expect(placeSignature).not.toHaveBeenCalled();
    expect(placement.active).toBe(true);
  });

  it("reports whether cancelling stopped a placement", () => {
    expect(placement.cancel()).toBe(false);
    expect(deps.ended).not.toHaveBeenCalled();
    placement.start("AAAA");
    expect(placement.cancel()).toBe(true);
    expect(deps.ended).toHaveBeenCalledOnce();
  });
});
