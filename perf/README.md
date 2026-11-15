# Load test

`perf/stress.mjs` checks that EzReader stays fast and does not leak on a very
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
| `dom_nodes_growth` | Page elements kept after a new layout |
| `cpu_idle_percent` | Work still running when nothing happens |
| `page_errors` | Uncaught errors in the page |

Run it locally (Linux, for the memory figures): `npm run test:perf`.
`PERF_VERBOSE=1` also prints the memory of each process.
`--rounds N` sets the number of rounds.
