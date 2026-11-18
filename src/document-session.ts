import { fileNameOf, isValidFileStem, splitFileName, withFileName } from "./file-paths";
import { isRedaction, type Annotation, type FormFieldValue, type RedactAnnotation, type StoredAnnotation } from "./models";

export interface PendingEdits {
  annotations(): Annotation[];
  formFields(): FormFieldValue[];
  rotation(): number;
}

export interface SessionIO {
  saveAnnotated(
    input: string,
    output: string,
    annotations: StoredAnnotation[],
    rotation: number,
    formFields: FormFieldValue[],
  ): Promise<void>;
  redact(input: string, output: string, redactions: RedactAnnotation[]): Promise<void>;
  tempPath(suffix: string): Promise<string>;
  encrypt(input: string, output: string, password: string): Promise<void>;
}

export interface SessionSnapshot {
  sourcePath: string | null;
  saveTarget: string | null;
  basePath: string | null;
  baseRotation: number;
  dirty: boolean;
  lock: string | null;
  pending: string | null;
  pendingName: string | null;
  unsavedCopy: boolean;
  suggestedPath: string | null;
}

export class DocumentSession {
  private _sourcePath: string | null = null;
  private _saveTarget: string | null = null;
  private _basePath: string | null = null;
  private _baseRotation = 0;
  private _dirty = false;
  private _lock: string | null = null;
  private _pending: string | null = null;
  private _pendingName: string | null = null;
  private _unsavedCopy = false;
  private _suggestedPath: string | null = null;

  constructor(private readonly edits: PendingEdits, private readonly io: SessionIO) {}

  snapshot(): SessionSnapshot {
    return {
      sourcePath: this._sourcePath, saveTarget: this._saveTarget, basePath: this._basePath,
      baseRotation: this._baseRotation, dirty: this._dirty, lock: this._lock, pending: this._pending,
      pendingName: this._pendingName, unsavedCopy: this._unsavedCopy, suggestedPath: this._suggestedPath,
    };
  }

  restore(s: SessionSnapshot | null): void {
    this._sourcePath = s?.sourcePath ?? null;
    this._saveTarget = s?.saveTarget ?? null;
    this._basePath = s?.basePath ?? null;
    this._baseRotation = s?.baseRotation ?? 0;
    this._dirty = s?.dirty ?? false;
    this._lock = s?.lock ?? null;
    this._pending = s?.pending ?? null;
    this._pendingName = s?.pendingName ?? null;
    this._unsavedCopy = s?.unsavedCopy ?? false;
    this._suggestedPath = s?.suggestedPath ?? null;
  }

  adoptSavePath(savePath: string): void {
    this._sourcePath = savePath;
    this._saveTarget = null;
  }

  get isUnsavedCopy(): boolean { return this._unsavedCopy; }

  get isOpen(): boolean { return this._sourcePath !== null; }
  get sourcePath(): string | null { return this._sourcePath; }
  get isDirty(): boolean { return this._dirty; }

  get basePath(): string | null { return this._basePath; }

  get saveTarget(): string | null { return this._saveTarget ?? this._sourcePath; }

  opened(sourcePath: string, workingCopy: string | null, password: string | null = null): void {
    this._sourcePath = sourcePath;
    this._saveTarget = null;
    this._basePath = workingCopy ?? sourcePath;
    this._baseRotation = 0;
    this._dirty = false;
    this._lock = password;
    this._pending = null;
    this.forgetName();
  }

  get pendingName(): string | null { return this._pendingName; }

  get displayName(): string | null {
    const target = this.saveTarget;
    return this._pendingName ?? (target ? fileNameOf(target) : null);
  }

  get needsSave(): boolean { return this._dirty || this._pendingName !== null; }

  rename(stem: string): boolean {
    if (!this.isOpen || !isValidFileStem(stem)) return false;
    const own = fileNameOf(this.saveTarget ?? "");
    const name = stem + splitFileName(own)[1];
    this._pendingName = name === own ? null : name;
    return true;
  }

  renameFailed(): void { this._pendingName = null; }

  markUnsavedCopy(suggested: string | null = null): void {
    this._unsavedCopy = true;
    this._suggestedPath = suggested;
  }

  forgetName(): void {
    this._pendingName = null;
    this._unsavedCopy = false;
    this._suggestedPath = null;
  }

  planSave(saveAs: boolean): { dialog: string | null; renameTo: string | null } {
    const current = this.saveTarget;
    if (!current) throw new Error("No document is open");
    const pending = this._pendingName;
    if (saveAs || this._unsavedCopy) {
      const base = (this._unsavedCopy && this._suggestedPath) || current;
      return { dialog: withFileName(base, pending ?? fileNameOf(base)), renameTo: null };
    }
    return { dialog: null, renameTo: pending && pending !== fileNameOf(current) ? withFileName(current, pending) : null };
  }

  savedAs(): void { this.forgetName(); }

  get isProtected(): boolean { return this._lock !== null; }

  get filePassword(): string | null { return this._lock; }

  get hasPendingPassword(): boolean { return this._pending !== null; }

  unlock(password: string): boolean {
    if (this._lock === null || password !== this._lock) return false;
    this._lock = null;
    this._dirty = true;
    return true;
  }

  protect(password: string | null): void {
    if (this._lock !== null) throw new Error("The document is already protected");
    this._pending = password;
  }

  replacedWorkingCopy(workingCopy: string): void {
    this._basePath = workingCopy;
    this._baseRotation = 0;
  }

  saved(target: string, base: string = target): void {
    this._sourcePath = target;
    this._saveTarget = target;
    this._basePath = base;
    this._baseRotation = this.edits.rotation();
    this._dirty = false;
  }

  private pendingRotation(): number {
    return (((this.edits.rotation() - this._baseRotation) % 360) + 360) % 360;
  }

  markDirty(dirty: boolean): void { this._dirty = dirty; }

  hasPendingEdits(): boolean {
    return this.edits.annotations().length > 0
      || this.edits.formFields().length > 0
      || this.pendingRotation() !== 0;
  }

  async materialize(opts: { annotations?: boolean } = {}): Promise<string> {
    const base = this._basePath;
    if (!base) throw new Error("No document is open");
    if (this._lock !== null) throw new Error("The document is protected: remove its password first");
    const keep = opts.annotations ?? true;
    if (keep && !this.hasPendingEdits()) return base;
    const out = await this.io.tempPath("current.pdf");
    await this.writeWithEdits(base, out, keep);
    return out;
  }

  async saveTo(target: string): Promise<void> {
    const base = this._basePath;
    if (!base) throw new Error("No document is open");
    if (this._lock !== null) throw new Error("The document is protected: remove its password first");
    const password = this._pending;
    if (password) {
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

  hasRedactions(): boolean {
    return this.edits.annotations().some(isRedaction);
  }

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

export function uniqueTempName(dir: string, tag: string, suffix: string): string {
  tempCounter += 1;
  const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "/";
  return `${dir}${sep}ezreader-${tag}-${Date.now().toString(36)}-${tempCounter}-${suffix}`;
}

export function isMicrosoftPrintToPdf(printerName: string): boolean {
  return /^microsoft print to pdf$/i.test(printerName.trim());
}
