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
  | "no-ocr-language"
  | "not-allowed"
  | "other";

export class CommandError extends Error {
  constructor(readonly code: ErrorCode, detail: string) {
    super(detail);
    this.name = "CommandError";
  }

  override toString(): string { return this.message; }
}

export function toCommandError(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "code" in raw && "detail" in raw) {
    const { code, detail } = raw as { code: unknown; detail: unknown };
    if (typeof code === "string" && typeof detail === "string") return new CommandError(code as ErrorCode, detail);
  }
  return raw;
}

export function errorCode(err: unknown): ErrorCode | null {
  return err instanceof CommandError ? err.code : null;
}
