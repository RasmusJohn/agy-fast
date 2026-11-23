# Contributing to `agy-fast`

Thanks for contributing! `agy-fast` uses a protected **`main` + `dev`** branching model so `main` stays releasable and safe for one-command installers (`install.sh` / `install.ps1`) and direct `git clone` users.

## Branching Model

| Branch | Role | Protection |
| :--- | :--- | :--- |
| `main` | Stable released code only (`vX.Y.Z` tags) | Protected: PR + passing Linux/Windows CI & stress benchmark required; no direct push, force-push, or deletion |
| `dev` | Active integration branch for upcoming releases | Protected against deletion & force-push; default target for feature/fix PRs and Dependabot |
| `feat/*`, `fix/*`, `docs/*` | Short-lived topic branches branched from `dev` | Automatically deleted after PR merge |
| `hotfix/*` | Urgent production fixes branched from `main` | PR into `main`, then back-merged into `dev` |

## Submitting a Pull Request

1. Branch off `dev`:
   ```bash
   git checkout dev
   git pull origin dev
   git checkout -b fix/your-topic
   ```
2. Make your edits and rebuild the bundled runtime outputs if you touched `src/`:
   ```bash
   npm run typecheck
   npm run build
   npm test
   ```
   If you also changed `plugin.json`, `mcp_config.json`, `hooks.json`, or `rules/AGENTS.md`, run:
   ```bash
   npm run validate
   ```
3. Open a PR targeting **`dev`**. CI will automatically verify Linux + Windows (`verify (ubuntu-latest)`, `verify (windows-latest)`), `dist/` bundle freshness, and the 11-scenario stress suite (`stress`).

## Release Flow (Maintainers)

1. On `dev`, bump version in `package.json`, `plugin.json`, and `CHANGELOG.md`, run `npm run typecheck && npm run build && npm test && npm run validate && npm run bench:stress`, and commit.
2. Open a Release PR from `dev` → `main` and wait for all required CI checks to pass.
3. Merge to `main`, tag `vX.Y.Z` on the merged `main` commit (tags matching `v*` are protected once pushed), and publish the GitHub Release.
