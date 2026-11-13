import { describe, it, expect, vi } from "vitest";
import { DocumentSession, isMicrosoftPrintToPdf, uniqueTempName } from "../document-session";
import type { Annotation, FormFieldValue } from "../models";

function makeSession() {
  const state = {
    annotations: [] as Annotation[],
    formFields: [] as FormFieldValue[],
    rotation: 0,
  };
  const saveAnnotated = vi.fn(async () => {});
  const redact = vi.fn(async () => {});
  const encrypt = vi.fn(async () => {});
  let n = 0;
  const session = new DocumentSession(
    {
      annotations: () => state.annotations,
      formFields: () => state.formFields,
      rotation: () => state.rotation,
    },
    { saveAnnotated, redact, encrypt, tempPath: async (suffix) => `/tmp/${++n}-${suffix}` },
  );
  return { session, state, saveAnnotated, redact, encrypt };
}

const rect = { kind: "rect", page: 1 } as unknown as Annotation;

describe("DocumentSession.materialize", () => {
  it("returns the viewed file untouched when nothing is pending", async () => {
    const { session, saveAnnotated } = makeSession();
    session.opened("/docs/a.pdf", null);
    expect(await session.materialize()).toBe("/docs/a.pdf");
    expect(saveAnnotated).not.toHaveBeenCalled();
  });

  it("starts from the working copy, not the original, after page edits", async () => {
    const { session } = makeSession();
    session.opened("/docs/a.pdf", null);
    session.replacedWorkingCopy("/tmp/pages.pdf");
    expect(await session.materialize()).toBe("/tmp/pages.pdf");
    expect(session.sourcePath).toBe("/docs/a.pdf");
  });

  it.each([
    ["annotations", (s: ReturnType<typeof makeSession>["state"]) => { s.annotations = [rect]; }],
    ["form values", (s: ReturnType<typeof makeSession>["state"]) => { s.formFields = [{ name: "f", value: "x" }]; }],
    ["rotation",    (s: ReturnType<typeof makeSession>["state"]) => { s.rotation = 90; }],
  ])("burns pending %s into a temp copy", async (_label, mutate) => {
    const { session, state, saveAnnotated } = makeSession();
    session.opened("/docs/a.pdf", "/tmp/display.pdf");
    mutate(state);
    const out = await session.materialize();
    expect(out).toBe("/tmp/1-current.pdf");
    expect(saveAnnotated).toHaveBeenCalledWith(
      "/tmp/display.pdf", out, state.annotations, state.rotation, state.formFields,
    );
  });

  it("throws when no document is open", async () => {
    const { session } = makeSession();
    await expect(session.materialize()).rejects.toThrow();
  });
});

describe("DocumentSession save targets", () => {
  it("saves back to the source by default and remembers Save As targets", async () => {
    const { session, saveAnnotated } = makeSession();
    session.opened("/docs/a.pdf", "/tmp/display.pdf");
    session.markDirty(true);
    expect(session.saveTarget).toBe("/docs/a.pdf");

    await session.saveTo("/docs/b.pdf");
    expect(saveAnnotated).toHaveBeenLastCalledWith("/tmp/display.pdf", "/docs/b.pdf", [], 0, []);
    expect(session.saveTarget).toBe("/docs/b.pdf");
    expect(session.sourcePath).toBe("/docs/b.pdf");
    expect(session.isDirty).toBe(false);
  });

  it("forgets the previous Save As target when another file is opened", () => {
    const { session } = makeSession();
    session.opened("/docs/a.pdf", null);
    session.saved("/docs/b.pdf");
    session.opened("/docs/c.pdf", null);
    expect(session.saveTarget).toBe("/docs/c.pdf");
  });
});

describe("DocumentSession after a save", () => {
  it("builds on the saved file and does not apply the rotation twice", async () => {
    const { session, state, saveAnnotated } = makeSession();
    session.opened("/docs/a.pdf", null);
    state.rotation = 90;
    await session.saveTo("/docs/a.pdf");
    expect(saveAnnotated).toHaveBeenLastCalledWith("/docs/a.pdf", "/docs/a.pdf", [], 90, []);

    // Saved file already holds the rotation: nothing pending, nothing to burn.
    expect(session.hasPendingEdits()).toBe(false);
    expect(await session.materialize()).toBe("/docs/a.pdf");

    // A further quarter turn is applied once, on top of the saved file.
    state.rotation = 180;
    await session.saveTo("/docs/b.pdf");
    expect(saveAnnotated).toHaveBeenLastCalledWith("/docs/a.pdf", "/docs/b.pdf", [], 90, []);
    expect(session.basePath).toBe("/docs/b.pdf");
  });

  it("starts from the saved file, not the old working copy", async () => {
    const { session, state, saveAnnotated } = makeSession();
    session.opened("/docs/a.pdf", "/tmp/display.pdf");
    state.annotations = [rect];
    await session.saveTo("/docs/b.pdf");
    await session.materialize();
    expect(saveAnnotated).toHaveBeenLastCalledWith("/docs/b.pdf", "/tmp/1-current.pdf", [rect], 0, []);
  });
});

describe("isMicrosoftPrintToPdf", () => {
  it("matches only the Microsoft virtual printer", () => {
    expect(isMicrosoftPrintToPdf("Microsoft Print to PDF")).toBe(true);
    expect(isMicrosoftPrintToPdf(" microsoft print to pdf ")).toBe(true);
    expect(isMicrosoftPrintToPdf("Adobe PDF")).toBe(false);
    expect(isMicrosoftPrintToPdf("PDFCreator")).toBe(false);
    expect(isMicrosoftPrintToPdf("HP LaserJet (PDF ready)")).toBe(false);
  });
});

describe("uniqueTempName", () => {
  it("never returns the same name twice", () => {
    const a = uniqueTempName("C:\\Temp\\", "pages-x.pdf");
    const b = uniqueTempName("C:\\Temp\\", "pages-x.pdf");
    expect(a).not.toBe(b);
    expect(a.startsWith("C:\\Temp\\ezreader-")).toBe(true);
    expect(uniqueTempName("/tmp", "x.pdf").startsWith("/tmp/ezreader-")).toBe(true);
  });
});

describe("DocumentSession redaction", () => {
  const blackout = { kind: "redact", page: 2, x: 10, y: 20, width: 30, height: 40 } as Annotation;

  it("redacts the base first, then writes the other edits on top, never storing the redaction", async () => {
    const { session, state, saveAnnotated, redact } = makeSession();
    session.opened("/docs/a.pdf", null);
    state.annotations = [rect, blackout];
    expect(session.hasRedactions()).toBe(true);

    await session.saveTo("/docs/a.pdf");

    expect(redact).toHaveBeenCalledWith("/docs/a.pdf", "/tmp/1-redacted.pdf", [blackout]);
    expect(saveAnnotated).toHaveBeenCalledWith("/tmp/1-redacted.pdf", "/docs/a.pdf", [rect], 0, []);
  });

  it("applies redactions to exported copies too", async () => {
    const { session, state, redact } = makeSession();
    session.opened("/docs/a.pdf", null);
    state.annotations = [blackout];
    await session.materialize();
    expect(redact).toHaveBeenCalledTimes(1);
  });

  it("does not redact when there is nothing to black out", async () => {
    const { session, state, redact } = makeSession();
    session.opened("/docs/a.pdf", null);
    state.annotations = [rect];
    expect(session.hasRedactions()).toBe(false);
    await session.saveTo("/docs/b.pdf");
    expect(redact).not.toHaveBeenCalled();
  });
});

describe("DocumentSession password", () => {
  it("a protected document can be neither saved nor copied", async () => {
    const { session, saveAnnotated, encrypt } = makeSession();
    session.opened("/docs/a.pdf", "/tmp/plain.pdf", "secret");
    expect(session.isProtected).toBe(true);
    await expect(session.saveTo("/docs/a.pdf")).rejects.toThrow(/protected/);
    await expect(session.materialize()).rejects.toThrow(/protected/);
    expect(saveAnnotated).not.toHaveBeenCalled();
    expect(encrypt).not.toHaveBeenCalled();
  });

  it("unlocks only with the file's password, then saves without one", async () => {
    const { session, encrypt } = makeSession();
    session.opened("/docs/a.pdf", "/tmp/plain.pdf", "secret");
    expect(session.unlock("wrong")).toBe(false);
    expect(session.isProtected).toBe(true);
    expect(session.unlock("secret")).toBe(true);
    expect(session.isProtected).toBe(false);
    expect(session.isDirty).toBe(true);
    await session.saveTo("/docs/a.pdf");
    expect(encrypt).not.toHaveBeenCalled();
    expect(session.basePath).toBe("/docs/a.pdf");
  });

  it("a chosen password is applied by the next save, which locks the document", async () => {
    const { session, encrypt, saveAnnotated } = makeSession();
    session.opened("/docs/a.pdf", null);
    session.protect("secret");
    expect(session.hasPendingPassword).toBe(true);
    expect(session.isProtected).toBe(false);
    await session.saveTo("/docs/b.pdf");
    const plain = (saveAnnotated.mock.calls[0] as unknown[])[1];
    expect(encrypt).toHaveBeenCalledWith(plain, "/docs/b.pdf", "secret");
    expect(session.basePath).toBe(plain);
    expect(session.isProtected).toBe(true);
    expect(session.filePassword).toBe("secret");
    expect(session.hasPendingPassword).toBe(false);
  });

  it("a cancelled password is not applied", async () => {
    const { session, encrypt } = makeSession();
    session.opened("/docs/a.pdf", null);
    session.protect("secret");
    session.protect(null);
    await session.saveTo("/docs/b.pdf");
    expect(encrypt).not.toHaveBeenCalled();
    expect(session.isProtected).toBe(false);
  });

  it("can leave annotations out but still applies redactions", async () => {
    const { session, state, saveAnnotated, redact } = makeSession();
    session.opened("/docs/a.pdf", null);
    state.annotations = [rect, { kind: "redact", page: 1 } as unknown as Annotation];
    await session.materialize({ annotations: false });
    expect(redact).toHaveBeenCalled();
    expect((saveAnnotated.mock.calls[0] as unknown[])[2]).toEqual([]);
  });
});
