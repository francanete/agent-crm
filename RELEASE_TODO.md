# Agent CRM 0.1.0 release checklist

Target: experimental public `0.1.0` release of `agent-crm` / `agentcrm`.

Legend: `[x]` verified locally, `[ ]` still required. A checked item may need to be rerun against the final release commit.

## Release scope

- [x] Local SQLite database and migrations
- [x] Schema-aware records and custom objects
- [x] Relationships, context, structured queries, and FTS5 search
- [x] Immutable history, provenance, and idempotency
- [x] Archive/restore lifecycle
- [x] Exact-field upsert
- [x] Native export/import
- [x] Explicitly mapped atomic CSV import
- [x] Bundled Agent Skill with managed install/uninstall
- [x] Freeze the `0.1.0` feature scope; fixes and release work only

Explicitly out of scope for `0.1.0`:

- MCP adapter
- A2UI/generative UI adapter
- hosted service or network synchronization
- vendor-specific CRM adapters
- duplicate merge
- graphical viewer

## P0: repository and naming

- [x] Confirm the public product, package, repository, and executable names: Agent CRM / `agent-crm` / `agentcrm`
- [x] Confirm `agent-crm` currently returns npm registry `404` and appears available (recheck immediately before publishing; availability is not reserved)
- [x] Decide the GitHub owner and repository URL: `https://github.com/francanete/agent-crm`
- [x] Add the Git remote: `git@github.com:francanete/agent-crm.git`
- [x] Review all untracked source files before the initial commit
- [x] Create the initial implementation commit (`2630126`)
- [x] Rename the default branch from `master` to `main`
- [x] Push the repository and set local `main` to track `origin/main`
- [x] Verify the repository is public and GitHub's default branch is `main`

## P0: package metadata

- [x] Change `package.json` version from `0.0.0` to `0.1.0`
- [x] Make `package.json` the authoritative CLI version source and test `agentcrm --version` against it
- [x] Remove `private: true` for the intentional public release
- [x] Add `repository`, `homepage`, and `bugs` metadata
- [x] Add useful npm `keywords`
- [x] Add author metadata
- [x] Confirm `license` is `MIT` and matches `LICENSE`
- [x] Use manual npm publication with 2FA for `0.1.0`; configure trusted publishing/provenance for later releases
- [x] Confirm npm account 2FA is enabled in `auth-and-writes` mode and the account email is verified
- [x] Recheck package-name availability immediately before publish; registry returned `E404` before the successful claim
- [x] Package contents are constrained by the `files` allowlist
- [x] Built CLI has a Node shebang and executable package bin entry
- [x] Runtime requires Node.js 24 or newer

## P0: automated verification

Run every item against the final release candidate commit:

- [x] `npm run check` currently passes
- [x] Biome formatting/linting currently passes
- [x] `tsc --noEmit` currently passes
- [x] 39 unit, integration, and CLI tests currently pass
- [x] `npm run build` currently passes
- [x] `npm pack --dry-run` currently passes
- [x] `npm audit` currently reports zero vulnerabilities
- [x] Add a clean-tarball installation smoke test to CI
- [x] Test the packaged `agentcrm --version` and `agentcrm --help`
- [x] Test init/create/search/context/export/import using only the packaged binary
- [x] Test Skill install, idempotent reinstall, managed upgrade, conflict protection, forced uninstall, and data retention using only the packaged binary
- [x] Verify CLI and skill uninstall leave the SQLite database untouched
- [x] Verify a representative database created by initial commit `2630126` opens unchanged after an in-place package upgrade to `0.1.0`
  - Compared complete native exports except `exportedAt`; IDs, schema, values, relationships, archived data, FTS search, and immutable history were preserved

## P0: cross-platform CI

- [x] GitHub Actions matrix is configured for Node 24 on Linux, macOS, and Windows
- [x] Push and obtain a passing Linux CI run
- [x] Obtain a passing macOS CI run
- [x] Obtain a passing Windows CI run ([workflow 33537221278](https://github.com/francanete/agent-crm/actions/runs/33537221278))
- [x] Investigate Windows CI differences: build through npm's cross-platform `pretest` lifecycle instead of spawning a command script, and enforce LF files with `.gitattributes` so Biome sees identical content on every runner
- [x] Save the successful security-hardened release-candidate run: [workflow 33617921093](https://github.com/francanete/agent-crm/actions/runs/33617921093) (`1c17924`, Linux/macOS/Windows)

## Agent acceptance testing

Use a fresh agent session with no repository implementation context and a temporary database.

- [x] Add `docs/agent-acceptance.md` with isolated setup, prompts, expected behavior, inspection, cleanup, evidence, and scoring
- [x] Confirm packaged Skill discovery and a read-only health workflow in Pi
- [x] Confirm packaged Skill discovery and a read-only health workflow in Hermes through Telegram
- [x] Verify both baseline workflows keep JSON private and respond naturally
- [x] Verify it searches before creating a person or organization
- [x] Verify it asks natural semantic questions rather than exposing schema/relationship identifiers
- [x] Verify an explicit relationship such as “a subscription for Pepito” is linked without unnecessary technical confirmation
- [x] Verify ambiguous identity does not cause a guessed mutation
- [x] Verify retries use stable idempotency keys and do not duplicate data
- [x] Verify meeting logging plus follow-up creation
- [x] Verify context-based meeting preparation
- [x] Verify custom object and field creation requires appropriate confirmation
- [x] Verify archive/restore behavior
- [x] Verify CSV import is dry-run first and mappings are confirmed
- [x] Inspect resulting records, relationships, FTS results, and event history after each scenario
- [x] Record harness/version, prompt, outcome, and any failure for reproducibility
  - 2026-09-02, packaged `agent-crm@0.1.0` from release candidate `1c17924`, Node `26.7.0`
  - Pi `0.84.4`, OpenAI Codex `gpt-5.6-terra` with one auto-routed `gpt-5.6-luna/high` turn: A2–A8 and final export/inspection passed; no observations or failures
  - Hermes Agent `0.20.6` (`e60983a6`), Telegram terminal enabled, OpenAI Codex `gpt-5.6-terra`: prior create/link plus targeted duplicate, ambiguity/clarified update, and CSV dry-run checks passed; no observations or failures
  - Exact prompts and inspection criteria are recorded in `docs/agent-acceptance.md`; temporary test exports were retained outside the repository

Do not claim Codex, Claude Code, or Hermes skill discovery as verified until each corresponding test passes.

## Documentation required for publication

- [x] Add `docs/architecture.md`
- [x] Add `docs/privacy-security.md`, covering local storage, permissions, agent/model trust, backups, retention, and optional future network adapters
- [x] Add `CONTRIBUTING.md`
- [x] Add `SECURITY.md` with a GitHub private vulnerability-reporting path
- [x] Enable GitHub private vulnerability reporting in repository security settings and verify the form
- [x] Skip a standalone changelog for the initial `0.1.0`; use GitHub release notes
- [x] Add `docs/cli-reference.md` covering every public command, option, output contract, and exit-status group
- [x] Document database location precedence (`--db`, `AGENTCRM_DB`, platform default)
- [x] Document clean install, update, Skill install/refresh, and uninstall
- [x] Document that npm/Skill uninstall never removes CRM data
- [x] Document native export/import
- [x] Document CSV import
- [x] Record presentation-adapter/A2UI boundary in ADR 0003
- [x] Review README claims and distinguish verified Pi/Hermes workflows from unverified host compatibility
- [x] Ensure README clearly labels `0.1.0` experimental and the CLI, database, and native export formats subject to pre-1.0 evolution

## Security and privacy review

- [x] Review all file reads/writes and overwrite protections; harden Skill uninstall and forced-export replacement
- [x] Reconfirm database, WAL, SHM, and export permissions on POSIX systems, including under `umask 000`
- [x] Reconfirm parameterized SQL and validated JSON paths/identifiers; require UUIDs in native imports
- [x] Reconfirm import size/row limits and transactional rollback; bound descriptor/stdin reads to limit plus one byte
- [x] Reconfirm archived records cannot be silently reactivated by upsert/CSV
- [x] Reconfirm Skill installation cannot overwrite local modifications without `--force` and uninstall cannot follow a symlinked Skill directory
- [x] Search the repository and packed tarball for secrets, personal test data, absolute developer paths, and accidental databases
- [x] Verify runtime source contains no network APIs or network-dependent feature
- [x] Document that future remote MCP gateways are opt-in and change the local-only threat model

## Release candidate procedure

- [x] Freeze dependencies and run `npm ci` from a clean checkout
- [x] Run `npm run check`
- [x] Run `npm run build`
- [x] Run `npm audit`
- [x] Create the tarball with `npm pack`
- [x] Inspect tarball contents with `npm pack --dry-run` and the packed-archive secret/path scan
- [x] Install the tarball in isolated Node environments through the package smoke test
- [x] Run the packaged end-to-end and direct-agent acceptance tests
- [x] Confirm all GitHub Actions jobs pass on exact release commit `ec398da`: [workflow 33634386598](https://github.com/francanete/agent-crm/actions/runs/33634386598)
- [x] Review `git diff`, `git status`, package metadata, and GitHub-release-notes changelog plan
- [x] Tag exact commit `ec398da` as `v0.1.0` and push the annotated tag
- [x] Publish `agent-crm@0.1.0` manually to npm with account 2FA; do not claim provenance for this release
- [x] Create [GitHub release `v0.1.0`](https://github.com/francanete/agent-crm/releases/tag/v0.1.0) with changelog and install instructions

## Post-release verification

- [x] Install `agent-crm@0.1.0` from npm in an isolated clean prefix
- [x] Verify `agentcrm --version` reports `0.1.0`
- [x] Refresh bundled Pi and Hermes Skills from the published package; the published checksum matches the package used in fresh-session acceptance tests
- [x] Run init/create/search/export/doctor smoke tests against a temporary database
- [x] Verify [npm package](https://www.npmjs.com/package/agent-crm/v/0.1.0) and [GitHub release](https://github.com/francanete/agent-crm/releases/tag/v0.1.0) links
- [x] Verify npm and Skill uninstall preserve the test database, then reinstall and pass `doctor`
- [x] Record no known release-blocking issues; no follow-up ticket is required at publication

## Release gate

Publish only when:

- [x] Every P0 item is complete
- [x] Linux, macOS, and Windows CI pass on release commit `ec398da`
- [x] Clean packaged installation passes
- [x] Pi and Hermes/Telegram agent acceptance tests pass
- [x] Documentation and security review are complete
- [x] No known issue risks data loss, silent partial mutation, raw tool output exposure, or accidental network access
