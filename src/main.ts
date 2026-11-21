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
  openPagesDialog,
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
  openForDisplay,
  getStartupArgs,
  printPages,
  extractPdfPages,
  openPagesInNewWindow,
  extractPagesToTemp,
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
  quickLookState,
  setQuickLook,
  tabDragHover,
  tabDragEnd,
  moveTab,
  type StartupArgs,
} from "./tauri-bridge";
import { DocTabs, type DocTab } from "./doc-tabs";
import { isLinux, isMac, macShortcuts } from "./platform";
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
import { SmoothWheelScroller, normalizeWheelDelta } from "./wheel-scroll";
import { tempDir, basename } from "@tauri-apps/api/path";
import { ask } from "@tauri-apps/plugin-dialog";

const ZOOM_LEVELS = [0.1, 0.15, 0.2, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0]
  .map(z => Math.round(z * CSS_UNITS * 1000) / 1000);

function snapZoom(current: number, dir: 1 | -1): number {
  if (dir === 1) {
    return ZOOM_LEVELS.find(z => z > current + 0.005) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
  } else {
    return [...ZOOM_LEVELS].reverse().find(z => z < current - 0.005) ?? ZOOM_LEVELS[0];
  }
}

const appWindow = getCurrentWindow();
let unlistenClose: (() => void) | null = null;

const formValues = new Map<string, string>();

let guardRegistering = false;
let fitMode: "none" | "fit-width" | "fit-height" | "fit-page" = "none";
let pendingSignature: string | null = null;
let pendingSignatureVector: InkVector | undefined;
let editingTextAnn:      TextAnnotation | null = null;
let editingShapeAnn:     ShapeAnnotation | null = null;
let editingHighlightAnn: HighlightAnnotation | null = null;
let editingSignatureAnn: SignatureAnnotation | null = null;

const viewer = new PdfViewer();
viewer.liveText.setRecognizer((data) => ocrImage(data, ocrLanguage()));
const tools = new ToolSelection();
const toolState = tools.state;
const toolbar   = new Toolbar();
const docTabs = new DocTabs<ParkedDoc>();
let shownPath: string | null = null;
let tabSwitch: Promise<void> | null = null;

const tabStrip = new TabStrip(document.getElementById("menubar-row")!, toolbar.titleElement, {
  activate: (id) => void switchTab(id),
  close: (id) => void closeTab(id),
  move: (id, index) => { docTabs.move(id, index); renderTabs(); },
  hover: (x, y) => tabDragHover(x, y),
  hoverEnd: () => void tabDragEnd().catch(() => {}),
  detach: (id, x, y) => void detachTab(id, x, y),
});

const annotations: AnnotationSession = new AnnotationSession({
  gateEnabled: () => false,
  isDirty: (): boolean => session.isDirty,
});
annotations.onChange(() => { setDirty(true); pageHistory.clearRedo(); });
annotations.onPendingChange((pending) => toolbar.setPending(pending));
const pageHistory = new PageHistory();
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

const studio = new StudioPanel(toolbar.toolOptions, {
  list: () => annotations.all(),
  selected: () => tools.selected,
  pick: (ann) => pickAnnotation(ann),
  remove: (ann) => removeAnnotation(ann),
});
document.getElementById("viewer-area")!.append(studio.el);
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

function pickAnnotation(ann: Annotation): void {
  if (!annotations.has(ann)) return;
  if (toolState.tool !== "select") toolbar.clearActiveTool();
  if (ann.page !== viewer.currentPage) viewer.goToPage(ann.page, "instant");
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

function removeAnnotation(ann: Annotation): void {
  if (!annotations.has(ann)) return;
  if (tools.selected === ann) tools.select(null);
  if (editingTextAnn === ann) { editingTextAnn = null; toolbar.hideTextStyles(); }
  if (editingShapeAnn === ann) { editingShapeAnn = null; toolbar.hideShapeStyles(); }
  if (editingHighlightAnn === ann) { editingHighlightAnn = null; toolbar.hideHighlightStyles(); }
  annotations.remove(ann);
  viewer.pageViews.find((p) => p.pageNum === ann.page)?.builtOverlay?.redrawCommitted();
}

let tempPrefix: Promise<[string, string]> | null = null;

async function newTempPath(suffix: string): Promise<string> {
  tempPrefix ??= Promise.all([tempDir(), tempTag()]);
  const [dir, tag] = await tempPrefix;
  return uniqueTempName(dir, tag, suffix);
}

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

const protection = new Protection({
  session,
  toolbar,
  passwords: passwordModal,
  msg,
  notify: (text, isError) => showToast(text, isError),
  setDirty: (dirty) => setDirty(dirty),
});

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
    scale = pageFitScale(page, room);
  } else {
    scale = (room.height - VIEWER_PADDING) / page.height;
  }
  if (Math.abs(viewer.clampScale(scale) - viewer.scale) > 1e-6) await viewer.setScale(scale);
  else viewer.reflow();
  toolbar.updateZoom(viewer.scale);
}

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

function firstPageShown(): { width: number; height: number } {
  const w = viewer.pageWidthPt, h = viewer.pageHeightPt;
  return viewer.rotation % 180 === 0 ? { width: w, height: h } : { width: h, height: w };
}

let autoFitWindow = true;

function scrollbarSize(): number {
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;width:100px;height:100px;overflow:scroll;";
  document.body.append(probe);
  const size = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return size;
}

async function fitWindowToDocument(): Promise<boolean> {
  if (!("__TAURI_INTERNALS__" in window)) return true;
  const pref = parseFloat(settingsModal.getSettings().defaultZoom);
  try {
    await setLauncherRatioLock(false);
    if (!autoFitWindow) return true;
    if (fullscreen || docTabs.count > 1 || await appWindow.isMaximized()) return preferredZoomShowsPage(pref);
    const monitor = await currentMonitor();
    if (!monitor) return preferredZoomShowsPage(pref);
    const sf = monitor.scaleFactor || 1;
    const scroll = document.getElementById("viewer-scroll")!;
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
    return plan.preferredFits && preferredZoomShowsPage(pref);
  } catch (err) {
    console.warn("fit window:", err);
    return preferredZoomShowsPage(pref);
  }
}

function preferredZoomShowsPage(pref: number): boolean {
  if (!Number.isFinite(pref)) return true;
  const room = pageRoom();
  const biggest = pageFitScale(firstPageShown(), { width: room.width + 2, height: room.height + 2 });
  return pref / 100 * CSS_UNITS <= biggest + 1e-6;
}

async function windowSizeSettles(target: { width: number; height: number }): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (Math.abs(window.innerWidth - target.width) <= 2 && Math.abs(window.innerHeight - target.height) <= 2) break;
    await new Promise((r) => setTimeout(r, 16));
  }
  await new Promise((r) => requestAnimationFrame(() => r(null)));
}

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
  if (refuseIfProtected()) return;
  formValues.set(name, val);
  setDirty(true);
}

viewer.setup(tools, annotations, formValues, onFormChange);

viewer.overlayEvents.onPick((ann, ov) => {
  if (toolState.tool !== "select") toolbar.clearActiveTool();
  ov.select(ann);
});

viewer.overlayEvents.onTextSelected((ann) => {
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

viewer.overlayEvents.onShapeSelected((ann) => {
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

viewer.overlayEvents.onHighlightSelected((ann) => {
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

viewer.onLayoutChanged((pageViews) => {
  toolbar.updateLayout(viewer.forcedColumns, viewer.scrollMode, viewer.columnCount, viewer.evenSpread);
  for (const pv of pageViews) {
    pv.builtOverlay?.setTool(tools.tool);
    pv.builtOverlay?.refreshStyle();
  }
});

viewer.onRenderActivity((busy) => pageSidebar.setViewerBusy(busy));

document.getElementById("viewer-scroll")!.addEventListener("focused-page-changed", (e: Event) => {
  const { page } = (e as CustomEvent<{ page: number }>).detail;
  pageSidebar.setCurrentPage(page);
});

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

mountWindowControls(document.getElementById("menubar-row")!, () => {
  const t = getTranslations(settingsModal.getSettings().language);
  return {
    minimize: t.wcMinimize ?? "Minimize",
    maximize: t.wcMaximize ?? "Maximize",
    restore:  t.wcRestore  ?? "Restore",
    close:    t.wcClose    ?? "Close",
  };
});

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
toolbar.brightness.value = settingsModal.getSettings().pageBrightness;
toolbar.brightness.onInput((v) => applyPageBrightness(v));
toolbar.brightness.onCommit((v) => settingsModal.setPageBrightness(v));

pageSidebar.setOutlineExpanded(settingsModal.getSettings().outlineExpanded);

settingsModal.onChange(s => {
  toolbar.brightness.value = s.pageBrightness;
  pageSidebar.setOutlineExpanded(s.outlineExpanded);
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

(async () => {
  try {
    await appWindow.listen<string[]>("open-files", async ({ payload }) => {
      for (const p of payload) await openPath(p);
    });
  } catch {
  }
  const app = document.getElementById("app")!;
  const reveal = () => app.classList.remove("booting");
  try {
    const startup = await getStartupArgs();
    if (!startup.filePath) {
      reveal();
    } else {
      setWelcomeVisible(false);
      const slow = setTimeout(reveal, 1500);
      try {
        await openStartupFile(startup);
      } finally {
        clearTimeout(slow);
        if (!session.isOpen) setWelcomeVisible(true);
        reveal();
      }
    }
  } catch {
    reveal();
  }
})();

async function openStartupFile(startup: StartupArgs): Promise<void> {
  const file = startup.filePath!;
  if (startup.shouldPrint) {
    autoFitWindow = false;
    document.getElementById("toolbar-container")!.style.display = "none";
    await loadPdf(file);
    document.getElementById("app")!.classList.remove("booting");
    const all = Array.from({ length: viewer.pageCount }, (_, i) => i + 1);
    await printPages(await renderForPrint(all));
    await appWindow.close();
  } else if (openKind(file) === "pictures") {
    await openPictures([file]);
  } else {
    await openTransferred(startup);
  }
}

function showToast(msg: string, isError = false): void {
  const toast = document.getElementById("toast")!;
  toast.textContent = msg;
  toast.className = `toast${isError ? " error" : ""}`;
  setTimeout(() => toast.classList.add("hidden"), 3000);
}

function setDirty(val: boolean): void {
  session.markDirty(val);
  toolbar.setDocTitle(session.displayName, val);
  if (session.isOpen && !docTabs.active) docTabs.add();
  syncActiveTab();
  if (docTabs.anyDirty) { void registerCloseGuard(); }
  else                  { unregisterCloseGuard(); }
}

function dropStaleSelection(): void {
  editingTextAnn = null;
  editingShapeAnn = null;
  editingHighlightAnn = null;
  toolbar.hideTextStyles();
  toolbar.hideShapeStyles();
  toolbar.hideHighlightStyles();
}

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

function discardDraft(): void {
  const dirty = annotations.discard();
  if (dirty === null) return;
  dropStaleSelection();
  syncAllPageOverlays();
  setDirty(dirty || session.pendingName !== null);
}

let closeGuardBusy = false;
let savingBeforeLeaving = false;

async function registerCloseGuard(): Promise<void> {
  if (unlistenClose || guardRegistering) return;
  guardRegistering = true;
  try {
    unlistenClose = await appWindow.onCloseRequested(async (event) => {
      if (!docTabs.anyDirty) { return; }
      if (savingBeforeLeaving) { event.preventDefault(); return; }
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

function syncProtection(): void {
  protection.sync();
}

function refuseIfProtected(): boolean {
  return protection.refuse();
}

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

function showThumbnails(reload = false): void {
  if (!viewer.document) return;
  pageSidebar.load(viewer.document, viewer.pageDimensions, viewer.rotation);
  pageSidebar.setCurrentPage(viewer.currentPage, !reload);
  docSearch.reset(viewer.document);
  void runSearch(toolbar.search.query, false);
}

let searchMatches: SearchMatch[] = [];
let searchIndex = -1;

function searchText(key: "sbSearchNone" | "sbSearching", fallback: string): string {
  return getTranslations(settingsModal.getSettings().language)[key] ?? fallback;
}

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
  if (!found) return;
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

async function showInViewer(path: string, reload = false): Promise<string | null> {
  annotations.clear();
  formValues.clear();

  const working = await newTempPath(`display-${fileNameOf(path)}`);
  const shown = await openForDisplay(path, working);
  annotations.load(shown.annotations);
  const workingCopy = shown.workingCopy ? working : null;

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

async function openPath(path: string): Promise<void> {
  if (openKind(path) === "pictures") { await openPictures([path]); return; }
  const open = tabShowing(path);
  if (open) { await switchTab(open.id); return; }
  await inNewTab(() => loadPdf(path));
}

async function openPictures(paths: string[]): Promise<void> {
  await inNewTab(() => picturesToTab(paths));
}

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

interface ParkedDoc {
  session: SessionSnapshot;
  annotations: AnnotationSnapshot;
  history: { undo: DocState[]; redo: DocState[] };
  forms: [string, string][];
  shownPath: string;
  rotation: number;
  scale: number;
  fitMode: "none" | "fit-width" | "fit-height" | "fit-page";
  page: number;
  scrollTop: number;
  scrollLeft: number;
}

function tabCloseLabel(t: { tabClose?: string }): string | undefined {
  return t.tabClose && (isMac ? macShortcuts(t.tabClose) : t.tabClose);
}

function renderTabs(): void {
  tabStrip.render(docTabs.tabs, docTabs.active?.id ?? null);
}

function syncActiveTab(): void {
  const tab = docTabs.active;
  if (tab && session.isOpen) {
    tab.title = session.displayName ?? "";
    tab.dirty = session.isDirty;
  }
  renderTabs();
}

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

async function tabsSettled(): Promise<void> {
  while (tabSwitch) await tabSwitch;
}

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

async function closeTab(id: number): Promise<void> {
  await tabsSettled();
  const tab = docTabs.get(id);
  if (!tab) return;
  if (tab !== docTabs.active) {
    if (!tab.dirty) { docTabs.remove(id); renderTabs(); setDirty(session.isDirty); return; }
    await switchTab(id);
    if (docTabs.active !== tab) return;
  }
  if (!await settleUnsaved("msgSaveBeforeClose")) return;
  await dropActiveTab();
}

async function dropActiveTab(): Promise<void> {
  const tab = docTabs.active;
  if (!tab) return;
  const next = docTabs.remove(tab.id);
  if (next) await showTab(next);
  else await closeDocument();
}

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

async function settleAllTabs(): Promise<boolean> {
  await tabsSettled();
  for (const tab of [...docTabs.tabs]) {
    if (!tab.dirty) continue;
    if (tab !== docTabs.active) {
      await switchTab(tab.id);
      if (docTabs.active !== tab) return false;
    }
    if (!await settleUnsaved("msgSaveBeforeClose")) return false;
    tab.dirty = false;
  }
  return true;
}

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
  session.markDirty(false);
  tab.dirty = false;
  if (docTabs.count > 1) {
    await dropActiveTab();
  } else {
    unregisterCloseGuard();
    await appWindow.destroy();
  }
}

async function transferOfActive(): Promise<{ args: StartupArgs; name: string | null }> {
  const page = viewer.currentPage;
  annotations.apply();
  const base = { shouldPrint: false, page };
  if (session.isProtected) {
    return { args: { ...base, filePath: session.sourcePath, password: session.filePassword }, name: null };
  }
  const unsaved = session.isUnsavedCopy;
  if (!session.isDirty && !unsaved) {
    return { args: { ...base, filePath: session.sourcePath }, name: null };
  }
  const file = await session.materialize();
  return {
    args: { ...base, filePath: file, unsaved, dirty: session.isDirty, savePath: unsaved ? null : session.saveTarget },
    name: unsaved ? session.displayName : null,
  };
}

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
  }
})();

async function saveFile(forceDialog: boolean): Promise<void> {
  const current = session.saveTarget;
  if (!current || refuseIfProtected()) return;
  let target = current;
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
        toolbar.flashSave("ok");
        return;
      }
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
      const page = viewer.currentPage;
      await loadPdf(target, session.filePassword);
      viewer.goToPage(page);
    }
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

function docStem(): string {
  return exportFlow.docStem();
}

function openExport(): void {
  exportFlow.open();
}

async function editPassword(): Promise<void> {
  await protection.edit();
}

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

async function renderForPrint(pages: number[]): Promise<string[]> {
  if (!session.hasPendingEdits()) {
    return viewer.renderPagesForPrint(pages, 200);
  }
  return viewer.renderFileForPrint(await session.materialize(), pages, 200);
}

async function applyPageLayout({ slots, keepPage, select }: PagePlan): Promise<boolean> {
  const source = session.sourcePath;
  if (!source) return false;
  try {
    const input   = await session.materialize();
    const before  = { path: input, page: viewer.currentPage, dirty: session.isDirty };
    const tmpPath = await newTempPath(`pages-${await basename(source)}`);
    await rearrangePages(input, tmpPath, slots);
    const workingCopy = await showInViewer(tmpPath, true);
    session.replacedWorkingCopy(workingCopy ?? tmpPath);
    pageHistory.record(before);
    setDirty(true);
    if (keepPage !== null && keepPage !== viewer.currentPage) viewer.goToPage(keepPage, "instant");
    pageSidebar.setSelection(select);
    return true;
  } catch (err) {
    showToast(msg("msgPagesFailed", { err: errText(err) }), true);
    return false;
  }
}

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

async function insertSlots(after: number, inserted: PageSlot[]): Promise<void> {
  if (await editPages(planInsert(viewer.pageCount, after, inserted))) showToast(msg("msgPagesUpdated"));
}

pageSidebar.onSelectionChange((pages) => toolbar.setPageSelection(pages.length));

function openAdjust(kind: "crop" | "straighten"): void {
  const doc = viewer.document;
  if (!doc || adjustView.isOpen) return;
  const pages = pageSidebar.selection.length > 0 ? pageSidebar.selection : [viewer.currentPage];
  cancelSignaturePlacement();
  toolbar.search.close();
  appEl.classList.add("adjusting");
  adjustView.open(doc, pages, kind, viewer.rotation);
}

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
  const ref = viewer.pageDimensions[Math.max(0, after - 1)] ?? { width: 595.28, height: 841.89 };
  await insertSlots(after, [{ kind: "blank", width: ref.width, height: ref.height, rotation: 0 }]);
});

pageSidebar.onInsertImages(async (after) => {
  const paths = await openImagesDialog();
  if (paths.length > 0) await insertPictures(after, paths);
});

pageSidebar.onInsertPdf(async (after) => {
  const paths = await openPagesDialog();
  await insertFiles(after, paths);
});

/** PDFs and pictures, in the order picked, in one step: each PDF brings all its pages, each picture one page. */
async function insertFiles(after: number, paths: string[]): Promise<void> {
  const slots: PageSlot[] = [];
  for (const path of paths) {
    if (isImagePath(path)) {
      const pic = await readPicture(path);
      if (pic) slots.push({ kind: "image", data: pic.data, rotation: 0 });
    } else if (path.toLowerCase().endsWith(".pdf")) {
      let count: number;
      try {
        count = await getPageCount(path);
      } catch (err) {
        showToast(msg("msgPagesFailed", { err: errText(err) }), true);
        return;
      }
      for (let i = 1; i <= count; i++) slots.push({ kind: "imported", path, page: i, rotation: 0 });
    }
  }
  if (slots.length > 0) await insertSlots(after, slots);
}

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

function pagesDocName(pages: number[]): string {
  const t = getTranslations(settingsModal.getSettings().language);
  const pattern = pages.length === 1 ? t.nwPageOne ?? "{name} (page {pages})" : t.nwPageMany ?? "{name} (pages {pages})";
  return `${fmt(pattern, { name: docStem(), pages: formatPageRange(pages) })}.pdf`;
}

pageSidebar.onDragOut(async (pages, x, y) => {
  if (!session.isOpen || !viewer.isLoaded() || refuseIfProtected()) return;
  pageSidebar.setBusy(true);
  try {
    await openPagesInNewWindow(await session.materialize(), pages, pagesDocName(pages), x, y);
  } catch (err) {
    showToast(msg("msgNewWindowFailed", { err: errText(err) }), true);
  } finally {
    pageSidebar.setBusy(false);
  }
});

pageSidebar.onTabZone((over) => tabStrip.setDropTarget(over));

pageSidebar.onDragToTab(async (pages) => {
  if (!session.isOpen || !viewer.isLoaded() || refuseIfProtected()) return;
  let file: string;
  pageSidebar.setBusy(true);
  try {
    file = await extractPagesToTemp(await session.materialize(), pages, pagesDocName(pages));
  } catch (err) {
    showToast(msg("msgOpenFailed", { err: errText(err) }), true);
    return;
  } finally {
    pageSidebar.setBusy(false);
  }
  await openTransferred({ filePath: file, shouldPrint: false, unsaved: true });
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
      if (refuseIfProtected()) return;
      const out = await savePdfDialog(source);
      if (!out) return;
      await extractPdfPages(await session.materialize(), out, settings.pageRange);
      showToast(msg("msgPdfSaved"));
    } else {
      const pages = await renderForPrint(settings.pageRange);
      await printPages(pages, settings.printerName, settings.copies, settings.orientation, settings.fitMode);
      showToast(msg("msgSentToPrinter"));
    }
  } catch (err) {
    showToast(msg("msgPrintFailed", { err: errText(err) }), true);
  }
});

mountWelcomeDots(document.getElementById("welcome-screen")!);

const welcomePrefs = new WelcomePrefs(document.getElementById("welcome-screen")!, {
  language: () => settingsModal.getSettings().language,
  setLanguage: (code) => settingsModal.setLanguage(code),
  t: () => getTranslations(settingsModal.getSettings().language),
  isDefault: () => isDefaultPdfReader(),
  setDefault: async (on) => {
    if (on) {
      await registerPdfHandler();
      await registerPrintVerb();
    } else {
      await unregisterPdfHandler();
    }
    await openDefaultAppsSettings();
  },
  quickLook: () => quickLookState(),
  setQuickLook: async (on) => {
    try {
      await setQuickLook(on);
    } catch (err) {
      const t = getTranslations(settingsModal.getSettings().language);
      const blocked = err instanceof Error && err.message === "startup-blocked";
      showToast(blocked ? t.settingsQuickLookBlocked ?? errText(err) : errText(err), true);
      throw err;
    }
  },
});
void welcomePrefs.refresh();
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
window.addEventListener("focus", () => void welcomePrefs.refresh());

document.getElementById("welcome-open-btn")?.addEventListener("click", async () => {
  await openFile();
});

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
      openExport();
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
      for (const pv of viewer.pageViews) pv.builtOverlay?.setTool(e.tool);
      editingTextAnn      = null;
      editingShapeAnn     = null;
      editingHighlightAnn = null;
      if (e.tool !== "signature") cancelSignaturePlacement();
      break;

    case "style-change":
      tools.setStyle(e.style);
      for (const pv of viewer.pageViews) pv.builtOverlay?.refreshStyle();
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
          viewer.pageViews.find(p => p.pageNum === ann.page)?.builtOverlay?.redrawCommitted();
          annotations.edited();
        }
      }
      break;

    case "layer-change": {
      const ann = editingTextAnn ?? editingShapeAnn;
      if (ann) {
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

let fullscreen = false;

let maximizedBeforeFullscreen = false;
let boundsBeforeFullscreen: { x: number; y: number; width: number; height: number } | null = null;

async function coversMonitor(): Promise<boolean> {
  const monitor = await currentMonitor();
  if (!monitor) return true;
  const pos = await appWindow.outerPosition();
  const size = await appWindow.outerSize();
  const m = monitor.position, ms = monitor.size;
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
      maximizedBeforeFullscreen = await appWindow.isMaximized();
      if (maximizedBeforeFullscreen) await appWindow.unmaximize();
      const pos = await appWindow.outerPosition();
      const size = await appWindow.outerSize();
      const before = { x: pos.x, y: pos.y, width: size.width, height: size.height };
      await setResizeBorder(false).catch(() => {});
      await appWindow.setFullscreen(true);
      await nextFrames();
      if (!(await appWindow.isFullscreen()) || !(await coversMonitor())) {
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
    console.warn("full screen:", err);
  }
  fullscreen = on;
  document.body.classList.toggle("fullscreen", on);
}

let presentation: Presentation | null = null;

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
  p.open({ hold: true });
  try {
    const monitor = await currentMonitor();
    if (monitor) {
      const s = monitor.scaleFactor || window.devicePixelRatio || 1;
      p.prefetch(monitor.size.width / s, monitor.size.height / s);
    }
  } catch {}
  try {
    await toggleFullscreen(true);
  } finally {
    await p.reveal();
  }
}

document.addEventListener("keydown", async (e) => {
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

function refreshSignatures(): void {
  toolbar.setSignatures(sigStore.getAll().map((s) => ({ id: s.id, dataUrl: s.imageDataUrl })));
}
refreshSignatures();

sigModal.onSignatureReady((imageData, vector) => {
  refreshSignatures();
  startSignaturePlacement(imageData, vector);
});

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

  const ratio = pendingSignatureRatio > 0 ? pendingSignatureRatio : 0.4;
  const h = Math.min(75, 150 * ratio);
  const w = h / ratio;
  pv.overlay.placeSignature(x, y, pendingSignature, w, h, pendingSignatureVector);
  cancelSignaturePlacement();
  if (toolState.tool !== "select") toolbar.clearActiveTool();
});

const ctxMenu    = document.getElementById("ctx-menu")!;
const ctxCopyBtn = document.getElementById("ctx-copy") as HTMLButtonElement;

document.addEventListener("contextmenu", (e: MouseEvent) => {
  e.preventDefault();
  const hlPage = document.querySelector(".hl-popover")?.closest(".page-wrapper");
  if (hlPage && hlPage.contains(e.target as Node)) {
    ctxMenu.classList.add("hidden");
    return;
  }
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
    e.preventDefault();
    annotations.apply();
    return;
  }
  if (e.key !== "Escape") return;
  if (pendingSignature) {
    cancelSignaturePlacement();
    showToast(msg("msgSignatureCancelled"));
  } else if (toolbar.isPending) {
    discardDraft();
  } else if (toolState.tool !== "select") {
    toolbar.clearActiveTool();
  } else if (fullscreen) {
    await toggleFullscreen(false);
  }
});

function familyOf(css: string | undefined): FontFamilyValue {
  if (!css) return "helvetica";
  if (/mono|courier/i.test(css)) return "courier";
  if (/serif/i.test(css) && !/sans/i.test(css)) return "times";
  return "helvetica";
}

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
  const style = {
    color: { r: 0, g: 0, b: 0 }, fontSize: Math.max(4, Math.round(fontSize)),
    bold: false, italic: false, underline: false, fontFamily: item.family, backgroundColor: null,
  };
  tools.setStyle({ ...style, textBackground: null });
  for (const p of viewer.pageViews) p.builtOverlay?.refreshStyle();
  toolbar.showTextStyles(style);
  pv.overlay.replaceText(item);
});

async function readPicture(path: string): Promise<Picture | null> {
  try {
    return await loadPictureFile(path);
  } catch (err) {
    showToast(msg("msgImageFailed", { err: errText(err) }), true);
    return null;
  }
}

async function placePicture(source: string | Picture, pv: PdfPageView, x: number, y: number): Promise<void> {
  const pic = typeof source === "string" ? await readPicture(source) : source;
  if (!pic) return;
  const page = pv.overlay.pageSizePt;
  const size = fitWithin(pic.width * 0.75, pic.height * 0.75, page.width * 0.6, page.height * 0.6);
  pv.overlay.placeImage(x, y, pic.data, size.width, size.height);
  if (toolState.tool !== "select") toolbar.clearActiveTool();
}

async function placeInView(source: string | Picture): Promise<void> {
  const pv = viewer.pageViews.find((p) => p.pageNum === viewer.currentPage);
  if (!pv) return;
  const r = pv.overlay.screenRect;
  const view = document.getElementById("viewer-scroll")!.getBoundingClientRect();
  const top = Math.max(r.top, view.top), bottom = Math.min(r.bottom, view.bottom);
  await placePicture(source, pv, r.width / 2, (top + bottom) / 2 - r.top);
}

async function browsePicture(): Promise<void> {
  const path = await openImageDialog();
  if (path) await placeInView(path);
}

async function insertPicture(source?: Picture): Promise<void> {
  if (!viewer.isLoaded() || refuseIfProtected()) return;
  toolbar.setMode("annotate");
  if (toolbar.currentMode !== "annotate") return;
  if (source) await placeInView(source);
  else await browsePicture();
}

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

async function insertPictures(after: number, paths: string[]): Promise<void> {
  const slots: PageSlot[] = [];
  for (const path of paths) {
    const pic = await readPicture(path);
    if (pic) slots.push({ kind: "image", data: pic.data, rotation: 0 });
  }
  if (slots.length > 0) await insertSlots(after, slots);
}

document.getElementById("viewer-scroll")!.addEventListener("mouseup", () => {
  if (toolState.tool !== "highlight" && toolState.tool !== "redact-text") return;
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
        const b = p.builtOverlay?.screenRect;
        return !!b && cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom;
      });
      if (!pv) continue;
      const b = pv.overlay.screenRect;
      const list = byPage.get(pv) ?? [];
      const next = { left: r.left - b.left, top: r.top - b.top, right: r.right - b.left, bottom: r.bottom - b.top };
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

const viewerScrollEl = document.getElementById("viewer-scroll")!;
const wheelScroller = isLinux ? new SmoothWheelScroller(viewerScrollEl) : null;

viewerScrollEl.addEventListener("wheel", async (e: WheelEvent) => {
  if (!e.ctrlKey) {
    if (e.defaultPrevented) return;
    if (wheelScroller && viewer.isLoaded()) {
      const { dx, dy, discrete } = normalizeWheelDelta({
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        shiftKey: e.shiftKey,
        horizontalMode: viewer.scrollMode === "horizontal",
        clientWidth: viewerScrollEl.clientWidth,
        clientHeight: viewerScrollEl.clientHeight,
      });
      if (dx === 0 && dy === 0) return;
      if (discrete || wheelScroller.isAnimating) {
        e.preventDefault();
        wheelScroller.scrollBy(dx, dy);
        return;
      }
    }
    if (viewer.scrollMode === "horizontal" && !e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      const lines = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? viewerScrollEl.clientWidth : 1;
      viewerScrollEl.scrollLeft += e.deltaY * lines;
    }
    return;
  }
  if (!e.ctrlKey || !viewer.isLoaded()) return;
  wheelScroller?.cancel();
  e.preventDefault();
  const px = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  wheelZoom.factor *= Math.min(1.25, Math.max(0.8, Math.exp(-px * 0.0015)));
  wheelZoom.anchor = { x: e.clientX, y: e.clientY };
  wheelZoom.settleMs = Math.abs(px) < 50 ? WHEEL_ZOOM_SETTLE_SMOOTH_MS : WHEEL_ZOOM_SETTLE_NOTCH_MS;
  if (fitMode !== "none") { fitMode = "none"; toolbar.updateFitMode(fitMode); }
  if (!wheelZoom.raf) wheelZoom.raf = requestAnimationFrame(applyWheelZoom);
}, { passive: false });

const WHEEL_ZOOM_SETTLE_SMOOTH_MS = 80;
const WHEEL_ZOOM_SETTLE_NOTCH_MS = 130;

const wheelZoom = {
  factor: 1,
  anchor: { x: 0, y: 0 },
  settleMs: WHEEL_ZOOM_SETTLE_NOTCH_MS,
  raf: 0,
  timer: null as ReturnType<typeof setTimeout> | null,
};

function applyWheelZoom(): void {
  wheelZoom.raf = 0;
  if (!viewer.isLoaded()) { wheelZoom.factor = 1; return; }
  const anchor = wheelZoom.anchor;
  const target = viewer.clampScale(viewer.shownScale * wheelZoom.factor);
  wheelZoom.factor = 1;
  viewer.previewScale(target, anchor);
  toolbar.updateZoom(target);
  if (wheelZoom.timer) clearTimeout(wheelZoom.timer);
  wheelZoom.timer = setTimeout(async () => {
    wheelZoom.timer = null;
    await viewer.setScale(viewer.shownScale, anchor);
    toolbar.updateZoom(viewer.scale);
  }, wheelZoom.settleMs);
}

function viewerCenter(): { x: number; y: number } {
  const r = document.getElementById("viewer-scroll")!.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

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
    await openPictures(images);
  } else {
    showToast(msg("msgDropImageOnPage"));
  }
}

(async () => {
  try {
    await appWindow.onDragDropEvent(async (event) => {
      const p = event.payload;
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
  }
})();
