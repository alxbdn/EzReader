import { errorCode, type ErrorCode } from "./errors";
import { fmt, getTranslations, type Translations } from "./i18n";

export type MessageKey = Extract<keyof Translations, `msg${string}`>;

/** Translated text for each error code a command can return. */
const ERROR_MESSAGES: Partial<Record<ErrorCode, MessageKey>> = {
  "wrong-password": "msgErrWrongPassword",
  "empty-password": "msgErrEmptyPassword",
  "already-encrypted": "msgErrAlreadyEncrypted",
  "exists": "msgRenameExists",
  "invalid-name": "msgRenameInvalid",
  "not-an-image": "msgErrNotAnImage",
  "too-large": "msgErrTooLarge",
  "page-count-changed": "msgErrPageCountChanged",
  "invalid-pages": "msgErrInvalidPages",
  "no-ocr-language": "msgErrNoOcrLanguage",
};

export interface Messages {
  /** Translated message, with `{name}` placeholders filled. */
  msg(key: MessageKey, vars?: Record<string, string | number>): string;
  /** What went wrong, in the interface language when the error has a known code. */
  errText(err: unknown): string;
}

/** Messages in the language `language()` names at the time of each call. */
export function createMessages(language: () => string): Messages {
  const msg = (key: MessageKey, vars: Record<string, string | number> = {}): string =>
    fmt(getTranslations(language())[key] ?? key, vars);
  const errText = (err: unknown): string => {
    const code = errorCode(err);
    const key = code ? ERROR_MESSAGES[code] : undefined;
    return key ? msg(key) : String(err);
  };
  return { msg, errText };
}
