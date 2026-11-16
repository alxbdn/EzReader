# Security policy

## Supported versions

Security fixes go into the latest release. Please update to it before reporting a problem.

| Version | Supported |
|---------|-----------|
| Latest release (1.x) | Yes |
| Older releases | No |

**Support period.** Security updates are free, for every version, on every channel. A major version (1.x today) receives them for as long as it is the current one, and for at least 12 months after the next major version comes out. Every update within a major version is a drop-in replacement, so staying on the latest release keeps you supported. The end date of a major version's support is announced here and on the releases page at least 6 months in advance.

**How updates reach you.** The Microsoft Store updates EzReader for you; Homebrew does with `brew upgrade --cask ezreader`. The GitHub build checks for a new version at start-up and installs it in one click, after checking the downloaded file against the SHA-256 digest GitHub publishes for it.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub instead: **[Report a vulnerability](https://github.com/alxbdn/EzReader/security/advisories/new)** (Security tab, then *Report a vulnerability*). Only the maintainer sees it.

Include what you can:

- the EzReader version and your operating system;
- the steps or the file that triggers the problem (a malformed PDF or picture is very welcome);
- what an attacker could do with it.

## What happens next

- You get an answer within **7 days**, usually much sooner.
- Once the problem is confirmed, a fix is released within **60 days**, and as soon as possible for a serious one.
- A GitHub security advisory is published with the fixed release, with a CVE identifier when it applies, crediting you unless you prefer otherwise. It says what was affected, which version fixes it and what to do.
- Details stay private until the fix is out, or until 90 days have passed, whichever comes first. If a problem lies in a dependency, it is also reported to that project.

## Actively exploited vulnerabilities

A vulnerability that is being exploited in the wild is handled first: the fix ships as soon as it is ready, and the advisory says so. EzReader is free, non-commercial open-source software and is currently outside the scope of the EU Cyber Resilience Act. If that changes, such vulnerabilities and severe incidents will also be reported to ENISA through its single reporting platform within the CRA's deadlines (24 hours for an early warning, 72 hours for a notification, 14 days after the fix for a final report). See [docs/cra](docs/cra/README.md).

## How EzReader is checked

Every push, every pull request and every week, GitHub Actions runs:

- **SCA**: `npm audit` for the JavaScript dependencies and `cargo deny` (RustSec advisories, licenses, sources) for the Rust ones;
- **SAST**: CodeQL `security-extended` on the TypeScript, the Rust and the workflows;
- **dynamic testing**: fuzzing with cargo-fuzz (libFuzzer) of the code that opens PDFs and pictures.

Dependabot proposes dependency updates every week, and third-party actions are pinned to a commit.

A release is only published if all these scans pass. Each release carries a **security report** (PDF), a **performance report** and the **software bills of materials** (CycloneDX) of its dependencies, together in `ezreader-reports.zip` ([latest](https://github.com/alxbdn/EzReader/releases/latest/download/ezreader-reports.zip)), and signed **build provenance** (SLSA, check it with `gh attestation verify <file> --repo alxbdn/EzReader`), in its assets on the [releases page](https://github.com/alxbdn/EzReader/releases).

## Design

EzReader has no server, no account and no telemetry: it never sends your documents anywhere. PDFs open in a locked-down viewer where document scripts never run and the page cannot reach the network. The app only reads and writes the files you open or pick in a dialog. Password protection uses the encryption defined by the PDF standard, through the `lopdf` library: EzReader does not implement its own cryptography.
