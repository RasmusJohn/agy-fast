# Security Policy

## Supported Versions

Security fixes are applied to the latest release and the `main` branch:

| Version | Supported |
| :--- | :---: |
| `main` / latest `0.2.x` | :white_check_mark: |
| `< 0.2.0` | :x: |

## Security Model

`agy-fast` is designed to be auditable and minimally privileged:

- **Zero runtime dependencies** — pre-built, unminified single-file ESM bundles in `dist/`.
- **100% local execution** — the MCP server runs over local Stdio (`node dist/mcp-server.mjs`) and never sends source code, transcripts, or prompts to any third-party endpoint.
- **Read-only Git allowlist** — `batch_search` strictly restricts `git` queries to an allowlist of read-only subcommands and blocks flag injection (`-c`, `--git-dir`, `--ext-diff`, etc.).
- **Policy-compliant** — does not intercept, bypass, or modify Antigravity's native permissions, checkpoints, or safety gates.
- **Optional auto-updater** — checks GitHub Releases over HTTPS only (strictly `github.com` / `api.github.com` / `objects.githubusercontent.com`), stages updates in an isolated temp directory, runs an MCP smoke test before atomic swap, and can be disabled with `AGY_FAST_AUTO_UPDATE=0`.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for suspected security vulnerabilities.

Instead, report vulnerabilities privately via **GitHub Security Advisories**:

- https://github.com/INK-Q/agy-fast/security/advisories/new

Include reproduction steps, affected file paths or commit SHA, and potential impact. You can expect an initial acknowledgment within 72 hours and a coordinated disclosure once a fix is verified and released.
