# Agent CRM

[![CI](https://github.com/francanete/agent-crm/actions/workflows/ci.yml/badge.svg)](https://github.com/francanete/agent-crm/actions/workflows/ci.yml)

A local-first, schema-aware relationship database for shell-capable AI agents.

Agent CRM gives agents durable contact, organization, interaction, follow-up, custom-object, and relationship memory through a deterministic CLI. SQLite is the system of record: there is no CRM server, account, telemetry, or runtime network dependency.

> **Experimental `0.1.0`:** CLI JSON contracts are tested and versioned, but the CLI, database format, and native export format may evolve before `1.0`. Back up important data before upgrading.

## Why Agent CRM?

General-purpose agent memory is not enough for reliable CRM workflows. Agents need to distinguish a person from an organization, validate dates and enums, avoid duplicate retries, preserve provenance, and query relationships without guessing.

Agent CRM provides:

- one portable local SQLite database;
- built-in people, organizations, interactions, and follow-ups;
- custom objects and typed fields;
- directed semantic relationships;
- schema-aware validation and structured parameterized filters;
- SQLite FTS5 search without embeddings;
- bounded relationship context for meeting preparation;
- immutable mutation history with actor and source provenance;
- idempotent mutations and exact-field upsert;
- reversible archive/restore lifecycle;
- versioned native backup and transactional restore;
- explicitly mapped, atomic CSV import;
- a bundled portable Agent Skill.

## Requirements

- Node.js 24 or newer
- npm

No external database server or SQLite package is required. Agent CRM uses Node.js `node:sqlite`.

## Install

After the public release:

```bash
npm install --global agent-crm
agentcrm --version
```

Set up the platform-default database and selected local agent hosts:

```bash
agentcrm setup
```

Setup is terminal-only and asks before creating the database or writing any Agent Skill. It shows the selected database path, offers detected verified hosts for selection, and gives session/restart guidance afterward. Candidate hosts remain available only through explicit `setup apply --agent <host>` selection. npm installation itself makes no data or host changes.

For deterministic automation or an agent-guided UI, preview first and then apply only explicit actions:

```bash
agentcrm setup plan --json
agentcrm setup apply --initialize --agent pi --yes --json
```

Database selection precedence is `--db`, then `AGENTCRM_DB`, then the platform default. See the [CLI reference](docs/cli-reference.md#database-path-precedence) for paths.

For an isolated trial:

```bash
export AGENTCRM_DB="$(mktemp -d -t agentcrm-trial-XXXXXX)/crm.db"
agentcrm init --json
agentcrm doctor --json
```

## Enable an Agent Skill

`agentcrm setup` is the recommended path. It installs a managed copy only for the hosts you select:

| Host | Skill root | After setup |
| --- | --- | --- |
| Pi | `~/.agents/skills` | Start a fresh Pi session |
| Claude Code | `$CLAUDE_CONFIG_DIR/skills`, or `~/.claude/skills` | Start a fresh Claude Code session |
| Hermes | `~/.hermes/skills` | Restart the gateway or start a fresh session |

The `agentcrm` executable must be visible on the agent or gateway process `PATH`. Setup does not edit `PATH`, shell profiles, or service files, and never restarts a host automatically.

For a custom or future host root, retain the manual installer:

```bash
agentcrm integration install-skill --destination /path/to/skills --json
```

The installer records a managed hash. It upgrades an unmodified managed copy and refuses to overwrite unowned or locally modified instructions unless force is explicit. Skill and npm uninstall never remove CRM data.

Hermes can serve several chat identities under one OS account. Without a future identity-to-profile mapping, every permitted gateway conversation uses the selected single local CRM. Enable it only when that shared database is appropriate.

Pi and Hermes have prior direct-agent acceptance coverage. Claude Code setup support must pass clean-host acceptance before it is described as verified. Any shell-capable agent can use the CLI without automatic Skill discovery.

## Quick start

### Search before creating

```bash
agentcrm search "ana@example.com" --object person --json
```

Create a person only after checking likely matches:

```bash
agentcrm --idempotency-key person-ana-v1 \
  record create person \
  --values '{"name":"Ana","email":"ana@example.com","role":"CTO"}' \
  --json
```

Create an organization and link it:

```bash
agentcrm --idempotency-key organization-acme-v1 \
  record create organization \
  --values '{"name":"Acme","domain":"example.com"}' \
  --json

agentcrm --idempotency-key ana-works-at-acme-v1 \
  relationship add <person-id> works_at <organization-id> \
  --json
```

Retrieve bounded relationship memory:

```bash
agentcrm context <person-id> --json
agentcrm history <person-id> --json
```

### Exact-field upsert

```bash
agentcrm --idempotency-key contact-import-ana-v1 \
  record upsert person \
  --match email=ana@example.com \
  --values '{"name":"Ana","role":"CTO"}' \
  --json
```

Upsert creates on zero active matches and partially updates one active match. It refuses multiple matches and archived matches rather than guessing, restoring, or silently duplicating data.

### Structured queries

```bash
agentcrm record list followup \
  --filter '{"all":[{"field":"status","op":"eq","value":"open"},{"field":"due_at","op":"lte","value":"2026-09-06T23:59:59Z"}]}' \
  --sort due_at:asc \
  --json
```

Filters are a validated JSON AST compiled to parameterized SQL. Agent CRM does not accept arbitrary SQL from callers.

### Custom schema

```bash
agentcrm schema object add subscription \
  --label Subscription \
  --plural-label Subscriptions \
  --title-field name \
  --title-field-label Name \
  --json

agentcrm schema field add subscription plan \
  --label Plan \
  --type enum \
  --options '["free","pro","enterprise"]' \
  --json
```

Field types include text, number, boolean, date, datetime, enum, multi-select, and JSON. Optional formats include email, phone, URL, currency, and percentage.

### Archive and restore

```bash
agentcrm record archive <record-id> --json
agentcrm record restore <record-id> --json
agentcrm relationship archive <relationship-id> --json
agentcrm relationship restore <relationship-id> --json
```

Archive preserves values, relationships, stable IDs, and immutable history. Archived records are hidden from normal list, search, context, and relationship results until restored. Archive is retention, not permanent erasure.

## CSV import

Map headers explicitly and dry-run before applying an import:

```bash
agentcrm csv import ./contacts.csv \
  --object person \
  --map 'Full Name=name' \
  --map 'Email=email' \
  --map 'Role=role' \
  --match email \
  --dry-run \
  --json
```

Apply the validated mapping with a stable retry key:

```bash
agentcrm --idempotency-key contacts-2026-09-v1 \
  csv import ./contacts.csv \
  --object person \
  --map 'Full Name=name' \
  --map 'Email=email' \
  --map 'Role=role' \
  --match email \
  --json
```

CSV import supports RFC-style quotes, escaped quotes, embedded newlines, CRLF, UTF-8 BOM, strict UTF-8, and schema-aware conversion. A real import is atomic: any failed row rolls back the entire file.

See [CSV import](docs/csv-import.md).

## Backup and restore

Create a complete versioned logical backup:

```bash
agentcrm export --output ./backup.json --json
```

Validate and restore into a pristine initialized database:

```bash
agentcrm --db ./restored.db init --json
agentcrm --db ./restored.db import ./backup.json --dry-run --json
agentcrm --db ./restored.db --idempotency-key restore-backup-v1 \
  import ./backup.json --json
```

Native export preserves schema, records, relationships, IDs, timestamps, archived data, and immutable history. `--without-history` creates a smaller export but is not a general redaction tool. Import refuses a target containing user data or logical schema changes and never performs an ambiguous merge.

See [Native import and export](docs/import-export.md).

## Stable JSON output

Agents and scripts should pass `--json` explicitly. Success:

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "database": "/absolute/path/to/crm.db",
    "cliVersion": "0.1.0"
  }
}
```

Failure:

```json
{
  "ok": false,
  "error": {
    "code": "STABLE_ERROR_CODE",
    "message": "Readable explanation",
    "details": {}
  }
}
```

Machine callers should check both the process status and `ok`. The bundled Skill instructs agents to treat JSON as private tool output and present results naturally instead of exposing envelopes to users.

## Safety model

- Every supported mutation is schema-validated and transactional.
- Domain changes, FTS updates, and immutable events commit together.
- Idempotency keys replay only the same normalized request; conflicting reuse fails.
- ID prefixes must be at least eight characters and unambiguous.
- Native import is validated, bounded, pristine-target-only, and transactional.
- CSV dry-run follows the real decision path; real import is all-or-nothing.
- Skill installation protects unowned and locally modified files.
- npm and Skill uninstall never remove CRM data.
- Agent CRM makes no runtime network requests.

The SQLite database and exports are not encrypted by Agent CRM. Agent hosts, model providers, and messaging channels remain part of the privacy boundary. Read [Privacy and security](docs/privacy-security.md) before storing sensitive data.

## Uninstall

Remove managed Skills first:

```bash
agentcrm integration uninstall-skill --json
agentcrm integration uninstall-skill --destination ~/.hermes/skills --json
```

Then remove the package:

```bash
npm uninstall --global agent-crm
```

These commands intentionally preserve the SQLite database. Back up important data and verify the selected database path before manually removing any files.

## Documentation

- [CLI reference](docs/cli-reference.md)
- [Architecture](docs/architecture.md)
- [Privacy and security](docs/privacy-security.md)
- [Native import and export](docs/import-export.md)
- [CSV import](docs/csv-import.md)
- [Agent acceptance checklist](docs/agent-acceptance.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Architecture decisions](docs/decisions/)

## Development

```bash
git clone https://github.com/francanete/agent-crm.git
cd agent-crm
npm ci
npm run check
npm run package:smoke
```

The CI matrix runs Node.js 24 on Linux, macOS, and Windows. See [CONTRIBUTING.md](CONTRIBUTING.md) for project conventions and release-sensitive invariants.

## Roadmap boundaries

Not included in `0.1.0`:

- MCP adapter or server
- A2UI/generative UI renderer
- hosted service or synchronization
- vendor-specific CRM adapters
- embeddings or vector search
- automatic duplicate merge
- graphical viewer

Future MCP and presentation integrations remain optional adapters around the local domain layer. They do not require changing SQLite's role as the authoritative store.

## License

[MIT](LICENSE)
