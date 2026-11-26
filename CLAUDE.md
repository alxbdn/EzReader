# EzReader

## Code style

- Never add comments in code: no line, block or doc comments, in any language (TypeScript, Rust, CSS, HTML, YAML, TOML, shell, PowerShell, Python, NSIS). Name things so the code explains itself, and put explanations in the PR description or in `docs/`.
- Only keep what a tool needs to work: `// @vitest-environment` pragmas, the `/// # Safety` section clippy requires on a public `unsafe fn`, the version label after a pinned action SHA (`@<sha> # v1.2.3`), and shebangs.
