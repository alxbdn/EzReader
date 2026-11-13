/**
 * Errors from the Rust commands: a stable `code` to match on and an English
 * `detail` (see src-tauri/src/error.rs). Never match on the text.
 */
export type ErrorCode =
  | "wrong-password"
  | "empty-password"
  | "already-encrypted"
  | "exists"
  | "invalid-name"
  | "cancelled"
  | "not-an-image"
  | "too-large"
  | "page-count-changed"
  | "invalid-pages"
  | "other";

export class CommandError extends Error {
  constructor(readonly code: ErrorCode, detail: string) {
    super(detail);
    this.name = "CommandError";
  }

  /** The detail alone, so `String(err)` in a message reads naturally. */
  override toString(): string { return this.message; }
}

/** Turns what a failed `invoke` threw into a `CommandError` when it carries a code. */
export function toCommandError(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "code" in raw && "detail" in raw) {
    const { code, detail } = raw as { code: unknown; detail: unknown };
    if (typeof code === "string" && typeof detail === "string") return new CommandError(code as ErrorCode, detail);
  }
  return raw;
}

/** The code of `err`, or null when it does not come from a command. */
export function errorCode(err: unknown): ErrorCode | null {
  return err instanceof CommandError ? err.code : null;
}
