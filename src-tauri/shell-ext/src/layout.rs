//! Sizes and positions, kept apart from Windows so they can be tested anywhere.

/// Space around and between the pages in the preview pane, in pixels.
pub const MARGIN: i32 = 12;
/// The preview pane never draws a page wider than this, in pixels.
pub const MAX_PAGE_WIDTH: i32 = 1400;

/// The size of a `width` × `height` page scaled to fit a `side` × `side`
/// square (Explorer asks for thumbnails by their longest side).
pub fn fit_in_square(width: f32, height: f32, side: u32) -> (u32, u32) {
    if !(width > 0.0 && height > 0.0) || side == 0 {
        return (side.max(1), side.max(1));
    }
    let side_f = side as f32;
    let (w, h) = if width >= height { (side_f, side_f * height / width) } else { (side_f * width / height, side_f) };
    ((w.round() as u32).clamp(1, side), (h.round() as u32).clamp(1, side))
}

/// Where a page sits in the scrolling column of the preview pane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Slot {
    pub top: i32,
    pub left: i32,
    pub width: i32,
    pub height: i32,
}

/// Lays the pages (their sizes in points) out in one column, as wide as the
/// pane allows. Returns each page's slot and the column's full height.
pub fn column(pages: &[(f32, f32)], pane_width: i32) -> (Vec<Slot>, i32) {
    let width = (pane_width - 2 * MARGIN).clamp(1, MAX_PAGE_WIDTH);
    let left = ((pane_width - width) / 2).max(0);
    let mut top = MARGIN;
    let mut slots = Vec::with_capacity(pages.len());
    for &(pw, ph) in pages {
        let ratio = if pw > 0.0 && ph > 0.0 { ph / pw } else { 1.414 };
        let height = ((width as f32 * ratio).round() as i32).max(1);
        slots.push(Slot { top, left, width, height });
        top += height + MARGIN;
    }
    (slots, top)
}

/// The indices of the slots seen through a window of `height` pixels
/// scrolled down by `scroll`.
pub fn visible(slots: &[Slot], scroll: i32, height: i32) -> std::ops::Range<usize> {
    let bottom = scroll + height;
    let start = slots.partition_point(|s| s.top + s.height <= scroll);
    let end = slots.partition_point(|s| s.top < bottom);
    start..end.max(start)
}

/// `scroll` kept between the top and the last screen of the column.
pub fn clamp_scroll(scroll: i32, total: i32, height: i32) -> i32 {
    scroll.clamp(0, (total - height).max(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thumbnails_keep_the_page_shape() {
        assert_eq!(fit_in_square(595.0, 842.0, 256), (181, 256));
        assert_eq!(fit_in_square(842.0, 595.0, 256), (256, 181));
        assert_eq!(fit_in_square(100.0, 100.0, 96), (96, 96));
    }

    #[test]
    fn odd_pages_still_get_a_thumbnail() {
        assert_eq!(fit_in_square(0.0, 0.0, 64), (64, 64));
        assert_eq!(fit_in_square(f32::NAN, 10.0, 32), (32, 32));
        assert_eq!(fit_in_square(10000.0, 1.0, 32), (32, 1));
    }

    #[test]
    fn column_stacks_pages_with_margins() {
        let (slots, total) = column(&[(100.0, 200.0), (200.0, 100.0)], 224);
        assert_eq!(slots[0], Slot { top: 12, left: 12, width: 200, height: 400 });
        assert_eq!(slots[1], Slot { top: 424, left: 12, width: 200, height: 100 });
        assert_eq!(total, 536);
    }

    #[test]
    fn wide_panes_centre_the_pages() {
        let (slots, _) = column(&[(1.0, 1.0)], 3000);
        assert_eq!(slots[0].width, MAX_PAGE_WIDTH);
        assert_eq!(slots[0].left, (3000 - MAX_PAGE_WIDTH) / 2);
    }

    #[test]
    fn only_pages_on_screen_are_visible() {
        let (slots, _) = column(&[(1.0, 1.0); 10], 124); // 100 px squares, 112 px apart
        assert_eq!(visible(&slots, 0, 50), 0..1);
        assert_eq!(visible(&slots, 0, 130), 0..2);
        assert_eq!(visible(&slots, 200, 100), 1..3);
        assert_eq!(visible(&slots, 5000, 100), 10..10);
    }

    #[test]
    fn scroll_stays_in_the_column() {
        assert_eq!(clamp_scroll(-5, 1000, 300), 0);
        assert_eq!(clamp_scroll(900, 1000, 300), 700);
        assert_eq!(clamp_scroll(50, 200, 300), 0);
    }
}
