import { errorCode } from "./errors";
import { createMessages } from "./messages";
import { Protection } from "./protection";
import { setUpCompress } from "./compress-flow";
import { setUpExport } from "./export-flow";
import type { Feedback } from "./backend";
import { tauriBackend } from "./tauri-backend";
import { fileNameOf } from "./file-paths";
import { mountWelcomeDots } from "./welcome-dots";
import { pdfjsLib } from "./pdfjs";
import { WelcomePrefs } from "./welcome-prefs";
import { UpdateBadge } from "./update-badge";
import { UpdateToast } from "./update-toast";
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
import { PageEditor } from "./page-editor";
import { ToolSelection } from "./tool-selection";
import {
  type Annotation,
  type FormFieldValue,
  type RgbColor,
  CSS_UNITS,
  type InkVector,
} from "./models";
import { StudioPanel } from "./studio-panel";
import { backgroundColorFrom, matchPdfFont, textColorFrom } from "./font-match";
import { setSelectionPillLabels, type PageTextItem } from "./canvas-overlay";
import { colorName } from "./tool-row";
import { fitWithin, isImagePath, openKind, picturesDocument, type Picture } from "./pictures";
import {
  openPagesDialog,
  openDocumentDialog,
  openDocumentsDialog,
  picturesToNewPdf,
  getPageCount,
  listSystemFonts,
  listPdfFonts,
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
  setResizeBorder,
  isDefaultPdfReader,
  checkForUpdate,
  installUpdate,
  prepareUpdate,
  registerPdfHandler,
  registerPrintVerb,
  unregisterPdfHandler,
  openDefaultAppsSettings,
  quickLookState,
  tabDragHover,
  tabDragEnd,
  moveTab,
  type StartupArgs,
} from "./tauri-bridge";
import { DocWorkspace } from "./doc-workspace";
import { AnnotationEditor } from "./annotation-editor";
import { AnnotationClipboard, copyable } from "./annotation-clipboard";
import { isLinux, isMac, macShortcuts } from "./platform";
import { TabStrip } from "./tab-strip";
import { SideTabs } from "./side-tabs";
import type { SessionSnapshot } from "./document-session";
import type { AnnotationSnapshot } from "./annotation-session";
import type { DocState } from "./page-history";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { a4WelcomeWidth, keepCentred, pageFitScale, planWindowFit } from "./window-fit";
import { showQuickLookCard } from "./welcome-quick-look";
import { mountWindowControls } from "./window-controls";
import { menuOwnsKey } from "./mac-menu";
import { InfoPanel } from "./info-panel";
import { SmoothWheelScroller, normalizeWheelDelta } from "./wheel-scroll";
import { tempDir, basename } from "@tauri-apps/api/path";
import { ask } from "@tauri-apps/plugin-dialog";
import { ViewZoom, type FitMode } from "./view-zoom";
import { EpubReader } from "./epub-reader";
import { EpubError } from "./epub-book";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl as openExternalUrl, openFileInNewWindow as openInNewWindow, inflateRaw, canPrintHtmlToPdf, printHtmlPages, finishBookPdf } from "./tauri-bridge";
import { bookToPdf } from "./epub-pdf";
import { SAFE_PDF } from "./pdf-options";
import { setInflateFallback } from "./epub-zip";

const appWindow = getCurrentWindow();
let unlistenClose: (() => void) | null = null;

const formValues = new Map<string, string>();

let guardRegistering = false;
let pendingSignature: string | null = null;
let pendingSignatureVector: InkVector | undefined;

const viewer = new PdfViewer();
viewer.liveText.setRecognizer((data) => ocrImage(data, ocrLanguage()));
const tools = new ToolSelection();
const toolState = tools.state;
const toolbar   = new Toolbar();
let shownPath: string | null = null;
const docs = new DocWorkspace<ParkedDoc>({
  isOpen: () => session.isOpen,
  title: () => session.displayName,
  isDirty: () => session.isDirty,
  canLeave: () => !pageEditor.busy && toolbar.allowed(),
  canOpen: () => toolbar.allowed(),
  fileOf: (p) => {
    const s = p ? p.session : null;
    if (s) return s.unsavedCopy ? null : s.sourcePath;
    return session.isUnsavedCopy ? null : session.sourcePath;
  },
  park: parkShown,
  show: showParked,
  clear: () => session.restore(null),
  close: closeDocument,
  settleUnsaved: () => settleUnsaved("msgSaveBeforeClose"),
}, {
  render: (tabs, activeId) => {
    // The title bar keeps only the current document's name; the list lives in the page panel.
    const active = tabs.find((t) => t.id === activeId);
    tabStrip.render(active ? [active] : [], activeId);
    sideTabs.render(tabs, activeId);
  },
  dirtyChanged: () => setDirty(session.isDirty),
}, samePath);

const tabStrip = new TabStrip(document.getElementById("menubar-row")!, toolbar.titleElement, {
  activate: (id) => void docs.switchTo(id),
  close: (id) => void docs.close(id),
  move: (id, index) => docs.move(id, index),
  hover: (x, y) => tabDragHover(x, y),
  hoverEnd: () => void tabDragEnd().catch(() => {}),
  detach: (id, x, y) => void detachTab(id, x, y),
});

const sideTabs = new SideTabs({
  activate: (id) => void docs.switchTo(id),
  close: (id) => void docs.close(id),
  move: (id, index) => docs.move(id, index),
  detach: (id, x, y) => void detachTab(id, x, y),
  open: () => void openFiles(),
});

const annotations: AnnotationSession = new AnnotationSession({
  gateEnabled: () => false,
  isDirty: (): boolean => session.isDirty,
});
annotations.onChange(() => { setDirty(true); pageEditor.history.clearRedo(); });

const editor = new AnnotationEditor({
  overlayOf: (page) => viewer.pageViews.find((p) => p.pageNum === page)?.overlay ?? null,
  redraw: (page) => viewer.pageViews.find((p) => p.pageNum === page)?.builtOverlay?.redrawCommitted(),
  has: (ann) => annotations.has(ann),
  beginEdit: () => annotations.beginEdit(),
  edited: () => annotations.edited(),
  markDirty: () => setDirty(true),
}, {
  showText: (ann) => toolbar.showTextStyles(ann),
  showShape: (ann, panel) => toolbar.showShapeStyles(ann, panel),
  showHighlight: (ann) => toolbar.showHighlightStyles(ann),
  showSignature: (color) => toolbar.showSignatureStyles(color),
  hide: (panel) => {
    if (panel === "text") toolbar.hideTextStyles();
    else if (panel === "shape") toolbar.hideShapeStyles();
    else if (panel === "highlight") toolbar.hideHighlightStyles();
    else toolbar.hideSignatureStyles();
  },
});
annotations.onPendingChange((pending) => toolbar.setPending(pending));
const pageEditor = new PageEditor({
  ready: () => session.isOpen && viewer.isLoaded(),
  refused: () => refuseIfProtected() || !toolbar.allowed(),
  current: async () => ({ path: await session.materialize(), page: viewer.currentPage, dirty: session.isDirty }),
  show: async (path) => {
    const workingCopy = await showInViewer(path, true);
    session.replacedWorkingCopy(workingCopy ?? path);
    dropStaleSelection();
  },
  setDirty: (dirty) => setDirty(dirty),
  goToPage: (page) => { if (page !== viewer.currentPage) viewer.goToPage(Math.min(page, viewer.pageCount), "instant"); },
  setBusy: (busy) => pageSidebar.setBusy(busy),
  failed: (kind, err) => showToast(msg(kind === "adjust" ? "msgAdjustFailed" : "msgPagesFailed", { err: errText(err) }), true),
});
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
document.getElementById("page-sidebar")!.prepend(sideTabs.el);
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
  reorder: (ann, index) => {
    if (annotations.moveTo(ann, index)) viewer.pageViews.find((p) => p.pageNum === ann.page)?.builtOverlay?.redrawCommitted();
  },
});
document.getElementById("viewer-area")!.append(studio.el);
let installedFonts: string[] = [];
void listSystemFonts().then((names) => {
  installedFonts = names ?? [];
  toolbar.setSystemFonts(installedFonts);
}).catch(() => {});
toolbar.onToolOptions((title, mode) => {
  studio.setOptions(title);
  studio.setShown(mode !== "read");
});
annotations.onContentChange(() => studio.refresh());
tools.onSelect((ann) => {
  studio.setSelected(ann);
  editor.selectionChanged(ann);
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
  editor.removed(ann);
  annotations.remove(ann);
  viewer.pageViews.find((p) => p.pageNum === ann.page)?.builtOverlay?.redrawCommitted();
}

const clipboard = new AnnotationClipboard();

function typingInField(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

/** The selected annotation, when it can be copied and no page text is selected instead. */
function copyableSelection(): Annotation | null {
  const ann = tools.selected;
  if (!ann || !annotations.has(ann) || !copyable(ann) || typingInField()) return null;
  return window.getSelection()?.isCollapsed === false ? null : ann;
}

/** Copies the selected annotation; false when there is none, so the key copies as usual. */
function copyAnnotation(): boolean {
  const ann = copyableSelection();
  if (!ann) return false;
  void navigator.clipboard.writeText(clipboard.copy(ann)).catch(() => {});
  return true;
}

/** Pastes the annotation copied last onto the page in view, and selects it. */
function pasteAnnotation(): void {
  if (refuseIfProtected() || !toolbar.allowed()) return;
  toolbar.setMode("annotate");
  if (toolbar.currentMode !== "annotate") return;
  const pv = viewer.pageViews.find((p) => p.pageNum === viewer.currentPage);
  const next = pv ? clipboard.next(pv.pageNum) : null;
  if (!pv || !next) return;
  if (toolState.tool !== "select") toolbar.clearActiveTool();
  pv.overlay.placeCopy(next.ann, next.steps);
}

/** Puts a copy of the selected annotation just below and right of it, and selects the copy. */
function duplicateAnnotation(): void {
  const ann = copyableSelection();
  const pv = ann && viewer.pageViews.find((p) => p.pageNum === ann.page);
  if (ann && pv) pv.overlay.placeCopy(structuredClone(ann), 1);
}

// The Edit menu's Copy (macOS) lands here; Ctrl/Cmd+C is taken earlier, in the key handler.
document.addEventListener("copy", (e) => {
  const ann = copyableSelection();
  if (!ann || !e.clipboardData) return;
  e.preventDefault();
  e.clipboardData.setData("text/plain", clipboard.copy(ann));
});

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

const zoom = new ViewZoom(viewer, {
  showFitMode: (mode) => toolbar.updateFitMode(mode),
  showZoom: (scale) => toolbar.updateZoom(scale),
  room: pageRoom,
  page: firstPageShown,
  center: viewerCenter,
  pixelsPerInch: () => settingsModal.getSettings().pxPerInch,
});

function applyDefaultZoom(): Promise<void> {
  return zoom.applyPreference(settingsModal.getSettings().defaultZoom);
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

/** At launch, widen or narrow the window so the opening screen itself is A4 portrait. */
async function fitWindowToWelcome(): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  try {
    if (fullscreen || await appWindow.isMaximized()) return;
    const monitor = await currentMonitor();
    const welcome = document.getElementById("welcome-screen");
    if (!monitor || !welcome) return;
    const sf = monitor.scaleFactor || 1;
    const width = a4WelcomeWidth(
      { width: window.innerWidth, height: window.innerHeight },
      { width: welcome.offsetWidth, height: welcome.offsetHeight },
      monitor.workArea.size.width / sf,
    );
    if (Math.abs(width - window.innerWidth) <= 1) return;
    const pos = await appWindow.outerPosition();
    const outer = await appWindow.outerSize();
    const next = { width: outer.width + Math.round((width - window.innerWidth) * sf), height: outer.height };
    const at = keepCentred(pos, outer, next, {
      x: monitor.workArea.position.x, y: monitor.workArea.position.y,
      width: monitor.workArea.size.width, height: monitor.workArea.size.height,
    });
    await appWindow.setSize(new LogicalSize(width, window.innerHeight));
    await appWindow.setPosition(new PhysicalPosition(at.x, at.y));
  } catch (err) {
    console.warn("fit window to welcome:", err);
  }
}

async function fitWindowToDocument(): Promise<boolean> {
  if (!("__TAURI_INTERNALS__" in window)) return true;
  const pref = parseFloat(settingsModal.getSettings().defaultZoom);
  try {
    if (!autoFitWindow) return true;
    if (fullscreen || docs.count > 1 || await appWindow.isMaximized()) return preferredZoomShowsPage(pref);
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
    await zoom.fit("fit-page");
  }
}

viewer.onResizeCb = () => zoom.refit();

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

viewer.overlayEvents.onTextSelected((ann) => editor.textSelected(ann));
viewer.overlayEvents.onShapeSelected((ann) => editor.shapeSelected(ann));
viewer.overlayEvents.onHighlightSelected((ann) => editor.highlightSelected(ann));

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
  const path = session.sourcePath;
  const fonts = async () => (path ? await listPdfFonts(path, session.filePassword) : []);
  await infoPanel.show(doc, name, getTranslations(s.language), s.language, fonts);
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

setInflateFallback(inflateRaw);
const epubReader = new EpubReader(document.getElementById("epub-reader")!, {
  openUrl: (url) => void openExternalUrl(url).catch(() => {}),
  titleChanged: (title) => {
    if (title) {
      toolbar.setDocTitle(title, false, false);
      document.title = `${title} – EzReader`;
    } else {
      setDirty(session.isDirty);
    }
  },
  closeRequested: () => closeEpub(),
  convertRequested: () => void convertEpubToPdf(),
  forwardKey: (e) => {
    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey, bubbles: true, cancelable: true,
    }));
  },
});

void canPrintHtmlToPdf().then((can) => epubReader.setCanConvert(can)).catch(() => {});

let convertingEpub = false;

/** Prints the open book to a PDF the user picks, with its table of contents as bookmarks. */
async function convertEpubToPdf(): Promise<void> {
  const book = epubReader.current;
  if (!book || convertingEpub) return;
  const out = await savePdfDialog(`${epubReader.title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Book"}.pdf`);
  if (!out) return;
  convertingEpub = true;
  epubReader.setConverting(true);
  try {
    await bookToPdf(book, {
      printPages: printHtmlPages,
      pageCount: getPageCount,
      pageTexts: pdfPageTexts,
      merge: async (parts) => {
        if (parts.length === 1) return parts[0]!.path;
        const merged = await newTempPath("book.pdf");
        const slots: PageSlot[] = parts.flatMap((p, i) => Array.from({ length: p.pages }, (_, k): PageSlot =>
          i === 0 ? { kind: "original", page: k + 1, rotation: 0 } : { kind: "imported", path: p.path, page: k + 1, rotation: 0 }));
        await rearrangePages(parts[0]!.path, merged, slots);
        return merged;
      },
      finish: (input, marks, title, author) => finishBookPdf(input, out, marks, title, author),
    }, (done, total) => showToast(msg("msgEpubPdfProgress", { done, total })));
    showToast(msg("msgEpubPdfDone", { name: fileNameOf(out) }));
  } catch (err) {
    showToast(msg("msgEpubPdfFailed", { err: errText(err) }), true);
  } finally {
    convertingEpub = false;
    epubReader.setConverting(false);
  }
}

/** The text of each page of a PDF, to find where a section starts. */
async function pdfPageTexts(path: string): Promise<string[]> {
  const doc = await (await pdfjsLib()).getDocument({ ...SAFE_PDF, url: convertFileSrc(path) + `?t=${Date.now()}` }).promise;
  try {
    const out: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      out.push(content.items.map((it) => ("str" in it ? it.str : "")).join(" "));
      page.cleanup();
    }
    return out;
  } finally {
    void doc.loadingTask.destroy();
  }
}

function closeEpub(): void {
  epubReader.close();
  if (!session.isOpen) setWelcomeVisible(true);
}

/** Opens a book here when the window shows nothing, in a new window otherwise. */
async function openEpub(path: string): Promise<void> {
  if (session.isOpen || docs.count > 0 || epubReader.isOpen) {
    try {
      await openInNewWindow(path);
    } catch (err) {
      showToast(msg("msgEpubFailed", { err: errText(err) }), true);
    }
    return;
  }
  try {
    const res = await fetch(convertFileSrc(path));
    if (!res.ok) throw new Error(res.statusText || String(res.status));
    await epubReader.open(path, new Uint8Array(await res.arrayBuffer()));
    setWelcomeVisible(false);
  } catch (err) {
    const drm = err instanceof EpubError && err.kind === "drm";
    showToast(drm ? msg("msgEpubDrm") : msg("msgEpubFailed", { err: errText(err) }), true);
  }
}

/** Shows every part of the window in `language`. */
function applyLanguage(language: string): void {
  const t = getTranslations(language);
  epubReader.applyTranslations(t);
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
  sideTabs.applyTranslations({ close: tabCloseLabel(t), open: t.tabsOpen, openHint: t.tabsOpenHint });
  setSelectionPillLabels({
    color: t.selColor ?? "Color",
    copyText: t.selCopyText ?? "Copy text",
    duplicate: `${t.menuDuplicate ?? "Duplicate"} (${isMac ? "⌘D" : "Ctrl+D"})`,
    delete: `${t.selDelete ?? "Delete"} (${isMac ? "⌫" : "Del"})`,
    colorName: (n) => colorName(t, n),
  });
  applyTranslationsToDOM(t);
}
applyLanguage(settingsModal.getSettings().language);
toolbar.brightness.value = settingsModal.getSettings().pageBrightness;
toolbar.brightness.onInput((v) => applyPageBrightness(v));
toolbar.brightness.onCommit((v) => settingsModal.setPageBrightness(v));

pageSidebar.setOutlineExpanded(settingsModal.getSettings().outlineExpanded);

settingsModal.onChange(s => {
  toolbar.brightness.value = s.pageBrightness;
  pageSidebar.setOutlineExpanded(s.outlineExpanded);
  applyLanguage(s.language);
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
      await fitWindowToWelcome();
      reveal();
      // Load pdf.js once the welcome screen is up, so the first document opens as fast as before.
      requestAnimationFrame(() => setTimeout(() => void pdfjsLib(), 0));
    } else {
      void pdfjsLib();
      setWelcomeVisible(false);
      const slow = setTimeout(reveal, 1500);
      try {
        await openStartupFile(startup);
      } finally {
        clearTimeout(slow);
        if (!session.isOpen && !epubReader.isOpen) setWelcomeVisible(true);
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
    document.getElementById("status-bar")!.style.display = "none";
    await loadPdf(file);
    document.getElementById("app")!.classList.remove("booting");
    const all = Array.from({ length: viewer.pageCount }, (_, i) => i + 1);
    await printPages(await renderForPrint(all));
    await appWindow.close();
  } else if (openKind(file) === "pictures") {
    await openPictures([file]);
  } else if (openKind(file) === "epub") {
    await openEpub(file);
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
  docs.sync();
  if (docs.anyDirty) { void registerCloseGuard(); }
  else                  { unregisterCloseGuard(); }
}

function dropStaleSelection(): void {
  editor.drop();
}

async function undoRedo(redo: boolean): Promise<void> {
  if (redo ? annotations.redo() : annotations.undo()) {
    dropStaleSelection();
    syncAllPageOverlays();
    setDirty(true);
    return;
  }
  await pageEditor.step(redo);
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
      if (!docs.anyDirty) { return; }
      if (savingBeforeLeaving) { event.preventDefault(); return; }
      if (closeGuardBusy) {
        setDirty(false);
        await appWindow.destroy();
        return;
      }
      event.preventDefault();
      closeGuardBusy = true;
      try {
        const ok = await docs.settleAll();
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
    pageEditor.history.clear();
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
    pageEditor.history.clear();
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

/** "Open a PDF" in the tab list: several files at once, each in its own tab. */
async function openFiles(): Promise<void> {
  const paths = await openDocumentsDialog();
  await openInTabs(paths);
}

async function openInTabs(paths: string[]): Promise<void> {
  const images = paths.filter(isImagePath);
  for (const p of paths) if (!isImagePath(p)) await openPath(p);
  if (images.length > 0) await openPictures(images);
}

async function openPath(path: string): Promise<void> {
  if (openKind(path) === "epub") { await openEpub(path); return; }
  if (epubReader.isOpen) {
    // The book keeps this window: the document gets its own.
    try { await openInNewWindow(path); } catch (err) { showToast(msg("msgOpenFailed", { err: errText(err) }), true); }
    return;
  }
  if (openKind(path) === "pictures") { await openPictures([path]); return; }
  const open = docs.showing(path);
  if (open) { await docs.switchTo(open.id); return; }
  await docs.inNewTab(() => loadPdf(path), fileNameOf(path));
}

async function openPictures(paths: string[]): Promise<void> {
  await docs.inNewTab(() => picturesToTab(paths));
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
  fitMode: FitMode;
  page: number;
  scrollTop: number;
  scrollLeft: number;
}

function tabCloseLabel(t: { tabClose?: string }): string | undefined {
  return t.tabClose && (isMac ? macShortcuts(t.tabClose) : t.tabClose);
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/");
  return isMac || navigator.userAgent.includes("Windows")
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
}

/** The shown document's state, kept while another tab is shown. */
function parkShown(): ParkedDoc | null {
  if (!shownPath || !viewer.isLoaded()) return null;
  annotations.apply();
  dropStaleSelection();
  cancelSignaturePlacement();
  return {
    session: session.snapshot(),
    annotations: annotations.snapshot(),
    history: pageEditor.history.snapshot(),
    forms: [...formValues.entries()],
    shownPath,
    rotation: viewer.rotation,
    scale: viewer.scale,
    fitMode: zoom.fitMode,
    page: viewer.currentPage,
    scrollTop: viewerScroll.scrollTop,
    scrollLeft: viewerScroll.scrollLeft,
  };
}

async function showParked(p: ParkedDoc): Promise<boolean> {
  session.restore(p.session);
  annotations.restoreParked(p.annotations);
  pageEditor.history.restore(p.history);
  formValues.clear();
  for (const [name, value] of p.forms) formValues.set(name, value);
  dropStaleSelection();
  shownPath = p.shownPath;
  try {
    await viewer.load(p.shownPath, p.rotation);
  } catch (err) {
    showToast(msg("msgOpenFailed", { err: String(err) }), true);
    return false;
  }
  showThumbnails();
  setWelcomeVisible(false);
  toolbar.setLoaded(true);
  await zoom.restore(p.fitMode, p.scale);
  viewerScroll.scrollTop = p.scrollTop;
  viewerScroll.scrollLeft = p.scrollLeft;
  syncProtection();
  setDirty(session.isDirty);
  if (infoPanel.isOpen) await showInfo();
  return true;
}

async function closeDocument(): Promise<void> {
  annotations.clear();
  pageEditor.history.clear();
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

async function detachTab(id: number, x: number, y: number): Promise<void> {
  await docs.settled();
  const tab = docs.active;
  if (!tab || tab.id !== id || !session.isOpen || pageEditor.busy || !toolbar.allowed()) {
    void tabDragEnd().catch(() => {});
    return;
  }
  let result: "merged" | "window" | "stayed";
  try {
    const { args, name } = await transferOfActive();
    result = await moveTab(x, y, args, name, docs.count > 1);
  } catch (err) {
    void tabDragEnd().catch(() => {});
    showToast(msg("msgOpenFailed", { err: errText(err) }), true);
    return;
  }
  if (result === "stayed") return;
  session.markDirty(false);
  tab.dirty = false;
  if (docs.count > 1) {
    await docs.dropActive();
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
    const open = docs.showing(file);
    if (open) { await docs.switchTo(open.id); return; }
  }
  await docs.inNewTab(async () => {
    await loadPdf(file, t.password ?? null);
    if (!session.isOpen) return;
    if (t.unsaved) session.markUnsavedCopy();
    else if (t.savePath) session.adoptSavePath(t.savePath);
    setDirty(!!(t.dirty || t.unsaved));
    if (t.page && t.page > 1) viewer.goToPage(Math.min(t.page, viewer.pageCount), "instant");
  }, fileNameOf(file));
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

async function editPages({ slots, keepPage, select }: PagePlan): Promise<boolean> {
  const source = session.sourcePath;
  if (!source) return false;
  const done = await pageEditor.apply(async (input) => {
    const out = await newTempPath(`pages-${await basename(source)}`);
    await rearrangePages(input, out, slots);
    return out;
  });
  if (!done) return false;
  if (keepPage !== null && keepPage !== viewer.currentPage) viewer.goToPage(keepPage, "instant");
  pageSidebar.setSelection(select);
  return true;
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
  const done = await pageEditor.apply(async (input) => {
    const { crops, warps } = await buildPageAdjustments(doc, viewer.rotation, settings);
    const name = await basename(source);
    let out = input;
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
    return out;
  }, { kind: "adjust", guarded: false });
  if (!done) return false;
  const pages = settings.map((s) => s.page);
  viewer.goToPage(pages[0], "instant");
  pageSidebar.setSelection(pages);
  showToast(pages.length === 1 ? msg("msgPageAdjusted") : msg("msgPagesAdjusted", { n: pages.length }));
  return true;
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

const welcomePrefs = new WelcomePrefs(document.getElementById("status-bar")!, {
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
});
void welcomePrefs.refresh();
void showQuickLookCard(quickLookState);
const updateToast = new UpdateToast();
const updateBadge: UpdateBadge = new UpdateBadge(welcomePrefs.root, {
  t: () => getTranslations(settingsModal.getSettings().language),
  check: () => checkForUpdate(),
  install: () => installUpdate(),
  prepare: () => prepareUpdate(),
  notify: (text, isError) => showToast(text, isError),
  onReady: (status) => {
    const t = getTranslations(settingsModal.getSettings().language);
    updateToast.show(
      {
        message: (t.updateReadyToast ?? "EzReader {v} is ready to install.").replace("{v}", status.latest),
        restart: t.updateRestart ?? "Restart",
        later: t.updateLater ?? "Later",
      },
      () => void updateBadge.restartNow(),
    );
  },
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
      await zoom.step(e.type === "zoom-in" ? 1 : -1);
      break;

    case "zoom-reset":
      await applyDefaultZoom();
      break;

    case "zoom-set":
      await zoom.set(e.scale);
      break;

    case "fit-width":
    case "fit-height":
      await zoom.toggleFit(e.type);
      break;

    case "zoom-real":
      await zoom.actualSize();
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

    case "theme":
      settingsModal.setTheme(e.dark ? "dark" : "light");
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
      editor.release();
      if (e.tool !== "signature") cancelSignaturePlacement();
      break;

    case "style-change":
      tools.setStyle(e.style);
      for (const pv of viewer.pageViews) pv.builtOverlay?.refreshStyle();
      editor.restyle(e.style);
      break;

    case "layer-change":
      editor.reorder(e.dir);
      break;

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

    case "duplicate":
      duplicateAnnotation();
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
  const typingHere = (document.activeElement as HTMLElement | null)?.matches?.("input, textarea, select, [contenteditable]") ?? false;
  if (epubReader.isOpen && !typingHere && !e.defaultPrevented && document.querySelector(".modal-backdrop:not(.hidden)") === null && epubReader.handleKey(e)) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const tag = (document.activeElement as HTMLElement)?.tagName ?? "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
      (document.activeElement as HTMLElement)?.isContentEditable) return;

  const ctrl  = e.ctrlKey || e.metaKey;
  const shift = e.shiftKey;

  // Menu shortcuts run their menu command, guards included. Zoom in and out are left to the
  // window listener below, which also takes them from text fields.
  const command = toolbar.commandForKey(e);
  if (command && command.type !== "zoom-in" && command.type !== "zoom-out") {
    e.preventDefault();
    toolbar.dispatch(command);
    return;
  }
  if (ctrl && !shift && !e.altKey && e.key.toLowerCase() === "c" && copyAnnotation()) {
    e.preventDefault();
    return;
  }
  if (ctrl && !shift && e.key.toLowerCase() === "w") {
    e.preventDefault();
    const tab = docs.active;
    if (tab && toolbar.allowed()) await docs.close(tab.id);
    return;
  }
  if (ctrl && (e.key === "Tab" || e.key === "PageDown" || e.key === "PageUp")) {
    e.preventDefault();
    const back = e.key === "PageUp" || (e.key === "Tab" && shift);
    const next = docs.neighbour(back ? -1 : 1);
    if (next) await docs.switchTo(next.id);
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
  // The menu only holds Copy, so it opens only over selected text: anywhere else it would be
  // empty. Annotations have their own pill, which a right click on them shows.
  const sel = window.getSelection()?.toString() ?? "";
  if (sel.trim().length === 0 || typingInField()) {
    ctxMenu.classList.add("hidden");
    return;
  }
  ctxCopyBtn.disabled = false;
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
  // The one place Ctrl/Cmd + and - zoom, ahead of the typing check so they work from any field.
  const command = toolbar.commandForKey(e);
  if (command?.type === "zoom-in" || command?.type === "zoom-out") {
    if (!viewer.isLoaded()) return;
    e.preventDefault();
    toolbar.dispatch(command);
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

/** The colour of the text drawn inside `r` on the page canvas. */
function inkAround(wrapper: HTMLElement, r: DOMRect, background: RgbColor): RgbColor {
  const canvas = wrapper.querySelector<HTMLCanvasElement>(".page-canvas");
  const ctx = canvas?.getContext("2d", { willReadFrequently: true });
  if (!canvas || !ctx || r.width < 1 || r.height < 1) return { r: 0, g: 0, b: 0 };
  const box = canvas.getBoundingClientRect();
  const kx = canvas.width / box.width, ky = canvas.height / box.height;
  const x = Math.max(0, Math.floor((r.left - box.left) * kx)), y = Math.max(0, Math.floor((r.top - box.top) * ky));
  const w = Math.min(canvas.width - x, Math.ceil(r.width * kx)), h = Math.min(canvas.height - y, Math.ceil(r.height * ky));
  if (w < 1 || h < 1) return { r: 0, g: 0, b: 0 };
  try {
    return textColorFrom(ctx.getImageData(x, y, w, h).data, background);
  } catch {
    return { r: 0, g: 0, b: 0 };
  }
}

/** The colour behind the text drawn inside `r` on the page canvas. */
function backgroundAround(wrapper: HTMLElement, r: DOMRect): RgbColor {
  const white = { r: 255, g: 255, b: 255 };
  const canvas = wrapper.querySelector<HTMLCanvasElement>(".page-canvas");
  const ctx = canvas?.getContext("2d", { willReadFrequently: true });
  if (!canvas || !ctx || r.width < 1 || r.height < 1) return white;
  const box = canvas.getBoundingClientRect();
  const kx = canvas.width / box.width, ky = canvas.height / box.height;
  const x = Math.max(0, Math.floor((r.left - box.left) * kx)), y = Math.max(0, Math.floor((r.top - box.top) * ky));
  const w = Math.min(canvas.width - x, Math.ceil(r.width * kx)), h = Math.min(canvas.height - y, Math.ceil(r.height * ky));
  if (w < 1 || h < 1) return white;
  try {
    return backgroundColorFrom(ctx.getImageData(x, y, w, h).data);
  } catch {
    return white;
  }
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
  const box = span.getBoundingClientRect();
  const background = backgroundAround(wrapper, box);
  const facts = span.dataset.font ? pv.fontFacts(span.dataset.font) : null;
  const font = matchPdfFont({ ...facts, generic: span.dataset.family }, installedFonts);
  const item: PageTextItem = {
    text: span.dataset.text ?? span.textContent ?? "",
    x, y, width, fontSize,
    family: font.fontFamily,
    background,
  };
  const style = {
    color: inkAround(wrapper, box, background), fontSize: Math.max(4, Math.round(fontSize * 2) / 2),
    bold: font.bold, italic: font.italic, underline: false,
    fontFamily: font.fontFamily, fontName: font.fontName, backgroundColor: null,
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
  if (!viewer.isLoaded()) return;
  if (!file) {
    if (!clipboard.holds(e.clipboardData?.getData("text/plain") ?? "")) return;
    e.preventDefault();
    pasteAnnotation();
    return;
  }
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
  zoom.wheelBy(px, { x: e.clientX, y: e.clientY });
}, { passive: false });

function viewerCenter(): { x: number; y: number } {
  const r = document.getElementById("viewer-scroll")!.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

async function handleDrop(paths: string[], at: { x: number; y: number } | null, gap: number | null): Promise<void> {
  const pdfs = paths.filter((p) => p.toLowerCase().endsWith(".pdf"));
  const images = paths.filter(isImagePath);
  const books = paths.filter((p) => openKind(p) === "epub");
  if (books.length > 0) {
    for (const book of books) await openEpub(book);
    for (const pdf of pdfs) await openPath(pdf);
    return;
  }
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
      const onTabs = !!at && sideTabs.contains(at.x, at.y);
      if (p.type === "over" || p.type === "enter") {
        document.body.classList.add("drag-over");
        sideTabs.setDropTarget(onTabs);
        if (onTabs) pageSidebar.hideExternalDrop();
        else if (at && viewer.isLoaded()) pageSidebar.externalDropAt(at.x, at.y);
      } else if (p.type === "leave") {
        document.body.classList.remove("drag-over");
        sideTabs.setDropTarget(false);
        pageSidebar.hideExternalDrop();
      } else if (p.type === "drop") {
        document.body.classList.remove("drag-over");
        sideTabs.setDropTarget(false);
        if (onTabs) { pageSidebar.hideExternalDrop(); await openInTabs(p.paths); return; }
        const gap = at && viewer.isLoaded() ? pageSidebar.externalDropAt(at.x, at.y) : null;
        pageSidebar.hideExternalDrop();
        await handleDrop(p.paths, at, gap);
      }
    });
  } catch {
  }
})();
