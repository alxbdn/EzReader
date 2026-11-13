import { isRedaction, type Annotation, type FormFieldValue, type RedactAnnotation, type StoredAnnotation } from "./models";

/**
 * Everything the app needs to know about the open document, in one place.
 *
 * Three paths are in play while a PDF is open:
 *  - `sourcePath`: the file the user opened (or last saved to). Its name is
 *    what dialogs and split suggest.
 *  - `saveTarget`: where Ctrl+S writes. `null` means "back to sourcePath".
 *  - `basePath`: the file that holds everything except the pending in-memory
 *    edits. Right after opening it is the source, or a temp working copy when
 *    the source had saved annotations (their burned layer is stripped so the
 *    overlay can draw them editable) or after page-manager edits. After a
 *    save it is the saved file.
 *
 * On top of `basePath`, the user may have pending in-memory edits:
 * annotations, form values and a whole-document rotation. Anything that
 * exports the document (save, compress, split, print) must start from
 * `materialize()`, which returns a file reflecting all of that — never from
 * `sourcePath` directly, which would silently drop the user's work.
 *
 * Redactions are applied first and for good: the affected pages of the base
 * are rasterised with the areas blacked out, their original content dropped,
 * and only then are the other edits written on top. They are never stored as
 * editable metadata, so reopening the file cannot bring the content back.
 */

export interface PendingEdits {
  annotations(): Annotation[];
  formFields(): FormFieldValue[];
  rotation(): number;
}

export interface SessionIO {
  /** Writes `input` + edits to `output` (the `save_annotated_pdf` command). */
  saveAnnotated(
    input: string,
    output: string,
    annotations: StoredAnnotation[],
    rotation: number,
    formFields: FormFieldValue[],
  ): Promise<void>;
  /**
   * Writes `input` to `output` with the redacted areas blacked out and the
   * original content of their pages removed (a full rewrite, no history).
   */
  redact(input: string, output: string, redactions: RedactAnnotation[]): Promise<void>;
  /** Returns a fresh, unique temp file path whose name ends with `suffix`. */
  tempPath(suffix: string): Promise<string>;
  /** Writes `input` to `output` encrypted with `password` (the `encrypt_pdf` command). */
  encrypt(input: string, output: string, password: string): Promise<void>;
}

export class DocumentSession {
  private _sourcePath: string | null = null;
  private _saveTarget: string | null = null;
  private _basePath: string | null = null;
  /** View rotation already written into `basePath` (by a previous save). */
  private _baseRotation = 0;
  private _dirty = false;
  /**
   * Password of the file on disk while it is protected (null: not protected).
   * A protected document is read-only until `unlock()` removes it. `basePath`
   * is always an unencrypted copy, used only to show the pages.
   */
  private _lock: string | null = null;
  /** Password chosen with Protect, applied by the next save (null: none). */
  private _pending: string | null = null;

  constructor(private readonly edits: PendingEdits, private readonly io: SessionIO) {}

  get isOpen(): boolean { return this._sourcePath !== null; }
  get sourcePath(): string | null { return this._sourcePath; }
  get isDirty(): boolean { return this._dirty; }

  /** The file holding everything except the pending edits. */
  get basePath(): string | null { return this._basePath; }

  /** Where a plain Save writes. */
  get saveTarget(): string | null { return this._saveTarget ?? this._sourcePath; }

  /**
   * A new document was opened from disk (the viewer shows `workingCopy ?? sourcePath`).
   * A protected file (`password` given) is shown from an unencrypted working
   * copy and is read-only until its password is removed.
   */
  opened(sourcePath: string, workingCopy: string | null, password: string | null = null): void {
    this._sourcePath = sourcePath;
    this._saveTarget = null;
    this._basePath = workingCopy ?? sourcePath;
    this._baseRotation = 0;
    this._dirty = false;
    this._lock = password;
    this._pending = null;
  }

  /** True while the file is password-protected, and so read-only. */
  get isProtected(): boolean { return this._lock !== null; }

  /** The password of the file on disk (to reopen it), or null. */
  get filePassword(): string | null { return this._lock; }

  /** True when Protect chose a password that the next save applies. */
  get hasPendingPassword(): boolean { return this._pending !== null; }

  /**
   * Removes the protection when `password` is the file's password. The
   * document becomes editable; the next save writes it without a password.
   */
  unlock(password: string): boolean {
    if (this._lock === null || password !== this._lock) return false;
    this._lock = null;
    this._dirty = true;
    return true;
  }

  /**
   * Chooses the password the next save applies (null cancels it). Once saved
   * with it, the document is protected and read-only.
   */
  protect(password: string | null): void {
    if (this._lock !== null) throw new Error("The document is already protected");
    this._pending = password;
  }

  /** The viewer reloaded `workingCopy` (e.g. after page edits) for the same source. */
  replacedWorkingCopy(workingCopy: string): void {
    this._basePath = workingCopy;
    this._baseRotation = 0; // a fresh load resets the view rotation
  }

  /**
   * The document was written to `target`, which becomes the new source and
   * base (`base` instead when the target is encrypted).
   */
  saved(target: string, base: string = target): void {
    this._sourcePath = target;
    this._saveTarget = target;
    this._basePath = base;
    this._baseRotation = this.edits.rotation();
    this._dirty = false;
  }

  /** Rotation the user applied that `basePath` does not contain yet. */
  private pendingRotation(): number {
    return (((this.edits.rotation() - this._baseRotation) % 360) + 360) % 360;
  }

  markDirty(dirty: boolean): void { this._dirty = dirty; }

  /** True when there is in-memory state that the viewed file does not contain. */
  hasPendingEdits(): boolean {
    return this.edits.annotations().length > 0
      || this.edits.formFields().length > 0
      || this.pendingRotation() !== 0;
  }

  /**
   * Returns a PDF path that reflects exactly what the user sees. When there
   * are no pending edits this is the viewed file itself; otherwise the edits
   * are written to a new temp file.
   */
  async materialize(opts: { annotations?: boolean } = {}): Promise<string> {
    const base = this._basePath;
    if (!base) throw new Error("No document is open");
    // Every copy starts here: a protected document must not leave unprotected.
    if (this._lock !== null) throw new Error("The document is protected: remove its password first");
    const keep = opts.annotations ?? true;
    if (keep && !this.hasPendingEdits()) return base;
    const out = await this.io.tempPath("current.pdf");
    await this.writeWithEdits(base, out, keep);
    return out;
  }

  /** Writes the document with all edits to `target` (Save / Save As). */
  async saveTo(target: string): Promise<void> {
    const base = this._basePath;
    if (!base) throw new Error("No document is open");
    if (this._lock !== null) throw new Error("The document is protected: remove its password first");
    const password = this._pending;
    if (password) {
      // The working copy stays unencrypted, to show the pages.
      const plain = await this.io.tempPath("saved.pdf");
      await this.writeWithEdits(base, plain);
      await this.io.encrypt(plain, target, password);
      this.saved(target, plain);
      this._pending = null;
      this._lock = password;
      return;
    }
    await this.writeWithEdits(base, target);
    this.saved(target);
  }

  /** True when saving will permanently remove content. */
  hasRedactions(): boolean {
    return this.edits.annotations().some(isRedaction);
  }

  /**
   * Writes `input` with the pending edits to `output`. Without `annotations`
   * the annotations are left out, but redactions are still applied: what
   * they hide must never come back.
   */
  private async writeWithEdits(input: string, output: string, annotations = true): Promise<void> {
    const all = this.edits.annotations();
    const redactions = all.filter(isRedaction);
    const others = annotations ? all.filter((a): a is StoredAnnotation => !isRedaction(a)) : [];
    if (redactions.length > 0) {
      const redacted = await this.io.tempPath("redacted.pdf");
      await this.io.redact(input, redacted, redactions);
      input = redacted;
    }
    await this.io.saveAnnotated(
      input,
      output,
      others,
      this.pendingRotation(),
      this.edits.formFields(),
    );
  }
}

let tempCounter = 0;

/** Builds a temp file name that cannot collide with another open document or operation. */
export function uniqueTempName(dir: string, suffix: string): string {
  tempCounter += 1;
  const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "/";
  return `${dir}${sep}ezreader-${Date.now().toString(36)}-${tempCounter}-${suffix}`;
}

/**
 * The "Microsoft Print to PDF" virtual printer is handled by writing the
 * selected pages as a vector PDF instead of rasterising them. Other printers
 * whose name merely contains "PDF" (Adobe PDF, PDFCreator, a real printer
 * named "HP PDF-ready"...) go through the normal print path.
 */
export function isMicrosoftPrintToPdf(printerName: string): boolean {
  return /^microsoft print to pdf$/i.test(printerName.trim());
}
