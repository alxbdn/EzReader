# Roadmap

What EzReader plans for the next twelve months, in rough order. Plans change; the [issues](https://github.com/alxbdn/EzReader/issues) and [pull requests](https://github.com/alxbdn/EzReader/pulls) show what is in progress. What EzReader will not do is just as stable: no account, no telemetry, no AI features, nothing sent off the computer.

## Trust and security

- **Signed Windows downloads**: Authenticode signing of the installer and portable app (SignPath Foundation), so Windows SmartScreen stops warning.
- **Notarized macOS app**, so Gatekeeper opens it without a warning.
- **Saved signatures in the system keychain** (Windows Credential Manager, macOS Keychain, Secret Service) instead of the webview's storage.
- **Reproducible builds**: the same source gives the same bits, checked in CI.
- **OpenSSF Best Practices silver badge**, then a steady OpenSSF Scorecard above 8.

## Quality

- Test coverage above 80 % of statements, measured on every pull request.
- A regression test with every bug fix.

## Features

- A studio panel that gathers tool options and the list of annotations.
- Better PDF form filling: more field types, and validation.
- Faster opening and lower memory on very large PDFs.
- More interface languages, contributed by users.

## Platforms

- Packages for more Linux distributions (Flatpak, then RPM).
- Keep Windows 10 and 11, macOS 11 and later, and current Ubuntu and Debian releases supported.
