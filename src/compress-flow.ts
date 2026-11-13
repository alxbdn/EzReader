import type { CompressModal } from "./compress-modal";
import type { DocumentSession } from "./document-session";
import { errorCode } from "./errors";
import type { Messages } from "./messages";
import type { CompressEstimate, CompressLevel, CompressResult } from "./tauri-bridge";

export interface CompressDeps {
  session: Pick<DocumentSession, "isOpen" | "sourcePath" | "materialize">;
  modal: CompressModal;
  /** True when the document is protected (and says so): compressing would copy it. */
  refuse(): boolean;
  messages: Messages;
  notify(text: string, isError?: boolean): void;
  ask(text: string): Promise<boolean>;
  savePdfDialog(suggested: string): Promise<string | null>;
  estimate(input: string): Promise<CompressEstimate>;
  compress(input: string, output: string, level: CompressLevel, targetBytes?: number): Promise<CompressResult>;
  cancel(): Promise<void>;
  onProgress(cb: (share: number) => void): Promise<() => void>;
}

/**
 * Compress: opens the dialog with the estimates, then runs the chosen level
 * with progress and Cancel, and says how it went. Returns the opener.
 */
export function setUpCompress(d: CompressDeps): () => Promise<void> {
  const { msg, errText } = d.messages;
  /** The file the dialog works on (what is shown, edits included). */
  let input: Promise<string> | null = null;

  d.modal.onConfirm(async (level, targetBytes) => {
    const source = d.session.sourcePath;
    if (!source) return;
    if (d.modal.wontShrink() && !await d.ask(msg("msgCompressNoGain"))) return;
    const out = await d.savePdfDialog(source);
    if (!out) return;
    const stopListening = await d.onProgress((share) => d.modal.setProgress(share));
    d.modal.startRunning(() => { void d.cancel(); });
    try {
      const result = await d.compress(await (input ?? d.session.materialize()), out, level, targetBytes);
      d.modal.finishRunning();
      const fromMB = (result.originalBytes / 1_048_576).toFixed(1);
      const toMB = (result.compressedBytes / 1_048_576).toFixed(1);
      const pct = result.originalBytes > 0 ? Math.round((1 - result.compressedBytes / result.originalBytes) * 100) : 0;
      if (!result.reachedTarget && targetBytes) {
        d.notify(msg("msgCompressTarget", { target: d.modal.size(targetBytes), to: d.modal.size(result.compressedBytes) }), true);
      } else {
        d.notify(msg("msgCompressed", { from: fromMB, to: toMB, pct }));
      }
    } catch (err) {
      d.modal.finishRunning();
      if (errorCode(err) === "cancelled") d.notify(msg("msgCompressCancelled"));
      else d.notify(msg("msgCompressFailed", { err: errText(err) }), true);
    } finally {
      stopListening();
    }
  });

  return async () => {
    if (!d.session.isOpen || d.modal.isOpen || d.refuse()) return;
    d.modal.open(0);
    input = d.session.materialize();
    try {
      d.modal.setEstimate(await d.estimate(await input));
    } catch {
      d.modal.setEstimate(null);
    }
  };
}
