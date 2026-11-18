# Contributing to EzReader

Thanks for your interest! Bug reports, ideas and pull requests are all welcome.

## Report a bug or suggest an idea

Open an [issue](https://github.com/alxbdn/EzReader/issues). For a bug, say which version and operating system you use, what you did, what you expected and what happened. A sample PDF helps a lot.

For a **security problem**, do not open an issue: follow [SECURITY.md](SECURITY.md).

## Set up

You need Rust (stable), Node.js 18 or later, and the platform tools for [Tauri 2](https://tauri.app/start/prerequisites/) (the Visual Studio C++ Build Tools on Windows, Xcode command line tools on macOS, WebKitGTK on Linux).

```bash
npm install
npm run tauri dev
```

The frontend lives in `src/` (TypeScript, no framework) and the backend in `src-tauri/` (Rust).

## Send a pull request

1. Fork the repository and create a branch from `main`.
2. Keep the change focused: one fix or one feature per pull request.
3. **Add tests for new behavior and for every bug fix** (see [Test policy](#test-policy)). Frontend tests sit in `src/__tests__/` (Vitest), Rust tests next to the code.
4. Run the checks that CI runs, and fix every warning:

   ```bash
   npm run build          # type-check and build
   npm test               # frontend tests
   cd src-tauri
   cargo fmt --check      # Rust formatting
   cargo clippy --all-targets -- -D warnings
   cargo test
   ```

5. Sign off every commit (`git commit -s`), see [Developer Certificate of Origin](#developer-certificate-of-origin).
6. Open the pull request with a short description of what changes for the user, and screenshots for anything visible.

CI runs the tests on Windows, the security checks (npm audit, cargo deny, CodeQL, fuzzing) and a load test of the viewer. A pull request is merged once they all pass.

## Test policy

- **New functionality must come with tests** in the automated suites (Vitest, `cargo test`, or the end-to-end and visual tests for what only shows in the real app). A pull request that adds a feature without tests is not merged.
- **Every bug fix must come with a regression test** that fails before the fix and passes after it, unless the bug cannot be reproduced in an automated test (say why in the pull request).
- Coverage is measured on every pull request (the *Coverage* job of the CI workflow): the Rust unit tests, and for the interface the Vitest unit tests merged with the browser flows in `tests/ui/` (`npm run test:ui`). The goal is at least 80 % of statements; a change should not lower it.

## Coding standards

- **Rust**: the [Rust Style Guide](https://doc.rust-lang.org/style-guide/) as applied by `rustfmt` (settings in `src-tauri/rustfmt.toml`), and the [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/) where they apply. Clippy runs with every warning as an error. CI enforces both.
- **TypeScript**: `strict` mode, enforced by `tsc` in CI; follow the style of the surrounding code (two-space indent, double quotes, semicolons).

## Style

- Keep functions small and named after what they do for the user.
- The interface follows a sober, less-is-more design: one accent color, no decoration that does not help the user.
- Interface text exists in 20 languages: add each new string to every language in `src/i18n.ts`.
- No telemetry, no network calls, no AI features: EzReader works entirely offline.

## Developer Certificate of Origin

By signing off a commit (`Signed-off-by: Your Name <email>`, added by `git commit -s`), you certify the [Developer Certificate of Origin 1.1](https://developercertificate.org/): you wrote the change, or have the right to submit it under the project's license.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](../LICENSE).
