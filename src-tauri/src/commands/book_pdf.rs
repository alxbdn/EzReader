//! EPUB to PDF: the interface hands over each chapter as a standalone HTML page
//! (pictures inlined, nothing active); the system webview prints it to PDF, and
//! the chapters are then put together with a table of contents as bookmarks.

use crate::error::{CmdResult, ErrorCode, PdfError};
use crate::fsutil;
use lopdf::{Dictionary, Document, Object, ObjectId, StringFormat};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const PRINT_WINDOW: &str = "book-print";
/// A5, the size of a paperback, in inches, with 15 mm margins.
const PAGE_WIDTH_IN: f64 = 5.83;
const PAGE_HEIGHT_IN: f64 = 8.27;
const MARGIN_IN: f64 = 0.59;
const STEP_TIMEOUT: Duration = Duration::from_secs(60);

fn other(e: impl ToString) -> PdfError {
    PdfError::new(ErrorCode::Other, e.to_string())
}

/// Whether this system's webview can print a page to PDF.
#[tauri::command]
pub fn can_print_html_to_pdf() -> bool {
    cfg!(any(windows, target_os = "linux"))
}

/// Prints each HTML page to its own temporary PDF, in order, and returns their paths.
/// `progress` receives the number of pages done after each one.
#[tauri::command(async)]
pub fn print_html_pages(app: AppHandle, pages: Vec<String>, progress: Channel<u32>) -> CmdResult<Vec<String>> {
    if !can_print_html_to_pdf() {
        return Err(other("printing to PDF is not available on this system"));
    }
    if pages.is_empty() {
        return Ok(Vec::new());
    }
    let (loaded_tx, loaded_rx) = mpsc::channel::<()>();
    let html_paths: Vec<PathBuf> = (0..pages.len()).map(|i| temp_path(&format!("book-{i}.html"))).collect();
    for (path, html) in html_paths.iter().zip(&pages) {
        std::fs::write(path, html).map_err(other)?;
    }
    let first = file_url(&html_paths[0])?;
    let window = print_window(&app, first, loaded_tx)?;
    let result = (|| {
        let mut out = Vec::with_capacity(pages.len());
        for (i, html_path) in html_paths.iter().enumerate() {
            if i > 0 {
                window.navigate(file_url(html_path)?).map_err(other)?;
            }
            loaded_rx.recv_timeout(STEP_TIMEOUT).map_err(|_| other("the page took too long to load"))?;
            // Let the layout settle after the load event.
            std::thread::sleep(Duration::from_millis(150));
            let pdf = temp_path(&format!("book-{i}.pdf"));
            print_to_pdf(&window, &pdf)?;
            let pdf = pdf.to_string_lossy().into_owned();
            crate::allow_viewing(&app, &pdf);
            out.push(pdf);
            let _ = progress.send(i as u32 + 1);
        }
        Ok(out)
    })();
    let _ = window.destroy();
    for path in &html_paths {
        let _ = std::fs::remove_file(path);
    }
    result
}

fn temp_path(name: &str) -> PathBuf {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    std::env::temp_dir().join(format!("ezreader-{}-{n:x}-{name}", crate::tempfiles::tag()))
}

fn file_url(path: &Path) -> CmdResult<url::Url> {
    url::Url::from_file_path(path).map_err(|_| other("invalid temporary path"))
}

/// An off-screen window that only shows the pages being printed: it has no access to the app's commands.
fn print_window(app: &AppHandle, first: url::Url, loaded: mpsc::Sender<()>) -> CmdResult<WebviewWindow> {
    if let Some(old) = app.get_webview_window(PRINT_WINDOW) {
        let _ = old.destroy();
    }
    let builder = WebviewWindowBuilder::new(app, PRINT_WINDOW, WebviewUrl::External(first))
        .title("EzReader")
        .inner_size(800.0, 1000.0)
        .position(-20000.0, -20000.0)
        .skip_taskbar(true)
        .focused(false)
        .decorations(false)
        .on_navigation(|url| url.scheme() == "file" || url.scheme() == "about")
        .on_page_load(move |_, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let _ = loaded.send(());
            }
        });
    builder.build().map_err(other)
}

#[cfg(windows)]
fn print_to_pdf(window: &WebviewWindow, out: &Path) -> CmdResult<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Environment6, ICoreWebView2_7};
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, HSTRING, PCWSTR};

    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let target = HSTRING::from(out.as_os_str());
    window
        .with_webview(move |pv| {
            let failed = tx.clone();
            let started = (|| -> windows::core::Result<()> {
                // SAFETY: COM calls on the webview's own thread, with interfaces it handed us.
                unsafe {
                    let core: ICoreWebView2_7 = pv.controller().CoreWebView2()?.cast()?;
                    let env: ICoreWebView2Environment6 = pv.environment().cast()?;
                    let settings = env.CreatePrintSettings()?;
                    settings.SetPageWidth(PAGE_WIDTH_IN)?;
                    settings.SetPageHeight(PAGE_HEIGHT_IN)?;
                    settings.SetMarginTop(MARGIN_IN)?;
                    settings.SetMarginBottom(MARGIN_IN)?;
                    settings.SetMarginLeft(MARGIN_IN)?;
                    settings.SetMarginRight(MARGIN_IN)?;
                    settings.SetShouldPrintBackgrounds(false)?;
                    settings.SetShouldPrintHeaderAndFooter(false)?;
                    let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
                        let _ = tx.send(match result {
                            Ok(()) if ok => Ok(()),
                            Ok(()) => Err("the page could not be printed".to_string()),
                            Err(e) => Err(e.to_string()),
                        });
                        Ok(())
                    }));
                    core.PrintToPdf(PCWSTR::from_raw(target.as_ptr()), &settings, &handler)
                }
            })();
            if let Err(e) = started {
                let _ = failed.send(Err(e.to_string()));
            }
        })
        .map_err(other)?;
    rx.recv_timeout(STEP_TIMEOUT).map_err(|_| other("printing took too long"))?.map_err(other)
}

#[cfg(target_os = "linux")]
fn print_to_pdf(window: &WebviewWindow, out: &Path) -> CmdResult<()> {
    use webkit2gtk::PrintOperationExt;

    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let uri = file_url(out)?.to_string();
    window
        .with_webview(move |pv| {
            let op = webkit2gtk::PrintOperation::new(&pv.inner());
            let settings = gtk::PrintSettings::new();
            settings.set_printer("Print to File");
            settings.set("output-file-format", Some("pdf"));
            settings.set("output-uri", Some(&uri));
            op.set_print_settings(&settings);
            let setup = gtk::PageSetup::new();
            let mm = |inches: f64| inches * 25.4;
            setup.set_paper_size(&gtk::PaperSize::new_custom(
                "ezreader-book",
                "A5",
                mm(PAGE_WIDTH_IN),
                mm(PAGE_HEIGHT_IN),
                gtk::Unit::Mm,
            ));
            setup.set_top_margin(mm(MARGIN_IN), gtk::Unit::Mm);
            setup.set_bottom_margin(mm(MARGIN_IN), gtk::Unit::Mm);
            setup.set_left_margin(mm(MARGIN_IN), gtk::Unit::Mm);
            setup.set_right_margin(mm(MARGIN_IN), gtk::Unit::Mm);
            op.set_page_setup(&setup);
            let done = tx.clone();
            op.connect_finished(move |_| {
                let _ = done.send(Ok(()));
            });
            op.connect_failed(move |_, err| {
                let _ = tx.send(Err(err.to_string()));
            });
            op.print();
        })
        .map_err(other)?;
    rx.recv_timeout(STEP_TIMEOUT).map_err(|_| other("printing took too long"))?.map_err(other)?;
    // The print job writes the file just after it reports being done.
    for _ in 0..50 {
        if std::fs::metadata(out).map(|m| m.len() > 0).unwrap_or(false) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(other("the printed file is missing"))
}

#[cfg(not(any(windows, target_os = "linux")))]
fn print_to_pdf(_window: &WebviewWindow, _out: &Path) -> CmdResult<()> {
    Err(other("printing to PDF is not available on this system"))
}

#[derive(Debug, Clone, Deserialize)]
pub struct Bookmark {
    pub title: String,
    /// 1-based page number.
    pub page: u32,
    pub depth: u32,
}

/// Writes `input` to `output` with `bookmarks` as the PDF's outline, and the book's title and author.
#[tauri::command(async)]
pub fn finish_book_pdf(
    input: String,
    output: String,
    bookmarks: Vec<Bookmark>,
    title: String,
    author: String,
) -> CmdResult<()> {
    crate::grants::check_all([&input, &output])?;
    let mut doc = Document::load(&input).map_err(other)?;
    add_outline(&mut doc, &bookmarks)?;
    set_info(&mut doc, &title, &author);
    fsutil::save_document(&mut doc, &output).map_err(other)
}

/// A PDF text string: plain bytes for ASCII, UTF-16 with a byte-order mark otherwise.
fn text_string(s: &str) -> Object {
    if s.is_ascii() {
        return Object::String(s.as_bytes().to_vec(), StringFormat::Literal);
    }
    let mut bytes = vec![0xfe, 0xff];
    for unit in s.encode_utf16() {
        bytes.extend_from_slice(&unit.to_be_bytes());
    }
    Object::String(bytes, StringFormat::Hexadecimal)
}

fn set_info(doc: &mut Document, title: &str, author: &str) {
    let mut info = Dictionary::new();
    if !title.is_empty() {
        info.set("Title", text_string(title));
    }
    if !author.is_empty() {
        info.set("Author", text_string(author));
    }
    info.set("Creator", Object::string_literal("EzReader"));
    let id = doc.add_object(info);
    doc.trailer.set("Info", Object::Reference(id));
}

pub(crate) fn add_outline(doc: &mut Document, bookmarks: &[Bookmark]) -> CmdResult<()> {
    let pages = doc.get_pages();
    let marks: Vec<(&Bookmark, ObjectId)> =
        bookmarks.iter().filter_map(|b| pages.get(&b.page).map(|&id| (b, id))).collect();
    if marks.is_empty() {
        return Ok(());
    }
    let root = doc.add_object(Dictionary::new());
    let ids: Vec<ObjectId> = marks.iter().map(|_| doc.add_object(Dictionary::new())).collect();

    // Parent of each entry: the nearest earlier entry less deep, or the root.
    let mut parent: Vec<ObjectId> = Vec::with_capacity(marks.len());
    let mut children: std::collections::HashMap<ObjectId, Vec<usize>> = std::collections::HashMap::new();
    let mut stack: Vec<(u32, usize)> = Vec::new();
    for (i, (mark, _)) in marks.iter().enumerate() {
        while stack.last().is_some_and(|&(depth, _)| depth >= mark.depth) {
            stack.pop();
        }
        let p = stack.last().map(|&(_, j)| ids[j]).unwrap_or(root);
        parent.push(p);
        children.entry(p).or_default().push(i);
        stack.push((mark.depth, i));
    }

    for (i, (mark, page)) in marks.iter().enumerate() {
        let mut d = Dictionary::new();
        d.set("Title", text_string(&mark.title));
        d.set("Parent", Object::Reference(parent[i]));
        d.set(
            "Dest",
            Object::Array(vec![
                Object::Reference(*page),
                Object::Name(b"XYZ".to_vec()),
                Object::Null,
                Object::Null,
                Object::Null,
            ]),
        );
        let siblings = &children[&parent[i]];
        let at = siblings.iter().position(|&s| s == i).expect("listed above");
        if at > 0 {
            d.set("Prev", Object::Reference(ids[siblings[at - 1]]));
        }
        if let Some(&next) = siblings.get(at + 1) {
            d.set("Next", Object::Reference(ids[next]));
        }
        if let Some(kids) = children.get(&ids[i]) {
            d.set("First", Object::Reference(ids[kids[0]]));
            d.set("Last", Object::Reference(ids[*kids.last().expect("not empty")]));
            // Negative: the entry starts closed.
            d.set("Count", Object::Integer(-(kids.len() as i64)));
        }
        doc.objects.insert(ids[i], Object::Dictionary(d));
    }

    let top = &children[&root];
    let mut r = Dictionary::new();
    r.set("Type", Object::Name(b"Outlines".to_vec()));
    r.set("First", Object::Reference(ids[top[0]]));
    r.set("Last", Object::Reference(ids[*top.last().expect("not empty")]));
    r.set("Count", Object::Integer(top.len() as i64));
    doc.objects.insert(root, Object::Dictionary(r));

    let catalog = doc.catalog_mut().map_err(other)?;
    catalog.set("Outlines", Object::Reference(root));
    catalog.set("PageMode", Object::Name(b"UseOutlines".to_vec()));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pdf_with_pages(n: u32) -> Document {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let kids: Vec<Object> = (0..n)
            .map(|_| {
                let mut p = Dictionary::new();
                p.set("Type", Object::Name(b"Page".to_vec()));
                p.set("Parent", Object::Reference(pages_id));
                p.set("MediaBox", Object::Array(vec![0.into(), 0.into(), 420.into(), 595.into()]));
                Object::Reference(doc.add_object(p))
            })
            .collect();
        let mut pages = Dictionary::new();
        pages.set("Type", Object::Name(b"Pages".to_vec()));
        pages.set("Count", Object::Integer(n as i64));
        pages.set("Kids", Object::Array(kids));
        doc.objects.insert(pages_id, Object::Dictionary(pages));
        let mut cat = Dictionary::new();
        cat.set("Type", Object::Name(b"Catalog".to_vec()));
        cat.set("Pages", Object::Reference(pages_id));
        let cat_id = doc.add_object(cat);
        doc.trailer.set("Root", Object::Reference(cat_id));
        doc
    }

    fn mark(title: &str, page: u32, depth: u32) -> Bookmark {
        Bookmark { title: title.into(), page, depth }
    }

    #[test]
    fn nests_bookmarks_by_depth() {
        let mut doc = pdf_with_pages(5);
        add_outline(&mut doc, &[mark("One", 1, 0), mark("One.a", 2, 1), mark("One.b", 3, 1), mark("Deux é", 4, 0)])
            .unwrap();
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        let doc = Document::load_mem(&bytes).unwrap();
        let cat = doc.catalog().unwrap();
        let root = doc.get_dictionary(cat.get(b"Outlines").unwrap().as_reference().unwrap()).unwrap();
        assert_eq!(root.get(b"Count").unwrap().as_i64().unwrap(), 2);
        let first = doc.get_dictionary(root.get(b"First").unwrap().as_reference().unwrap()).unwrap();
        assert_eq!(first.get(b"Title").unwrap().as_str().unwrap(), b"One");
        assert_eq!(first.get(b"Count").unwrap().as_i64().unwrap(), -2);
        let child = doc.get_dictionary(first.get(b"First").unwrap().as_reference().unwrap()).unwrap();
        assert_eq!(child.get(b"Title").unwrap().as_str().unwrap(), b"One.a");
        assert!(child.get(b"Next").is_ok());
        let second = doc.get_dictionary(first.get(b"Next").unwrap().as_reference().unwrap()).unwrap();
        assert_eq!(second.get(b"Title").unwrap().as_str().unwrap()[..2], [0xfe, 0xff]);
        let dest = second.get(b"Dest").unwrap().as_array().unwrap();
        assert_eq!(dest[0].as_reference().unwrap(), doc.get_pages()[&4]);
    }

    #[test]
    fn skips_bookmarks_past_the_last_page() {
        let mut doc = pdf_with_pages(1);
        add_outline(&mut doc, &[mark("Gone", 9, 0)]).unwrap();
        assert!(doc.catalog().unwrap().get(b"Outlines").is_err());
    }
}
