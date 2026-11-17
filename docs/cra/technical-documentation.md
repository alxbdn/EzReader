# EzReader technical documentation (CRA Annex VII)

Draft of the technical documentation the Cyber Resilience Act asks for. EzReader is currently outside the CRA's scope (see [README](README.md)); this file is kept up to date so that it is ready if that changes. It must then be kept for 10 years after the product is placed on the market, or for the support period if longer.

*Version covered: 1.0.0. Last reviewed: 16 November 2026.*

## 1. General description

| | |
|---|---|
| Product | EzReader, PDF reader and editor |
| Manufacturer | alxbdn (maintainer of github.com/alxbdn/EzReader) |
| Intended purpose | Read, annotate, sign, edit, reorganize, convert, compress and password-protect PDF files on a personal computer |
| Platforms | Windows 10 (2004+) and 11 x64, macOS 11+ (Intel and Apple Silicon), Linux x64 |
| Distribution | GitHub releases, Microsoft Store, Homebrew cask, Linux packages |
| Licence | MIT |
| Product class | Default (not in Annex III or IV) |
| Previous versions | Listed on the [releases page](https://github.com/alxbdn/EzReader/releases) |

User information and instructions: [README](../../README.md), [SECURITY.md](../../SECURITY.md), [PRIVACY.md](../../PRIVACY.md).

## 2. Design, development and production

**Architecture.** A [Tauri 2](https://tauri.app) desktop application: a Rust back end (PDF processing, file access, OCR, updates) and a TypeScript front end in the system webview (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux). PDFs are rendered with PDF.js inside the webview.

**Trust boundaries.**

| Boundary | Untrusted input | Controls |
|---|---|---|
| Opened files | PDF and image files, possibly malformed or hostile | Rust parsers, fuzzing (cargo-fuzz), hostile-input and corpus tests; document JavaScript never runs |
| Webview to back end | IPC calls from the front end | Tauri capabilities (`src-tauri/capabilities/default.json`) limited to window commands; file commands only reach files the user opened or picked (`src-tauri/src/grants.rs`) |
| Webview content | Rendered document content | Content Security Policy: `script-src 'self'`, `object-src 'none'`, no remote `connect-src` |
| Network | Version check and update download from GitHub | HTTPS only; the downloaded installer must match the SHA-256 digest published by GitHub (`src-tauri/src/commands/update.rs`) |
| Build and supply chain | Dependencies and CI actions | Lockfiles, Dependabot, `npm audit`, `cargo deny` (advisories, licences, sources), actions pinned to a commit, OpenSSF Scorecard |

**Production.** Every release is built by GitHub Actions (`.github/workflows/release.yml`, started by `bump.yml` or by a tag pushed by hand) only after the security scans pass (`security.yml`), tested by installing it on a clean runner (`install-test.yml`), attested with signed SLSA build provenance, and attached with its SBOMs and reports (`release-reports.yml`) to a draft that is published last. Releases are immutable once published: their files and tag cannot change. Store packages are signed by Microsoft. macOS builds are only ad-hoc signed (not notarized), and the Windows installer on GitHub is not Authenticode-signed.

## 3. Cybersecurity risk assessment

| Risk | Impact | Likelihood | Treatment |
|---|---|---|---|
| Malicious PDF exploits a parser bug (crash, memory corruption) | High | Medium | Memory-safe Rust, fuzzing, hostile-input tests, quick dependency updates |
| Document script or embedded content runs code or reaches the network | High | Low | Scripts never run, strict CSP, no network from the viewer |
| Webview compromise reaches arbitrary files | High | Low | Capability allow-list, per-file grants |
| Tampered update | High | Low | HTTPS, SHA-256 digest check, signed SLSA build provenance, Microsoft-signed Store packages. Residual: unsigned Windows installer and non-notarized macOS app on GitHub |
| Vulnerable dependency | Medium | Medium | SBOM, weekly audits, Dependabot security updates |
| Leak of document content | High | Low | No telemetry, no upload; temporary copies deleted at exit |
| Weak PDF password protection | Medium | Low | Standard PDF encryption through `lopdf`, no custom cryptography |

Annex I Part I (2)(l), security logging, is not applicable: EzReader is an offline single-user tool with no account and no service, and logging user activity would conflict with data minimisation.

How each essential requirement is met: see the [gap analysis](README.md#gap-analysis).

## 4. Vulnerability handling

Described in [SECURITY.md](../../SECURITY.md): private reporting, response and fix targets, advisories, support period, update channels and reporting of actively exploited vulnerabilities. SBOMs (CycloneDX) are attached to every release.

## 5. Standards and specifications applied

No harmonised standard under the CRA has been published yet. EzReader follows:

- OpenSSF Scorecard checks;
- ISO 32000 (PDF) for document encryption.

## 6. Test reports

Attached to every release on the [releases page](https://github.com/alxbdn/EzReader/releases): security report (SCA, SAST, fuzzing results), performance report, SBOMs, together in `ezreader-reports.zip`. CI history: GitHub Actions on the repository.

## 7. EU declaration of conformity

Template: [eu-declaration-of-conformity.md](eu-declaration-of-conformity.md). Not issued while EzReader is outside the CRA's scope.

## 8. Support period

See [SECURITY.md](../../SECURITY.md#supported-versions).
