# Feature Specification: Toolbar, Pages Panel and Search Redesign

**Feature Branch**: `006-toolbar-redesign`
**Created**: 2026-11-13 (written after the fact; shipped in PR #18, with the welcome screen dots of PR #17)
**Status**: Implemented

## User Scenarios & Testing

### User Story 1 — Read, annotate or edit from one toolbar (P1)

A user switches between Read, Annotate and Edit modes from the main toolbar. Annotate and Edit unfold their tools in a second row.

**Acceptance Scenarios**:
1. **Given** a document is open, **When** the user picks Annotate, **Then** the annotate tools appear in a second row.
2. **Given** the zoom group, **When** the user clicks the percentage, **Then** the zoom resets; double-clicking lets them type a value.

### User Story 2 — Find text with the search pill (P1)

**Acceptance Scenarios**:
1. **Given** a document is open, **When** the user presses Ctrl+F, **Then** the search pill opens with an "n / total" counter and previous/next buttons.
2. **Given** the pill is open, **When** the user presses Escape, **Then** it closes.

### User Story 3 — Manage pages from the panel (P1)

**Acceptance Scenarios**:
1. **Given** the pages panel, **When** the user types a page number in the pill, **Then** the viewer goes to that page; holding an arrow scrolls through pages.
2. **Given** pages are selected (checkbox, red outline), **When** the user clicks Delete (n), **Then** those pages are removed and none of their data remains in the saved file (see 001 and PR #24).
3. **Given** a page, **When** the user clicks rotate-left under it, **Then** it rotates 90° counter-clockwise.

### User Story 4 — Rename the file from the title bar (P2)

**Acceptance Scenarios**:
1. **Given** a document is open, **When** the user clicks the file name, edits it and saves, **Then** the file is renamed with its extension kept.
2. **Given** another file already has that name, **When** the user saves, **Then** nothing is overwritten and the user is told (error code `exists`).

## Requirements

- **FR-001**: The main toolbar MUST offer Save, undo/redo, hand/select, zoom (−, %, +, 1:1), pages per row, Read/Annotate/Edit, Export, Compress, Info, password padlock and search.
- **FR-002**: Ctrl+F MUST open search and Escape MUST close it.
- **FR-003**: The pages panel MUST support select all/none, delete, rotate, insert blank page, insert PDF and extract selected pages.
- **FR-004**: Rename MUST never overwrite another file and MUST keep the extension.
- **FR-005**: English MUST be the default interface language.

## Success Criteria

- **SC-001**: Every action above is reachable in at most two clicks from an open document.
- **SC-002**: A rename never replaces an existing file.
