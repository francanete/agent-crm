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
- [ ] Create the initial implementation commit (the repository currently has no commits)
- [x] Rename the default branch from `master` to `main`
- [ ] Push the repository and verify the default branch/settings

## P0: package metadata

- [ ] Change `package.json` version from `0.0.0` to `0.1.0`
- [ ] Update the CLI version constant to `0.1.0` from the same authoritative source
- [ ] Remove `private: true` only when publication is intentional
- [ ] Add `repository`, `homepage`, and `bugs` metadata
- [ ] Add useful npm `keywords`
- [ ] Add author/maintainer metadata
- [ ] Confirm `license` is `MIT` and matches `LICENSE`
- [ ] Decide manual npm publication versus trusted publishing/provenance
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
- [ ] Add a clean-tarball installation smoke test to CI
- [ ] Test the packaged `agentcrm --version` and `agentcrm --help`
- [ ] Test init/create/search/context/export/import using only the packaged binary
- [ ] Test skill install, upgrade, conflict protection, and uninstall using only the packaged binary
- [ ] Verify CLI and skill uninstall leave the SQLite database untouched
- [ ] Verify a database created by the pre-release build opens unchanged with the final package

## P0: cross-platform CI

- [x] GitHub Actions matrix is configured for Node 24 on Linux, macOS, and Windows
- [ ] Push and obtain a passing Linux CI run
- [ ] Obtain a passing macOS CI run
- [ ] Obtain a passing Windows CI run
- [ ] Investigate any permission/path/shell differences rather than weakening tests globally
- [ ] Save/link the successful release-candidate workflow run

## Agent acceptance testing

Use a fresh agent session with no repository implementation context and a temporary database.

- [ ] Add `docs/agent-acceptance.md` with prompts, expected behavior, and scoring
- [ ] Test with Pi using the packaged Agent Skill
- [ ] Test with Hermes through Telegram
- [ ] Verify the agent uses JSON as private tool output and never sends raw envelopes to the user
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

- [ ] Add `docs/architecture.md`
- [ ] Add `docs/privacy-security.md`, emphasizing local storage, permissions, subprocess trust, backups, and optional future network adapters
- [ ] Add `CONTRIBUTING.md`
- [ ] Add `SECURITY.md` with a private vulnerability-reporting path
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
- [ ] Document that future remote MCP gateways are opt-in and change the local-only threat model

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
