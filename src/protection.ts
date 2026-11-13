import type { DocumentSession } from "./document-session";
import type { Messages } from "./messages";

export interface ProtectionDeps {
  session: Pick<DocumentSession, "isOpen" | "isProtected" | "hasPendingPassword" | "unlock" | "protect">;
  toolbar: {
    setProtected(on: boolean): void;
    setReadOnly(on: boolean): void;
    onReadOnlyRefused(cb: () => void): void;
  };
  passwords: {
    askCurrent(check: (pw: string) => boolean): Promise<boolean>;
    askNew(): Promise<string | null>;
  };
  msg: Messages["msg"];
  notify(text: string, isError?: boolean): void;
  setDirty(dirty: boolean): void;
}

/**
 * The password rules as the user meets them: a protected document is
 * read-only, the padlock removes or chooses a password, and refused actions
 * say how to unlock. The rule itself lives in `DocumentSession`.
 */
export class Protection {
  constructor(private readonly d: ProtectionDeps) {
    d.toolbar.onReadOnlyRefused(() => { this.refuse(); });
  }

  /** Closed padlock while the file has (or will be saved with) a password; protected means read-only. */
  sync(): void {
    const s = this.d.session;
    this.d.toolbar.setProtected(s.isProtected || s.hasPendingPassword);
    this.d.toolbar.setReadOnly(s.isProtected);
  }

  /** Refuses an action on a protected document, saying how to unlock it. True when the action must stop. */
  refuse(): boolean {
    if (!this.d.session.isProtected) return false;
    this.d.notify(this.d.msg("msgProtectedReadOnly"), true);
    return true;
  }

  /**
   * The padlock. On a protected file: remove its password (asks for it), which
   * makes the document editable; the next save writes it unprotected. Otherwise:
   * choose a password that the next save applies, or cancel one not saved yet.
   */
  async edit(): Promise<void> {
    const { session, passwords, msg, notify, setDirty } = this.d;
    if (!session.isOpen) return;
    if (session.isProtected) {
      if (!await passwords.askCurrent((pw) => session.unlock(pw))) return;
      this.sync();
      setDirty(true);
      notify(msg("msgUnprotected"));
      return;
    }
    if (session.hasPendingPassword) {
      session.protect(null);
      this.sync();
      notify(msg("msgProtectCancelled"));
      return;
    }
    const pw = await passwords.askNew();
    if (!pw) return;
    session.protect(pw);
    this.sync();
    setDirty(true);
    notify(msg("msgProtected"));
  }
}
