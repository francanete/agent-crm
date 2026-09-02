# Contributing to Agent CRM

Thank you for helping improve Agent CRM. The project is an experimental local-first CRM for shell-capable AI agents. Contributions should preserve deterministic CLI contracts, local data ownership, and safe agent workflows.

## Before contributing

Please read:

- [Architecture](docs/architecture.md)
- [Privacy and security](docs/privacy-security.md)
- [Native import and export](docs/import-export.md)
- [CSV import](docs/csv-import.md)
- [Architecture decisions](docs/decisions/)

Use GitHub Issues for reproducible bugs and focused feature proposals. Do not open a public issue for an unpatched vulnerability; follow [SECURITY.md](SECURITY.md) instead.

## Requirements

- Node.js 24 or newer
- npm
- Git
- SQLite FTS5 support provided by the Node.js runtime

Agent CRM uses Node.js `node:sqlite`; no external SQLite package or database server is required.

## Development setup

```bash
git clone https://github.com/francanete/agent-crm.git
cd agent-crm
npm ci
npm run check
```

Build and inspect the CLI:

```bash
npm run build
node dist/cli.js --help
node dist/cli.js --version
```

Use an isolated database while developing:

```bash
export AGENTCRM_DB="$(mktemp -d -t agentcrm-dev-XXXXXX)/crm.db"
node dist/cli.js init --json
node dist/cli.js doctor --json
```

Never point development commands or tests at a real CRM database.

## Project layout

```text
src/cli/               CLI commands, options, and output behavior
src/config/            actor and database-path resolution
src/core/              schema-aware domain services
src/db/                SQLite connections, migrations, seed data, transactions
src/integrations/      managed Agent Skill installation
src/output/            stable success/error envelopes
skills/agentcrm/       bundled Agent Skill source
tests/unit/            focused behavior tests
tests/integration/     database/domain integration tests
tests/cli/             compiled CLI and agent-workflow tests
scripts/               release and package qualification scripts
docs/                  architecture, operations, and decisions
```

The npm package currently exposes the CLI, not a supported JavaScript library API.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Bundle the Node.js 24 ESM CLI with tsup |
| `npm run check` | Run Biome, TypeScript, build, and all Vitest tests |
| `npm run format` | Apply Biome formatting |
| `npm run format:check` | Check formatting only |
| `npm run lint` | Run Biome lint rules |
| `npm run typecheck` | Run `tsc --noEmit` |
| `npm test` | Build and run the test suite once |
| `npm run test:watch` | Run Vitest in watch mode |
| `npm run package:smoke` | Pack, install, exercise, uninstall, and reinstall the npm tarball in isolation |
| `npm pack --dry-run` | Inspect files intended for publication |

Run `npm run check` before requesting review. Run the package smoke test when changing package metadata, build output, executable resolution, portability, data locations, or Skill installation.

## Coding style

- Use TypeScript with strict compiler settings.
- Use ESM and explicit `.js` extensions in relative TypeScript imports.
- Use Node.js built-ins with the `node:` prefix.
- Let Biome format code and organize imports.
- Keep functions and modules focused on one domain responsibility.
- Prefer typed domain inputs and stable result objects over loosely shaped data.
- Do not add runtime network calls without an accepted architecture and privacy decision.
- Do not add a dependency when the Node.js standard library provides a clear solution.

Avoid broad formatting or unrelated refactors in a focused pull request.

## Domain and database rules

SQLite is the authoritative store. Supported code must not edit CRM tables outside the database/domain boundaries merely to bypass validation.

### Mutations

A mutation should:

1. Resolve active schema and stable IDs.
2. Canonicalize and validate the request.
3. Check idempotency before changing state.
4. Run domain writes, FTS changes, and event creation in one transaction.
5. Return a stable result suitable for replay.
6. Roll back completely on error.

New retryable mutations must define what constitutes the normalized request and add conflict/replay tests.

### SQL

- Bind user values through SQLite parameters.
- Do not accept arbitrary SQL from CLI callers.
- Validate every dynamic identifier, field, operator, and sort key against internal vocabulary or active schema.
- Add indexes only with a demonstrated query or integrity purpose.
- Keep foreign-key enforcement enabled.

### Migrations

Database migrations are compatibility boundaries.

- Never rewrite a migration that may have been released or used to create a database.
- Increment `CURRENT_DATABASE_VERSION` for a new migration.
- Apply migrations in order and inside an immediate transaction.
- Reject databases newer than the running CLI supports.
- Add upgrade tests using a database produced by the previous version.
- Preserve IDs, values, relationships, timestamps, archived state, and history unless a documented migration explicitly transforms them.

A pull request that changes the database format must explain rollback and backup expectations.

### Events

Supported mutations append immutable events. Do not update or delete history to simplify a feature. If a new event action or subject is needed, update validation, export/import, idempotency replay, and tests together.

Audit history is not a debug log. Avoid adding incidental secrets or large unbounded payloads to event metadata.

### Archive and restore

Prefer archive/restore over deletion. Restoration must validate current schema, endpoint state, active uniqueness, and FTS behavior. Permanent record deletion or history redaction requires a separate audited design.

## Stable CLI behavior

Agents depend on predictable commands and output.

- Machine invocations use `--json` and must emit exactly one JSON value on stdout.
- Successful JSON uses `{ "ok": true, "data": ..., "meta": ... }`.
- Failed JSON uses `{ "ok": false, "error": { "code", "message", "details" } }`.
- Keep error codes stable and actionable.
- Send no progress text, warning, or stack trace to JSON stdout.
- Bound input, output, filters, and pagination where resource usage can grow.
- Put global options before commands in documentation for portable parsing.

Breaking command, envelope, database, native-export, or Skill behavior must be identified explicitly. Before `1.0`, compatibility may evolve, but silent breakage is still unacceptable.

## Adding or changing a CLI command

A command change normally requires:

- typed option/input definitions;
- bounded parsing for caller-provided JSON or files;
- domain-level validation;
- stable success data and error codes;
- transaction and idempotency behavior for mutations;
- immutable event coverage;
- JSON-only CLI integration tests;
- help and documentation updates;
- Agent Skill updates when agent workflow changes.

Do not put conversational policy into the CLI. User-facing agent guidance belongs in the bundled Skill; domain truth and validation belong in core services.

## Search and FTS5

FTS contains derived active-record state. Any feature that changes searchable values or lifecycle state must update FTS in the same transaction. Add tests for normal search and `doctor` consistency. Native import must rebuild FTS rather than trusting external index rows.

Embeddings and network search are outside the `0.1.0` architecture.

## Import and export changes

The native `agentcrm-export` format, mapped CSV, and future vendor adapters are separate contracts.

For native-format changes:

- version the format intentionally;
- maintain strict validation and size limits;
- preserve pristine-target and transactional guarantees;
- test archived state, custom schema, relationships, timestamps, and history;
- document forward/backward compatibility.

For CSV changes:

- keep mappings explicit;
- preserve strict UTF-8 and parser edge cases;
- use the same decision path for dry-run and real import;
- keep real import atomic;
- add row-limit, conversion, rollback, and idempotency tests.

Do not treat CSV as a complete Agent CRM backup.

## Agent Skill changes

Edit the source at:

```text
skills/agentcrm/SKILL.md
```

Do not edit generated or installed copies under a user's home directory as the source of a contribution.

Skill guidance should:

- use `--json` for machine calls;
- keep tool JSON private from users;
- inspect schema before unfamiliar operations;
- search before creating people and organizations;
- avoid guessing facts or identity;
- discuss relationships in real-world language;
- use deterministic internal relationship types without asking users to invent them;
- use idempotency keys for exact retries;
- archive rather than delete.

Update `tests/unit/skill.test.ts` for important wording invariants and run a fresh-agent acceptance scenario when behavior changes. Installation must continue protecting unowned and locally modified Skills.

## Tests

Tests should be deterministic, offline, and isolated.

- Create temporary directories with operating-system APIs.
- Close database connections before cleanup.
- Do not depend on execution order or a developer's home directory.
- Do not use real CRM data, credentials, or network services.
- Cover both successful behavior and stable failure codes.
- Assert rollback and absence of partial state for failing mutations.
- Use the compiled CLI for command-contract tests.
- Keep platform-specific permission assertions conditional and test equivalent Windows behavior where applicable.

The CI matrix runs Node.js 24 on Linux, macOS, and Windows. A fix for one platform must not weaken guarantees on all platforms.

For agent behavior, follow [the agent acceptance checklist](docs/agent-acceptance.md) with fake data and an isolated database.

## Documentation

Update documentation in the same pull request as behavior. Examples must use valid current commands and fake identities/domains. Clearly distinguish implemented behavior from future plans.

Record durable architecture choices as ADRs under `docs/decisions/`. An ADR should describe context, decision, consequences, and relevant compatibility or security trade-offs.

## Pull requests

Keep pull requests small enough to review. Include:

- the problem and intended behavior;
- architecture/security implications;
- compatibility impact;
- tests added or changed;
- commands run and results;
- documentation updates;
- any known limitations or follow-up work.

Suggested checklist:

- [ ] Scope is focused and no unrelated files changed.
- [ ] `npm ci` succeeds from the lockfile.
- [ ] `npm run check` passes.
- [ ] `npm run package:smoke` passes when packaging/integration behavior changed.
- [ ] New mutations are transactional, audited, and idempotent where retryable.
- [ ] JSON output and error codes are tested.
- [ ] Import failure paths prove complete rollback.
- [ ] Documentation and Skill guidance match implementation.
- [ ] No secrets, personal CRM data, database files, or machine-specific paths are included.
- [ ] Security-sensitive changes include a threat-model explanation.

## Reporting bugs

A useful bug report includes:

- Agent CRM and Node.js versions;
- operating system;
- command shape with sensitive values removed;
- stable error code and sanitized JSON details;
- expected and actual behavior;
- whether the issue reproduces with a temporary database;
- minimal schema or import fixture when relevant.

Never attach a real CRM database or unredacted native export to a public issue.

## License

By contributing, you agree that your contribution may be distributed under the repository's [MIT License](LICENSE).
