import type { Backend, Feedback } from "./backend";
import type { DocumentSession } from "./document-session";
import { docFileName, isDocFormat, pageFileName, type ExportModal, type ExportRequest } from "./export-modal";
import { textLength } from "./text-layout";
import type { Messages } from "./messages";
import { fileNameOf, withFileName } from "./file-paths";

export interface ExportDeps {
  session: Pick<DocumentSession, "isOpen" | "saveTarget" | "materialize">;
  viewer: {
    isLoaded(): boolean;
    readonly pageCount: number;
    renderFilePages(path: string, pages: number[], dpi: number, type: string, write: (data: string) => Promise<void>): Promise<void>;
  };
  modal: ExportModal;
  /** The name typed in the title bar and not saved yet, if any. */
  pendingRename(): string | null;
  messages: Messages;
  ui: Feedback;
  backend: Pick<Backend,
    "savePdfDialog" | "saveAsDialog" | "pickDirectory" | "pickImages" | "existingFiles" | "writeImageFile"
    | "imagesToPdf" | "exportFlattenedPages" | "extractText" | "convertText">;
}

export interface ExportFlow {
  /** Opens Export on a tab. */
  open(tab: "pdf" | "images"): void;
  /** Name of the open document without its extension (for exported files). */
  docStem(): string;
}

/**
 * Export: pictures of the pages, a flattened PDF copy, the text as Word /
 * Excel / RTF / HTML / text / XML, or pictures to a new PDF.
 */
export function setUpExport(d: ExportDeps): ExportFlow {
  const { msg, errText } = d.messages;
  const { backend, ui } = d;

  const docStem = (): string => {
    const current = d.session.saveTarget;
    const name = d.pendingRename() ?? (current ? fileNameOf(current) : "document.pdf");
    return name.replace(/\.pdf$/i, "");
  };

  const run = async (req: ExportRequest): Promise<void> => {
    try {
      if (req.kind === "images") {
        const out = await backend.savePdfDialog(`${req.paths.length === 1 ? fileNameOf(req.paths[0]).replace(/\.[^.]+$/, "") : "Images"}.pdf`);
        if (!out) return;
        await backend.imagesToPdf(req.paths, out);
        ui.notify(msg("msgImagesPdfSaved", { n: req.paths.length }));
        return;
      }
      if (!d.session.isOpen || !d.viewer.isLoaded()) return;
      if (isDocFormat(req.format)) {
        // The text only: annotations are drawings, and redactions are already
        // burnt into the materialized file, so nothing hidden can leak.
        const input = await d.session.materialize({ annotations: false });
        const doc = await backend.extractText(input, req.pages, docStem());
        if (textLength(doc) === 0) {
          ui.notify(msg("msgNoTextFound"), true);
          return;
        }
        const out = await backend.saveAsDialog(docFileName(docStem(), req.format), req.format);
        if (!out) return;
        await backend.convertText(doc, req.format, out);
        ui.notify(msg("msgConverted", { name: fileNameOf(out) }));
        return;
      }
      if (req.format === "pdf") {
        const current = d.session.saveTarget!;
        const rename = d.pendingRename();
        const out = await backend.savePdfDialog(rename ? withFileName(current, rename) : current);
        if (!out) return;
        const input = await d.session.materialize({ annotations: req.annotations });
        await backend.exportFlattenedPages(input, out, req.pages);
        ui.notify(msg("msgPdfSaved"));
        return;
      }
      const dir = await backend.pickDirectory();
      if (!dir) return;
      const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
      const base = dir.endsWith(sep) ? dir : dir + sep;
      const paths = req.pages.map((n) => base + pageFileName(docStem(), n, d.viewer.pageCount, req.format as "png" | "jpeg"));
      const existing = await backend.existingFiles(paths);
      if (existing.length > 0 && !await ui.ask(msg("msgOverwrite", { n: existing.length }), msg("msgOverwriteTitle"))) return;
      const input = await d.session.materialize({ annotations: req.annotations });
      let i = 0;
      await d.viewer.renderFilePages(input, req.pages, req.dpi, req.format === "jpeg" ? "image/jpeg" : "image/png", async (data) => {
        await backend.writeImageFile(paths[i++], data);
      });
      ui.notify(paths.length === 1 ? msg("msgExportedOne") : msg("msgExportedMany", { n: paths.length }));
    } catch (err) {
      ui.notify(msg("msgExportFailed", { err: errText(err) }), true);
    }
  };

  d.modal.onPickImages(() => backend.pickImages());
  d.modal.onExport((req) => void run(req));

  return {
    open: (tab) => d.modal.open(d.viewer.isLoaded() ? d.viewer.pageCount : 0, docStem(), tab),
    docStem,
  };
}
