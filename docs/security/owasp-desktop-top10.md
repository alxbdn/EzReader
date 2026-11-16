# EzReader and the OWASP Desktop App Security Top 10

Self-assessment against the [OWASP Desktop App Security Top 10](https://owasp.org/www-project-desktop-app-security-top-10/) (2021). OWASP does not certify anything: this file records, risk by risk, how EzReader is exposed and what protects it, with pointers to the code.

*Last reviewed: 16 November 2026, for EzReader 1.0.0.* ✅ covered, 🟡 covered with a residual risk, ➖ not applicable.

| # | Risk | Status |
|---|---|---|
| DA1 | Injections | ✅ |
| DA2 | Broken authentication and session management | ➖ |
| DA3 | Sensitive data exposure | 🟡 |
| DA4 | Improper cryptography usage | ✅ |
| DA5 | Improper authorization | ✅ |
| DA6 | Security misconfiguration | 🟡 |
| DA7 | Insecure communication | ✅ |
| DA8 | Poor code quality | ✅ |
| DA9 | Using components with known vulnerabilities | ✅ |
| DA10 | Insufficient logging and monitoring | ➖ |

## DA1. Injections

EzReader's untrusted input is the documents it opens. Nothing from a document is ever interpreted as code or as a command line.

- **Script in documents**: PDF JavaScript never runs, and pdf.js is loaded with `isEvalSupported: false`, so it never compiles code from a document (`src/pdf-options.ts`, checked by `src/__tests__/pdf-options.test.ts`).
- **HTML injection in the interface**: `innerHTML` is only used with the app's own icons or to clear an element; document text and file names go through `textContent`.
- **Content Security Policy** in `src-tauri/tauri.conf.json`: `script-src 'self'`, `object-src 'none'`, no remote `connect-src`.
- **Links in documents**: `open_url` (`src-tauri/src/commands/shell.rs`) only lets through http(s) addresses with a host and no user name, in their parsed and percent-encoded form, and hands them to the browser through `ShellExecuteW` on Windows (no command line to parse). `file:`, `javascript:`, `ms-settings:` and other schemes are refused, with tests.
- **Commands**: external programs (`lp`, `lpstat`, `xdg-mime`, `curl`, `brew`) are started with `std::process::Command` and separate arguments, never through a shell string.
- **Path traversal**: see DA5.

## DA2. Broken authentication and session management ➖

EzReader has no account, no login, no server and no session. Opening a password-protected PDF uses the PDF standard's own check; the password is not stored.

## DA3. Sensitive data exposure 🟡

- Documents never leave the computer: no telemetry, no upload, no analytics ([PRIVACY.md](../../PRIVACY.md)).
- Temporary working copies live in the system temp folder under `ezreader-…` names and are deleted at exit, or at the next start after a crash (`src-tauri/src/tempfiles.rs`).
- **Redaction** removes the content under the black boxes when the file is saved, instead of just covering it.
- **Residual**: saved signatures (up to three) are kept in the webview's local storage, unencrypted, in the user's profile. Anyone who can read that profile can copy them. Possible improvement: keep them in the system keychain (Windows Credential Manager, macOS Keychain, Secret Service).

## DA4. Improper cryptography usage

- EzReader implements no cryptography of its own.
- Password protection uses AES-256 (PDF 2.0, revision 6) through `lopdf` (`src-tauri/src/commands/security.rs`); RC4 and 40/128-bit modes are not offered.
- Updates are checked against their SHA-256 digest (`src-tauri/src/commands/update.rs`).
- TLS is handled by the system's `curl` and certificate store.

## DA5. Improper authorization

- The webview can only call the commands the app registers, and the Tauri capabilities (`src-tauri/capabilities/default.json`) only allow window commands and a confirmation dialog: no file-system, shell or HTTP plugin is exposed.
- Every file command checks its path against the grants (`src-tauri/src/grants.rs`): only files the user picked (dialogs, drag and drop, command line), files directly inside a folder the user picked, and the app's own temp files. Anything else is refused with `NotAllowed`, so even script running in the webview could not read or write elsewhere.
- Installing an update on Linux asks for the administrator password through `pkexec`; EzReader itself never runs with elevated rights.

## DA6. Security misconfiguration 🟡

- Secure by default: nothing to configure, no open port, no plugin system, no remote content.
- CI actions from third parties are pinned to a commit, and the workflows have no dangerous patterns (OpenSSF Scorecard).
- **Residual**: the Windows installer on GitHub is not Authenticode-signed and the macOS app is only signed ad hoc (not notarized). The Store package is signed by Microsoft. Build provenance (SLSA) lets anyone check where a download comes from.
- **Residual**: some workflows still grant `contents: write` at the top level instead of per job (Scorecard "Token-Permissions").

## DA7. Insecure communication

- One connection on its own: the version check to `api.github.com`.
- `curl` runs with `--proto =https --proto-redir =https`: no plain HTTP, even after a redirect.
- The downloaded installer must match the SHA-256 digest GitHub publishes for it, or it is deleted and not run.
- Documents cannot reach the network (CSP, no remote `connect-src`).

## DA8. Poor code quality

- Back end in Rust (memory-safe; `unsafe` only appears around operating-system API calls: Windows shell and printing, macOS windows, OCR), front end in strict TypeScript.
- `cargo clippy -D warnings`, `tsc --noEmit`, unit tests, end-to-end tests on the real app, visual regression tests and a PDF compatibility corpus on every pull request.
- Fuzzing (cargo-fuzz, libFuzzer) of the code that opens PDFs and pictures, on every push and for 15 minutes every week; hostile-input tests (`src-tauri/src/hostile_input_tests.rs`).
- CodeQL `security-extended` on TypeScript, Rust and the workflows.

## DA9. Using components with known vulnerabilities

- `npm audit` and `cargo deny` (RustSec advisories, licences, sources) on every push, every pull request and every week; a release is not published if they fail.
- Dependabot security and version updates every week.
- CycloneDX SBOMs attached to every release.

## DA10. Insufficient logging and monitoring ➖

EzReader is an offline, single-user tool with no server, no account and no telemetry, so there is no one to monitor events for, and recording what a user does would go against its privacy promise. Errors are shown to the user and written to the console only. Security monitoring happens upstream instead: dependency advisories, CodeQL alerts, secret scanning and private vulnerability reports ([SECURITY.md](../../SECURITY.md)).
