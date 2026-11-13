<div align="center">

# EzReader

**A fast, lightweight PDF reader and editor for Windows.**
Read, annotate, sign, edit, reorganize, compress and protect your PDFs. Everything runs on your computer: no account, no subscription, no telemetry.

[![Latest Release](https://img.shields.io/github/v/release/alxbdn/EzReader?style=flat-square&label=Download)](https://github.com/alxbdn/EzReader/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

</div>

---

## Download

**[Download the latest release](https://github.com/alxbdn/EzReader/releases/latest)** and pick the file that suits you:

| File | What it is |
|------|------------|
| `ezreader-<version>-win-x64-setup.exe` | Installer |
| `ezreader-portable-<version>-win-x64.exe` | Portable app: a single file you can run from anywhere, nothing to install |

EzReader runs on 64-bit Windows.

---

## Features

EzReader has three modes, picked from the toolbar: **Read**, **Annotate** and **Edit**. The pages side panel and the File, Edit, View and Pages menus are available in all of them.

### Read

- Sharp rendering at any zoom, powered by PDF.js
- Zoom in and out, fit to width or height, actual size (1:1, calibrated to your screen), or type any percentage
- One, two or three pages per row, with vertical or horizontal scrolling
- Hand tool to drag the page around, or text selection to copy text
- Search the whole document (Ctrl+F) and jump between matches
- Fill in interactive forms: text fields, checkboxes and radio buttons
- Document info: page size, PDF version, author, producer, dates and keywords
- Rename the open file by clicking its name in the toolbar
- Open files by dropping them onto the window

### Annotate

- **Text** with font, size, color and background
- **Pencil**, freeform or straight lines, with color, thickness and opacity
- **Shapes**: rectangle, ellipse and arrow, with outline and fill colors
- **Highlighter** on selected text (select it again to remove the highlight)
- **Sticky notes**
- **Signatures**: draw one or import a picture, keep up to three saved, and place them anywhere
- Each change is validated (Enter) or discarded (Esc), and everything can be undone and redone (Ctrl+Z, Ctrl+Y)
- Annotations stay editable when you reopen the file

### Edit

- **Edit text**: click existing text in the PDF to replace it
- **Images**: browse for a picture or drop one on a page to place it
- **Redact** selected text or an area. Redactions are permanent once saved: the content under the black boxes is removed, not just hidden
- **Stamps**: check marks and crosses
- **Crop** pages, with handles and automatic content margins
- **Straighten** scanned pages by placing each corner with a magnifying loupe, and flip pages vertically or horizontally

### Manage pages

The side panel shows a thumbnail of every page.

- Select pages, then rotate, delete or export them
- Drag thumbnails to reorder pages (Ctrl+← and Ctrl+→ with the keyboard)
- Insert a blank page, insert another PDF, or add a PDF at the end to merge files
- Drop a picture in the panel to add it as a new page
- Drag pages out of the window to open them in a new window
- Extract the selected pages to a new PDF, or split the document into several files (every page, every N pages, or custom ranges)

Extracted, split and rearranged files contain nothing from the pages you left out: their text, images and annotations are removed from the output, not just hidden.

### Export, compress and protect

- **Export** pages as PNG or JPEG images (96, 150 or 300 dpi), or as a flattened PDF copy, with or without annotations
- **Convert** the text of a PDF to Word (.docx), Excel (.xlsx, one sheet per page), RTF, a web page (HTML), plain text or XML. Paragraphs, titles and tables are kept; pictures and the exact layout are not
- **Images to PDF**: turn a set of pictures into a PDF, one picture per page
- **Compress** with a Lossless, Balanced or Maximum preset, or give a target size and let EzReader find the best quality under it. The estimated result is shown before you save
- **Password**: protect a PDF with a password (with a strength meter and tips), open protected PDFs, or remove the protection
- **Print** with a choice of printer, pages, copies, orientation and scale

### Settings and Windows integration

- Light, dark or system theme
- Default zoom when a file opens
- 20 interface languages, switched instantly: English, Français, 中文, हिन्दी, Español, العربية, বাংলা, Русский, Português, اردو, Bahasa Indonesia, Deutsch, 日本語, Kiswahili, मराठी, తెలుగు, Türkçe, தமிழ், Tiếng Việt, 한국어
- Set EzReader as the default PDF viewer from Settings, no administrator rights needed
- Print from the command line: `ezreader-portable.exe --print file.pdf`

---

## Build from source

EzReader is built with Rust, TypeScript and [Tauri 2](https://tauri.app). You need Rust (stable), Node.js 18 or later, and the Visual Studio C++ Build Tools.

```bash
npm install
npm run tauri dev      # run in development
npm run tauri build    # build the release app
```

The frontend lives in `src/` and the Rust backend in `src-tauri/`. Before opening a pull request, run the checks that CI runs:

```bash
npx tsc --noEmit
npm test
cd src-tauri && cargo clippy -- -D warnings && cargo test
```

Bug reports and ideas are welcome in the [issues](https://github.com/alxbdn/EzReader/issues).

---

## Credits and license

EzReader started as a fork of [PDF Rider](https://github.com/pleymor/pdf-rider) by pleymor, used under the MIT license. Thanks to its author for the foundation this app is built on.

PDF rendering uses [PDF.js](https://mozilla.github.io/pdf.js/) by Mozilla.

EzReader is released under the MIT license. See [LICENSE](LICENSE) for details.
