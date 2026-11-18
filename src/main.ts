import { errorCode } from "./errors";
import { createMessages } from "./messages";
import { Protection } from "./protection";
import { setUpCompress } from "./compress-flow";
import { setUpExport } from "./export-flow";
import type { Feedback } from "./backend";
import { tauriBackend } from "./tauri-backend";
import { fileNameOf } from "./file-paths";
import { mountWelcomeDots } from "./welcome-dots";
import { WelcomePrefs } from "./welcome-prefs";
import { UpdateBadge } from "./update-badge";
import { PdfViewer, PdfPageView, renderRedactedPages, renderStraightenedPages } from "./pdf-viewer";
import { AdjustView, type PageSetting } from "./adjust-view";
import { Toolbar } from "./toolbar";
import { Presentation } from "./presentation";
import { CompressModal } from "./compress-modal";
import { ExportModal } from "./export-modal";
import { OcrModal, savedLanguage as ocrLanguage } from "./ocr-modal";
import { PasswordModal } from "./password-modal";
import { PrintModal } from "./print-modal";
import { SignatureModal } from "./signature-modal";
import { SignatureStore } from "./signature-store";
import { SettingsModal, applyPageBrightness } from "./settings";
import { saveChangesDialog } from "./confirm-dialog";
import { PageSidebar } from "./page-sidebar";
import { DocSearch, type SearchMatch } from "./doc-search";
import { planDelete, planInsert, planMove, planRotate, type PagePlan } from "./page-layout";
import { formatPageRange } from "./page-range";
import type { PageSlot } from "./tauri-bridge";
import { buildPageAdjustments } from "./page-adjustment";
import { SplitModal } from "./split-modal";
import { getTranslations, applyTranslationsToDOM, fmt, type Translations } from "./i18n";
import { DocumentSession, uniqueTempName, isMicrosoftPrintToPdf } from "./document-session";
import { AnnotationSession } from "./annotation-session";
import { PageHistory } from "./page-history";
import { ToolSelection } from "./tool-selection";
import {
  type Annotation,
  type FormFieldValue,
  type HighlightAnnotation,
  type TextAnnotation,
  type FontFamilyValue,
  type RgbColor,
  CSS_UNITS,
  type InkVector,
  type SignatureAnnotation,
} from "./models";
import { StudioPanel } from "./studio-panel";
import { SIGNATURE_INK } from "./signature-ink";
import type { PageTextItem, ShapeAnnotation } from "./canvas-overlay";
import { fitWithin, isImagePath, openKind, picturesDocument, type Picture } from "./pictures";
import {
  openPdfDialog,
  openDocumentDialog,
  picturesToNewPdf,
  getPageCount,
  listSystemFonts,
  savePdfDialog,
  loadPictureFile,
  saveAnnotatedPdf,
  stripAnnotationStreams,
  ocrImage,
  ocrLanguages,
  readAnnotations,
  getStartupArgs,
  printPages,
  extractPdfPages,
  openPagesInNewWindow,
  rearrangePages,
  splitPdf,
  pickDirectoryDialog,
  redactPages,
  straightenPages,
  renameFile,
  openImageDialog,
  openImagesDialog,
  adjustPages,
  encryptPdf,
  decryptPdf,
  tempTag,
  setLauncherRatioLock,
  setResizeBorder,
  isDefaultPdfReader,
  checkForUpdate,
  installUpdate,
  registerPdfHandler,
  registerPrintVerb,
  unregisterPdfHandler,
  openDefaultAppsSettings,
  tabDragHover,
  tabDragEnd,
  moveTab,
  type StartupArgs,
} from "./tauri-bridge";
import { DocTabs, type DocTab } from "./doc-tabs";
import { isMac, macShortcuts } from "./platform";
import { TabStrip } from "./tab-strip";
import type { SessionSnapshot } from "./document-session";
import type { AnnotationSnapshot } from "./annotation-session";
import type { DocState } from "./page-history";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { keepCentred, pageFitScale, planWindowFit, VIEWER_PADDING } from "./window-fit";
import { mountWindowControls } from "./window-controls";
import { menuOwnsKey } from "./mac-menu";
import { InfoPanel } from "./info-panel";
import { tempDir, basename } from "@tauri-apps/api/path";
import { ask } from "@tauri-apps/plugin-dialog";

// ── Zoom levels ───────────────────────────────────────────────────────────────

// Zoom levels in internal (pdf.js) scale.  Each entry = user-visible fraction × CSS_UNITS.
const ZOOM_LEVELS = [0.1, 0.15, 0.2, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0]
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
let fitMode: "none" | "fit-width" | "fit-height" | "fit-page" = "none";
let pendingSignature: string | null = null;
/** The pen strokes of the pending signature, when it was drawn. */
let pendingSignatureVector: InkVector | undefined;
let editingTextAnn:      TextAnnotation | null = null;
let editingShapeAnn:     ShapeAnnotation | null = null;
let editingHighlightAnn: HighlightAnnotation | null = null;
/** The selected drawn signature, whose ink the Sign options change. */
let editingSignatureAnn: SignatureAnnotation | null = null;

// ── Instances ─────────────────────────────────────────────────────────────────

const viewer = new PdfViewer();
// Scans and photos: their words can be selected and copied, read in the
// background by the OCR built into the system.
viewer.liveText.setRecognizer((data) => ocrImage(data, ocrLanguage()));
/** The active tool, its style presets and the one selected annotation. */
const tools = new ToolSelection();
const toolState = tools.state;
const toolbar   = new Toolbar();
/** The documents open in this window. Only the active one is loaded. */
const docTabs = new DocTabs<ParkedDoc>();
/** The file the viewer shows for the active tab. */
let shownPath: string | null = null;
/** A tab is being parked or brought back. */
let tabSwitch: Promise<void> | null = null;

const tabStrip = new TabStrip(document.getElementById("menubar-row")!, toolbar.titleElement, {
  activate: (id) => void switchTab(id),
  close: (id) => void closeTab(id),
  move: (id, index) => { docTabs.move(id, index); renderTabs(); },
  hover: (x, y) => tabDragHover(x, y),
  hoverEnd: () => void tabDragEnd().catch(() => {}),
  detach: (id, x, y) => void detachTab(id, x, y),
});

/** Annotations and undo / redo. */
const annotations: AnnotationSession = new AnnotationSession({
  gateEnabled: () => false,
  isDirty: (): boolean => session.isDirty,
});
annotations.onChange(() => { setDirty(true); pageHistory.clearRedo(); });
annotations.onPendingChange((pending) => toolbar.setPending(pending));
/** Page edits of the open document, undone once its annotation changes are. */
const pageHistory = new PageHistory();
/** A page edit or its undo is being applied. */
let pageEditBusy = false;
const compressModal      = new CompressModal();
const exportModal        = new ExportModal();
const ocrModal = new OcrModal({
  pageCount: () => (viewer.isLoaded() ? viewer.pageCount : 0),
  currentPage: () => viewer.currentPage,
  materialize: () => session.materialize({ annotations: false }),
  renderPage: async (path, n) => {
    let data = "";
    await viewer.renderFilePages(path, [n], 300, "image/png", async (d) => { data = d; });
    return data;
  },
  languages: ocrLanguages,
  recognize: ocrImage,
  pickPicture: async () => {
    const path = await openImageDialog();
    if (!path) return null;
    const pic = await loadPictureFile(path);
    const mime = pic.data.startsWith("/9j/") ? "image/jpeg" : "image/png";
    return { dataUrl: `data:${mime};base64,${pic.data}`, name: fileNameOf(path) };
  },
  copy: (text) => navigator.clipboard.writeText(text),
  errText: (err) => messages.errText(err),
});
const passwordModal      = new PasswordModal();
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

// ── Studio panel: tool options and the list of annotations ──────────────────

const studio = new StudioPanel(toolbar.toolOptions, {
  list: () => annotations.all(),
  selected: () => tools.selected,
  pick: (ann) => pickAnnotation(ann),
  remove: (ann) => removeAnnotation(ann),
});
document.getElementById("viewer-area")!.append(studio.el);
// The common fonts of this computer, offered for text (embedded when saved).
void listSystemFonts().then((names) => toolbar.setSystemFonts(names ?? [])).catch(() => {});
toolbar.onToolOptions((title, mode) => {
  studio.setOptions(title);
  studio.setShown(mode !== "read");
});
annotations.onContentChange(() => studio.refresh());
tools.onSelect((ann) => {
  studio.setSelected(ann);
  if (ann?.kind === "signature" && ann.vector) {
    editingSignatureAnn = ann;
    toolbar.showSignatureStyles(ann.color ?? SIGNATURE_INK);
  } else if (editingSignatureAnn) {
    editingSignatureAnn = null;
    toolbar.hideSignatureStyles();
  }
});

/** Shows the page of `ann` and selects it, ready to move or restyle. */
function pickAnnotation(ann: Annotation): void {
  if (!annotations.has(ann)) return;
  if (toolState.tool !== "select") toolbar.clearActiveTool();
  if (ann.page !== viewer.currentPage) viewer.goToPage(ann.page, "instant");
  // The page may still be drawing: try again for a second at most.
  let tries = 60;
  const attempt = (): void => {
    const pv = viewer.pageViews.find((p) => p.pageNum === ann.page);
    if (pv?.rendered) {
      pv.overlay.select(ann);
      if (tools.selected === ann) return;
    }
    if (--tries > 0) requestAnimationFrame(attempt);
  };
  attempt();
}

/** The trash of a row in the studio panel. */
function removeAnnotation(ann: Annotation): void {
  if (!annotations.has(ann)) return;
  if (tools.selected === ann) tools.select(null);
  if (editingTextAnn === ann) { editingTextAnn = null; toolbar.hideTextStyles(); }
  if (editingShapeAnn === ann) { editingShapeAnn = null; toolbar.hideShapeStyles(); }
  if (editingHighlightAnn === ann) { editingHighlightAnn = null; toolbar.hideHighlightStyles(); }
  annotations.remove(ann);
  viewer.pageViews.find((p) => p.pageNum === ann.page)?.overlay.redrawCommitted();
}

let tempPrefix: Promise<[string, string]> | null = null;

async function newTempPath(suffix: string): Promise<string> {
  tempPrefix ??= Promise.all([tempDir(), tempTag()]);
  const [dir, tag] = await tempPrefix;
  return uniqueTempName(dir, tag, suffix);
}

/** The open document: paths, dirty flag and the edits not yet written to disk. */
const session = new DocumentSession(
  {
    annotations: () => annotations.all(),
    formFields:  () => [...formValues.entries()].map(([name, value]): FormFieldValue => ({ name, value })),
    rotation:    () => viewer.rotation,
  },
  {
    saveAnnotated: saveAnnotatedPdf,
    redact: async (input, output, redactions) =>
      redactPages(input, output, await renderRedactedPages(input, redactions)),
    tempPath: newTempPath,
    encrypt: encryptPdf,
  },
);

const messages = createMessages(() => settingsModal.getSettings().language);
const { msg, errText } = messages;

/** Password rules as the user meets them (read-only while protected, the padlock). */
const protection = new Protection({
  session,
  toolbar,
  passwords: passwordModal,
  msg,
  notify: (text, isError) => showToast(text, isError),
  setDirty: (dirty) => setDirty(dirty),
});

/** Toasts and warning questions, for the dialog flows. */
const feedback: Feedback = {
  notify: (text, isError) => showToast(text, isError),
  ask: (text, title) => ask(text, title === undefined ? { kind: "warning" } : { title, kind: "warning" }),
};

const openCompress = setUpCompress({
  session,
  modal: compressModal,
  refuse: () => protection.refuse(),
  messages,
  ui: feedback,
  backend: tauriBackend,
});

const exportFlow = setUpExport({
  session,
  viewer,
  modal: exportModal,
  pendingRename: () => session.pendingName,
  messages,
  ui: feedback,
  backend: tauriBackend,
});

/**
 * The room the pages get in the viewer, CSS px, whether its scroll bars show
 * right now or not. Fitting to the room left by the scroll bars of the
 * moment looped: the fitted page made a scroll bar appear, which narrowed
 * the room, which made the page smaller, which made the bar go away, and so
 * on, the page flickering between two sizes. So the vertical bar keeps its
 * place even when hidden (scrollbar-gutter in app.css) and the horizontal
 * one is counted only where it is always there, pages side by side.
 */
function pageRoom(): { width: number; height: number } {
  const scroll = document.getElementById("viewer-scroll")!;
  const horizontal = viewer.scrollMode === "horizontal";
  return {
    width: scroll.clientWidth,
    height: scroll.offsetHeight - (horizontal ? scrollbarSize() : 0),
  };
}

async function applyFitMode(): Promise<void> {
  if (!viewer.isLoaded() || fitMode === "none") return;
  const room = pageRoom();
  const page = firstPageShown();
  let scale: number;
  if (fitMode === "fit-width") {
    scale = (room.width - VIEWER_PADDING) / page.width;
  } else if (fitMode === "fit-page") {
    // The whole page, portrait or landscape: whichever side is tighter.
    scale = pageFitScale(page, room);
  } else {
    scale = (room.height - VIEWER_PADDING) / page.height;
  }
  // Same zoom as now (the window only grew a scroll bar, say): nothing to redraw.
  if (Math.abs(viewer.clampScale(scale) - viewer.scale) > 1e-6) await viewer.setScale(scale);
  else viewer.reflow();
  toolbar.updateZoom(viewer.scale);
}

/** Applies the zoom chosen in Settings (on open, Ctrl+0 and the magnifier button). */
async function applyDefaultZoom(): Promise<void> {
  if (!viewer.isLoaded()) return;
  const pref = settingsModal.getSettings().defaultZoom;
  if (pref === "fit-width" || pref === "fit-page") {
    fitMode = pref === "fit-width" ? "fit-width" : "fit-page";
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

/** The first page's size in points, as shown (view rotation applied). */
function firstPageShown(): { width: number; height: number } {
  const w = viewer.pageWidthPt, h = viewer.pageHeightPt;
  return viewer.rotation % 180 === 0 ? { width: w, height: h } : { width: h, height: w };
}

/** False while a window opened only to print: it closes again at once. */
let autoFitWindow = true;

/** Width of the viewer's scroll bars (they are styled, see app.css). */
function scrollbarSize(): number {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;width:100px;height:100px;overflow:scroll;";
  document.body.append(probe);
  const size = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return size;
}

/**
 * Gives the window the shape of one page of the document just opened,
 * portrait or landscape (see window-fit.ts), and frees its proportions,
 * which stay locked only on the launcher. A maximized or full-screen
 * window keeps its size. Returns false when the zoom from Settings does not
 * show a whole page in the window as it ends up (too big for the screen,
 * or a window that keeps its size): the page is fitted instead.
 */
async function fitWindowToDocument(): Promise<boolean> {
  if (!("__TAURI_INTERNALS__" in window)) return true;
  const pref = parseFloat(settingsModal.getSettings().defaultZoom);
  try {
    await setLauncherRatioLock(false);
    if (!autoFitWindow) return true;
    // Another tab's document already gave the window its size: it stays.
    if (fullscreen || docTabs.count > 1 || await appWindow.isMaximized()) return preferredZoomShowsPage(pref);
    const monitor = await currentMonitor();
    if (!monitor) return preferredZoomShowsPage(pref);
    const sf = monitor.scaleFactor || 1;
    const scroll = document.getElementById("viewer-scroll")!;
    // The vertical scroll bar's place is always kept, the horizontal one is
    // counted when pages sit side by side (see pageRoom).
    const bar = scrollbarSize();
    const horizontal = viewer.scrollMode === "horizontal";
    const plan = planWindowFit({
      page: firstPageShown(),
      preferredScale: Number.isFinite(pref) ? pref / 100 * CSS_UNITS : null,
      window: { width: window.innerWidth, height: window.innerHeight },
      viewer: { width: scroll.offsetWidth, height: scroll.offsetHeight },
      scrollbars: { width: bar, height: horizontal ? bar : 0 },
      area: { width: monitor.workArea.size.width / sf, height: monitor.workArea.size.height / sf },
    });
    const target = plan.window;
    if (Math.abs(target.width - window.innerWidth) > 1 || Math.abs(target.height - window.innerHeight) > 1) {
      const pos = await appWindow.outerPosition();
      const outer = await appWindow.outerSize();
      const inner = await appWindow.innerSize();
      const next = {
        width: Math.round(target.width * sf) + outer.width - inner.width,
        height: Math.round(target.height * sf) + outer.height - inner.height,
      };
      const at = keepCentred(pos, outer, next, {
        x: monitor.workArea.position.x, y: monitor.workArea.position.y,
        width: monitor.workArea.size.width, height: monitor.workArea.size.height,
      });
      await appWindow.setSize(new LogicalSize(target.width, target.height));
      await appWindow.setPosition(new PhysicalPosition(at.x, at.y));
      await windowSizeSettles(target);
    }
    // Judged on the window as it really ended up, not as planned: Windows
    // may give it another size (a snapped window, a size it refuses).
    return plan.preferredFits && preferredZoomShowsPage(pref);
  } catch (err) {
    console.warn("fit window:", err);
    return preferredZoomShowsPage(pref);
  }
}

/**
 * True when the zoom from Settings (`pref`, in percent) shows the whole
 * first page in the viewer as it is now, or when Settings asks for a fit.
 */
function preferredZoomShowsPage(pref: number): boolean {
  if (!Number.isFinite(pref)) return true;
  const room = pageRoom();
  // A pixel or two of slack: the window's size is rounded.
  const biggest = pageFitScale(firstPageShown(), { width: room.width + 2, height: room.height + 2 });
  return pref / 100 * CSS_UNITS <= biggest + 1e-6;
}

/** Waits (half a second at most) until the page sees the window's new size. */
async function windowSizeSettles(target: { width: number; height: number }): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (Math.abs(window.innerWidth - target.width) <= 2 && Math.abs(window.innerHeight - target.height) <= 2) break;
    await new Promise((r) => setTimeout(r, 16));
  }
  await new Promise((r) => requestAnimationFrame(() => r(null)));
}

/** A document was just opened: the window fits one page, then the zoom from Settings. */
async function showOpenedDocument(): Promise<void> {
  if (await fitWindowToDocument()) {
    await applyDefaultZoom();
  } else {
    fitMode = "fit-page";
    toolbar.updateFitMode(fitMode);
    await applyFitMode();
  }
}

viewer.onResizeCb = async () => {
  if (fitMode !== "none") await applyFitMode();
  else viewer.reflow();
};

function onFormChange(name: string, val: string): void {
  // Form fields of a protected file are disabled (body.read-only); this is the backstop.
  if (refuseIfProtected()) return;
  formValues.set(name, val);
  setDirty(true);
}

viewer.setup(tools, annotations, formValues, onFormChange);

// ── Per-page overlay event wiring ─────────────────────────────────────────────

function wirePageOverlay(pv: PdfPageView): void {
  const ov = pv.overlay;

  ov.onPick((ann) => {
    if (toolState.tool !== "select") toolbar.clearActiveTool();
    ov.select(ann);
  });

  ov.onTextAnnotationSelected((ann: TextAnnotation | null) => {
    editingTextAnn = ann;
    if (ann) {
      editingShapeAnn = null;
      editingHighlightAnn = null;
      toolbar.showTextStyles(ann);
      toolbar.hideShapeStyles();
      toolbar.hideHighlightStyles();
    } else {
      toolbar.hideTextStyles();
    }
  });

  ov.onShapeAnnotationSelected((ann: ShapeAnnotation | null) => {
    editingShapeAnn = ann;
    if (ann) {
      editingTextAnn = null;
      editingHighlightAnn = null;
      toolbar.showShapeStyles(ann, ann.kind === "ink" && !ann.arrow ? "pencil" : "shapes");
      toolbar.hideTextStyles();
      toolbar.hideHighlightStyles();
    } else {
      toolbar.hideShapeStyles();
    }
  });

  ov.onHighlightAnnotationSelected((ann: HighlightAnnotation | null) => {
    editingHighlightAnn = ann;
    if (ann) {
      editingTextAnn = null;
      editingShapeAnn = null;
      toolbar.showHighlightStyles(ann);
      toolbar.hideTextStyles();
      toolbar.hideShapeStyles();
    } else {
      toolbar.hideHighlightStyles();
    }
  });
}

const wiredOverlays = new WeakSet<object>();
viewer.onLayoutChanged((pageViews) => {
  toolbar.updateLayout(viewer.forcedColumns, viewer.scrollMode, viewer.columnCount, viewer.evenSpread);
  for (const pv of pageViews) {
    if (!wiredOverlays.has(pv.overlay)) {
      wirePageOverlay(pv);
      wiredOverlays.add(pv.overlay);
    }
    pv.overlay.setTool(tools.tool);
    pv.overlay.refreshStyle();
  }
});

viewer.onRenderActivity((busy) => pageSidebar.setViewerBusy(busy));

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
  const name = session.displayName ?? "";
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
  studio.applyTranslations(t);
  compressModal.applyTranslations(t);
  exportModal.applyTranslations(t);
  ocrModal.applyTranslations(t);
  passwordModal.applyTranslations(t);
  pageSidebar.applyTranslations(t);
  printModal.applyTranslations(t);
  splitModal.applyTranslations(t);
  adjustView.applyTranslations(t);
  tabStrip.applyTranslations({ close: tabCloseLabel(t), dragNew: t.sbDragOut, dragMerge: t.tabDragMerge });
  applyTranslationsToDOM(t);
}
// Page brightness button in the toolbar, kept in step with Settings.
toolbar.brightness.value = settingsModal.getSettings().pageBrightness;
toolbar.brightness.onInput((v) => applyPageBrightness(v));
toolbar.brightness.onCommit((v) => settingsModal.setPageBrightness(v));

settingsModal.onChange(s => {
  toolbar.brightness.value = s.pageBrightness;
  const t = getTranslations(s.language);
  toolbar.applyTranslations(t);
  studio.applyTranslations(t);
  compressModal.applyTranslations(t);
  exportModal.applyTranslations(t);
  ocrModal.applyTranslations(t);
  passwordModal.applyTranslations(t);
  pageSidebar.applyTranslations(t);
  printModal.applyTranslations(t);
  splitModal.applyTranslations(t);
  adjustView.applyTranslations(t);
  tabStrip.applyTranslations({ close: tabCloseLabel(t), dragNew: t.sbDragOut, dragMerge: t.tabDragMerge });
  applyTranslationsToDOM(t);
});

// ── Startup handling ──────────────────────────────────────────────────────────

(async () => {
  try {
    // macOS: documents opened from the Finder while the app runs. The first
    // one replaces the launcher, the others (or all, when a document is
    // already open) get windows of their own.
    await appWindow.listen<string[]>("open-files", async ({ payload }) => {
      for (const p of payload) await openPath(p);
    });
  } catch {
    // Not running in Tauri (browser preview)
  }
  // The window shows nothing until it is known whether a document opens
  // (index.html starts #app as "booting"): the launcher appears only when
  // there is none, and a document shows once it fits its window.
  const app = document.getElementById("app")!;
  const reveal = () => app.classList.remove("booting");
  try {
    const startup = await getStartupArgs();
    if (!startup.filePath) {
      reveal();
    } else {
      setWelcomeVisible(false);
      // A slow document: the viewer shows while it loads.
      const slow = setTimeout(reveal, 1500);
      try {
        await openStartupFile(startup);
      } finally {
        clearTimeout(slow);
        // The document could not be opened: the launcher, not an empty viewer.
        if (!session.isOpen) setWelcomeVisible(true);
        reveal();
      }
    }
  } catch {
    // Not running in Tauri (browser preview) — skip
    reveal();
  }
})();

/** Opens the document the app was started with (command line, Finder). */
async function openStartupFile(startup: StartupArgs): Promise<void> {
  const file = startup.filePath!;
  if (startup.shouldPrint) {
    autoFitWindow = false;
    document.getElementById("toolbar-container")!.style.display = "none";
    await loadPdf(file);
    document.getElementById("app")!.classList.remove("booting"); // the page shows while it prints
    const all = Array.from({ length: viewer.pageCount }, (_, i) => i + 1);
    await printPages(await renderForPrint(all));
    await appWindow.close();
  } else if (openKind(file) === "pictures") {
    await openPictures([file]);
  } else {
    // Pages or a tab dragged out of another window, or a file to open.
    await openTransferred(startup);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function showToast(msg: string, isError = false): void {
  const toast = document.getElementById("toast")!;
  toast.textContent = msg;
  toast.className = `toast${isError ? " error" : ""}`;
  setTimeout(() => toast.classList.add("hidden"), 3000);
}

function setDirty(val: boolean): void {
  session.markDirty(val);
  toolbar.setDocTitle(session.displayName, val);
  // The first document opened in the window gets its tab here.
  if (session.isOpen && !docTabs.active) docTabs.add();
  syncActiveTab();
  if (docTabs.anyDirty) { void registerCloseGuard(); }
  else                  { unregisterCloseGuard(); }
}

// ── Changes waiting for ✓ / ✕ ───────────────────────────────────────────────

/** The selected annotation objects were replaced: drop the stale ones. */
function dropStaleSelection(): void {
  editingTextAnn = null;
  editingShapeAnn = null;
  editingHighlightAnn = null;
  toolbar.hideTextStyles();
  toolbar.hideShapeStyles();
  toolbar.hideHighlightStyles();
}

/**
 * Ctrl+Z / Ctrl+Y: annotation changes first; once there are none left, the
 * page edits (delete, move, rotate, insert, crop, straighten) before them.
 */
async function undoRedo(redo: boolean): Promise<void> {
  if (redo ? annotations.redo() : annotations.undo()) {
    dropStaleSelection();
    syncAllPageOverlays();
    setDirty(true);
    return;
  }
  if (!(redo ? pageHistory.canRedo : pageHistory.canUndo) || pageEditBusy) return;
  pageEditBusy = true;
  pageSidebar.setBusy(true);
  try {
    const current = { path: await session.materialize(), page: viewer.currentPage, dirty: session.isDirty };
    const target = redo ? pageHistory.redo(current) : pageHistory.undo(current);
    if (!target) return;
    const workingCopy = await showInViewer(target.path, true);
    session.replacedWorkingCopy(workingCopy ?? target.path);
    dropStaleSelection();
    setDirty(target.dirty);
    if (target.page !== viewer.currentPage) viewer.goToPage(Math.min(target.page, viewer.pageCount), "instant");
  } catch (err) {
    showToast(msg("msgPagesFailed", { err: errText(err) }), true);
  } finally {
    pageEditBusy = false;
    pageSidebar.setBusy(false);
  }
}

/** ✕: the pending changes are thrown away. */
function discardDraft(): void {
  const dirty = annotations.discard();
  if (dirty === null) return;
  dropStaleSelection();
  syncAllPageOverlays();
  setDirty(dirty || session.pendingName !== null);
}

let closeGuardBusy = false;
/** "Save before closing?" was answered Yes and the save is running. */
let savingBeforeLeaving = false;

async function registerCloseGuard(): Promise<void> {
  // guardRegistering is a synchronous flag that prevents a second async call
  // from registering a second listener before the first await resolves.
  if (unlistenClose || guardRegistering) return;
  guardRegistering = true;
  try {
    unlistenClose = await appWindow.onCloseRequested(async (event) => {
      if (!docTabs.anyDirty) { return; }
      // Saving before closing: wait for it.
      if (savingBeforeLeaving) { event.preventDefault(); return; }
      // If the dialog is already open (e.g. user clicked close twice), force-close.
      if (closeGuardBusy) {
        setDirty(false);
        await appWindow.destroy();
        return;
      }
      event.preventDefault();
      closeGuardBusy = true;
      try {
        const ok = await settleAllTabs();
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
      pv.viewport
    );
  }
}

/**
 * "Save the changes before …?" Yes saves and goes on once the save went
 * through, No goes on without saving, Cancel stays. True when it may go on.
 */
async function settleUnsaved(key: "msgSaveBeforeClose" | "msgSaveBeforeOpen"): Promise<boolean> {
  if (!session.isDirty) return true;
  const answer = await saveChangesDialog({
    title: msg("msgUnsavedTitle"),
    text: msg(key, { name: session.displayName ?? "" }),
    yes: msg("msgYes"), no: msg("msgNo"), cancel: msg("msgCancel"),
  });
  if (answer === "cancel") return false;
  if (answer === "discard") return true;
  savingBeforeLeaving = true;
  try {
    await saveFile(false);
  } finally {
    savingBeforeLeaving = false;
  }
  return !session.isDirty;
}

// ── Load / Save ───────────────────────────────────────────────────────────────

/**
 * Shows the protection state: the padlock is closed while the file has (or
 * will be saved with) a password, and a protected file is read-only.
 */
function syncProtection(): void {
  protection.sync();
}

/**
 * Refuses an action on a protected document, saying how to unlock it.
 * Returns true when the action must stop.
 */
function refuseIfProtected(): boolean {
  return protection.refuse();
}

/**
 * Opens a password-protected file read-only: it is shown from an
 * unencrypted temp copy, and nothing can change or copy it until its
 * password is removed. `password` is tried first when known (after saving
 * a protected file).
 */
async function openProtected(fp: string, password?: string | null): Promise<void> {
  const name = fileNameOf(fp);
  let plain: string | null = null;
  let used = "";
  let failure: unknown = null;
  const tryOpen = async (pw: string): Promise<boolean> => {
    const tmp = await newTempPath(`unlocked-${name}`);
    try {
      await decryptPdf(fp, tmp, pw);
    } catch (err) {
      if (errorCode(err) === "wrong-password") return false;
      failure = err;
      return true;
    }
    plain = tmp;
    used = pw;
    return true;
  };
  if (!(password && await tryOpen(password)) && !await passwordModal.askToOpen(name, tryOpen)) return;
  if (failure !== null || plain === null) {
    if (failure !== null) showToast(msg("msgOpenProtectedFailed", { err: errText(failure) }), true);
    return;
  }
  try {
    const workingCopy = await showInViewer(plain);
    pageHistory.clear();
    session.opened(fp, workingCopy ?? plain, used);
    syncProtection();
    setDirty(false);
    await showOpenedDocument();
    if (infoPanel.isOpen) await showInfo();
  } catch (err) {
    showToast(msg("msgOpenProtectedFailed", { err: errText(err) }), true);
  }
}

/** Fills the thumbnails sidebar from the document the viewer just opened. */
function showThumbnails(reload = false): void {
  if (!viewer.document) return;
  pageSidebar.load(viewer.document, viewer.pageDimensions, viewer.rotation);
  // After an edit the panel stays where the user left it.
  pageSidebar.setCurrentPage(viewer.currentPage, !reload);
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
async function showInViewer(path: string, reload = false): Promise<string | null> {
  annotations.clear();
  formValues.clear();

  // Read annotations BEFORE viewer.load() so IntersectionObserver finds them populated
  const saved = await readAnnotations(path);
  annotations.load(saved);

  // A file with saved annotations is shown from a copy whose burned layer
  // is stripped, so the overlay can draw the annotations editable.
  let workingCopy: string | null = null;
  if (saved.length > 0) {
    workingCopy = await newTempPath(`display-${await basename(path)}`);
    await stripAnnotationStreams(path, workingCopy);
  }

  if (reload) await viewer.reload(workingCopy ?? path);
  else await viewer.load(workingCopy ?? path);
  shownPath = workingCopy ?? path;
  showThumbnails(reload);

  setWelcomeVisible(false);
  toolbar.setLoaded(true);
  toolbar.updateZoom(viewer.scale);
  return workingCopy;
}

async function loadPdf(path: string, password?: string | null): Promise<void> {
  session.forgetName();
  // Changes still waiting for ✓ / ✕ are kept as they are.
  annotations.apply();
  if (password) { await openProtected(path, password); return; }
  try {
    const workingCopy = await showInViewer(path);
    pageHistory.clear();
    session.opened(path, workingCopy);
    syncProtection();
    setDirty(false);
    await showOpenedDocument();
    if (infoPanel.isOpen) await showInfo();
  } catch (err: unknown) {
    // pdf.js's own error (not a command's): it has no code.
    const why = String(err);
    if (why.includes("PasswordException") || why.includes("password")) {
      await openProtected(path);
    } else {
      showToast(msg("msgOpenFailed", { err: why }), true);
    }
  }
}

async function openFile(): Promise<void> {
  const path = await openDocumentDialog();
  if (!path) return;
  await openPath(path);
}

/**
 * Opens `path` in a new tab: a PDF as it is, a picture as a new one-page
 * PDF. A PDF already open in a tab is shown there instead.
 */
async function openPath(path: string): Promise<void> {
  if (openKind(path) === "pictures") { await openPictures([path]); return; }
  const open = tabShowing(path);
  if (open) { await switchTab(open.id); return; }
  await inNewTab(() => loadPdf(path));
}

/** Opens the pictures in a new tab, as a new PDF (see `picturesToTab`). */
async function openPictures(paths: string[]): Promise<void> {
  await inNewTab(() => picturesToTab(paths));
}

/**
 * Opens the pictures as a new PDF, one page each. It was never saved: the
 * first Save asks where to put it, suggesting the pictures' folder.
 */
async function picturesToTab(paths: string[]): Promise<void> {
  const { name, suggested } = picturesDocument(paths);
  let pdf: string;
  try {
    pdf = await picturesToNewPdf(paths, name);
  } catch (err) {
    showToast(msg("msgImageFailed", { err: errText(err) }), true);
    return;
  }
  await loadPdf(pdf);
  if (session.sourcePath === pdf) {
    session.markUnsavedCopy(suggested);
    setDirty(true);
  }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

/** What a tab in the background needs to come back as it was left. */
interface ParkedDoc {
  session: SessionSnapshot;
  annotations: AnnotationSnapshot;
  history: { undo: DocState[]; redo: DocState[] };
  forms: [string, string][];
  /** The file the viewer showed (a working copy, or the file itself). */
  shownPath: string;
  rotation: number;
  scale: number;
  fitMode: "none" | "fit-width" | "fit-height" | "fit-page";
  page: number;
  scrollTop: number;
  scrollLeft: number;
}

/** "Close tab (Ctrl+W)", with the macOS shortcut there. */
function tabCloseLabel(t: { tabClose?: string }): string | undefined {
  return t.tabClose && (isMac ? macShortcuts(t.tabClose) : t.tabClose);
}

function renderTabs(): void {
  tabStrip.render(docTabs.tabs, docTabs.active?.id ?? null);
}

/** The active tab shows the open document's name and dirty flag. */
function syncActiveTab(): void {
  const tab = docTabs.active;
  if (tab && session.isOpen) {
    tab.title = session.displayName ?? "";
    tab.dirty = session.isDirty;
  }
  renderTabs();
}

/** The tab showing the file at `path`, if one does. */
function tabShowing(path: string): DocTab<ParkedDoc> | null {
  const same = (p: string | null | undefined) => !!p && samePath(p, path);
  return docTabs.tabs.find((t) => t.parked
    ? same(t.parked.session.sourcePath) && !t.parked.session.unsavedCopy
    : same(session.sourcePath) && !session.isUnsavedCopy) ?? null;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/");
  return isMac || navigator.userAgent.includes("Windows")
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
}

/** Waits for a tab switch in progress. */
async function tabsSettled(): Promise<void> {
  while (tabSwitch) await tabSwitch;
}

/**
 * Puts the active document in the background: its state goes into its tab
 * and the viewer is free for another one. Changes waiting for ✓ / ✕ are
 * applied, as when another file was opened.
 */
function parkActive(): void {
  const tab = docTabs.active;
  if (!tab || !session.isOpen || !shownPath || !viewer.isLoaded()) return;
  annotations.apply();
  dropStaleSelection();
  cancelSignaturePlacement();
  tab.title = session.displayName ?? tab.title;
  tab.dirty = session.isDirty;
  tab.parked = {
    session: session.snapshot(),
    annotations: annotations.snapshot(),
    history: pageHistory.snapshot(),
    forms: [...formValues.entries()],
    shownPath,
    rotation: viewer.rotation,
    scale: viewer.scale,
    fitMode,
    page: viewer.currentPage,
    scrollTop: viewerScroll.scrollTop,
    scrollLeft: viewerScroll.scrollLeft,
  };
}

/** Brings a parked tab back into the viewer, as it was left. */
async function showTab(tab: DocTab<ParkedDoc>): Promise<void> {
  const p = tab.parked;
  docTabs.activate(tab.id);
  if (!p) return;
  tab.parked = null;
  session.restore(p.session);
  annotations.restoreParked(p.annotations);
  pageHistory.restore(p.history);
  formValues.clear();
  for (const [name, value] of p.forms) formValues.set(name, value);
  dropStaleSelection();
  shownPath = p.shownPath;
  try {
    await viewer.load(p.shownPath, p.rotation);
  } catch (err) {
    // The file went away meanwhile (a temp folder cleaned up): the tab goes too.
    showToast(msg("msgOpenFailed", { err: String(err) }), true);
    const next = docTabs.remove(tab.id);
    if (next) await showTab(next);
    else await closeDocument();
    return;
  }
  showThumbnails();
  setWelcomeVisible(false);
  toolbar.setLoaded(true);
  fitMode = p.fitMode;
  toolbar.updateFitMode(fitMode);
  if (fitMode !== "none") await applyFitMode();
  else await viewer.setScale(p.scale);
  toolbar.updateZoom(viewer.scale);
  viewerScroll.scrollTop = p.scrollTop;
  viewerScroll.scrollLeft = p.scrollLeft;
  syncProtection();
  setDirty(session.isDirty);
  if (infoPanel.isOpen) await showInfo();
}

/** Shows tab `id`, parking the active one. */
async function switchTab(id: number): Promise<void> {
  await tabsSettled();
  const tab = docTabs.get(id);
  if (!tab || tab === docTabs.active || pageEditBusy || !toolbar.allowed()) { renderTabs(); return; }
  const run = (async () => {
    parkActive();
    await showTab(tab);
  })();
  tabSwitch = run;
  try { await run; } finally { tabSwitch = null; renderTabs(); }
}

/**
 * Opens a document in a new tab: `open` loads it into the viewer, the
 * active document parked first. When nothing opens (an error, a password
 * not given), the tab goes away and the one before comes back.
 */
async function inNewTab(open: () => Promise<void>): Promise<void> {
  await tabsSettled();
  if (!toolbar.allowed()) return;
  const before = session.isOpen ? docTabs.active : null;
  if (before) parkActive();
  const tab = docTabs.add();
  session.restore(null);
  renderTabs();
  try {
    await open();
  } finally {
    if (!session.isOpen) {
      docTabs.remove(tab.id);
      if (before) await showTab(before);
      else renderTabs();
    }
  }
}

/** Closes tab `id`, asking first when it has unsaved changes. */
async function closeTab(id: number): Promise<void> {
  await tabsSettled();
  const tab = docTabs.get(id);
  if (!tab) return;
  if (tab !== docTabs.active) {
    if (!tab.dirty) { docTabs.remove(id); renderTabs(); setDirty(session.isDirty); return; }
    // Shown first, so the question is about what the user sees.
    await switchTab(id);
    if (docTabs.active !== tab) return;
  }
  if (!await settleUnsaved("msgSaveBeforeClose")) return;
  await dropActiveTab();
}

/** The active tab goes away: the next one shows, or the launcher. */
async function dropActiveTab(): Promise<void> {
  const tab = docTabs.active;
  if (!tab) return;
  const next = docTabs.remove(tab.id);
  if (next) await showTab(next);
  else await closeDocument();
}

/** No document left: back to the launcher, the viewer emptied. */
async function closeDocument(): Promise<void> {
  annotations.clear();
  pageHistory.clear();
  formValues.clear();
  session.restore(null);
  shownPath = null;
  dropStaleSelection();
  cancelSignaturePlacement();
  if (infoPanel.isOpen) { infoPanel.close(); toolbar.setInfoOpen(false); }
  searchMatches = [];
  searchIndex = -1;
  docSearch.reset(null);
  pageSidebar.clear();
  await viewer.close();
  toolbar.setLoaded(false);
  setWelcomeVisible(true);
  syncProtection();
  setDirty(false);
}

/**
 * Closing the window: each tab with unsaved changes is shown in turn and
 * asked about. False when the user cancelled.
 */
async function settleAllTabs(): Promise<boolean> {
  await tabsSettled();
  for (const tab of [...docTabs.tabs]) {
    if (!tab.dirty) continue;
    if (tab !== docTabs.active) {
      await switchTab(tab.id);
      if (docTabs.active !== tab) return false;
    }
    if (!await settleUnsaved("msgSaveBeforeClose")) return false;
    // "Don't save": nothing to ask about this one any more.
    tab.dirty = false;
  }
  return true;
}

/**
 * Tab `id` was dropped outside the title bar at the screen point (`x`,
 * `y`): it moves to the EzReader window there, or to a new window. Its
 * unsaved changes go with it, in a temp copy that saves back to its file.
 */
async function detachTab(id: number, x: number, y: number): Promise<void> {
  await tabsSettled();
  const tab = docTabs.get(id);
  if (!tab || tab !== docTabs.active || !session.isOpen || pageEditBusy || !toolbar.allowed()) {
    void tabDragEnd().catch(() => {});
    return;
  }
  let result: "merged" | "window" | "stayed";
  try {
    const { args, name } = await transferOfActive();
    result = await moveTab(x, y, args, name, docTabs.count > 1);
  } catch (err) {
    void tabDragEnd().catch(() => {});
    showToast(msg("msgOpenFailed", { err: errText(err) }), true);
    return;
  }
  if (result === "stayed") return;
  // The document lives in the other window now: forgotten here, no question.
  session.markDirty(false);
  tab.dirty = false;
  if (docTabs.count > 1) {
    await dropActiveTab();
  } else {
    unregisterCloseGuard();
    await appWindow.destroy();
  }
}

/** The active document, as another window opens it (see `openTransferred`). */
async function transferOfActive(): Promise<{ args: StartupArgs; name: string | null }> {
  const page = viewer.currentPage;
  annotations.apply();
  const base = { shouldPrint: false, page };
  if (session.isProtected) {
    // Read-only, so nothing pending: the file itself, and its password.
    return { args: { ...base, filePath: session.sourcePath, password: session.filePassword }, name: null };
  }
  const unsaved = session.isUnsavedCopy;
  if (!session.isDirty && !unsaved) {
    return { args: { ...base, filePath: session.sourcePath }, name: null };
  }
  const file = await session.materialize();
  return {
    args: { ...base, filePath: file, unsaved, dirty: session.isDirty, savePath: unsaved ? null : session.saveTarget },
    // A temp copy: the other window shows it under its own name.
    name: unsaved ? session.displayName : null,
  };
}

/**
 * Opens what another window handed over in a new tab: a file, pages
 * dragged out (a copy never saved), or a tab with its pending edits.
 */
async function openTransferred(t: StartupArgs): Promise<void> {
  const file = t.filePath;
  if (!file) return;
  if (!t.unsaved && !t.dirty && !t.savePath) {
    const open = tabShowing(file);
    if (open) { await switchTab(open.id); return; }
  }
  await inNewTab(async () => {
    await loadPdf(file, t.password ?? null);
    if (!session.isOpen) return;
    if (t.unsaved) session.markUnsavedCopy();
    else if (t.savePath) session.adoptSavePath(t.savePath);
    setDirty(!!(t.dirty || t.unsaved));
    if (t.page && t.page > 1) viewer.goToPage(Math.min(t.page, viewer.pageCount), "instant");
  });
}

void (async () => {
  try {
    await appWindow.listen<StartupArgs>("tab-received", ({ payload }) => {
      tabStrip.setDropTarget(false);
      void openTransferred(payload);
    });
    await appWindow.listen<boolean>("tab-drag-hover", ({ payload }) => tabStrip.setDropTarget(payload));
  } catch {
    // Not running in Tauri (browser preview)
  }
})();

async function saveFile(forceDialog: boolean): Promise<void> {
  const current = session.saveTarget;
  if (!current || refuseIfProtected()) return;
  let target = current;
  // A plain Save also applies the name typed in the title bar.
  const { dialog, renameTo } = session.planSave(forceDialog);
  if (dialog !== null) {
    const picked = await savePdfDialog(dialog);
    if (!picked) return;
    target = picked;
  }
  const redacting = session.hasRedactions();
  if (redacting) {
    const ok = await ask(msg("msgRedactConfirm"), { title: msg("msgRedactTitle"), kind: "warning" });
    if (!ok) return;
  }
  toolbar.setSaving(true);
  try {
    await session.saveTo(target);
    if (dialog !== null) session.savedAs();
    if (renameTo) {
      const page = viewer.currentPage;
      try {
        await renameFile(target, renameTo);
      } catch (err) {
        session.renameFailed();
        setDirty(false);
        const code = errorCode(err);
        showToast(code === "exists" ? msg("msgRenameExists")
          : code === "invalid-name" ? msg("msgRenameInvalid")
          : msg("msgRenameFailed", { err: errText(err) }), true);
        toolbar.flashSave("ok"); // the content was saved, only the rename failed
        return;
      }
      // Show the file under its new name (pdf.js reads it from its path).
      const password = session.filePassword;
      session.saved(renameTo);
      await loadPdf(renameTo, password);
      viewer.goToPage(page, "instant");
      showToast(msg("msgRenamed", { name: fileNameOf(renameTo) }));
      toolbar.flashSave("ok");
      return;
    }
    setDirty(false);
    if (redacting) {
      // Show the saved file: the redacted pages are now images and the
      // redaction boxes are gone from the editable annotations.
      const page = viewer.currentPage;
      await loadPdf(target, session.filePassword);
      viewer.goToPage(page);
    }
    // Saved with a new password: the file is now protected, so read-only.
    syncProtection();
    showToast(msg(session.isProtected ? "msgSavedProtected" : "msgSaved"));
    toolbar.flashSave("ok");
  } catch (err: unknown) {
    showToast(msg("msgSaveFailed", { err: errText(err) }), true);
    toolbar.flashSave("error");
  } finally {
    toolbar.setSaving(false);
  }
}

/** Name of the open document without its extension (for exported files). */
function docStem(): string {
  return exportFlow.docStem();
}

function openExport(tab: "pdf" | "images"): void {
  exportFlow.open(tab);
}

/** The padlock (see protection.ts). */
async function editPassword(): Promise<void> {
  await protection.edit();
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


// ── Page panel (thumbnails sidebar) ──────────────────────────────────────────

/**
 * Replaces the open document's pages with `slots` and shows the result.
 * Returns false when it failed (a toast says why).
 */
/** `keepPage` is the page to show afterwards; null stays exactly where the view is. */
async function applyPageLayout({ slots, keepPage, select }: PagePlan): Promise<boolean> {
  const source = session.sourcePath;
  if (!source) return false;
  try {
    // Burn pending edits first (no-op when there are none: the viewed file is
    // used as is), then apply the new page layout as an incremental update.
    const input   = await session.materialize();
    const before  = { path: input, page: viewer.currentPage, dirty: session.isDirty };
    const tmpPath = await newTempPath(`pages-${await basename(source)}`);
    await rearrangePages(input, tmpPath, slots);
    // Still the same document: Save keeps writing to the source / Save As target.
    const workingCopy = await showInViewer(tmpPath, true);
    session.replacedWorkingCopy(workingCopy ?? tmpPath);
    pageHistory.record(before); // Ctrl+Z shows `input` again
    setDirty(true);
    if (keepPage !== null && keepPage !== viewer.currentPage) viewer.goToPage(keepPage, "instant");
    pageSidebar.setSelection(select);
    return true;
  } catch (err) {
    showToast(msg("msgPagesFailed", { err: errText(err) }), true);
    return false;
  }
}

/** Runs a page edit from the panel, with the panel locked meanwhile. */
async function editPages(plan: PagePlan): Promise<boolean> {
  if (!session.isOpen || !viewer.isLoaded() || pageEditBusy) return false;
  if (refuseIfProtected() || !toolbar.allowed()) return false;
  pageSidebar.setBusy(true);
  try {
    return await applyPageLayout(plan);
  } finally {
    pageSidebar.setBusy(false);
  }
}

/** Inserts `inserted` after page `after` (0 = at the start). */
async function insertSlots(after: number, inserted: PageSlot[]): Promise<void> {
  if (await editPages(planInsert(viewer.pageCount, after, inserted))) showToast(msg("msgPagesUpdated"));
}

pageSidebar.onSelectionChange((pages) => toolbar.setPageSelection(pages.length));

// ── Crop / Straighten ────────────────────────────────────────────────────────

/** Opens Crop / Straighten on the pages selected in the side panel. */
function openAdjust(kind: "crop" | "straighten"): void {
  const doc = viewer.document;
  if (!doc || adjustView.isOpen) return;
  // The checked pages, or else the page shown.
  const pages = pageSidebar.selection.length > 0 ? pageSidebar.selection : [viewer.currentPage];
  cancelSignaturePlacement();
  toolbar.search.close();
  appEl.classList.add("adjusting");
  adjustView.open(doc, pages, kind, viewer.rotation);
}

/**
 * ✓ of Crop / Straighten. Crops and flips stay vector (CropBox and a
 * mirroring matrix); straightened pages become pictures of the page, with
 * their text laid back invisibly (still searchable and selectable) and their
 * links and fields moved with the warp.
 */
async function applyAdjust(settings: PageSetting[]): Promise<boolean> {
  const source = session.sourcePath;
  const doc = viewer.document;
  if (!source || !doc) return false;
  if (settings.length === 0) return true;
  try {
    const { crops, warps } = await buildPageAdjustments(doc, viewer.rotation, settings);
    const name = await basename(source);
    let out = await session.materialize();
    const before = { path: out, page: viewer.currentPage, dirty: session.isDirty };
    if (crops.length > 0) {
      const tmp = await newTempPath(`adjust-${name}`);
      await adjustPages(out, tmp, crops);
      out = tmp;
    }
    if (warps.length > 0) {
      // Pictures are taken without our annotation layer: the annotations
      // stay editable on top, where they were.
      const bare = await newTempPath(`straighten-src-${name}`);
      await stripAnnotationStreams(out, bare);
      const pictures = await renderStraightenedPages(bare, warps);
      const tmp = await newTempPath(`straighten-${name}`);
      await straightenPages(out, tmp, pictures);
      out = tmp;
    }
    const workingCopy = await showInViewer(out, true);
    session.replacedWorkingCopy(workingCopy ?? out);
    pageHistory.record(before);
    setDirty(true);
    const pages = settings.map((s) => s.page);
    viewer.goToPage(pages[0], "instant");
    pageSidebar.setSelection(pages);
    showToast(pages.length === 1 ? msg("msgPageAdjusted") : msg("msgPagesAdjusted", { n: pages.length }));
    return true;
  } catch (err) {
    showToast(msg("msgAdjustFailed", { err: errText(err) }), true);
    return false;
  }
}

pageSidebar.onGoTo((page, instant) => viewer.goToPage(page, instant ? "instant" : "smooth"));
pageSidebar.onDestination((dest) => void viewer.goToDestination(dest));

pageSidebar.onVisibilityChange((visible) => toolbar.updateSidebar(visible));
toolbar.updateSidebar(pageSidebar.visible);

pageSidebar.onDelete(async (pages) => {
  if (!viewer.isLoaded()) return;
  const plan = planDelete(viewer.pageCount, pages, viewer.currentPage);
  if (!plan) {
    showToast(msg("msgCannotDeleteAll"), true);
    return;
  }
  if (await editPages(plan)) showToast(msg("msgPagesDeleted", { n: pages.length }));
});

pageSidebar.onRotate(async (pages, quarterTurns) => {
  await editPages(planRotate(viewer.pageCount, pages, quarterTurns));
});

pageSidebar.onMove(async (pages, insertAt) => {
  await editPages(planMove(viewer.pageCount, pages, insertAt, viewer.currentPage));
});

pageSidebar.onInsertBlank(async (after) => {
  // Same size as the page it follows (or the first page).
  const ref = viewer.pageDimensions[Math.max(0, after - 1)] ?? { width: 595.28, height: 841.89 };
  await insertSlots(after, [{ kind: "blank", width: ref.width, height: ref.height, rotation: 0 }]);
});

pageSidebar.onInsertImages(async (after) => {
  const paths = await openImagesDialog();
  if (paths.length > 0) await insertPictures(after, paths);
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
    showToast(msg("msgPagesFailed", { err: errText(err) }), true);
    return;
  }
  if (count < 1) return;
  await insertSlots(after, Array.from({ length: count }, (_, i): PageSlot => ({ kind: "imported", path, page: i + 1, rotation: 0 })));
}

pageSidebar.onExport(async (pages) => {
  const source = session.sourcePath;
  if (!source || !viewer.isLoaded() || refuseIfProtected()) return;
  const name = (await basename(source)).replace(/\.pdf$/i, "");
  const out  = await savePdfDialog(`${name} (pages).pdf`);
  if (!out) return;
  pageSidebar.setBusy(true);
  try {
    await extractPdfPages(await session.materialize(), out, pages);
    showToast(msg("msgPagesExported", { n: pages.length }));
  } catch (err) {
    showToast(msg("msgExportFailed", { err: errText(err) }), true);
  } finally {
    pageSidebar.setBusy(false);
  }
});

// Pages dragged out of the window open as a new document in a new window.
pageSidebar.onDragOut(async (pages, x, y) => {
  if (!session.isOpen || !viewer.isLoaded() || refuseIfProtected()) return;
  const t = getTranslations(settingsModal.getSettings().language);
  const pattern = pages.length === 1 ? t.nwPageOne ?? "{name} (page {pages})" : t.nwPageMany ?? "{name} (pages {pages})";
  const name = `${fmt(pattern, { name: docStem(), pages: formatPageRange(pages) })}.pdf`;
  pageSidebar.setBusy(true);
  try {
    await openPagesInNewWindow(await session.materialize(), pages, name, x, y);
  } catch (err) {
    showToast(msg("msgNewWindowFailed", { err: errText(err) }), true);
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
    showToast(tmpl.replace("{err}", errText(err)), true);
  }
});

printModal.onConfirm(async (settings) => {
  const source = session.sourcePath;
  if (!viewer.isLoaded() || !source) return;
  try {
    if (isMicrosoftPrintToPdf(settings.printerName)) {
      // Write the selected pages as a real (vector) PDF rather than a
      // rasterised one. That is a copy, refused on a protected file.
      if (refuseIfProtected()) return;
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
    showToast(msg("msgPrintFailed", { err: errText(err) }), true);
  }
});

// ── Welcome screen ────────────────────────────────────────────────────────────

mountWelcomeDots(document.getElementById("welcome-screen")!);

// Default reader checkbox + language picker at the bottom of the welcome screen.
const welcomePrefs = new WelcomePrefs(document.getElementById("welcome-screen")!, {
  language: () => settingsModal.getSettings().language,
  setLanguage: (code) => settingsModal.setLanguage(code),
  t: () => getTranslations(settingsModal.getSettings().language),
  isDefault: () => isDefaultPdfReader(),
  // Windows lets only the user pick the default app: register EzReader so it
  // is offered, then open Default apps. On Linux registering sets it.
  setDefault: async (on) => {
    if (on) {
      await registerPdfHandler();
      await registerPrintVerb();
    } else {
      await unregisterPdfHandler();
    }
    await openDefaultAppsSettings();
  },
});
void welcomePrefs.refresh();
// Up to date? Checked once per launch, next to the language picker.
const updateBadge = new UpdateBadge(welcomePrefs.root, {
  t: () => getTranslations(settingsModal.getSettings().language),
  check: () => checkForUpdate(),
  install: () => installUpdate(),
  notify: (text, isError) => showToast(text, isError),
});
void updateBadge.refresh();
settingsModal.onChange(() => {
  welcomePrefs.render();
  updateBadge.render();
});
// Back from Windows' Default apps page: show what the user chose.
window.addEventListener("focus", () => void welcomePrefs.refresh());

document.getElementById("welcome-open-btn")?.addEventListener("click", async () => {
  await openFile();
});

// ── Toolbar events ────────────────────────────────────────────────────────────

toolbar.on(async (e) => {
  if (adjustView.isOpen) {
    await adjustView.finish();
    if (e.type === "adjust") return;
  }
  switch (e.type) {
    case "open":
      await openFile();
      break;

    case "save":
      await saveFile(false);
      break;

    case "save-as":
      await saveFile(true);
      break;

    case "compress":
      await openCompress();
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
        await viewer.setScale(snapZoom(viewer.scale, e.type === "zoom-in" ? 1 : -1), viewerCenter());
        toolbar.updateZoom(viewer.scale);
      }
      break;

    case "zoom-reset":
      await applyDefaultZoom();
      break;

    case "zoom-set":
      if (viewer.isLoaded()) {
        fitMode = "none"; toolbar.updateFitMode(fitMode);
        await viewer.setScale(e.scale, viewerCenter());
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
      viewer.setColumns(e.n, e.even ?? false);
      if (e.n != null && viewer.scrollMode === "horizontal") viewer.setScrollMode("vertical");
      toolbar.updateLayout(viewer.forcedColumns, viewer.scrollMode, viewer.columnCount, viewer.evenSpread);
      break;

    case "scroll-mode":
      viewer.setScrollMode(e.mode);
      toolbar.updateLayout(viewer.forcedColumns, viewer.scrollMode, viewer.columnCount, viewer.evenSpread);
      break;

    case "info":
      if (infoPanel.isOpen) { infoPanel.close(); toolbar.setInfoOpen(false); }
      else { await showInfo(); }
      break;

    case "export":
      openExport("pdf");
      break;

    case "images-to-pdf":
      openExport("images");
      break;

    case "ocr":
      ocrModal.open();
      break;

    case "password":
      await editPassword();
      break;

    case "rename":
      if (!session.isOpen) break;
      if (!session.rename(e.stem)) { showToast(msg("msgRenameInvalid"), true); break; }
      setDirty(session.needsSave);
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
      tools.setTool(e.tool);
      document.getElementById("viewer-scroll")!.classList.toggle("etext-mode", e.tool === "etext");
      updateHandMode();
      for (const pv of viewer.pageViews) pv.overlay.setTool(e.tool);
      editingTextAnn      = null;
      editingShapeAnn     = null;
      editingHighlightAnn = null;
      if (e.tool !== "signature") cancelSignaturePlacement();
      break;

    case "style-change":
      tools.setStyle(e.style);
      for (const pv of viewer.pageViews) pv.overlay.refreshStyle();
      if (editingTextAnn) {
        const pv = viewer.pageViews.find(p => p.pageNum === editingTextAnn!.page);
        pv?.overlay.applyTextAnnotationStyle(editingTextAnn, e.style);
        setDirty(true);
      } else if (editingShapeAnn) {
        const pv = viewer.pageViews.find(p => p.pageNum === editingShapeAnn!.page);
        pv?.overlay.applyShapeAnnotationStyle(editingShapeAnn, e.style.shapeColor, e.style.strokeWidth, e.style.fillColor, e.style.opacity);
        setDirty(true);
      } else if (editingHighlightAnn) {
        const pv = viewer.pageViews.find(p => p.pageNum === editingHighlightAnn!.page);
        pv?.overlay.applyHighlightAnnotationStyle(editingHighlightAnn, e.style.highlightColor, e.style.highlightOpacity);
        setDirty(true);
      } else if (editingSignatureAnn && annotations.has(editingSignatureAnn)) {
        const ann = editingSignatureAnn;
        const c = e.style.signatureColor;
        if (!ann.color || ann.color.r !== c.r || ann.color.g !== c.g || ann.color.b !== c.b) {
          annotations.beginEdit();
          ann.color = { ...c };
          viewer.pageViews.find(p => p.pageNum === ann.page)?.overlay.redrawCommitted();
          annotations.edited();
        }
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

    case "image-browse":
      await browsePicture();
      break;

    case "insert-image":
      await insertPicture();
      break;

    case "insert-image-page":
      pageSidebar.requestInsertImages();
      break;

    case "find":
      if (viewer.isLoaded()) toolbar.search.open();
      break;

    case "signature-use": {
      const sig = sigStore.getAll().find((x) => x.id === e.id);
      if (sig) {
        sigStore.touch(sig.id);
        startSignaturePlacement(sig.imageDataUrl.split(",")[1] ?? sig.imageDataUrl, sig.vector);
        refreshSignatures();
        toolbar.setActiveSignature(sig.id);
      }
      break;
    }

    case "signature-delete":
      sigStore.delete(e.id);
      refreshSignatures();
      break;

    case "present":
      await startPresentation();
      break;

    case "fullscreen":
      await toggleFullscreen();
      break;

    case "draft-apply":
      annotations.apply();
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

    case "undo":
      await undoRedo(false);
      break;

    case "redo":
      await undoRedo(true);
      break;
  }
});

// ── Full screen ───────────────────────────────────────────────────────────────

let fullscreen = false;

/** Full screen on / off: the title bar hides, the toolbar stays. */
/** The window was maximized when full screen began: it is maximized again after. */
let maximizedBeforeFullscreen = false;
/**
 * Bounds to put back when full screen was done by hand (the window stretched
 * over its monitor because the system's own full screen did not cover it).
 */
let boundsBeforeFullscreen: { x: number; y: number; width: number; height: number } | null = null;

/** True when the window covers the whole monitor it is on. */
async function coversMonitor(): Promise<boolean> {
  const monitor = await currentMonitor();
  if (!monitor) return true;
  const pos = await appWindow.outerPosition();
  const size = await appWindow.outerSize();
  const m = monitor.position, ms = monitor.size;
  // Wayland always reports window outerPosition as (0, 0), even on secondary monitors.
  if (pos.x === 0 && pos.y === 0 && size.width >= ms.width && size.height >= ms.height) {
    return true;
  }
  return pos.x <= m.x && pos.y <= m.y
    && pos.x + size.width >= m.x + ms.width
    && pos.y + size.height >= m.y + ms.height;
}

const nextFrames = () => new Promise<void>((resolve) => setTimeout(resolve, 150));

async function toggleFullscreen(on = !fullscreen): Promise<void> {
  try {
    if (on) {
      // Windows keeps a maximized frameless window at its maximized size
      // (taskbar still showing) when asked to go full screen: restore it
      // first, and maximize it again on the way out.
      maximizedBeforeFullscreen = await appWindow.isMaximized();
      if (maximizedBeforeFullscreen) await appWindow.unmaximize();
      const pos = await appWindow.outerPosition();
      const size = await appWindow.outerSize();
      const before = { x: pos.x, y: pos.y, width: size.width, height: size.height };
      // The invisible resize strip on the top edge would sit over the menu
      // row (see resize_border.rs).
      await setResizeBorder(false).catch(() => {});
      await appWindow.setFullscreen(true);
      await nextFrames();
      if (!(await appWindow.isFullscreen()) || !(await coversMonitor())) {
        // The system did not make it full screen (seen on Windows 10 with a
        // frameless window): stretch the window over its monitor instead.
        // A borderless window covering the screen hides the taskbar.
        const monitor = await currentMonitor();
        if (monitor) {
          boundsBeforeFullscreen = before;
          await appWindow.setPosition(new PhysicalPosition(monitor.position.x, monitor.position.y));
          await appWindow.setSize(new PhysicalSize(monitor.size.width, monitor.size.height));
          await appWindow.setFocus();
        }
      }
    } else {
      await appWindow.setFullscreen(false);
      const bounds = boundsBeforeFullscreen;
      boundsBeforeFullscreen = null;
      if (bounds) {
        await appWindow.setSize(new PhysicalSize(bounds.width, bounds.height));
        await appWindow.setPosition(new PhysicalPosition(bounds.x, bounds.y));
      }
      if (maximizedBeforeFullscreen) {
        maximizedBeforeFullscreen = false;
        await appWindow.maximize();
      }
      await setResizeBorder(true).catch(() => {});
    }
  } catch (err) {
    // Browser preview: no window to resize.
    console.warn("full screen:", err);
  }
  fullscreen = on;
  document.body.classList.toggle("fullscreen", on);
}

// ── Presentation ──────────────────────────────────────────────────────────────

let presentation: Presentation | null = null;

/**
 * One page at a time over a black, full-screen view, from the current page.
 * On exit the viewer shows the last page presented and the window goes back
 * to how it was.
 */
async function startPresentation(): Promise<void> {
  if (presentation || !viewer.isLoaded()) return;
  const t = getTranslations(settingsModal.getSettings().language);
  const wasFullscreen = fullscreen;
  presentation = new Presentation({
    pageCount: viewer.pageCount,
    render: (n, w, h) => viewer.renderPageToFit(n, w, h),
    onExit: (page) => {
      presentation = null;
      if (!wasFullscreen) void toggleFullscreen(false);
      viewer.goToPage(page, "instant");
    },
  }, viewer.currentPage, {
    prev: t.ttPagePrev,
    next: t.ttPageNext,
    exit: t.ttPresentExit ?? "Stop presenting (Esc)",
  });
  const p = presentation;
  if (wasFullscreen) { p.open(); return; }
  // Black screen first, page later: going full screen moves and resizes the
  // window a few times, and a page drawn at each step jumped around.
  p.open({ hold: true });
  try {
    // Start drawing at the size the window is heading to (the monitor).
    const monitor = await currentMonitor();
    if (monitor) {
      const s = monitor.scaleFactor || window.devicePixelRatio || 1;
      p.prefetch(monitor.size.width / s, monitor.size.height / s);
    }
  } catch { /* browser preview: no monitor */ }
  try {
    await toggleFullscreen(true);
  } finally {
    await p.reveal();
  }
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

document.addEventListener("keydown", async (e) => {
  // macOS: the menu at the top of the screen answers these.
  if (menuOwnsKey(e)) return;
  const tag = (document.activeElement as HTMLElement)?.tagName ?? "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
      (document.activeElement as HTMLElement)?.isContentEditable) return;

  const ctrl  = e.ctrlKey || e.metaKey;
  const shift = e.shiftKey;

  if (e.key === "F11") {
    e.preventDefault();
    await toggleFullscreen();
    return;
  }
  if (e.key === "F5") {
    // Also keeps WebView2 from reloading the app.
    e.preventDefault();
    if (!shift && !ctrl && toolbar.allowed()) await startPresentation();
    return;
  }

  if (ctrl && !shift && e.key === "z") {
    e.preventDefault();
    void undoRedo(false);
    return;
  }
  if (ctrl && (e.key === "y" || (shift && e.key === "Z"))) {
    e.preventDefault();
    void undoRedo(true);
    return;
  }
  if (ctrl && !shift && e.key === "o") {
    e.preventDefault();
    if (!toolbar.allowed()) return;
    await openFile();
    return;
  }
  if (ctrl && !shift && e.key.toLowerCase() === "w") {
    e.preventDefault();
    const tab = docTabs.active;
    if (tab && toolbar.allowed()) await closeTab(tab.id);
    return;
  }
  if (ctrl && (e.key === "Tab" || e.key === "PageDown" || e.key === "PageUp")) {
    e.preventDefault();
    const back = e.key === "PageUp" || (e.key === "Tab" && shift);
    const next = docTabs.neighbour(back ? -1 : 1);
    if (next) await switchTab(next.id);
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
  if (ctrl && !shift && e.key === ",") {
    e.preventDefault();
    if (toolbar.allowed()) settingsModal.open();
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
    await openCompress();
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
    if (viewer.isLoaded()) { e.preventDefault(); viewer.nextPage(); }
    return;
  }
  if (!ctrl && (e.key === "ArrowLeft" || e.key === "PageUp")) {
    if (viewer.isLoaded()) { e.preventDefault(); viewer.prevPage(); }
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

/** Height / width of the signature being placed (0 until its picture loads). */
let pendingSignatureRatio = 0;

function startSignaturePlacement(imageData: string, vector?: InkVector): void {
  pendingSignature = imageData;
  pendingSignatureVector = vector;
  pendingSignatureRatio = vector && vector.w > 0 ? vector.h / vector.w : 0;
  const probe = new Image();
  probe.onload = () => {
    if (pendingSignature === imageData && probe.naturalWidth > 0) pendingSignatureRatio = probe.naturalHeight / probe.naturalWidth;
  };
  probe.src = `data:image/png;base64,${imageData}`;
  showSigPreview(imageData);
  document.getElementById("viewer-scroll")!.style.cursor = "none";
  updateHandMode();
  showToast(msg("msgPlaceSignature"));
}

function cancelSignaturePlacement(): void {
  if (!pendingSignature) return;
  pendingSignature = null;
  pendingSignatureVector = undefined;
  toolbar.setActiveSignature(null);
  hideSigPreview();
  document.getElementById("viewer-scroll")!.style.cursor = "";
  updateHandMode();
}

/** Saved signatures, shown in the Sign options. */
function refreshSignatures(): void {
  toolbar.setSignatures(sigStore.getAll().map((s) => ({ id: s.id, dataUrl: s.imageDataUrl })));
}
refreshSignatures();

sigModal.onSignatureReady((imageData, vector) => {
  refreshSignatures();
  startSignaturePlacement(imageData, vector);
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

  // 150 pt wide in the picture's own proportions (at most 75 pt high).
  const ratio = pendingSignatureRatio > 0 ? pendingSignatureRatio : 0.4;
  const h = Math.min(75, 150 * ratio);
  const w = h / ratio;
  pv.overlay.placeSignature(x, y, pendingSignature, w, h, pendingSignatureVector);
  cancelSignaturePlacement();
  // Ready to move and resize right away.
  if (toolState.tool !== "select") toolbar.clearActiveTool();
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
  if (menuOwnsKey(e)) return;
  if (e.ctrlKey && (e.key === "+" || e.key === "=" || e.key === "-")) {
    if (!viewer.isLoaded()) return;
    e.preventDefault();
    fitMode = "none"; toolbar.updateFitMode(fitMode);
    await viewer.setScale(snapZoom(viewer.scale, e.key === "-" ? -1 : 1), viewerCenter());
    toolbar.updateZoom(viewer.scale);
    return;
  }
  const active = document.activeElement as HTMLElement | null;
  const typing = !!active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT" || active.isContentEditable);
  if (typing) return;
  if (e.key === "Enter" && toolbar.isPending) {
    // Enter validates the pending changes (✓).
    e.preventDefault();
    annotations.apply();
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
  } else if (fullscreen) {
    await toggleFullscreen(false);
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
  tools.setStyle({ ...style, textBackground: null });
  for (const p of viewer.pageViews) p.overlay.refreshStyle();
  toolbar.showTextStyles(style);
  pv.overlay.replaceText(item);
});

// ── Pictures: placed on a page, or added as a page ───────────────────────────

/** Reads the picture at `path`; shows an error and returns null if it can't. */
async function readPicture(path: string): Promise<Picture | null> {
  try {
    return await loadPictureFile(path);
  } catch (err) {
    showToast(msg("msgImageFailed", { err: errText(err) }), true);
    return null;
  }
}

/** Places the picture (a file or one already read) centred on (x, y), canvas px of `pv`'s page. */
async function placePicture(source: string | Picture, pv: PdfPageView, x: number, y: number): Promise<void> {
  const pic = typeof source === "string" ? await readPicture(source) : source;
  if (!pic) return;
  // Natural size at 96 dpi, at most 60 % of the page.
  const page = pv.overlay.pageSizePt;
  const size = fitWithin(pic.width * 0.75, pic.height * 0.75, page.width * 0.6, page.height * 0.6);
  pv.overlay.placeImage(x, y, pic.data, size.width, size.height);
  // Ready to move and resize right away.
  if (toolState.tool !== "select") toolbar.clearActiveTool();
}

/** Places a picture on the page shown, centred on the part in view. */
async function placeInView(source: string | Picture): Promise<void> {
  const pv = viewer.pageViews.find((p) => p.pageNum === viewer.currentPage);
  if (!pv) return;
  const r = pv.overlay.screenRect;
  const view = document.getElementById("viewer-scroll")!.getBoundingClientRect();
  const top = Math.max(r.top, view.top), bottom = Math.min(r.bottom, view.bottom);
  await placePicture(source, pv, r.width / 2, (top + bottom) / 2 - r.top);
}

/** Asks for a picture and places it on the page shown. */
async function browsePicture(): Promise<void> {
  const path = await openImageDialog();
  if (path) await placeInView(path);
}

/**
 * Edit › Insert a picture and Ctrl+V of a copied picture: both switch to
 * Annotate (so it can be moved and resized right away) and place it on the
 * page shown.
 */
async function insertPicture(source?: Picture): Promise<void> {
  if (!viewer.isLoaded() || refuseIfProtected()) return;
  toolbar.setMode("annotate");
  if (toolbar.currentMode !== "annotate") return;
  if (source) await placeInView(source);
  else await browsePicture();
}

/** A copied picture as PNG (base64), whatever format the clipboard holds. */
async function clipboardPicture(file: File): Promise<Picture | null> {
  try {
    const bmp = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext("2d")!.drawImage(bmp, 0, 0);
    bmp.close();
    const data = canvas.toDataURL("image/png").split(",")[1] ?? "";
    return { data, width: canvas.width, height: canvas.height };
  } catch (err) {
    showToast(msg("msgImageFailed", { err: errText(err) }), true);
    return null;
  }
}

document.addEventListener("paste", async (e) => {
  const el = document.activeElement as HTMLElement | null;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
  const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.kind === "file" && i.type.startsWith("image/"));
  const file = item?.getAsFile();
  if (!file || !viewer.isLoaded()) return;
  e.preventDefault();
  if (!toolbar.allowed()) return;
  const pic = await clipboardPicture(file);
  if (pic) await insertPicture(pic);
});

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
  // Smooth zoom around the mouse: while the wheel turns, the pages already
  // drawn are only stretched; they are redrawn sharp once it stops.
  const px = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  const factor = Math.min(1.25, Math.max(0.8, Math.exp(-px * 0.0015)));
  const anchor = { x: e.clientX, y: e.clientY };
  const target = viewer.clampScale(viewer.shownScale * factor);
  if (fitMode !== "none") { fitMode = "none"; toolbar.updateFitMode(fitMode); }
  viewer.previewScale(target, anchor);
  toolbar.updateZoom(target);
  if (wheelZoomTimer) clearTimeout(wheelZoomTimer);
  wheelZoomTimer = setTimeout(async () => {
    wheelZoomTimer = null;
    await viewer.setScale(viewer.shownScale, anchor);
    toolbar.updateZoom(viewer.scale);
  }, 200);
}, { passive: false });

/** Redraws the pages once the Ctrl+wheel zoom stops. */
let wheelZoomTimer: ReturnType<typeof setTimeout> | null = null;

/** The middle of the page area: buttons and keys zoom around it. */
function viewerCenter(): { x: number; y: number } {
  const r = document.getElementById("viewer-scroll")!.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

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
    for (const pdf of pdfs) await openPath(pdf);
  } else if (!viewer.isLoaded()) {
    // On the launcher: the pictures become a new document.
    await openPictures(images);
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
