# EzReader and the EU Cyber Resilience Act

The Cyber Resilience Act (CRA, [Regulation (EU) 2024/2847](https://eur-lex.europa.eu/eli/reg/2024/2847/oj)) sets security rules for software sold or supplied in the EU. This folder records how EzReader stands against it.

*Last reviewed: 16 November 2026, for EzReader 1.0.0.*

## Does the CRA apply to EzReader?

**Not today.** The CRA covers products made available on the EU market "in the course of a commercial activity". Free and open-source software that is developed and given away without being monetized is outside that scope (recitals 18 and 19). EzReader is free on every channel (GitHub releases, Microsoft Store, Homebrew, Linux packages), has no paid tier, no ads, no in-app purchases and collects no personal data, so it is not a commercial product under the CRA.

**It would apply** if EzReader started to be monetized: a price on the Store, paid features, a paid support offer tied to the software, or ads. In that case:

| Point | What it means for EzReader |
|---|---|
| Product class | Default category. A PDF reader and editor is not listed in Annex III (important) or Annex IV (critical). |
| Conformity assessment | Internal control (module A, Annex VIII): self-assessment, no notified body. |
| Paperwork | [Technical documentation](technical-documentation.md) (Annex VII), [EU declaration of conformity](eu-declaration-of-conformity.md) (Annex V), CE marking, user information (Annex II). |
| Support period | At least 5 years, unless the product is expected to be used for less (Art. 13(8)), stated with an end month and year at purchase. |
| Reporting | Actively exploited vulnerabilities and severe incidents to the CSIRT and ENISA through the single reporting platform: early warning within 24 h, notification within 72 h, final report within 14 days (Art. 14). |
| Dates | Reporting obligations from **11 September 2026**, everything else from **11 December 2027**. |

Even outside its scope, EzReader follows the CRA's essential requirements where they make sense, because they are good practice and a clear trust signal.

## Gap analysis

Status against Annex I. ✅ met, 🟡 partly met, ⬜ only needed if the CRA applies.

### Part II: vulnerability handling

| Requirement | Status | How |
|---|---|---|
| 1. Identify components, SBOM | ✅ | CycloneDX SBOMs (npm and Cargo) attached to every release, in `ezreader-reports.zip` |
| 2. Fix vulnerabilities without delay | ✅ | Dependabot security updates, `npm audit` and `cargo deny` on every push and weekly; fix targets in [SECURITY.md](../../.github/SECURITY.md) |
| 3. Regular security testing | ✅ | CodeQL `security-extended`, cargo-fuzz on the PDF and image parsers, hostile-input tests, OpenSSF Scorecard |
| 4. Public disclosure of fixed vulnerabilities | ✅ | GitHub security advisories (with CVE through GitHub's CNA) published with the fix |
| 5. Coordinated vulnerability disclosure policy | ✅ | [SECURITY.md](../../.github/SECURITY.md) |
| 6. Contact address for reports | ✅ | GitHub private vulnerability reporting, enabled |
| 7. Secure distribution of updates | 🟡 | HTTPS only; the in-app updater checks the SHA-256 digest GitHub publishes for each asset; every package has signed SLSA build provenance (`gh attestation verify`); Store packages are signed by Microsoft. The Windows installer on GitHub is not Authenticode-signed and the macOS app is not notarized |
| 8. Free security updates, with advisories | ✅ | Every update is free; advisories explain the fix |

### Part I: product security

| Requirement | Status | How |
|---|---|---|
| (a) No known exploitable vulnerability at release | ✅ | The release workflows run `npm audit`, `cargo deny`, CodeQL and fuzzing first, and publish nothing if one fails |
| (b) Secure by default | ✅ | No account, no open port, no telemetry; document scripts never run |
| (c) Security updates, automatic by default | 🟡 | The app checks for updates at start-up and offers a one-click install; the Store updates automatically and Homebrew through `brew upgrade`. The GitHub build does not install on its own |
| (d) Protection from unauthorized access | ✅ | Tauri capabilities limit the webview to window commands; file access only for files the user opens or picks |
| (e) Confidentiality | ✅ | No data leaves the computer; PDF password protection uses the standard PDF encryption through `lopdf` |
| (f) Integrity | ✅ | Strict CSP (`script-src 'self'`, `object-src 'none'`), no remote code, checksum check on updates |
| (g) Data minimisation | ✅ | Only local preferences are stored, see [PRIVACY.md](../../.github/PRIVACY.md) |
| (h) Availability | ✅ | Load tests and a performance report on every release; fuzzing for crashes on malformed files |
| (i) No harm to other devices or networks | ✅ | One outbound request (version check to api.github.com) |
| (j) Limited attack surface | ✅ | Locked-down viewer, no network access from documents, no plugins |
| (k) Limit the impact of an incident | ✅ | Memory-safe Rust back end, temporary files deleted at exit |
| (l) Security logging, with opt-out | ⬜ | Not relevant for an offline reader with no account; to justify in the risk assessment if the CRA applies |
| (m) Secure removal of data and settings | ✅ | Uninstalling removes the settings; saved signatures can be deleted in the app |

### Paperwork

| Item | Status |
|---|---|
| Vulnerability-handling policy and support period | ✅ [SECURITY.md](../../.github/SECURITY.md) |
| Technical documentation (Annex VII) | ✅ draft in [technical-documentation.md](technical-documentation.md) |
| EU declaration of conformity (Annex V) | ⬜ template in [eu-declaration-of-conformity.md](eu-declaration-of-conformity.md), not issued |
| CE marking and user information (Annex II) | ⬜ only if the CRA applies |
| ENISA reporting process | ✅ described in [SECURITY.md](../../.github/SECURITY.md), used only if the CRA applies |

## Remaining work

Useful now, whatever happens:

1. **Sign the GitHub builds**: Authenticode for the Windows installer, and Developer ID signing plus notarization for macOS.

Only if EzReader is monetized:

2. Commit to a support period of at least 5 years and show its end date on the Store listing and download page.
3. Complete the technical documentation, sign the EU declaration of conformity, add the CE marking and the Annex II information.
4. Register with the ENISA single reporting platform.
5. Decide on automatic installation of security updates for the GitHub build (with an opt-out).
