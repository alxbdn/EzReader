# EzReader marketing

## Microsoft Store screenshots

`store-screenshots/` holds eleven 3840 × 2160 PNGs, ready to upload to Partner Center. Each one shows a single feature as the answer to a problem:

| File | Feature | Headline |
|------|---------|----------|
| 01-launcher | Home screen | Every PDF job, one calm home. |
| 02-brightness | Page brightness | Glaring white pages? Dim them. |
| 03-speed | Speed | Waiting for a PDF to open? Not here. |
| 04-size | Small download | Bloated PDF suites? Not this one. |
| 05-windows | Windows 10 & 11 | Still on Windows 10? You're covered. |
| 06-straighten | Crop & straighten scans | Crooked phone scan? Square it up. |
| 07-sign | Sign | Print, sign, scan? Just sign. |
| 08-export | Export & convert | Text stuck in a PDF? Set it free. |
| 09-private | No AI, no telemetry | Your files, nobody else's. |
| 10-secure | Locked-down viewer, passwords | Suspicious attachment? It stays boxed in. |
| 11-free | Free forever, open source | All of it. Free, for good. |

The Store accepts at most ten desktop screenshots, so leave one out when uploading (05-windows is the easiest to spare, since the listing already states the supported Windows versions).

## How they are made

Everything is in `source/` and can be regenerated after a UI change:

- `samples/`: the demo documents (`report`, `contract`, `scan`), written as HTML and printed to PDF with Chrome.
- `capture/`: runs the real EzReader front end in headless Chrome with a stand-in for the Tauri runtime (`mock.js`), drives it (`scene.js <scene>`) and saves the app shots to `shots/`.
- `slides.js`: the copy of each screenshot. `store.html` lays one slide out; `render.cjs` renders them all to `store-screenshots/`.

```bash
npx vite                                  # serves the app and this folder on :5173
node marketing/source/capture/scene.js sign
node marketing/source/render.cjs          # all slides, or pass an index
```

Both scripts need `playwright-core` (set `PW` to its path if it is not installed here) and Chrome at its default location (or `CHROME`).
