import { mountWelcomeDots } from "./welcome-dots";
import { PdfViewer, PdfPageView, renderRedactedPages, renderStraightenedPages } from "./pdf-viewer";
import { AdjustView, type PageSetting } from "./adjust-view";
import { Toolbar, isValidFileStem, splitFileName } from "./toolbar";
import { CompressModal } from "./compress-modal";
import { PrintModal } from "./print-modal";
import { SignatureModal } from "./signature-modal";
import { SignatureStore } from "./signature-store";
import { SettingsModal } from "./settings";
import { PageSidebar } from "./page-sidebar";
import { DocSearch, type SearchMatch } from "./doc-search";
import { moveItems } from "./page-order";
import type { PageAdjust, PageSlot } from "./tauri-bridge";
import { SplitModal } from "./split-modal";
import { getTranslations, applyTranslationsToDOM, fmt, type Translations } from "./i18n";
import { DocumentSession, uniqueTempName, isMicrosoftPrintToPdf } from "./document-session";
import { AnnotationStore } from "./annotation-store";
import { AnnotationHistory } from "./annotation-history";
import {
  defaultToolState,
  type Annotation,
  type FormFieldValue,
  type TextAnnotation,
  type FontFamilyValue,
  type RgbColor,
  CSS_UNITS,
} from "./models";
import type { PageTextItem, ShapeAnnotation } from "./canvas-overlay";
import { fitWithin, isImagePath, loadPicture, type Picture } from "./pictures";
import {
  openPdfDialog,
  getPageCount,
  savePdfDialog,
  saveAnnotatedPdf,
  stripAnnotationStreams,
  compressPdf,
  readAnnotations,
  getStartupArgs,
  printPages,
  extractPdfPages,
  rearrangePages,
  splitPdf,
  pickDirectoryDialog,
  redactPages,
  renameFile,
  openImageDialog,
  adjustPages,
} from "./tauri-bridge";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { mountWindowControls } from "./window-controls";
import { InfoPanel } from "./info-panel";
import { tempDir, basename } from "@tauri-apps/api/path";
import { ask } from "@tauri-apps/plugin-dialog";

// ── Zoom levels ───────────────────────────────────────────────────────────────

// Zoom levels in internal (pdf.js) scale.  Each entry = user-visible fraction × CSS_UNITS.
const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0]
  .map(z => Math.round(z * CSS_UNITS * 1000) / 1000);

function snapZoom(current: number, dir: 1 | -1): number {
  if (dir === 1) {
    return ZOOM_LEVELS.find(z => z > current + 0.005) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
  } else {
    return [...ZOOM_LEVELS].reverse().find(z => z < current - 0.005) ?? ZOOM_LEVELS[0];
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

const appWindow = getCurrentWindow();
let unlistenClose: (() => void) | null = null;

const formValues = new Map<string, string>();

let guardRegistering = false;
let fitMode: "none" | "fit-width" | "fit-height" = "none";
let pendingSignature: string | null = null;
let editingTextAnn:  TextAnnotation | null = null;
let editingShapeAnn: ShapeAnnotation | null = null;

// ── Instances ─────────────────────────────────────────────────────────────────

const viewer = new PdfViewer();
const store  = new AnnotationStore();
const toolState = defaultToolState();
const toolbar   = new Toolbar();
const history   = new AnnotationHistory();
const compressModal      = new CompressModal();
const printModal         = new PrintModal();
const sigStore           = new SignatureStore();
const sigModal           = new SignatureModal(sigStore);
const settingsModal      = new SettingsModal();
const splitModal         = new SplitModal();
const pageSidebar        = new PageSidebar(document.getElementById("page-sidebar")!);
const docSearch          = new DocSearch();
const appEl              = document.getElementById("app")!;
const adjustView         = new AdjustView(appEl, applyAdjust, () => {
  appEl.classList.remove("adjusting");
  toolbar.setBlocker(null);
});
document.getElementById("viewer-area")!.after(adjustView.el);

async function newTempPath(suffix: string): Promise<string> {
  return uniqueTempName(await tempDir(), suffix);
}

/** The open document: paths, dirty flag and the edits not yet written to disk. */
const session = new DocumentSession(
  {
    annotations: () => store.getAll(),
    formFields:  () => [...formValues.entries()].map(([name, value]): FormFieldValue => ({ name, value })),
    rotation:    () => viewer.rotation,
  },
  {
    saveAnnotated: saveAnnotatedPdf,
    redact: async (input, output, redactions) =>
      redactPages(input, output, await renderRedactedPages(input, redactions)),
    tempPath: newTempPath,
  },
);

type MessageKey = Extract<keyof Translations, `msg${string}`>;

/** Translated message for the current UI language, with `{name}` placeholders filled. */
function msg(key: MessageKey, vars: Record<string, string | number> = {}): string {
  const t = getTranslations(settingsModal.getSettings().language);
  return fmt(t[key] ?? key, vars);
}

async function applyFitMode(): Promise<void> {
  if (!viewer.isLoaded() || fitMode === "none") return;
  const scroll = document.getElementById("viewer-scroll")!;
  if (fitMode === "fit-width") {
    await viewer.setScale((scroll.clientWidth - 40) / viewer.pageWidthPt);
  } else {
    await viewer.setScale(scroll.clientHeight / viewer.pageHeightPt);
  }
  toolbar.updateZoom(viewer.scale);
}

/** Applies the zoom chosen in Settings (on open, Ctrl+0 and the magnifier button). */
async function applyDefaultZoom(): Promise<void> {
  if (!viewer.isLoaded()) return;
  const pref = settingsModal.getSettings().defaultZoom;
  if (pref === "fit-width" || pref === "fit-page") {
    fitMode = pref === "fit-width" ? "fit-width" : "fit-height";
    toolbar.updateFitMode(fitMode);
    await applyFitMode();
  } else {
    fitMode = "none";
    toolbar.updateFitMode(fitMode);
    const pct = parseFloat(pref);
    await viewer.setScale((Number.isFinite(pct) ? pct : 100) / 100 * CSS_UNITS);
  }
  toolbar.updateZoom(viewer.scale);
}

viewer.onResizeCb = async () => {
  if (fitMode !== "none") await applyFitMode();
  else viewer.reflow();
};

function onFormChange(name: string, val: string): void {
  formValues.set(name, val);
  setDirty(true);
}

viewer.setup(toolState, store, formValues, onFormChange);

// ── Per-page overlay event wiring ─────────────────────────────────────────────

function wirePageOverlay(pv: PdfPageView): void {
  const ov = pv.overlay;

  ov.onAnnotationCreated((ann: Annotation) => {
    beginChange();
    store.add(ann);
    setDirty(true);
  });

  ov.onBeforeModify(() => beginChange());

  ov.onAnnotationMoved(() => setDirty(true));

  ov.onAnnotationRemoved((ann: Annotation) => {
    store.removeRef(ann);
    setDirty(true);
  });

  ov.onAnnotationReordered((ann: Annotation, dir) => {
    store.moveLayer(ann, dir === "up" ? 1 : -1);
    setDirty(true);
  });

  ov.onTextAnnotationSelected((ann: TextAnnotation | null) => {
    editingTextAnn = ann;
    if (ann) {
      editingShapeAnn = null;
      toolbar.showTextStyles(ann);
      toolbar.hideShapeStyles();
    } else {
      toolbar.hideTextStyles();
    }
  });

  ov.onShapeAnnotationSelected((ann: ShapeAnnotation | null) => {
    editingShapeAnn = ann;
    if (ann) {
      editingTextAnn = null;
      toolbar.showShapeStyles(ann, ann.kind === "ink" && !ann.arrow ? "pencil" : "shapes");
      toolbar.hideTextStyles();
    } else {
      toolbar.hideShapeStyles();
    }
  });
}

const wiredOverlays = new WeakSet<object>();
viewer.onLayoutChanged((pageViews) => {
  for (const pv of pageViews) {
    if (!wiredOverlays.has(pv.overlay)) {
      wirePageOverlay(pv);
      wiredOverlays.add(pv.overlay);
    }
    pv.overlay.setTool(toolState.tool);
    pv.overlay.setStyle(toolState);
  }
});

// ── Focused-page tracking → toolbar page indicator ────────────────────────────

document.getElementById("viewer-scroll")!.addEventListener("focused-page-changed", (e: Event) => {
  const { page } = (e as CustomEvent<{ page: number }>).detail;
  pageSidebar.setCurrentPage(page);
});

// ── Document info ─────────────────────────────────────────────────────────────

const infoPanel = new InfoPanel(document.getElementById("app")!);
infoPanel.onClose = () => toolbar.setInfoOpen(false);

async function showInfo(): Promise<void> {
  const doc = viewer.document;
  if (!doc) return;
  const s = settingsModal.getSettings();
  const name = displayName() ?? "";
  toolbar.setInfoOpen(true);
  await infoPanel.show(doc, name, getTranslations(s.language), s.language);
}

// ── Title bar (native decorations are off) ──────────────────────────────────

mountWindowControls(document.getElementById("menubar-row")!, () => {
  const t = getTranslations(settingsModal.getSettings().language);
  return {
    minimize: t.wcMinimize ?? "Minimize",
    maximize: t.wcMaximize ?? "Maximize",
    restore:  t.wcRestore  ?? "Restore",
    close:    t.wcClose    ?? "Close",
  };
});

// ── Translations ──────────────────────────────────────────────────────────────

{
  const t = getTranslations(settingsModal.getSettings().language);
  toolbar.applyTranslations(t);
  compressModal.applyTranslations(t);
  pageSidebar.applyTranslations(t);
  printModal.applyTranslations(t);
  splitModal.applyTranslations(t);
  adjustView.applyTranslations(t);
  applyTranslationsToDOM(t);
}
settingsModal.onChange(s => {
  const t = getTranslations(s.language);
  toolbar.applyTranslations(t);
  compressModal.applyTranslations(t);
  pageSidebar.applyTranslations(t);
  printModal.applyTranslations(t);
  splitModal.applyTranslations(t);
  adjustView.applyTranslations(t);
  applyTranslationsToDOM(t);
});

// ── Startup handling ──────────────────────────────────────────────────────────

(async () => {
  try {
    const startup = await getStartupArgs();
    if (startup.filePath) {
      if (startup.shouldPrint) {
        document.getElementById("toolbar-container")!.style.display = "none";
        document.getElementById("welcome-screen")!.classList.add("hidden");
        await loadPdf(startup.filePath);
        const all = Array.from({ length: viewer.pageCount }, (_, i) => i + 1);
        await printPages(await renderForPrint(all));
        await appWindow.close();
      } else {
        await loadPdf(startup.filePath);
      }
    }
  } catch {
    // Not running in Tauri (browser preview) — skip
  }
})();

// ── Helpers ───────────────────────────────────────────────────────────────────

function showToast(msg: string, isError = false): void {
  const toast = document.getElementById("toast")!;
  toast.textContent = msg;
  toast.className = `toast${isError ? " error" : ""}`;
  setTimeout(() => toast.classList.add("hidden"), 3000);
}

/** New file name typed in the title bar, applied by the next Save. */
let pendingRename: string | null = null;

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** `path` with its file name replaced by `name` (same folder). */
function withFileName(path: string, name: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(0, cut + 1) + name;
}

/** The name shown in the title bar: the pending rename, or the file's own. */
function displayName(): string | null {
  const target = session.saveTarget;
  return pendingRename ?? (target ? fileNameOf(target) : null);
}

function setDirty(val: boolean): void {
  session.markDirty(val);
  toolbar.setDocTitle(displayName(), val);
  if (val) { void registerCloseGuard(); }
  else      { unregisterCloseGuard(); }
}

// ── Changes waiting for ✓ / ✕ ───────────────────────────────────────────────

/** Annotations (and dirty flag) as they were before the pending changes. */
let draft: { annotations: string; dirty: boolean } | null = null;

/** Call before any annotation change: records undo history and opens a draft. */
function beginChange(): void {
  history.push(store.getAll());
  if (!draft && toolbar.currentMode !== "read") {
    draft = { annotations: JSON.stringify(store.getAll()), dirty: session.isDirty };
    toolbar.setPending(true);
  }
}

/** ✓: the pending changes are kept. */
function applyDraft(): void {
  if (!draft) return;
  draft = null;
  toolbar.setPending(false);
}

/** ✕: the pending changes are thrown away. */
function discardDraft(): void {
  if (!draft) return;
  history.push(store.getAll()); // Ctrl+Z brings them back
  store.replaceAll(JSON.parse(draft.annotations) as Annotation[]);
  const dirty = draft.dirty || pendingRename !== null;
  draft = null;
  toolbar.setPending(false);
  editingTextAnn = null;
  editingShapeAnn = null;
  toolbar.hideTextStyles();
  toolbar.hideShapeStyles();
  syncAllPageOverlays();
  setDirty(dirty);
}

let closeGuardBusy = false;

async function registerCloseGuard(): Promise<void> {
  // guardRegistering is a synchronous flag that prevents a second async call
  // from registering a second listener before the first await resolves.
  if (unlistenClose || guardRegistering) return;
  guardRegistering = true;
  try {
    unlistenClose = await appWindow.onCloseRequested(async (event) => {
      if (!session.isDirty) { return; }
      // If the dialog is already open (e.g. user clicked close twice), force-close.
      if (closeGuardBusy) {
        setDirty(false);
        await appWindow.destroy();
        return;
      }
      event.preventDefault();
      closeGuardBusy = true;
      try {
        const ok = await ask(msg("msgCloseWithoutSaving"), { title: msg("msgUnsavedTitle"), kind: "warning" });
        if (ok) {
          setDirty(false);
          await appWindow.destroy();
        }
      } finally {
        closeGuardBusy = false;
      }
    });
  } finally {
    guardRegistering = false;
  }
}

function unregisterCloseGuard(): void {
  unlistenClose?.();
  unlistenClose = null;
}

/** Re-sync annotation overlays for all currently-rendered pages. */
function syncAllPageOverlays(): void {
  for (const pv of viewer.pageViews) {
    if (!pv.rendered || !pv.viewport) continue;
    pv.overlay.syncToPage(
      pv.pageNum,
      viewer.scale,
      pv.viewport.height / viewer.scale,
      store.getForPage(pv.pageNum),
      pv.viewport
    );
  }
}

async function confirmUnsaved(): Promise<boolean> {
  if (!session.isDirty) return true;
  return ask(msg("msgDiscardChanges"), { title: msg("msgUnsavedTitle"), kind: "warning" });
}

// ── Load / Save ───────────────────────────────────────────────────────────────

async function promptPassword(fp: string): Promise<void> {
  const pw = window.prompt(msg("msgPasswordPrompt"));
  if (pw === null) return;
  try {
    store.clear();
    formValues.clear();
    const saved = await readAnnotations(fp);
    for (const ann of saved) store.add(ann);

    await viewer.loadWithPassword(fp, pw);
    showThumbnails();
    session.opened(fp, null);
    history.clear();
    setDirty(false);
    setWelcomeVisible(false);
    toolbar.setLoaded(true);
    await applyDefaultZoom();
  } catch {
    showToast(msg("msgWrongPassword"), true);
  }
}

/** Fills the thumbnails sidebar from the document the viewer just opened. */
function showThumbnails(): void {
  if (!viewer.document) return;
  pageSidebar.load(viewer.document, viewer.pageDimensions, viewer.rotation);
  pageSidebar.setCurrentPage(viewer.currentPage);
  // The text changed: search again (without jumping) if a term is entered.
  docSearch.reset(viewer.document);
  void runSearch(toolbar.search.query, false);
}

// ── Search in the document ───────────────────────────────────────────────────

let searchMatches: SearchMatch[] = [];
let searchIndex = -1;

function searchText(key: "sbSearchNone" | "sbSearching", fallback: string): string {
  return getTranslations(settingsModal.getSettings().language)[key] ?? fallback;
}

/** Finds `query` in the whole document and highlights it; `jump` shows the first match from the current page on. */
async function runSearch(query: string, jump = true): Promise<void> {
  if (!query) {
    docSearch.reset(viewer.document);
    searchMatches = [];
    searchIndex = -1;
    viewer.setSearch("");
    pageSidebar.setHits(new Map());
    toolbar.search.setStatus("");
    return;
  }
  toolbar.search.setStatus(searchText("sbSearching", "Searching…"));
  const found = await docSearch.find(query, (done, total) =>
    toolbar.search.setStatus(`${Math.round((done / total) * 100)}%`));
  if (!found) return; // superseded by a newer search
  searchMatches = found;
  const hits = new Map<number, number>();
  for (const m of found) hits.set(m.page, (hits.get(m.page) ?? 0) + 1);
  pageSidebar.setHits(hits);
  if (found.length === 0) {
    searchIndex = -1;
    viewer.setSearch(query);
    toolbar.search.setStatus(searchText("sbSearchNone", "No results"), true);
    return;
  }
  const from = found.findIndex((m) => m.page >= viewer.currentPage);
  searchIndex = from === -1 ? 0 : from;
  showSearchMatch(jump);
}

function showSearchMatch(scroll: boolean): void {
  const m = searchMatches[searchIndex];
  if (!m) return;
  viewer.setSearch(toolbar.search.query, m.page, m.index, scroll);
  toolbar.search.setStatus(`${searchIndex + 1} / ${searchMatches.length}`);
}

toolbar.search.onSearch((query) => void runSearch(query));
toolbar.search.onStep((dir) => {
  if (searchMatches.length === 0) return;
  searchIndex = (searchIndex + dir + searchMatches.length) % searchMatches.length;
  showSearchMatch(true);
});

function setWelcomeVisible(visible: boolean): void {
  const el = document.getElementById("welcome-screen");
  if (el) el.classList.toggle("hidden", !visible);
}

/**
 * Loads `path` into the viewer with its saved annotations. Returns the
 * working copy actually displayed, or null when `path` itself is shown.
 */
async function showInViewer(path: string): Promise<string | null> {
  store.clear();
  formValues.clear();

  // Read annotations BEFORE viewer.load() so IntersectionObserver finds them populated
  const saved = await readAnnotations(path);
  for (const ann of saved) store.add(ann);

  // A file with saved annotations is shown from a copy whose burned layer
  // is stripped, so the overlay can draw the annotations editable.
  let workingCopy: string | null = null;
  if (saved.length > 0) {
    workingCopy = await newTempPath(`display-${await basename(path)}`);
    await stripAnnotationStreams(path, workingCopy);
  }

  await viewer.load(workingCopy ?? path);
  showThumbnails();

  history.clear();
  setWelcomeVisible(false);
  toolbar.setLoaded(true);
  toolbar.updateZoom(viewer.scale);
  return workingCopy;
}

async function loadPdf(path: string): Promise<void> {
  pendingRename = null;
  draft = null;
  toolbar.setPending(false);
  try {
    const workingCopy = await showInViewer(path);
    session.opened(path, workingCopy);
    setDirty(false);
    await applyDefaultZoom();
    if (infoPanel.isOpen) await showInfo();
  } catch (err: unknown) {
    const errText = String(err);
    if (errText.includes("PasswordException") || errText.includes("password")) {
      await promptPassword(path);
    } else {
      showToast(msg("msgOpenFailed", { err: errText }), true);
    }
  }
}

async function openFile(): Promise<void> {
  const path = await openPdfDialog();
  if (!path) return;
  await loadPdf(path);
}

async function saveFile(forceDialog: boolean): Promise<void> {
  const current = session.saveTarget;
  if (!current) return;
  let target = current;
  if (forceDialog) {
    const picked = await savePdfDialog(pendingRename ? withFileName(current, pendingRename) : current);
    if (!picked) return;
    target = picked;
  }
  // A plain Save also applies the name typed in the title bar.
  const renameTo = !forceDialog && pendingRename && pendingRename !== fileNameOf(current)
    ? withFileName(current, pendingRename) : null;
  const redacting = session.hasRedactions();
  if (redacting) {
    const ok = await ask(msg("msgRedactConfirm"), { title: msg("msgRedactTitle"), kind: "warning" });
    if (!ok) return;
  }
  try {
    await session.saveTo(target);
    if (forceDialog) pendingRename = null;
    if (renameTo) {
      const page = viewer.currentPage;
      try {
        await renameFile(target, renameTo);
      } catch (err) {
        pendingRename = null;
        setDirty(false);
        const why = String(err);
        showToast(why.includes("exists") ? msg("msgRenameExists")
          : why.includes("invalid") ? msg("msgRenameInvalid")
          : msg("msgRenameFailed", { err: why }), true);
        return;
      }
      // Show the file under its new name (pdf.js reads it from its path).
      session.saved(renameTo);
      await loadPdf(renameTo);
      viewer.goToPage(page, "instant");
      showToast(msg("msgRenamed", { name: fileNameOf(renameTo) }));
      return;
    }
    setDirty(false);
    if (redacting) {
      // Show the saved file: the redacted pages are now images and the
      // redaction boxes are gone from the editable annotations.
      const page = viewer.currentPage;
      await loadPdf(target);
      viewer.goToPage(page);
    }
    showToast(msg("msgSaved"));
  } catch (err: unknown) {
    showToast(msg("msgSaveFailed", { err: String(err) }), true);
  }
}

/** Writes a copy of what is shown (edits included) elsewhere; the open document is unchanged. */
async function exportCopy(): Promise<void> {
  const current = session.saveTarget;
  if (!current || !viewer.isLoaded()) return;
  const out = await savePdfDialog(pendingRename ? withFileName(current, pendingRename) : current);
  if (!out) return;
  try {
    const all = Array.from({ length: viewer.pageCount }, (_, i) => i + 1);
    await extractPdfPages(await session.materialize(), out, all);
    showToast(msg("msgPdfSaved"));
  } catch (err) {
    showToast(msg("msgExportFailed", { err: String(err) }), true);
  }
}

// ── Hand tool: drag the pages around ─────────────────────────────────────────

const viewerScroll = document.getElementById("viewer-scroll")!;
let panStart: { x: number; y: number; left: number; top: number; id: number } | null = null;

function handActive(): boolean {
  return toolbar.pointerMode === "hand" && toolState.tool === "select" && !pendingSignature;
}

function updateHandMode(): void {
  viewerScroll.classList.toggle("hand-mode", handActive());
}

viewerScroll.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !handActive()) return;
  if ((e.target as HTMLElement).closest("input, textarea, select, a, button")) return;
  e.preventDefault();
  panStart = { x: e.clientX, y: e.clientY, left: viewerScroll.scrollLeft, top: viewerScroll.scrollTop, id: e.pointerId };
  viewerScroll.setPointerCapture(e.pointerId);
  viewerScroll.classList.add("panning");
}, { capture: true });

viewerScroll.addEventListener("pointermove", (e) => {
  if (!panStart || e.pointerId !== panStart.id) return;
  viewerScroll.scrollLeft = panStart.left - (e.clientX - panStart.x);
  viewerScroll.scrollTop  = panStart.top  - (e.clientY - panStart.y);
});

const endPan = (e: PointerEvent) => {
  if (!panStart || e.pointerId !== panStart.id) return;
  panStart = null;
  viewerScroll.classList.remove("panning");
};
viewerScroll.addEventListener("pointerup", endPan);
viewerScroll.addEventListener("pointercancel", endPan);

/**
 * Rasterises pages for printing exactly as the user sees them, including
 * annotations, form values and rotation that are not saved yet.
 */
async function renderForPrint(pages: number[]): Promise<string[]> {
  if (!session.hasPendingEdits()) {
    // What the viewer shows (its document plus view rotation) is exactly the
    // base file, so render from it directly. This also works for
    // password-protected files, which the viewer already has open.
    return viewer.renderPagesForPrint(pages, 200);
  }
  return viewer.renderFileForPrint(await session.materialize(), pages, 200);
}

// ── Compress handler ──────────────────────────────────────────────────────────

compressModal.onConfirm(async (level) => {
  const source = session.sourcePath;
  if (!source) return;
  const out = await savePdfDialog(source);
  if (!out) return;
  try {
    const result = await compressPdf(await session.materialize(), out, level);
    const fromMB = (result.originalBytes   / 1_048_576).toFixed(1);
    const toMB   = (result.compressedBytes / 1_048_576).toFixed(1);
    const pct    = result.originalBytes > 0
      ? Math.round((1 - result.compressedBytes / result.originalBytes) * 100)
      : 0;
    showToast(msg("msgCompressed", { from: fromMB, to: toMB, pct }));
  } catch (err) {
    showToast(msg("msgCompressFailed", { err: String(err) }), true);
  }
});

// ── Page panel (thumbnails sidebar) ──────────────────────────────────────────

/**
 * Replaces the open document's pages with `slots` and shows the result.
 * Returns false when it failed (a toast says why).
 */
async function applyPageLayout(slots: PageSlot[], keepPage = 1, select: number[] = []): Promise<boolean> {
  const source = session.sourcePath;
  if (!source) return false;
  try {
    // Burn pending edits first (no-op when there are none: the viewed file is
    // used as is), then apply the new page layout as an incremental update.
    const input   = await session.materialize();
    const tmpPath = await newTempPath(`pages-${await basename(source)}`);
    await rearrangePages(input, tmpPath, slots);
    // Still the same document: Save keeps writing to the source / Save As target.
    const workingCopy = await showInViewer(tmpPath);
    session.replacedWorkingCopy(workingCopy ?? tmpPath);
    setDirty(true);
    if (keepPage > 1) viewer.goToPage(keepPage, "instant");
    pageSidebar.setSelection(select);
    return true;
  } catch (err) {
    showToast(msg("msgPagesFailed", { err: String(err) }), true);
    return false;
  }
}

/** Runs a page edit from the panel, with the panel locked meanwhile. */
async function editPages(slots: PageSlot[], keepPage: number, select: number[] = []): Promise<boolean> {
  if (!session.isOpen || !viewer.isLoaded()) return false;
  if (!toolbar.allowed()) return false;
  pageSidebar.setBusy(true);
  try {
    return await applyPageLayout(slots, keepPage, select);
  } finally {
    pageSidebar.setBusy(false);
  }
}

/** The document's pages unchanged, as slots to edit. */
function currentSlots(): PageSlot[] {
  return Array.from({ length: viewer.pageCount }, (_, i): PageSlot => ({ kind: "original", page: i + 1, rotation: 0 }));
}

/** Slots with `inserted` placed after page `after` (0 = at the start). */
async function insertSlots(after: number, inserted: PageSlot[]): Promise<void> {
  const slots = currentSlots();
  slots.splice(after, 0, ...inserted);
  const first = after + 1;
  const select = inserted.map((_, i) => first + i);
  if (await editPages(slots, first, select)) showToast(msg("msgPagesUpdated"));
}

pageSidebar.onSelectionChange((pages) => toolbar.tools.setPageSelection(pages.length));

// ── Crop / Straighten ────────────────────────────────────────────────────────

/** Opens Crop / Straighten on the pages selected in the side panel. */
function openAdjust(kind: "crop" | "straighten"): void {
  const doc = viewer.document;
  if (!doc || adjustView.isOpen) return;
  const pages = pageSidebar.selection;
  if (pages.length === 0) {
    showToast(msg(kind === "crop" ? "msgSelectPagesCrop" : "msgSelectPagesStraighten"));
    return;
  }
  cancelSignaturePlacement();
  toolbar.search.close();
  appEl.classList.add("adjusting");
  toolbar.setBlocker(() => adjustView.shake());
  adjustView.open(doc, pages, kind, viewer.rotation);
}

/**
 * ✓ of Crop / Straighten. Crops and flips stay vector (CropBox and a
 * mirroring matrix); straightened pages become pictures of the page.
 */
async function applyAdjust(settings: PageSetting[]): Promise<boolean> {
  const source = session.sourcePath;
  const doc = viewer.document;
  if (!source || !doc) return false;
  if (settings.length === 0) return true;
  try {
    const crops: PageAdjust[] = [];
    for (const s of settings) {
      if (s.mode !== "crop") continue;
      const page = await doc.getPage(s.page);
      const rotation = (page.rotate + viewer.rotation) % 360;
      const vp = page.getViewport({ scale: 1, rotation });
      const { l, t, r, b } = s.crop;
      const full = l <= 1e-4 && t <= 1e-4 && r >= 1 - 1e-4 && b >= 1 - 1e-4;
      const [x1, y1] = vp.convertToPdfPoint(l * vp.width, t * vp.height);
      const [x2, y2] = vp.convertToPdfPoint(r * vp.width, b * vp.height);
      // On a page shown sideways, left-right on screen is the page's up-down.
      const sideways = rotation % 180 !== 0;
      crops.push({
        page: s.page,
        ...(full ? {} : { crop: [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)] as [number, number, number, number] }),
        flipH: sideways ? s.flipV : s.flipH,
        flipV: sideways ? s.flipH : s.flipV,
      });
    }
    const name = await basename(source);
    let out = await session.materialize();
    if (crops.length > 0) {
      const tmp = await newTempPath(`adjust-${name}`);
      await adjustPages(out, tmp, crops);
      out = tmp;
    }
    const warps = settings.filter((s) => s.mode === "straighten");
    if (warps.length > 0) {
      // Pictures are taken without our annotation layer: the annotations
      // stay editable on top, where they were.
      const bare = await newTempPath(`straighten-src-${name}`);
      await stripAnnotationStreams(out, bare);
      const pictures = await renderStraightenedPages(bare, warps.map((s) => ({ page: s.page, quad: s.quad })));
      const tmp = await newTempPath(`straighten-${name}`);
      await redactPages(out, tmp, pictures);
      out = tmp;
    }
    const workingCopy = await showInViewer(out);
    session.replacedWorkingCopy(workingCopy ?? out);
    setDirty(true);
    const pages = settings.map((s) => s.page);
    viewer.goToPage(pages[0], "instant");
    pageSidebar.setSelection(pages);
    showToast(pages.length === 1 ? msg("msgPageAdjusted") : msg("msgPagesAdjusted", { n: pages.length }));
    return true;
  } catch (err) {
    showToast(msg("msgAdjustFailed", { err: String(err) }), true);
    return false;
  }
}

pageSidebar.onGoTo((page, instant) => viewer.goToPage(page, instant ? "instant" : "smooth"));

pageSidebar.onVisibilityChange((visible) => toolbar.updateSidebar(visible));
toolbar.updateSidebar(pageSidebar.visible);

pageSidebar.onDelete(async (pages) => {
  if (!viewer.isLoaded()) return;
  const doomed = new Set(pages);
  if (doomed.size >= viewer.pageCount) {
    showToast(msg("msgCannotDeleteAll"), true);
    return;
  }
  const slots: PageSlot[] = [];
  for (let p = 1; p <= viewer.pageCount; p++) {
    if (!doomed.has(p)) slots.push({ kind: "original", page: p, rotation: 0 });
  }
  // Stay on the page that was shown (or the one that took its place).
  const current = viewer.currentPage;
  const before  = pages.filter((p) => p < current).length;
  const keep    = Math.max(1, Math.min(current - before, slots.length));
  if (await editPages(slots, keep)) showToast(msg("msgPagesDeleted", { n: pages.length }));
});

pageSidebar.onRotate(async (pages, quarterTurns) => {
  const turn = new Set(pages);
  const rotation = (((quarterTurns * 90) % 360) + 360) % 360;
  const slots = currentSlots().map((s) => (s.kind === "original" && turn.has(s.page) ? { ...s, rotation } : s));
  await editPages(slots, viewer.currentPage, pages);
});

pageSidebar.onMove(async (pages, insertAt) => {
  const order = moveItems(
    Array.from({ length: viewer.pageCount }, (_, i) => i + 1),
    pages.map((p) => p - 1),
    insertAt,
  );
  const moved = new Set(pages);
  const select = order.flatMap((p, i) => (moved.has(p) ? [i + 1] : []));
  // Follow the page that was shown to wherever it ends up.
  const keep = order.indexOf(viewer.currentPage) + 1;
  await editPages(order.map((page): PageSlot => ({ kind: "original", page, rotation: 0 })), keep, select);
});

pageSidebar.onInsertBlank(async (after) => {
  // Same size as the page it follows (or the first page).
  const ref = viewer.pageDimensions[Math.max(0, after - 1)] ?? { width: 595.28, height: 841.89 };
  await insertSlots(after, [{ kind: "blank", width: ref.width, height: ref.height, rotation: 0 }]);
});

pageSidebar.onInsertPdf(async (after) => {
  const path = await openPdfDialog();
  if (path) await insertPdfAt(after, path);
});

/** Inserts every page of the PDF at `path` after page `after`. */
async function insertPdfAt(after: number, path: string): Promise<void> {
  let count: number;
  try {
    count = await getPageCount(path);
  } catch (err) {
    showToast(msg("msgPagesFailed", { err: String(err) }), true);
    return;
  }
  if (count < 1) return;
  await insertSlots(after, Array.from({ length: count }, (_, i): PageSlot => ({ kind: "imported", path, page: i + 1, rotation: 0 })));
}

pageSidebar.onExport(async (pages) => {
  const source = session.sourcePath;
  if (!source || !viewer.isLoaded()) return;
  const name = (await basename(source)).replace(/\.pdf$/i, "");
  const out  = await savePdfDialog(`${name} (pages).pdf`);
  if (!out) return;
  pageSidebar.setBusy(true);
  try {
    await extractPdfPages(await session.materialize(), out, pages);
    showToast(msg("msgPagesExported", { n: pages.length }));
  } catch (err) {
    showToast(msg("msgExportFailed", { err: String(err) }), true);
  } finally {
    pageSidebar.setBusy(false);
  }
});

splitModal.onConfirm(async (req) => {
  const source = session.sourcePath;
  if (!source) return;
  const t = getTranslations(settingsModal.getSettings().language);
  try {
    const dir = await pickDirectoryDialog();
    if (!dir) return;
    const fullName = await basename(source);
    const stem = fullName.replace(/\.pdf$/i, "");
    const created = await splitPdf(await session.materialize(), dir, stem, req.ranges);
    const tmpl = t.splitDoneToast ?? "Split into {n} file(s) in {dir}";
    showToast(tmpl.replace("{n}", String(created.length)).replace("{dir}", dir));
  } catch (err) {
    const tmpl = t.splitFailedToast ?? "Split failed: {err}";
    showToast(tmpl.replace("{err}", String(err)), true);
  }
});

printModal.onConfirm(async (settings) => {
  const source = session.sourcePath;
  if (!viewer.isLoaded() || !source) return;
  try {
    if (isMicrosoftPrintToPdf(settings.printerName)) {
      // Write the selected pages as a real (vector) PDF rather than a
      // rasterised one.
      const out = await savePdfDialog(source);
      if (!out) return;
      await extractPdfPages(await session.materialize(), out, settings.pageRange);
      showToast(msg("msgPdfSaved"));
    } else {
      // Rasterise and print in-process: handing the file to the shell's
      // "printto" verb fails when the default PDF app (e.g. Edge, the
      // Windows 10 default) registers no print verbs.
      const pages = await renderForPrint(settings.pageRange);
      await printPages(pages, settings.printerName, settings.copies, settings.orientation, settings.fitMode);
      showToast(msg("msgSentToPrinter"));
    }
  } catch (err) {
    showToast(msg("msgPrintFailed", { err: String(err) }), true);
  }
});

// ── Welcome screen ────────────────────────────────────────────────────────────

mountWelcomeDots(document.getElementById("welcome-screen")!);

document.getElementById("welcome-open-btn")?.addEventListener("click", async () => {
  await openFile();
});

// ── Toolbar events ────────────────────────────────────────────────────────────

toolbar.on(async (e) => {
  switch (e.type) {
    case "open":
      if (await confirmUnsaved()) await openFile();
      break;

    case "save":
      await saveFile(false);
      break;

    case "save-as":
      await saveFile(true);
      break;

    case "compress":
      if (session.isOpen) compressModal.open();
      break;

    case "rotate":
      if (viewer.isLoaded()) {
        await viewer.rotate();
        pageSidebar.setRotation(viewer.rotation, viewer.pageDimensions);
        setDirty(true);
      }
      break;

    case "pages":
      if (viewer.isLoaded() && viewer.document) {
        pageSidebar.focus();
      }
      break;

    case "toggle-sidebar":
      if (viewer.isLoaded()) pageSidebar.toggle();
      break;

    case "split":
      if (viewer.isLoaded() && session.isOpen) {
        splitModal.open(viewer.pageCount);
      }
      break;

    case "zoom-in":
    case "zoom-out":
      if (viewer.isLoaded()) {
        fitMode = "none"; toolbar.updateFitMode(fitMode);
        await viewer.setScale(snapZoom(viewer.scale, e.type === "zoom-in" ? 1 : -1));
        toolbar.updateZoom(viewer.scale);
      }
      break;

    case "zoom-reset":
      await applyDefaultZoom();
      break;

    case "zoom-set":
      if (viewer.isLoaded()) {
        fitMode = "none"; toolbar.updateFitMode(fitMode);
        await viewer.setScale(e.scale);
        toolbar.updateZoom(viewer.scale);
      }
      break;

    case "fit-width":
      if (viewer.isLoaded()) {
        fitMode = fitMode === "fit-width" ? "none" : "fit-width";
        toolbar.updateFitMode(fitMode);
        if (fitMode === "fit-width") await applyFitMode();
      }
      break;

    case "fit-height":
      if (viewer.isLoaded()) {
        fitMode = fitMode === "fit-height" ? "none" : "fit-height";
        toolbar.updateFitMode(fitMode);
        if (fitMode === "fit-height") await applyFitMode();
      }
      break;

    case "zoom-real":
      if (viewer.isLoaded()) {
        fitMode = "none"; toolbar.updateFitMode(fitMode);
        const ppi = settingsModal.getSettings().pxPerInch;
        await viewer.setScale((Number.isFinite(ppi) && ppi > 0 ? ppi : 96) / 72);
        toolbar.updateZoom(viewer.scale);
      }
      break;

    case "columns":
      viewer.setColumns(e.n);
      if (e.n != null && viewer.scrollMode === "horizontal") viewer.setScrollMode("vertical");
      toolbar.updateLayout(viewer.forcedColumns, viewer.scrollMode);
      break;

    case "scroll-mode":
      viewer.setScrollMode(e.mode);
      toolbar.updateLayout(viewer.forcedColumns, viewer.scrollMode);
      break;

    case "info":
      if (infoPanel.isOpen) { infoPanel.close(); toolbar.setInfoOpen(false); }
      else { await showInfo(); }
      break;

    case "export":
      await exportCopy();
      break;

    case "rename":
      if (!session.isOpen) break;
      if (!isValidFileStem(e.stem)) { showToast(msg("msgRenameInvalid"), true); break; }
      {
        const own = fileNameOf(session.saveTarget ?? "");
        const name = e.stem + splitFileName(own)[1];
        pendingRename = name === own ? null : name;
        setDirty(session.isDirty || pendingRename !== null);
      }
      break;

    case "mode-change":
      document.body.dataset["mode"] = e.mode;
      break;

    case "pointer-mode":
      updateHandMode();
      break;

    case "select-all-pages":
      if (viewer.isLoaded()) { pageSidebar.setVisible(true); pageSidebar.selectAll(); }
      break;

    case "insert-blank":
      pageSidebar.requestInsertBlank();
      break;

    case "insert-pdf":
      pageSidebar.requestInsertPdf();
      break;

    case "extract-pages":
      pageSidebar.requestExportSelection();
      break;

    case "tool-change":
      toolState.tool = e.tool;
      document.getElementById("viewer-scroll")!.classList.toggle("etext-mode", e.tool === "etext");
      updateHandMode();
      for (const pv of viewer.pageViews) pv.overlay.setTool(e.tool);
      editingTextAnn  = null;
      editingShapeAnn = null;
      if (e.tool !== "signature") cancelSignaturePlacement();
      break;

    case "style-change":
      Object.assign(toolState, e.style);
      for (const pv of viewer.pageViews) pv.overlay.setStyle(toolState);
      if (editingTextAnn) {
        const pv = viewer.pageViews.find(p => p.pageNum === editingTextAnn!.page);
        pv?.overlay.applyTextAnnotationStyle(editingTextAnn, e.style);
        setDirty(true);
      } else if (editingShapeAnn) {
        const pv = viewer.pageViews.find(p => p.pageNum === editingShapeAnn!.page);
        pv?.overlay.applyShapeAnnotationStyle(editingShapeAnn, e.style.shapeColor, e.style.strokeWidth, e.style.fillColor, e.style.opacity);
        setDirty(true);
      }
      break;

    case "layer-change": {
      const ann = editingTextAnn ?? editingShapeAnn;
      if (ann) {
        // The overlay reorders and reports back through onAnnotationReordered.
        const pv = viewer.pageViews.find(p => p.pageNum === ann.page);
        pv?.overlay.reorderAnnotation(ann, e.dir);
      }
      break;
    }

    case "signature":
      sigModal.open();
      break;

    case "adjust":
      openAdjust(e.kind);
      break;

    case "image-browse": {
      const path = await openImageDialog();
      if (!path) break;
      const pv = viewer.pageViews.find((p) => p.pageNum === viewer.currentPage);
      if (!pv) break;
      // Centred on the part of the page in view.
      const r = pv.overlay.screenRect;
      const view = document.getElementById("viewer-scroll")!.getBoundingClientRect();
      const top = Math.max(r.top, view.top), bottom = Math.min(r.bottom, view.bottom);
      await placePicture(path, pv, r.width / 2, (top + bottom) / 2 - r.top);
      break;
    }

    case "signature-use": {
      const sig = sigStore.getAll().find((x) => x.id === e.id);
      if (sig) {
        sigStore.touch(sig.id);
        startSignaturePlacement(sig.imageDataUrl.split(",")[1] ?? sig.imageDataUrl);
        refreshSignatures();
      }
      break;
    }

    case "signature-delete":
      sigStore.delete(e.id);
      refreshSignatures();
      break;

    case "draft-apply":
      applyDraft();
      break;

    case "draft-discard":
      discardDraft();
      break;

    case "print":
      if (viewer.isLoaded()) printModal.open(viewer.pageCount, viewer.currentPage, { w: viewer.pageWidthPt, h: viewer.pageHeightPt });
      break;

    case "settings":
      settingsModal.open();
      break;

    case "undo": {
      const prev = history.undo(store.getAll());
      if (prev) { store.replaceAll(prev); syncAllPageOverlays(); setDirty(true); }
      break;
    }

    case "redo": {
      const next = history.redo(store.getAll());
      if (next) { store.replaceAll(next); syncAllPageOverlays(); setDirty(true); }
      break;
    }
  }
});

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

document.addEventListener("keydown", async (e) => {
  const tag = (document.activeElement as HTMLElement)?.tagName ?? "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
      (document.activeElement as HTMLElement)?.isContentEditable) return;

  const ctrl  = e.ctrlKey || e.metaKey;
  const shift = e.shiftKey;

  if (ctrl && !shift && e.key === "z") {
    e.preventDefault();
    const prev = history.undo(store.getAll());
    if (prev) { store.replaceAll(prev); syncAllPageOverlays(); setDirty(true); }
    return;
  }
  if (ctrl && (e.key === "y" || (shift && e.key === "Z"))) {
    e.preventDefault();
    const next = history.redo(store.getAll());
    if (next) { store.replaceAll(next); syncAllPageOverlays(); setDirty(true); }
    return;
  }
  if (ctrl && !shift && e.key === "o") {
    e.preventDefault();
    if (!toolbar.allowed()) return;
    if (await confirmUnsaved()) await openFile();
    return;
  }
  if (ctrl && shift && e.key === "S") {
    e.preventDefault();
    if (!toolbar.allowed()) return;
    await saveFile(true);
    return;
  }
  if (ctrl && !shift && e.key === "s") {
    e.preventDefault();
    if (!toolbar.allowed()) return;
    await saveFile(false);
    return;
  }
  if (ctrl && !shift && e.key === "p") {
    e.preventDefault();
    if (!toolbar.allowed()) return;
    if (viewer.isLoaded()) printModal.open(viewer.pageCount, viewer.currentPage, { w: viewer.pageWidthPt, h: viewer.pageHeightPt });
    return;
  }
  if (ctrl && !shift && e.key.toLowerCase() === "f") {
    e.preventDefault();
    if (viewer.isLoaded()) toolbar.search.open();
    return;
  }
  if (ctrl && shift && e.key === "E") {
    e.preventDefault();
    if (!toolbar.allowed()) return;
    if (session.isOpen) compressModal.open();
    return;
  }
  if (ctrl && (e.key === "+" || e.key === "=")) {
    e.preventDefault();
    if (viewer.isLoaded()) { fitMode = "none"; toolbar.updateFitMode(fitMode); await viewer.setScale(snapZoom(viewer.scale, 1));  toolbar.updateZoom(viewer.scale); }
    return;
  }
  if (ctrl && e.key === "-") {
    e.preventDefault();
    if (viewer.isLoaded()) { fitMode = "none"; toolbar.updateFitMode(fitMode); await viewer.setScale(snapZoom(viewer.scale, -1)); toolbar.updateZoom(viewer.scale); }
    return;
  }
  if (ctrl && e.key === "0") {
    e.preventDefault();
    await applyDefaultZoom();
    return;
  }
  if (!ctrl && (e.key === "ArrowRight" || e.key === "PageDown")) {
    if (viewer.isLoaded()) { e.preventDefault(); viewer.goToPage(viewer.currentPage + viewer.columnCount); }
    return;
  }
  if (!ctrl && (e.key === "ArrowLeft" || e.key === "PageUp")) {
    if (viewer.isLoaded()) { e.preventDefault(); viewer.goToPage(viewer.currentPage - viewer.columnCount); }
    return;
  }
});

// ── Signature events ──────────────────────────────────────────────────────────

// Floating signature preview that follows the cursor during placement
const sigPreview = document.createElement("img");
sigPreview.className = "sig-preview";
document.body.appendChild(sigPreview);

function showSigPreview(b64: string): void {
  sigPreview.src = `data:image/png;base64,${b64}`;
  sigPreview.style.display = "block";
}

function hideSigPreview(): void {
  sigPreview.style.display = "none";
  sigPreview.src = "";
}

document.addEventListener("mousemove", (e: MouseEvent) => {
  if (!pendingSignature) return;
  sigPreview.style.left = `${e.clientX}px`;
  sigPreview.style.top  = `${e.clientY}px`;
});

function startSignaturePlacement(imageData: string): void {
  pendingSignature = imageData;
  showSigPreview(imageData);
  document.getElementById("viewer-scroll")!.style.cursor = "none";
  updateHandMode();
  showToast(msg("msgPlaceSignature"));
}

function cancelSignaturePlacement(): void {
  if (!pendingSignature) return;
  pendingSignature = null;
  hideSigPreview();
  document.getElementById("viewer-scroll")!.style.cursor = "";
  updateHandMode();
}

/** Saved signatures, shown in the Sign options. */
function refreshSignatures(): void {
  toolbar.setSignatures(sigStore.getAll().map((s) => ({ id: s.id, dataUrl: s.imageDataUrl })));
}
refreshSignatures();

sigModal.onSignatureReady((imageData: string) => {
  refreshSignatures();
  startSignaturePlacement(imageData);
});

// Click on a page wrapper to place signature
document.getElementById("viewer-scroll")!.addEventListener("click", (e: MouseEvent) => {
  if (!pendingSignature) return;
  const wrapper = (e.target as HTMLElement).closest(".page-wrapper") as HTMLElement | null;
  if (!wrapper) return;

  const pageNum = parseInt(wrapper.dataset.page ?? "0");
  const pv = viewer.pageViews.find(p => p.pageNum === pageNum);
  if (!pv) return;

  const rect = wrapper.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  beginChange();
  const ann = pv.overlay.placeSignature(x, y, pendingSignature, 150, 60);
  store.add(ann);
  setDirty(true);
  cancelSignaturePlacement();
});

// ── Context menu ──────────────────────────────────────────────────────────────

const ctxMenu    = document.getElementById("ctx-menu")!;
const ctxCopyBtn = document.getElementById("ctx-copy") as HTMLButtonElement;

document.addEventListener("contextmenu", (e: MouseEvent) => {
  e.preventDefault();
  const sel = window.getSelection()?.toString() ?? "";
  ctxCopyBtn.disabled = sel.length === 0;
  ctxMenu.style.left = `${e.clientX}px`;
  ctxMenu.style.top  = `${e.clientY}px`;
  ctxMenu.classList.remove("hidden");
});

ctxCopyBtn.addEventListener("click", async () => {
  const text = window.getSelection()?.toString() ?? "";
  if (text) await navigator.clipboard.writeText(text);
  ctxMenu.classList.add("hidden");
});

document.addEventListener("mousedown", (e: MouseEvent) => {
  if (!ctxMenu.contains(e.target as Node)) ctxMenu.classList.add("hidden");
});

// ── Escape / zoom keyboard shortcuts (window-level) ──────────────────────────

window.addEventListener("keydown", async (e: KeyboardEvent) => {
  if (e.ctrlKey && (e.key === "+" || e.key === "=" || e.key === "-")) {
    if (!viewer.isLoaded()) return;
    e.preventDefault();
    fitMode = "none"; toolbar.updateFitMode(fitMode);
    await viewer.setScale(snapZoom(viewer.scale, e.key === "-" ? -1 : 1));
    toolbar.updateZoom(viewer.scale);
    return;
  }
  const active = document.activeElement as HTMLElement | null;
  const typing = !!active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT" || active.isContentEditable);
  if (typing) return;
  if (e.key === "Enter" && toolbar.isPending) {
    // Enter validates the pending changes (✓).
    e.preventDefault();
    applyDraft();
    return;
  }
  if (e.key !== "Escape") return;
  if (pendingSignature) {
    cancelSignaturePlacement();
    showToast(msg("msgSignatureCancelled"));
  } else if (toolbar.isPending) {
    // Escape discards them (✕).
    discardDraft();
  } else if (toolState.tool !== "select") {
    toolbar.clearActiveTool();
  }
});

// ── Edit text: click existing words to replace them ──────────────────────────

/** PDF font family that looks like the one pdf.js reports for the text. */
function familyOf(css: string | undefined): FontFamilyValue {
  if (!css) return "helvetica";
  if (/mono|courier/i.test(css)) return "courier";
  if (/serif/i.test(css) && !/sans/i.test(css)) return "times";
  return "helvetica";
}

/** The page's colour around `r` (screen px), read from the rendered page. */
function backgroundAround(wrapper: HTMLElement, r: DOMRect): RgbColor {
  const canvas = wrapper.querySelector<HTMLCanvasElement>(".page-canvas");
  const ctx = canvas?.getContext("2d", { willReadFrequently: true });
  if (!canvas || !ctx) return { r: 255, g: 255, b: 255 };
  const box = canvas.getBoundingClientRect();
  const kx = canvas.width / box.width, ky = canvas.height / box.height;
  const counts = new Map<string, number>();
  const points = [
    [r.left - 3, r.top - 2], [r.right + 3, r.top - 2], [r.left - 3, r.bottom + 2], [r.right + 3, r.bottom + 2],
    [r.left + r.width / 2, r.top - 2], [r.left + r.width / 2, r.bottom + 2],
  ];
  let best: RgbColor = { r: 255, g: 255, b: 255 }, bestN = 0;
  for (const [x, y] of points) {
    const px = Math.round((x - box.left) * kx), py = Math.round((y - box.top) * ky);
    if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
    const [cr, cg, cb] = ctx.getImageData(px, py, 1, 1).data;
    const key = `${cr},${cg},${cb}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (n > bestN) { bestN = n; best = { r: cr, g: cg, b: cb }; }
  }
  return best;
}

document.getElementById("viewer-scroll")!.addEventListener("click", (e: MouseEvent) => {
  if (toolState.tool !== "etext") return;
  const wrapper = (e.target as HTMLElement).closest<HTMLElement>(".page-wrapper");
  const pv = wrapper && viewer.pageViews.find((p) => p.pageNum === Number(wrapper.dataset.page));
  if (!wrapper || !pv) return;
  // Text replaced earlier is edited again, not the original under it.
  if (pv.overlay.editTextAt(e.clientX, e.clientY)) { e.preventDefault(); return; }
  const span = (e.target as HTMLElement).closest<HTMLElement>(".page-text-layer span");
  if (!span || !span.dataset.pdf) return;
  e.preventDefault();
  window.getSelection()?.removeAllRanges();
  const [x, y, fontSize, width] = span.dataset.pdf.split(",").map(Number);
  const item: PageTextItem = {
    text: span.dataset.text ?? span.textContent ?? "",
    x, y, width, fontSize,
    family: familyOf(span.dataset.family),
    background: backgroundAround(wrapper, span.getBoundingClientRect()),
  };
  // The new text starts out like the old one; the options can change it.
  const style = {
    color: { r: 0, g: 0, b: 0 }, fontSize: Math.max(4, Math.round(fontSize)),
    bold: false, italic: false, underline: false, fontFamily: item.family, backgroundColor: null,
  };
  Object.assign(toolState, { ...style, textBackground: null });
  for (const p of viewer.pageViews) p.overlay.setStyle(toolState);
  toolbar.showTextStyles(style);
  pv.overlay.replaceText(item);
});

// ── Pictures: placed on a page, or added as a page ───────────────────────────

/** Reads the picture at `path`; shows an error and returns null if it can't. */
async function readPicture(path: string): Promise<Picture | null> {
  try {
    return await loadPicture(path);
  } catch (err) {
    showToast(msg("msgImageFailed", { err: String(err) }), true);
    return null;
  }
}

/** Places the picture at `path` centred on (x, y), canvas px of `pv`'s page. */
async function placePicture(path: string, pv: PdfPageView, x: number, y: number): Promise<void> {
  const pic = await readPicture(path);
  if (!pic) return;
  // Natural size at 96 dpi, at most 60 % of the page.
  const page = pv.overlay.pageSizePt;
  const size = fitWithin(pic.width * 0.75, pic.height * 0.75, page.width * 0.6, page.height * 0.6);
  beginChange();
  const ann = pv.overlay.placeImage(x, y, pic.data, size.width, size.height);
  store.add(ann);
  setDirty(true);
  // Ready to move and resize right away.
  if (toolState.tool !== "select") toolbar.clearActiveTool();
}

/** Adds each picture as a new page, after page `after`. */
async function insertPictures(after: number, paths: string[]): Promise<void> {
  const slots: PageSlot[] = [];
  for (const path of paths) {
    const pic = await readPicture(path);
    if (pic) slots.push({ kind: "image", data: pic.data, rotation: 0 });
  }
  if (slots.length > 0) await insertSlots(after, slots);
}

// ── Highlighter: applies to the text selected while it is on ─────────────────

document.getElementById("viewer-scroll")!.addEventListener("mouseup", () => {
  if (toolState.tool !== "highlight" && toolState.tool !== "redact-text") return;
  // Let the browser finish the selection first.
  setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const rects: DOMRect[] = [];
    for (let i = 0; i < sel.rangeCount; i++) rects.push(...Array.from(sel.getRangeAt(i).getClientRects()));
    sel.removeAllRanges();
    const byPage = new Map<typeof viewer.pageViews[number], { left: number; top: number; right: number; bottom: number }[]>();
    const seen = new Set<string>();
    for (const r of rects) {
      if (r.width < 1 || r.height < 1) continue;
      const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const pv = viewer.pageViews.find((p) => {
        const b = p.overlay.screenRect;
        return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom;
      });
      if (!pv) continue;
      const b = pv.overlay.screenRect;
      const list = byPage.get(pv) ?? [];
      const next = { left: r.left - b.left, top: r.top - b.top, right: r.right - b.left, bottom: r.bottom - b.top };
      // A span inside the selection reports its box and its text's box: merge
      // what sits on the same line so overlaps don't darken twice.
      const same = list.find((o) => {
        const v = Math.min(o.bottom, next.bottom) - Math.max(o.top, next.top);
        return v > 0.5 * Math.min(o.bottom - o.top, next.bottom - next.top) && next.left <= o.right + 1 && next.right >= o.left - 1;
      });
      if (same) {
        same.left = Math.min(same.left, next.left); same.right = Math.max(same.right, next.right);
        same.top = Math.min(same.top, next.top); same.bottom = Math.max(same.bottom, next.bottom);
      } else list.push(next);
      byPage.set(pv, list);
    }
    for (const [pv, list] of byPage) {
      if (toolState.tool === "redact-text") pv.overlay.applyRedactText(list);
      else pv.overlay.applyHighlight(list, toolState.highlightColor, toolState.highlightOpacity);
    }
  }, 0);
});

// ── Ctrl+wheel zoom ───────────────────────────────────────────────────────────

document.getElementById("viewer-scroll")!.addEventListener("wheel", async (e: WheelEvent) => {
  if (!e.ctrlKey && viewer.scrollMode === "horizontal" && !e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    // A plain mouse wheel moves along the row of pages.
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const lines = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? el.clientWidth : 1;
    el.scrollLeft += e.deltaY * lines;
    return;
  }
  if (!e.ctrlKey || !viewer.isLoaded()) return;
  e.preventDefault();
  fitMode = "none"; toolbar.updateFitMode(fitMode);
  await viewer.setScale(snapZoom(viewer.scale, e.deltaY < 0 ? 1 : -1));
  toolbar.updateZoom(viewer.scale);
}, { passive: false });

// ── Drag-drop ─────────────────────────────────────────────────────────────────

/**
 * Files dropped on the window. In the side panel, PDFs and pictures are
 * inserted where they land; a picture dropped on a page is placed there;
 * otherwise a PDF is opened.
 */
async function handleDrop(paths: string[], at: { x: number; y: number } | null, gap: number | null): Promise<void> {
  const pdfs = paths.filter((p) => p.toLowerCase().endsWith(".pdf"));
  const images = paths.filter(isImagePath);
  if (pdfs.length === 0 && images.length === 0) {
    if (paths.length > 0) showToast(msg("msgOnlyPdf"), true);
    return;
  }
  if (gap !== null && viewer.isLoaded()) {
    if (!toolbar.allowed()) return;
    if (images.length > 0) await insertPictures(gap, images);
    else await insertPdfAt(gap, pdfs[0]);
    return;
  }
  if (images.length > 0 && at && viewer.isLoaded()) {
    const wrapper = document.elementFromPoint(at.x, at.y)?.closest<HTMLElement>(".page-wrapper");
    const pv = wrapper && viewer.pageViews.find((v) => v.pageNum === Number(wrapper.dataset.page));
    if (pv) {
      const r = pv.overlay.screenRect;
      await placePicture(images[0], pv, at.x - r.left, at.y - r.top);
      return;
    }
  }
  if (pdfs.length > 0) {
    if (await confirmUnsaved()) void loadPdf(pdfs[0]);
  } else {
    showToast(msg("msgDropImageOnPage"));
  }
}

(async () => {
  try {
    await appWindow.onDragDropEvent(async (event) => {
      const p = event.payload;
      // Physical pixels → CSS pixels of the page.
      const at = "position" in p ? { x: p.position.x / devicePixelRatio, y: p.position.y / devicePixelRatio } : null;
      if (p.type === "over" || p.type === "enter") {
        document.body.classList.add("drag-over");
        if (at && viewer.isLoaded()) pageSidebar.externalDropAt(at.x, at.y);
      } else if (p.type === "leave") {
        document.body.classList.remove("drag-over");
        pageSidebar.hideExternalDrop();
      } else if (p.type === "drop") {
        document.body.classList.remove("drag-over");
        const gap = at && viewer.isLoaded() ? pageSidebar.externalDropAt(at.x, at.y) : null;
        pageSidebar.hideExternalDrop();
        await handleDrop(p.paths, at, gap);
      }
    });
  } catch {
    // Fallback for dev server / browser preview
  }
})();
