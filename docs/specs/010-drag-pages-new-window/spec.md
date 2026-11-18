# Feature Specification: Drag Pages Out to a New Window

**Feature Branch**: `010-drag-pages-new-window`
**Created**: 2026-11-13 (written after the fact; shipped in PR #23)
**Status**: Implemented

## User Scenarios & Testing

### User Story 1 — Open some pages on their own (P2)

**Acceptance Scenarios**:
1. **Given** thumbnails are dragged past the window's edge, **Then** the label reads "Release to open in a new window".
2. **Given** they are released there, **Then** a new window opens near the pointer with only those pages, named like `Report (pages 2-3).pdf`.
3. **Given** the new document, **When** the user saves it for the first time, **Then** Save As asks where to save it.
4. **Given** they are dragged back inside, **Then** it is a normal reorder.
5. **Given** the source document is protected, **Then** drag-out is refused until its password is removed (PR #25).

## Requirements

- **FR-001**: The new window MUST contain only the dragged pages, with the pending edits, and no data of the other pages (PR #24).
- **FR-002**: The new document MUST start as unsaved and ask where to save it.
- **FR-003**: Drag-out MUST NOT be possible from a protected document.

## Success Criteria

- **SC-001**: The temporary copy holds no data of pages that were not dragged.
