# Security policy

## Supported versions

Security fixes go into the latest release. Please update to it before reporting a problem.

| Version | Supported |
|---------|-----------|
| Latest release (1.x) | Yes |
| Older releases | No |

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
- A GitHub security advisory is published with the fixed release, crediting you unless you prefer otherwise.

## How EzReader is checked

Every push, every pull request and every week, GitHub Actions runs:

- **SCA**: `npm audit` for the JavaScript dependencies and `cargo deny` (RustSec advisories, licenses, sources) for the Rust ones;
- **SAST**: CodeQL `security-extended` on the TypeScript, the Rust and the workflows;
- **dynamic testing**: fuzzing with cargo-fuzz (libFuzzer) of the code that opens PDFs and pictures.

Dependabot proposes dependency updates every week, and third-party actions are pinned to a commit.

Each release carries a **security report** (PDF), a **performance report** and the **software bills of materials** (CycloneDX) of its dependencies, in its assets on the [releases page](https://github.com/alxbdn/EzReader/releases).

## Design

EzReader has no server, no account and no telemetry: it never sends your documents anywhere. PDFs open in a locked-down viewer where document scripts never run and the page cannot reach the network. The app only reads and writes the files you open or pick in a dialog. Password protection uses the encryption defined by the PDF standard, through the `lopdf` library: EzReader does not implement its own cryptography.
