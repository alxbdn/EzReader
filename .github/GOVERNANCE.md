# Governance

EzReader is a small open-source project with one maintainer and one backup maintainer. This file says who decides what, how a change gets in, and how the project carries on if the maintainer can no longer look after it.

## Roles

| Role | Who | Responsibilities |
|------|-----|------------------|
| **Maintainer** | Alexandre Boudon ([@alxbdn](https://github.com/alxbdn)) | Sets the direction and the [roadmap](ROADMAP.md). Reviews and merges pull requests. Triages issues. Publishes releases and the Microsoft Store, Homebrew and Linux packages. Handles vulnerability reports as described in [SECURITY.md](SECURITY.md). Enforces the [code of conduct](CODE_OF_CONDUCT.md). Keeps the documentation current. |
| **Backup maintainer** | Mathieu De Sousa ([@mdesousa-fr](https://github.com/mdesousa-fr)) | Holds admin access to the repository so that the project never depends on one account. Takes over the maintainer's tasks if the maintainer is unavailable (see [Continuity](#continuity)). Does not merge or release while the maintainer is active, unless the maintainer asks. |
| **Contributor** | Anyone | Reports bugs, suggests ideas, and sends pull requests following [CONTRIBUTING.md](CONTRIBUTING.md). |
| **Security reporter** | Anyone | Reports vulnerabilities privately, as described in [SECURITY.md](SECURITY.md), and is credited in the advisory unless they prefer otherwise. |

## How decisions are made

- **Day-to-day changes** (bug fixes, small features, dependency updates) are decided by the maintainer through pull request review. A change is merged once CI passes: tests, Clippy, the security scans and the load test.
- **Larger changes** (new features, a change of file format, a new platform, a new dependency with network or file access) start as an issue so that anyone can comment before the work begins. The maintainer decides, and writes down the reason in the issue.
- **Principles that guide every decision**: EzReader works offline, collects no data, has no AI features and no account, and stays small and fast. A proposal that breaks one of these is declined.
- **Disagreements** are discussed in the issue or pull request. The maintainer has the final say and explains it.

## Releases

The maintainer publishes releases with the *Bump & Release* workflow. A release is only published if the security scans and the install tests pass, and it carries signed build provenance, SBOMs and security and performance reports. See [SECURITY.md](SECURITY.md#how-ezreader-is-checked).

## Continuity

The project must be able to create and close issues, accept changes and publish a release within a week of losing its maintainer. To make that possible:

- The backup maintainer has **admin access to the GitHub repository**, so they can manage issues, merge pull requests, run the release workflow and change settings without any credential from the maintainer.
- Releases are built and published by GitHub Actions from the repository alone: no signing key or build machine lives on the maintainer's computer. Build provenance uses GitHub's keyless signing.
- The accounts that publish outside GitHub (Microsoft Partner Center for the Store, the `alxbdn/homebrew-ezreader` tap) are listed in a private recovery note held by the backup maintainer, with how to transfer them. The GitHub release and the Linux and Windows downloads keep working without them.
- If the maintainer is unreachable for 30 days, or confirms they are stepping down, the backup maintainer becomes the maintainer, updates this file and announces it in a pinned issue.

## Changing this document

Changes to this file go through a pull request like any other change, and are announced in the release notes.
