// Window size when a document opens: the window takes the shape of one page,
// portrait or landscape, as big as the screen allows (the launcher, before,
// keeps its own fixed shape; see `set_launcher_ratio_lock` in Rust).

/** Space around the pages inside the viewer (its padding, 20 px each side). */
export const VIEWER_PADDING = 40;

/** Share of the screen's work area the window may take. */
export const SCREEN_SHARE = 0.9;

/** Smallest window, as in tauri.conf.json. */
export const MIN_WINDOW = { width: 720, height: 480 };

export interface Size { width: number; height: number }

/** Zoom (CSS px per PDF point) at which a `page` fits whole in `box`, padding included. */
export function pageFitScale(page: Size, box: Size, padding = VIEWER_PADDING): number {
  if (page.width <= 0 || page.height <= 0) return 1;
  return Math.max(0.01, Math.min((box.width - padding) / page.width, (box.height - padding) / page.height));
}

export interface WindowFitInput {
  /** The page to show whole, in PDF points (view rotation applied). */
  page: Size;
  /** The zoom chosen in Settings, or null for "fit width" / "fit page". */
  preferredScale: number | null;
  /** The window's inner size now, CSS px. */
  window: Size;
  /** The page area now (the viewer, scroll bars excluded), CSS px. */
  viewer: Size;
  /** Scroll bars the viewer will show with the page fitted (CSS px each way). */
  scrollbars: Size;
  /** The screen's work area, CSS px. */
  area: Size;
}

export interface WindowFit {
  /** New inner size of the window, CSS px. */
  window: Size;
  /** Zoom the page is shown at in that window. */
  scale: number;
  /** False when the preferred zoom was too big for the screen (the page is fitted instead). */
  preferredFits: boolean;
}

/**
 * The window size that shows exactly one `page`: the window's chrome
 * (menu, toolbar, side panel, scroll bars) stays as it is, the page area
 * takes the page's shape. The page is shown at the preferred zoom when it
 * fits on the screen, else as big as fits.
 */
export function planWindowFit(i: WindowFitInput): WindowFit {
  const chrome = {
    width: Math.max(0, i.window.width - i.viewer.width) + i.scrollbars.width,
    height: Math.max(0, i.window.height - i.viewer.height) + i.scrollbars.height,
  };
  const room = {
    width: Math.max(1, Math.floor(i.area.width * SCREEN_SHARE) - chrome.width),
    height: Math.max(1, Math.floor(i.area.height * SCREEN_SHARE) - chrome.height),
  };
  const biggest = pageFitScale(i.page, room);
  const preferredFits = i.preferredScale !== null && i.preferredScale <= biggest;
  const scale = preferredFits ? i.preferredScale! : biggest;
  const window = {
    width: Math.max(MIN_WINDOW.width, Math.ceil(i.page.width * scale + VIEWER_PADDING + chrome.width)),
    height: Math.max(MIN_WINDOW.height, Math.ceil(i.page.height * scale + VIEWER_PADDING + chrome.height)),
  };
  return { window, scale, preferredFits };
}

/**
 * Where the window goes once resized: same centre as before, moved just
 * enough to stay inside the work area. All in the same unit.
 */
export function keepCentred(
  pos: { x: number; y: number },
  size: Size,
  next: Size,
  area: { x: number; y: number; width: number; height: number },
): { x: number; y: number } {
  const place = (p: number, s: number, n: number, a: number, as: number): number => {
    const centred = p + (s - n) / 2;
    return Math.round(Math.max(a, Math.min(centred, a + as - n)));
  };
  return {
    x: place(pos.x, size.width, next.width, area.x, area.width),
    y: place(pos.y, size.height, next.height, area.y, area.height),
  };
}
