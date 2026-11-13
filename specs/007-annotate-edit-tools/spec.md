# Feature Specification: Annotate and Edit Tools

**Feature Branch**: `007-annotate-edit-tools`
**Created**: 2026-11-13 (written after the fact; shipped in PRs #19 and #20)
**Status**: Implemented

## User Scenarios & Testing

### User Story 1 — Annotate a document (P1)

The user picks Text, Pencil, Shapes, Sticky note, Highlighter or Sign. An options row sets color, thickness and opacity. Each change waits for ✓ (Enter) or ✕ (Esc).

**Acceptance Scenarios**:
1. **Given** Pencil is active, **When** the user draws, **Then** the stroke is saved as a PDF path with its opacity.
2. **Given** selected text, **When** the user highlights it again, **Then** the highlight is removed.
3. **Given** a change waits for ✓/✕, **When** the user picks another tool or saves, **Then** the action is refused and the buttons shake.
4. **Given** three saved signatures, **When** the user opens Sign, **Then** they appear as chips to use or delete.

### User Story 2 — Edit a document (P1)

The user picks Edit text, Image, Redact (text, area) or Stamps.

**Acceptance Scenarios**:
1. **Given** Edit text, **When** the user clicks words and types, **Then** the new text is drawn over a patch of the page's colour. The original words stay underneath (not a redaction).
2. **Given** Redact area, **When** the user saves, **Then** the page is rasterised with the area blacked out and its original content is removed from the file.
3. **Given** a picture is dropped on a page, **Then** it is placed there; dropped in the side panel, **Then** it becomes a new page.
4. **Given** a WebP, GIF or BMP picture, **When** the user places it, **Then** it is converted in Rust to PNG (or JPEG for photos) (PR D2).

## Requirements

- **FR-001**: Annotations MUST stay editable after save and reopen (EzReader's `CCAnnot` data), except in a flattened export.
- **FR-002**: Redaction MUST remove the redacted content from the saved file, not only cover it.
- **FR-003**: Edit text MUST NOT be presented as a redaction.
- **FR-004**: Every change MUST be validated (✓) or discarded (✕) before another action.
- **FR-005**: Pictures, signatures and stamps MUST keep their proportions when resized from a corner.

## Success Criteria

- **SC-001**: Redacted text can't be found by searching or extracting text from the saved file.
- **SC-002**: Annotations reopen editable in EzReader.
