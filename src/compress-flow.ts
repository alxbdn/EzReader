import type { Backend, Feedback } from "./backend";
import type { CompressModal } from "./compress-modal";
import type { DocumentSession } from "./document-session";
import { errorCode } from "./errors";
import type { Messages } from "./messages";

export interface CompressDeps {
  session: Pick<DocumentSession, "isOpen" | "sourcePath" | "materialize">;
  modal: CompressModal;
  /** True when the document is protected (and says so): compressing would copy it. */
  refuse(): boolean;
  messages: Messages;
  ui: Feedback;
  backend: Pick<Backend, "savePdfDialog" | "estimateCompression" | "compress" | "cancelCompression" | "onCompressProgress">;
}

/**
 * Compress: opens the dialog with the estimates, then runs the chosen level
 * with progress and Cancel, and says how it went. Returns the opener.
 */
export function setUpCompress(d: CompressDeps): () => Promise<void> {
  const { msg, errText } = d.messages;
  const { backend, ui } = d;
  /** The file the dialog works on (what is shown, edits included). */
  let input: Promise<string> | null = null;

  d.modal.onConfirm(async (level, targetBytes) => {
    const source = d.session.sourcePath;
    if (!source) return;
    if (d.modal.wontShrink() && !await ui.ask(msg("msgCompressNoGain"))) return;
    const out = await backend.savePdfDialog(source);
    if (!out) return;
    const stopListening = await backend.onCompressProgress((share) => d.modal.setProgress(share));
    d.modal.startRunning(() => { void backend.cancelCompression(); });
    try {
      const result = await backend.compress(await (input ?? d.session.materialize()), out, level, targetBytes);
      d.modal.finishRunning();
      const fromMB = (result.originalBytes / 1_048_576).toFixed(1);
      const toMB = (result.compressedBytes / 1_048_576).toFixed(1);
      const pct = result.originalBytes > 0 ? Math.round((1 - result.compressedBytes / result.originalBytes) * 100) : 0;
      if (!result.reachedTarget && targetBytes) {
        ui.notify(msg("msgCompressTarget", { target: d.modal.size(targetBytes), to: d.modal.size(result.compressedBytes) }), true);
      } else {
        ui.notify(msg("msgCompressed", { from: fromMB, to: toMB, pct }));
      }
    } catch (err) {
      d.modal.finishRunning();
      if (errorCode(err) === "cancelled") ui.notify(msg("msgCompressCancelled"));
      else ui.notify(msg("msgCompressFailed", { err: errText(err) }), true);
    } finally {
      stopListening();
    }
  });

  return async () => {
    if (!d.session.isOpen || d.modal.isOpen || d.refuse()) return;
    d.modal.open(0);
    input = d.session.materialize();
    try {
      d.modal.setEstimate(await backend.estimateCompression(await input));
    } catch {
      d.modal.setEstimate(null);
    }
  };
}
