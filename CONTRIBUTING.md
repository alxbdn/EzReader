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
3. **Add tests for new behavior and for every bug fix.** Frontend tests sit in `src/__tests__/` (Vitest), Rust tests next to the code or in `src-tauri/tests/`.
4. Run the checks that CI runs, and fix every warning:

   ```bash
   npm run build          # type-check and build
   npm test               # frontend tests
   cd src-tauri
   cargo clippy --all-targets -- -D warnings
   cargo test
   ```

5. Open the pull request with a short description of what changes for the user, and screenshots for anything visible.

CI runs the tests on Windows, the security checks (npm audit, cargo deny, CodeQL, fuzzing) and a load test of the viewer. A pull request is merged once they all pass.

## Style

- TypeScript is checked with `strict` mode; Rust with Clippy.
- The interface follows a sober, less-is-more design: one accent color, no decoration that does not help the user.
- Interface text exists in 20 languages: add each new string to every language in `src/i18n.ts`.
- No telemetry, no network calls, no AI features: EzReader works entirely offline.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
