# Load test

`tests/perf/stress.mjs` checks that EzReader stays fast and does not leak on a very
large document. CI runs it on every pull request (`.github/workflows/perf.yml`).

What it does:

1. `make-big-pdf.mjs` writes a 1500-page PDF (no dependencies): text and
   vector charts on most pages, a colour picture every 10th page, and a scan
   (full-page picture, no text) every 5th page, which the app reads in the
   background with OCR.
2. The built front end (`dist/`) runs in headless Chromium, the engine of
   WebView2. The Rust side is replaced by canned answers; OCR answers after
   250 ms with 40 lines of words, like the Windows engine on a page.
3. The PDF is opened, then each round reads fast with the wheel (~100
   pages), jumps to 30 random pages, zooms in and out 36 times, and reads
   back up. Quick test: 3 rounds. Weekly soak test: 15 rounds, 3000 pages.
4. Memory (PSS of every browser process, from `/proc`), JS heaps, canvas
   pixels, DOM nodes, CPU and response times are measured. The job fails
   when one goes past `thresholds.json`.

| Measure | What it catches |
|---|---|
| `open_ms` | Time from launch to the first page drawn |
| `jump_p95_ms`, `zoom_p95_ms` | Slow redraws after a jump or a zoom step |
| `memory_peak_mb`, `memory_opened_mb` | Memory of the whole app (all processes) |
| `memory_leak_per_round_mb` | Memory that keeps growing round after round |
| `heap_leak_per_round_mb`, `pdf_worker_heap_end_mb` | JS objects kept alive (page, pdf.js worker) |
| `canvas_peak_mb` | Page bitmaps not given back when pages scroll away |
| `dom_nodes_growth_per_page` | Page elements kept after a new layout, per page of the document: a page keeps its layers once drawn, so the total grows with the pages visited |
| `cpu_idle_percent` | Work still running when nothing happens |
| `page_errors` | Uncaught errors in the page |

Run it locally (Linux, for the memory figures): `npm run test:perf`.
`PERF_VERBOSE=1` also prints the memory of each process.
`--rounds N` sets the number of rounds.

## Several documents in tabs

`tests/perf/tabs.mjs` opens several large PDFs at once, each in its own tab, most of them
already annotated, and goes round the tabs: on each tab it waits for the document to come
back, jumps to 8 pages, scrolls, and draws a rectangle. At the end every tab is saved and
the annotations sent to the save are counted. `.github/workflows/perf-tabs.yml` runs it.

| Profile | When | Tabs | Pages | Annotations | Rounds |
|---|---|---:|---:|---:|---:|
| `quick` | Every pull request and push to `main` | 4 | 2,900 | 21,000 | 3 |
| `soak` | Every release tag, and on demand | 8 | 6,000 | 50,000 | 10 |

The documents of each profile are in `tabs-profiles.json`: page count, annotations per
page (highlights, ink with 50 to 200 points, text, shapes, notes, stamps, signatures),
`inkHeavy` for mostly ink, `scanEvery: 1` for a scanned document read by the OCR. The
annotations are handed to the app as if read from the file.

| Measure | What it catches |
|---|---|
| `open_all_ms` | Time to open every tab |
| `switch_p95_ms` | Time from Ctrl+Tab to the page where the tab was left drawn again |
| `jump_p95_ms` | Slow redraws after a jump in an annotated document |
| `memory_peak_mb`, `memory_leak_per_round_mb` | Memory of the whole app, and memory that keeps growing round after round |
| `heap_leak_per_round_mb` | JS objects kept alive between rounds (tabs in the background, undo history) |
| `dom_nodes_growth_after_round_1` | Page elements left behind by a tab that was hidden |
| `pdf_worker_heap_end_mb` | Documents of hidden tabs not given back by pdf.js |
| `annotations_lost` | Annotations missing from the save, after all the tab switches |
| `dirty_tabs_lost` | Tabs with a drawn annotation no longer marked as changed |
| `wrong_document_shown` | A tab showing another document, or the wrong page count |

Limits are in `tabs-thresholds.json`.

Idle CPU is measured 12 s after the last save. With 8 heavy tabs, V8 runs one or two
"reduce memory" collections over the whole heap about 8 s after the work stops; they
take about 0.6 s of CPU once and are not work the app keeps doing. A window that
starts earlier catches them and reads 9 to 20 %. Run it locally: `npm run test:perf:tabs`, with
`--profile soak` for the long one and `--rounds N` to change the number of rounds.
