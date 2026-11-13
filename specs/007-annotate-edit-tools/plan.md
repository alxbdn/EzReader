# Implementation Plan: Annotate and Edit Tools

**Branch**: `007-annotate-edit-tools` | **Date**: 2026-11-13 (after the fact) | **Spec**: [spec.md](spec.md)

## Summary

The tool row (`tool-row.ts`) and options row drive the drawing overlay (`canvas-overlay.ts`). Annotations are written by `save_annotated_pdf` (`pdf/writer.rs`) as PDF paths, text and images, plus EzReader's `CCAnnot` data so they stay editable. Redaction rasterises the affected pages (`redact_pages`, `pdf/redact.rs`) and removes their original content.

## Technical Context

**Language/Version**: TypeScript 5.x, Rust stable
**Primary Dependencies**: pdfjs-dist, lopdf, image (png, jpeg; webp, gif, bmp added in PR D2)
**Testing**: `cargo test` (writer: shapes, ink, arrow, highlight, note, text background, stamps, JPEG pass-through, PNG with or without SMask); Vitest (picture helpers)

## Constitution Check

### Principle I — Tauri Desktop-First ✅

### Principle II — Single Executable Distribution ✅
No side-car; the `image` features are compiled in.

### Principle III — Rust Backend / Web Frontend ⚠️ justified
PDF writing, redaction and picture re-encoding (since PR D2) are in Rust. Redacted pages are **rendered** by pdf.js in the webview, because EzReader has no renderer in Rust; Rust receives the picture and does the rewrite.

### Principle IV — Simplicity & YAGNI ✅
The `image` crate was already a dependency. The `webp`, `gif` and `bmp` features (PR D2) are justified: the picture dialogs already accept those formats, and decoding them moved from the browser to Rust.

### Principle V — Test-Driven Development ⚠️
Rust writer tests cover every annotation kind. Interaction tests for the tool row and overlay came with review fix PR E.

## Complexity Tracking

| Deviation | Why | Simpler alternative rejected because |
|---|---|---|
| Page rendering for redaction in the frontend | Only pdf.js can render pages | Adding pdfium as a side-car DLL would break principle II |
| Spec written after the code | Shipped before review | Recorded now |
