# Implementation Plan: Export, Compress and Password

**Branch**: `009-export-compress-password` | **Date**: 2026-11-13 (after the fact) | **Spec**: [spec.md](spec.md)

## Summary

- **Export:** `export-modal.ts`. PDF goes to `export_flattened_pages` (`pdf/flatten.rs`), pictures are rendered by pdf.js and written by `write_image_file`, and Images to PDF uses `images_to_pdf`.
- **Compress:** `compress-modal.ts` with `estimate_compression`, `compress_pdf` (progress events) and `cancel_compression`.
- **Password:** `password-modal.ts` and `password-strength.ts`; `encrypt_pdf` and `decrypt_pdf` (`commands/security.rs`). `DocumentSession` owns the read-only rule.

## Technical Context

**Language/Version**: TypeScript 5.x, Rust stable
**Primary Dependencies**: lopdf (encryption), image, **getrandom** (new, see below)
**Testing**: `cargo test` (encryption round trip, compress levels, forms kept, progress and cancel, flatten, dropped pages); Vitest (page ranges, password strength, session protection, read-only actions, no-gain warning)

## Constitution Check

### Principle I — Tauri Desktop-First ✅

### Principle II — Single Executable Distribution ✅
getrandom is compiled in; no side-car.

### Principle III — Rust Backend / Web Frontend ✅
Encryption, decryption, compression, flattening and page extraction are in Rust. Page pictures for PNG/JPEG export are rendered by pdf.js, the only renderer.

### Principle IV — Simplicity & YAGNI ✅ (dependency justified)
**getrandom** (`0.4`) is added to draw the 32-byte AES-256 file key from the operating system's secure random source. Revision 6 encryption requires a random key, and the Rust standard library has no cryptographically secure random generator. getrandom is the minimal, widely audited crate that wraps the OS source (`BCryptGenRandom` on Windows) and the same version (0.4) was already compiled into the app through Tauri (`tauri` → `tauri-utils` → `infer` → `cfb` → `uuid`), so it adds no new code to the build.

### Principle V — Test-Driven Development ✅
Tests for the review fixes (#24, #25, #27, #28) were written failing first.

## Complexity Tracking

| Deviation | Why | Simpler alternative rejected because |
|---|---|---|
| getrandom dependency | Secure random key for AES-256 | std has no CSPRNG; a time-based seed would make the key guessable |
| Picture export rendered in the frontend | Only pdf.js renders pages | pdfium side-car breaks principle II |
