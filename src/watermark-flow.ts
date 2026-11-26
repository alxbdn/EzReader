import type { Backend, Feedback } from "./backend";
import type { DocumentSession } from "./document-session";
import type { Messages } from "./messages";
import type { PagePreview, WatermarkModal, WatermarkRequest } from "./watermark-modal";

export interface WatermarkDeps {
  session: Pick<DocumentSession, "isOpen" | "sourcePath" | "materialize">;
  modal: Pick<WatermarkModal, "open" | "onConfirm" | "isOpen" | "close" | "startRunning" | "setProgress" | "finishRunning" | "copyLabel">;
  refuse(): boolean;
  messages: Messages;
  ui: Feedback;
  backend: Pick<Backend, "savePdfDialog">;
  renderPreview(input: string, widthPx: number, page: number): Promise<HTMLCanvasElement>;
  burn(input: string, output: string, o: WatermarkRequest, copyLabel: string, onProgress: (done: number, total: number) => void): Promise<void>;
  today(): string;
  pages(): { current: number; total: number };
}

export function watermarkedName(source: string, suffix: string): string {
  return source.replace(/(\.pdf)?$/i, `-${suffix}.pdf`);
}

export function setUpWatermark(d: WatermarkDeps): () => Promise<void> {
  const { msg, errText } = d.messages;
  let input: Promise<string> | null = null;

  d.modal.onConfirm(async (o) => {
    const source = d.session.sourcePath;
    if (!source || !input || o.pages.length === 0) return;
    const out = await d.backend.savePdfDialog(watermarkedName(source, msg("msgWmFileSuffix")));
    if (!out) return;
    d.modal.startRunning();
    try {
      await d.burn(await input, out, o, d.modal.copyLabel, (done, total) => d.modal.setProgress(done, total));
      d.modal.finishRunning();
      d.modal.close();
      d.ui.notify(msg("msgWatermarked", { name: out.split(/[\\/]/).pop() ?? out }));
    } catch (err) {
      d.modal.finishRunning();
      d.ui.notify(msg("msgWatermarkFailed", { err: errText(err) }), true);
    }
  });

  return async () => {
    if (!d.session.isOpen || d.modal.isOpen || d.refuse()) return;
    input = d.session.materialize();
    const preview: PagePreview = async (w, page) => d.renderPreview(await input!, w, page);
    d.modal.open(preview, d.today(), d.pages());
  };
}
