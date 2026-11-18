# Feature Specification: Tabs, Dragged Out to a Window and Back

**Feature Branch**: `011-detachable-tabs`
**Created**: 2026-11-16
**Status**: Implemented

## User Scenarios & Testing

### User Story 1 — Several PDFs in one window (P1)

1. **Given** a document is open, **When** another one is opened (Open, Ctrl+O, drag and drop, the Finder), **Then** it opens in a new tab right after the current one; the first stays as it was left (page, zoom, pending edits, undo history).
2. **Given** one document, **Then** the title bar shows only its name, as before tabs.
3. **Given** the file is already open in a tab, **Then** that tab is shown instead of a second copy.
4. Ctrl+Tab / Ctrl+Shift+Tab (or Ctrl+PageDown / PageUp) go to the next / previous tab; Ctrl+W, the ×, or a middle click close one, asking first when it has unsaved changes. Closing the last tab shows the launcher.
5. Closing the window asks about every tab with unsaved changes, one after the other.

### User Story 2 — Split and merge windows (P1)

1. **Given** two tabs or more, **When** one is dragged along the title bar, **Then** it changes place.
2. **When** it is pulled down off the title bar or out of the window and released over nothing, **Then** it opens in a new window there.
3. **When** it is released over another EzReader window (that window's title bar lights up while it hovers), **Then** it moves into that window as a new tab, and a window left without tabs closes.
4. A tab with unsaved changes keeps them in its new window, and Save writes back to its own file.

## Requirements

- **FR-001**: Only the active tab's PDF is loaded; the others keep their state only, so memory stays that of one document (`perf/` thresholds unchanged).
- **FR-002**: A moved tab carries its edits in a temp copy (`%TEMP%\ezreader-…`), never through other paths than the ones the user picked (see `grants.rs`).
- **FR-003**: A protected document moves read-only, with its password, as it was.
