# Feature Specification: Crop and Straighten

**Feature Branch**: `008-crop-straighten`
**Created**: 2026-11-13 (written after the fact; shipped in PR #21, revised in PR #29)
**Status**: Implemented

## User Scenarios & Testing

### User Story 1 — Crop pages (P1)

**Acceptance Scenarios**:
1. **Given** pages are selected, **When** the user crops with the 8 handles and confirms, **Then** the CropBox is set and the text stays vector and selectable.
2. **Given** Auto margins, **Then** the box snaps to the content.
3. **Given** Flip, **Then** the page is mirrored about its visible area, and EzReader's annotations are not mirrored.

### User Story 2 — Straighten a photographed page (P1)

**Acceptance Scenarios**:
1. **Given** the 4 corners are placed on the page in the photo, **When** the user confirms, **Then** that area is stretched over the whole page.
2. **Given** the page had text, **When** it is straightened, **Then** the text can still be searched, selected and copied at its new place (invisible text layer, PR #29).
3. **Given** the page had links, form fields or annotations, **Then** they stay, moved with the warp (PR #29).
4. **Given** the document has a structure tree, **Then** it is kept (PR #29).

## Requirements

- **FR-001**: Crop MUST keep content vector (CropBox, no rasterising).
- **FR-002**: Straighten MUST keep the page's text searchable and selectable.
- **FR-003**: Straighten MUST keep annotations, links, form fields and the structure tree.
- **FR-004**: The adjust view MUST block other actions until ✓ or ✕.
- **FR-005**: Pages that never had text (scans) are out of scope; they would need OCR.

## Success Criteria

- **SC-001**: Searching a straightened page finds the same words as before.
