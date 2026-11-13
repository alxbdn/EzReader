# Implementation Plan: Crop and Straighten

**Branch**: `008-crop-straighten` | **Date**: 2026-11-13 (after the fact) | **Spec**: [spec.md](spec.md)

## Summary

`adjust-view.ts` collects a crop box or 4 corners per page. Crop and flip go to `adjust_pages` (CropBox, mirroring matrix). Straighten renders the page with pdf.js, warps it (`warp.ts`), computes the warp in PDF user space and moves the page's text runs (`straighten.ts`), then `straighten_pages` (`pdf/straighten.rs`) writes the picture, an invisible text layer in a glyph-less Identity-H font, and the moved annotations.

## Technical Context

**Language/Version**: TypeScript 5.x, Rust stable
**Primary Dependencies**: pdfjs-dist, lopdf, image (existing)
**Testing**: Vitest (warp, straightenMap, pageMap, moveTextRuns, adjust view); `cargo test` (crop and mirror; text layer reads back; annotations moved; structure tree kept)

## Constitution Check

### Principle I — Tauri Desktop-First ✅

### Principle II — Single Executable Distribution ✅
No new dependency.

### Principle III — Rust Backend / Web Frontend ⚠️ justified
Writing the page, the text layer and moving annotations happen in Rust. Rendering the page and its perspective warp happen in the webview: the warp runs on the rendered pixels, and only pdf.js can render. Moving the warp alone to Rust would mean sending a picture of up to 40 MP across the bridge twice, for no gain to the user.

### Principle IV — Simplicity & YAGNI ✅
The invisible text layer uses the same trick as OCR tools, with no new dependency.

### Principle V — Test-Driven Development ✅
The PR #29 tests were written alongside; the warp math has unit tests.

## Complexity Tracking

| Deviation | Why | Simpler alternative rejected because |
|---|---|---|
| Rendering and warp in the frontend | Pixels come from pdf.js | pdfium side-car breaks principle II; pixel round trip is slow |
