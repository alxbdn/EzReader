import type { DocumentSession } from "./document-session";
import { docFileName, isDocFormat, pageFileName, type DocFormat, type ExportModal, type ExportRequest } from "./export-modal";
import { textLength, type TextDoc } from "./text-layout";
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
  notify(text: string, isError?: boolean): void;
  ask(text: string, title: string): Promise<boolean>;
  savePdfDialog(suggested: string): Promise<string | null>;
  pickDirectory(): Promise<string | null>;
  pickImages(): Promise<string[]>;
  existingFiles(paths: string[]): Promise<string[]>;
  writeImageFile(path: string, data: string): Promise<void>;
  imagesToPdf(paths: string[], output: string): Promise<void>;
  exportFlattenedPages(input: string, output: string, pages: number[]): Promise<void>;
  extractText(path: string, pages: number[], title: string): Promise<TextDoc>;
  saveAsDialog(suggested: string, format: DocFormat): Promise<string | null>;
  convertText(doc: TextDoc, format: DocFormat, output: string): Promise<void>;
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

  const docStem = (): string => {
    const current = d.session.saveTarget;
    const name = d.pendingRename() ?? (current ? fileNameOf(current) : "document.pdf");
    return name.replace(/\.pdf$/i, "");
  };

  const run = async (req: ExportRequest): Promise<void> => {
    try {
      if (req.kind === "images") {
        const out = await d.savePdfDialog(`${req.paths.length === 1 ? fileNameOf(req.paths[0]).replace(/\.[^.]+$/, "") : "Images"}.pdf`);
        if (!out) return;
        await d.imagesToPdf(req.paths, out);
        d.notify(msg("msgImagesPdfSaved", { n: req.paths.length }));
        return;
      }
      if (!d.session.isOpen || !d.viewer.isLoaded()) return;
      if (isDocFormat(req.format)) {
        // The text only: annotations are drawings, and redactions are already
        // burnt into the materialized file, so nothing hidden can leak.
        const input = await d.session.materialize({ annotations: false });
        const doc = await d.extractText(input, req.pages, docStem());
        if (textLength(doc) === 0) {
          d.notify(msg("msgNoTextFound"), true);
          return;
        }
        const out = await d.saveAsDialog(docFileName(docStem(), req.format), req.format);
        if (!out) return;
        await d.convertText(doc, req.format, out);
        d.notify(msg("msgConverted", { name: fileNameOf(out) }));
        return;
      }
      if (req.format === "pdf") {
        const current = d.session.saveTarget!;
        const rename = d.pendingRename();
        const out = await d.savePdfDialog(rename ? withFileName(current, rename) : current);
        if (!out) return;
        const input = await d.session.materialize({ annotations: req.annotations });
        await d.exportFlattenedPages(input, out, req.pages);
        d.notify(msg("msgPdfSaved"));
        return;
      }
      const dir = await d.pickDirectory();
      if (!dir) return;
      const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
      const base = dir.endsWith(sep) ? dir : dir + sep;
      const paths = req.pages.map((n) => base + pageFileName(docStem(), n, d.viewer.pageCount, req.format as "png" | "jpeg"));
      const existing = await d.existingFiles(paths);
      if (existing.length > 0 && !await d.ask(msg("msgOverwrite", { n: existing.length }), msg("msgOverwriteTitle"))) return;
      const input = await d.session.materialize({ annotations: req.annotations });
      let i = 0;
      await d.viewer.renderFilePages(input, req.pages, req.dpi, req.format === "jpeg" ? "image/jpeg" : "image/png", async (data) => {
        await d.writeImageFile(paths[i++], data);
      });
      d.notify(paths.length === 1 ? msg("msgExportedOne") : msg("msgExportedMany", { n: paths.length }));
    } catch (err) {
      d.notify(msg("msgExportFailed", { err: errText(err) }), true);
    }
  };

  d.modal.onPickImages(() => d.pickImages());
  d.modal.onExport((req) => void run(req));

  return {
    open: (tab) => d.modal.open(d.viewer.isLoaded() ? d.viewer.pageCount : 0, docStem(), tab),
    docStem,
  };
}
