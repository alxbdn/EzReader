# Implementation Plan: Drag Pages Out to a New Window

**Branch**: `010-drag-pages-new-window` | **Date**: 2026-11-13 (after the fact) | **Spec**: [spec.md](spec.md)

## Summary

`page-sidebar.ts` tracks the drag with pointer capture. Releasing outside calls `open_pages_in_new_window` (`commands/window.rs`). It extracts the pages (compacted, PR #24) into `$TEMP/ezreader-window-…/`, allows the file in the asset scope and opens a `doc-N` window. `get_startup_args` answers per window, and the capability covers `doc-*`.

## Technical Context

**Language/Version**: TypeScript 5.x, Rust stable
**Primary Dependencies**: Tauri v2 window API (existing)
**Testing**: Vitest (`formatPageRange`); `cargo test` (safe file names; dropped pages leave no data)

## Constitution Check

### Principle I — Tauri Desktop-First ✅
The window is created through Tauri.

### Principle II — Single Executable Distribution ✅

### Principle III — Rust Backend / Web Frontend ✅
The copy and the window are made in Rust; the frontend only tracks the drag.

### Principle IV — Simplicity & YAGNI ✅

### Principle V — Test-Driven Development ⚠️
Window creation itself only runs on a real Windows build and has no automated test.

## Complexity Tracking

| Deviation | Why | Simpler alternative rejected because |
|---|---|---|
| No automated test of window creation | Needs a real Windows session | Covered by the extraction tests and manual checks |
