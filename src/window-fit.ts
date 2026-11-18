export const VIEWER_PADDING = 40;

export const SCREEN_SHARE = 0.9;

export const MIN_WINDOW = { width: 720, height: 480 };

export interface Size { width: number; height: number }

export function pageFitScale(page: Size, box: Size, padding = VIEWER_PADDING): number {
  if (page.width <= 0 || page.height <= 0) return 1;
  return Math.max(0.01, Math.min((box.width - padding) / page.width, (box.height - padding) / page.height));
}

export interface WindowFitInput {
  page: Size;
  preferredScale: number | null;
  window: Size;
  viewer: Size;
  scrollbars: Size;
  area: Size;
}

export interface WindowFit {
  window: Size;
  scale: number;
  preferredFits: boolean;
}

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
