# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

> **Status:** EzReader has applied to the SignPath Foundation. Until signing is switched on, the Windows files on the releases page are not Authenticode-signed; every release already carries signed [build provenance](../README.md#download-the-files) you can check with `gh attestation verify`.

## What gets signed

Only files built by this repository's [release workflow](workflows/release.yml) on GitHub Actions, from the tagged source code, are signed:

- the Windows installer, `ezreader-<version>-win-x64-setup.exe`;
- the portable Windows app, `ezreader-portable-<version>-win-x64.exe`.

Nothing built on a personal computer is ever signed, and no file that was not built from this repository's source is signed. The Microsoft Store package (`.msix`) is not published on GitHub: it goes to the Store only, and Microsoft signs it when the Store publishes it.

Every signed file carries the product name **EzReader** and the version of the release it belongs to.

## Team and roles

EzReader is maintained by one person, who holds every role:

| Role | Who | Responsibility |
|------|-----|----------------|
| Committers and reviewers | [Alex (@alxbdn)](https://github.com/alxbdn) | Writes changes and reviews every pull request from anyone else, including dependency updates, before it is merged |
| Approvers | [Alex (@alxbdn)](https://github.com/alxbdn) | Approves each signing request by hand in SignPath, release by release |

Everyone with one of these roles uses multi-factor authentication on both GitHub and SignPath. The `main` branch is protected: changes reach it only through pull requests that pass CI.

## Privacy

EzReader's [privacy policy](PRIVACY.md) explains what the app does with your data. In short: it collects and sends no personal data. The only connection it makes on its own is a check, at start-up, of the latest version number on GitHub (api.github.com), covered by [GitHub's privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).

## Reporting a problem

If you think a signed EzReader file is malicious or was not built from this repository, report it privately as described in [SECURITY.md](SECURITY.md). The SignPath Foundation can also be contacted at [signpath.org](https://signpath.org).
