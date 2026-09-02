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
- [ ] Confirm the npm account has the required 2FA/publication settings
- [ ] Recheck package-name availability immediately before publish
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
- [ ] Test skill install, upgrade, conflict protection, and uninstall using only the packaged binary
- [x] Verify CLI and skill uninstall leave the SQLite database untouched
- [x] Verify a representative database created by initial commit `2630126` opens unchanged after an in-place package upgrade to `0.1.0`
  - Compared complete native exports except `exportedAt`; IDs, schema, values, relationships, archived data, FTS search, and immutable history were preserved

## P0: cross-platform CI

- [x] GitHub Actions matrix is configured for Node 24 on Linux, macOS, and Windows
- [x] Push and obtain a passing Linux CI run
- [x] Obtain a passing macOS CI run
- [x] Obtain a passing Windows CI run ([workflow 33537221278](https://github.com/francanete/agent-crm/actions/runs/33537221278))
- [x] Investigate Windows CI differences: build through npm's cross-platform `pretest` lifecycle instead of spawning a command script, and enforce LF files with `.gitattributes` so Biome sees identical content on every runner
- [ ] Save/link the successful release-candidate workflow run

## Agent acceptance testing

Use a fresh agent session with no repository implementation context and a temporary database.

- [x] Add `docs/agent-acceptance.md` with isolated setup, prompts, expected behavior, inspection, cleanup, evidence, and scoring
- [x] Confirm packaged Skill discovery and a read-only health workflow in Pi
- [x] Confirm packaged Skill discovery and a read-only health workflow in Hermes through Telegram
- [x] Verify both baseline workflows keep JSON private and respond naturally
- [ ] Verify it searches before creating a person or organization
- [ ] Verify it asks natural semantic questions rather than exposing schema/relationship identifiers
- [ ] Verify an explicit relationship such as “a subscription for Pepito” is linked without unnecessary technical confirmation
- [ ] Verify ambiguous identity does not cause a guessed mutation
- [ ] Verify retries use stable idempotency keys and do not duplicate data
- [ ] Verify meeting logging plus follow-up creation
- [ ] Verify context-based meeting preparation
- [ ] Verify custom object and field creation requires appropriate confirmation
- [ ] Verify archive/restore behavior
- [ ] Verify CSV import is dry-run first and mappings are confirmed
- [ ] Inspect resulting records, relationships, FTS results, and event history after each scenario
- [ ] Record harness/version, prompt, outcome, and any failure for reproducibility

Do not claim Codex, Claude Code, or Hermes skill discovery as verified until each corresponding test passes.

## Documentation required for publication

- [x] Add `docs/architecture.md`
- [x] Add `docs/privacy-security.md`, covering local storage, permissions, agent/model trust, backups, retention, and optional future network adapters
- [x] Add `CONTRIBUTING.md`
- [x] Add `SECURITY.md` with a GitHub private vulnerability-reporting path
- [ ] Enable GitHub private vulnerability reporting in repository security settings and verify the form
- [ ] Add `CHANGELOG.md` with the `0.1.0` feature set and experimental compatibility warning
- [ ] Add a concise CLI command reference or ensure every command is discoverable from README/help
- [ ] Document database location precedence (`--db`, `AGENTCRM_DB`, platform default)
- [ ] Document clean install, update, skill install, skill update, and uninstall
- [ ] Document that npm/skill uninstall never removes CRM data
- [x] Document native export/import
- [x] Document CSV import
- [x] Record presentation-adapter/A2UI boundary in ADR 0003
- [ ] Review README claims and remove every unverified compatibility claim
- [ ] Ensure README clearly labels `0.1.0` experimental and the data format subject to pre-1.0 evolution

## Security and privacy review

- [ ] Review all file reads/writes and overwrite protections
- [ ] Reconfirm database and export permissions on POSIX systems
- [ ] Reconfirm parameterized SQL and validated JSON paths/identifiers
- [ ] Reconfirm import size/row limits and transactional rollback
- [ ] Reconfirm archived records cannot be silently reactivated by upsert/CSV
- [ ] Reconfirm skill installation cannot overwrite local modifications without `--force`
- [ ] Search the repository and package tarball for secrets, personal test data, absolute developer paths, and accidental databases
- [ ] Verify no runtime feature requires network access
- [x] Document that future remote MCP gateways are opt-in and change the local-only threat model

## Release candidate procedure

- [ ] Freeze dependencies and run `npm ci` from a clean checkout
- [ ] Run `npm run check`
- [ ] Run `npm run build`
- [ ] Run `npm audit`
- [ ] Create the tarball with `npm pack`
- [ ] Inspect tarball contents with `npm pack --dry-run` or `tar -tf`
- [ ] Install the tarball globally in a clean Node 24 environment
- [ ] Run the packaged end-to-end and agent acceptance smoke tests
- [ ] Confirm all GitHub Actions jobs pass on the exact release commit
- [ ] Review `git diff`, `git status`, package metadata, and changelog
- [ ] Tag the exact commit as `v0.1.0`
- [ ] Publish with the chosen npm publication/provenance process
- [ ] Create a GitHub release from `v0.1.0` with changelog and install instructions

## Post-release verification

- [ ] Install `agent-crm@0.1.0` from npm in a clean environment
- [ ] Verify `agentcrm --version` reports `0.1.0`
- [ ] Install the bundled Agent Skill and start a fresh agent session
- [ ] Run init/create/search/export smoke tests against a temporary database
- [ ] Verify npm package and GitHub release links
- [ ] Verify uninstall preserves the test database
- [ ] Record known issues and open follow-up tickets

## Release gate

Publish only when:

- [ ] Every P0 item is complete
- [ ] Linux, macOS, and Windows CI pass on the release commit
- [ ] Clean packaged installation passes
- [ ] Pi and Hermes/Telegram agent acceptance tests pass
- [ ] Documentation and security review are complete
- [ ] No known issue risks data loss, silent partial mutation, raw tool output exposure, or accidental network access
