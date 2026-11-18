# Implementation Plan: Toolbar, Pages Panel and Search Redesign

**Branch**: `006-toolbar-redesign` | **Date**: 2026-11-13 (after the fact) | **Spec**: [spec.md](spec.md)

## Summary

Rebuild the toolbar (`toolbar.ts`), the pages panel (`page-sidebar.ts`) and search (`search-pill.ts`) from the approved prototype. Page edits go through `rearrange_pages`; renaming goes through a new `rename_file` command that refuses to overwrite.

## Technical Context

**Language/Version**: TypeScript 5.x, Rust stable
**Primary Dependencies**: pdfjs-dist, Tauri v2, lopdf (all existing)
**Testing**: Vitest (file-name checks), `cargo test` (rename: rename, no overwrite, invalid names)
**Constraints**: no new crate or npm package

## Constitution Check

### Principle I — Tauri Desktop-First ✅
Windows desktop only; the rename goes through a Tauri command.

### Principle II — Single Executable Distribution ✅
No new dependency.

### Principle III — Rust Backend / Web Frontend ✅
Renaming and page edits run in Rust (`rename_file`, `rearrange_pages`). The frontend only lays out the toolbar, panel and search.

### Principle IV — Simplicity & YAGNI ✅
No new dependency. The toolbar and panel are plain DOM classes.

### Principle V — Test-Driven Development ⚠️
Rust rename tests and frontend file-name tests exist. Interaction tests for the toolbar and panel were added later (review fix PR E). The test-first order can't be shown after the fact.

## Complexity Tracking

| Deviation | Why | Simpler alternative rejected because |
|---|---|---|
| Spec and plan written after the code (Governance) | Shipped before the review of PRs #17–#23 | Recorded now so later changes have a spec to check against |
