# Feature Specification: Export, Compress and Password

**Feature Branch**: `009-export-compress-password`
**Created**: 2026-11-13 (written after the fact; shipped in PR #22, revised in PRs #24, #25, #27, #28)
**Status**: Implemented

Compress also follows `specs/002-compress-pdf/spec.md` (FR-006 to FR-009 since PR #27).

## User Scenarios & Testing

### User Story 1 — Export pages (P1)

**Acceptance Scenarios**:
1. **Given** a page range and a resolution, **When** the user exports PNG or JPEG, **Then** one picture per page is written, asking before replacing files.
2. **Given** PDF is chosen, **Then** a flattened copy is written: what annotations and form fields show is drawn into the pages and nothing stays editable, links excepted (PR #28).
3. **Given** a page range, **Then** the pages left out leave no data in the copy (PR #24).
4. **Given** pictures, **When** the user uses Images to PDF, **Then** each becomes a page fitted to A4.

### User Story 2 — Compress (P1)

See spec 002. Form fields are kept, progress is shown, the user can cancel, and a level that won't shrink the file is flagged.

### User Story 3 — Protect with a password (P1)

**Acceptance Scenarios**:
1. **Given** an unprotected document, **When** the user sets a password (strength bar, confirmation) and saves, **Then** the file is encrypted with AES-256 and becomes read-only in EzReader.
2. **Given** a protected file, **When** it is opened with its password, **Then** it can be read, searched and printed, but nothing can edit, save or copy it (export, compress, extract, split, drag-out, Print to PDF) (PR #25).
3. **Given** a protected file, **When** the user removes the password with the current password, **Then** it becomes editable and the next save writes it unprotected.

## Requirements

- **FR-001**: PDF export MUST be flattened and MUST contain only the chosen pages.
- **FR-002**: A protected document MUST be read-only until its password is removed.
- **FR-003**: No copy of a protected document may be written while it is protected.
- **FR-004**: Encryption MUST be AES-256 (PDF 2.0, revision 6) with a random file key.
- **FR-005**: An empty password MUST be refused; a wrong password MUST be reported as such (error code `wrong-password`).

## Success Criteria

- **SC-001**: pdf.js refuses an EzReader-protected file without its password.
- **SC-002**: No exported copy contains data of a page left out.
