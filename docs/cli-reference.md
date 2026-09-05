# CLI reference

This document describes the public `agentcrm` command-line interface for `0.1.0`. Run `agentcrm <command> --help` for the authoritative short-form syntax installed with your version.

## Installation

Agent CRM requires Node.js 24 or newer.

After publication:

```bash
npm install --global agent-crm
agentcrm --version
```

For release-candidate testing from a local tarball:

```bash
npm pack
npm install --global ./agent-crm-0.1.0.tgz
```

Update the CLI, then refresh each managed Skill installation so its instructions match:

```bash
npm install --global agent-crm@latest
agentcrm integration install-skill --json
agentcrm integration install-skill --destination ~/.hermes/skills --json
agentcrm doctor --json
```

Uninstalling the package and Skills does not remove CRM data:

```bash
agentcrm integration uninstall-skill --json
agentcrm integration uninstall-skill --destination ~/.hermes/skills --json
npm uninstall --global agent-crm
```

Back up important data before upgrades and verify the selected database path before uninstalling anything manually.

## Command shape

```text
agentcrm [global-options] <command> [command-options]
```

Put database, provenance, actor, and idempotency global options before the command. The examples often leave `--json` at the end for readability; Agent CRM accepts it there as an inherited output option:

```bash
agentcrm --db ./crm.db --idempotency-key contact-ana-v1 \
  record create person --values '{"name":"Ana"}' --json
```

## Global options

| Option | Description |
| --- | --- |
| `-V`, `--version` | Print the package version and exit |
| `--db <path>` | Override the database path |
| `--json` | Emit the stable machine JSON envelope |
| `--text` | Emit indented result data without the success envelope |
| `--actor <name>` | Override the actor stored in mutation history |
| `--source <description>` | Attach provenance to a mutation |
| `--idempotency-key <key>` | Make a mutation safely retryable |
| `--quiet` | Suppress successful result output |
| `-h`, `--help` | Display help |

`--json` and `--text` are mutually exclusive. When neither is given, output uses `--text` behavior on an interactive terminal and `--json` behavior when stdout is redirected or piped. Agents and scripts should always pass `--json` explicitly.

`--quiet` suppresses successful output, not errors. It should not be combined with workflows that need returned IDs.

### Database path precedence

Agent CRM selects the first available value:

1. `--db <path>`
2. `AGENTCRM_DB`
3. Platform default

| Platform | Default database |
| --- | --- |
| Linux/XDG | `$XDG_DATA_HOME/agentcrm/crm.db`, or `~/.local/share/agentcrm/crm.db` |
| macOS | `~/Library/Application Support/agentcrm/crm.db` |
| Windows | `%LOCALAPPDATA%\agentcrm\crm.db` |

`~` is expanded in an explicit path. Relative paths are resolved from the current working directory.

### Actor resolution

Mutation actor precedence is:

1. `--actor`
2. `AGENTCRM_ACTOR`
3. `AI_AGENT`
4. `pi` when `PI_CODING_AGENT=true`
5. `human-cli`

`--source` is optional free-form provenance, such as `telegram` or `csv:contacts-2026-09`.

## Output contracts

### JSON success

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

Commands that do not use a database, such as Skill installation, omit `meta.database`.

### JSON failure

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Readable explanation",
    "details": {}
  }
}
```

In JSON mode, success and failure each produce exactly one JSON value on stdout. Check both the process exit status and `ok`.

### Exit statuses

| Status | Meaning |
| --- | --- |
| `0` | Success or help/version output |
| `2` | Invalid arguments, values, filters, CSV, or native import document |
| `3` | Database not initialized or requested object/field/record/relationship/event not found |
| `4` | Ambiguous ID prefix |
| `5` | Current-state conflict, archived resource, duplicate, idempotency conflict, or protected overwrite |
| `6` | Invalid/database/integration I/O failure |
| `7` | Unsupported database version or schema conflict |
| `10` | Unexpected internal error |

Use the stable JSON `error.code` for program logic; the table groups multiple codes under shared process statuses.

## IDs

Records, relationships, events, objects, and fields use stable UUIDs internally. Commands accepting an ID may use a hexadecimal UUID prefix when it is:

- at least eight characters;
- syntactically valid;
- unambiguous for the requested resource.

Ambiguous prefixes fail with `AMBIGUOUS_ID`. Scripts should retain and reuse complete IDs returned by the CLI.

## Initialization and diagnostics

### `version`

```bash
agentcrm version --json
agentcrm --version
```

`version --json` uses the normal JSON envelope. `--version` prints only the version.

### `init`

Initialize a new database or apply supported migrations:

```bash
agentcrm --db ./crm.db init --json
```

A new database receives the default `person`, `organization`, `interaction`, and `followup` objects. Repeating `init` is safe. Agent CRM refuses to adopt an arbitrary or newer incompatible SQLite file.

### `doctor`

Inspect health through a read-only connection:

```bash
agentcrm --db ./crm.db doctor --json
```

Checks include database version, POSIX permissions, foreign-key integrity, FTS5 consistency, and default schema availability. `healthy` is false when a required integrity check fails; warnings remain visible in `checks`.

## Setup

### `setup`

Run guided setup in a trusted local terminal:

```bash
agentcrm setup
```

The command is intentionally interactive only when stdin, stdout, and stderr are terminals. It shows the selected database path and local-data notice, asks before creating an absent database, presents detected verified hosts, allows a comma-separated subset such as `pi, hermes` (or `none`), then shows a final summary and asks again before writing. Candidate hosts require explicit `setup apply --agent <host>` selection.

It does not run from an ordinary agent chat, JSON mode, a pipe, or CI command; those uses fail with `SETUP_INTERACTIVE_TTY_REQUIRED`. Use plan/apply instead. It does not change shell/service configuration, restart hosts, or install every cataloged host by default.

### `setup plan`

Inspect database and host setup:

```bash
agentcrm --db ./crm.db setup plan --json
```

The plan reports database state, selection source, local privacy notice, host detection evidence, host Skill state, destination groups, and restart guidance. It creates neither the selected database nor a Skill directory. Existing databases without active journal sidecars are inspected in immutable read-only mode so sidecar files are not created during planning. A regular rollback journal with a zeroed header, as left by a successful PERSIST-mode commit, is safe to inspect. If a `-wal` sidecar is nonempty, a `-journal` sidecar has a hot-journal header, or either sidecar is not a regular file, the plan reports `wal-present` or `journal-present` with a recovery hint instead of reading potentially stale metadata; interactive setup and apply refuse to proceed. Close applications using the database and let SQLite checkpoint or recover it before retrying. After an unclean shutdown, SQLite may need to reopen and cleanly close the database to recover it first. Never delete WAL or rollback-journal files manually: they may be needed for recovery. Setup performs no checkpoint or recovery itself. Inspection is a point-in-time preflight, not protection against another process changing the database concurrently. Host and destination-group `destinationKey` values use the same canonical-path rule.

### `setup apply`

Use a deterministic, non-prompting operation only after a local administrator has reviewed the plan and consented:

```bash
agentcrm --db ./crm.db setup apply \
  --initialize \
  --agent pi \
  --agent claude-code \
  --yes \
  --json
```

Options:

| Option | Meaning |
| --- | --- |
| `--initialize` | Create an absent database or apply supported migrations to the selected database |
| `--agent <pi|claude-code|hermes>` | Install the bundled Skill for an explicit host; repeat for several hosts |
| `--all-detected` | Select detected verified hosts only; never selects a cataloged but undetected host |
| `--no-skill` | Initialize the database without installing any Skill |
| `--force-skill` | Replace a selected modified Skill after explicit review; does not bypass symlink safety |
| `--yes` | Confirm only the actions supplied on this command; it does not select hosts implicitly |

An absent database requires both `--initialize` and `--yes`. Repeating initialization reports `unchanged` when no database creation, migration, or seeding was needed. Apply rejects unsafe database targets, unsafe Skill paths, and unowned or locally modified Skills unless `--force-skill` is explicit. Symlinked path components, including destination ancestors and managed manifests, are rejected even with force. The only symlink exceptions are macOS's standard `/tmp`, `/var`, and `/etc` aliases to their corresponding `/private/...` directories. Use a canonical path instead of a user-created symlink. These checks do not protect against concurrent path replacement by another process with write access. Separate Skill roots are applied independently; an error after one success reports `SETUP_PARTIAL_FAILURE` with completed and failed destinations, and retrying is safe.

Known setup destinations are Pi at `~/.agents/skills`, Claude Code at `$CLAUDE_CONFIG_DIR/skills` or `~/.claude/skills`, and Hermes at `~/.hermes/skills`. Pi and Claude Code require fresh sessions; Hermes needs a fresh session or gateway restart. Setup only reports this guidance and never restarts a process.

## Schema commands

### `schema show`

Show every object or one object and its field definitions:

```bash
agentcrm schema show --json
agentcrm schema show person --json
```

Agents should inspect schema before using unfamiliar fields.

### `schema object add`

```bash
agentcrm --idempotency-key schema-subscription-v1 \
  schema object add subscription \
  --label Subscription \
  --plural-label Subscriptions \
  --description "A customer's subscription" \
  --title-field name \
  --title-field-label Name \
  --json
```

Required arguments/options:

```text
schema object add <key>
  --label <label>
  --plural-label <label>
  --title-field <key>
  --title-field-label <label>
```

`--description` is optional. The command creates the object and its required text title field atomically.

### `schema object archive|restore`

```bash
agentcrm schema object archive subscription --json
agentcrm schema object restore subscription --json
```

An object can be archived only when it contains no active or archived records. Restore applies to an archived empty object.

### `schema field add`

```bash
agentcrm schema field add person priority \
  --label Priority \
  --type enum \
  --options '["high","normal","low"]' \
  --default '"normal"' \
  --json
```

Syntax:

```text
schema field add <object> <key>
  --label <label>
  --type <type>
  [--description <description>]
  [--format <format>]
  [--required]
  [--options <json-array>]
  [--default <json-value>]
```

Field types:

```text
text  number  boolean  date  datetime  enum  multi_select  json
```

Optional formats:

```text
email  phone  url  currency  percentage
```

`enum` and constrained `multi_select` fields use `--options`. `--default` is parsed as JSON, so a text default requires JSON quotes, as in `'"normal"'`.

### `schema field archive|restore`

```bash
agentcrm schema field archive person priority --json
agentcrm schema field restore person priority --json
```

A title field cannot be archived. Archiving preserves stored legacy values and rebuilds affected FTS entries. Restore validates active records before making the field active again.

## Record commands

### Value input

`record create`, `record update`, and `record upsert` require exactly one value-input mode:

```text
--values <json-object>
--values-file <path-or-->
one or more --set <field=value>
```

Examples:

```bash
agentcrm record create person \
  --values '{"name":"Ana","email":"ana@example.com"}' --json

printf '%s' '{"name":"Ana","notes":"Private notes"}' | \
  agentcrm record create person --values-file - --json

agentcrm record update <record-id> \
  --set role=CTO --set notes="Met at conference" --json
```

`--values` and `--values-file` support typed JSON. `--set` supplies text values and is best suited to text fields. Record/filter JSON input is bounded; record input has a 1 MiB limit.

### `record create`

```bash
agentcrm --idempotency-key person-ana-v1 \
  record create person \
  --values '{"name":"Ana","email":"ana@example.com"}' --json
```

The object and fields must be active. Values are normalized and validated against current schema. The title field determines `displayName`.

Agents should search before creating a person or organization; idempotency protects exact retries but is not identity matching.

### `record get`

```bash
agentcrm record get <record-id-or-prefix> --json
```

Returns the record including values, schema version, timestamps, and archive state. A directly requested archived record can be retrieved; normal list/search/context operations hide archived records unless their command explicitly supports inclusion.

### `record update`

```bash
agentcrm --idempotency-key person-ana-role-v1 \
  record update <record-id> --values '{"role":"CTO"}' --json
```

Update is partial: omitted fields retain their current values. The final record must satisfy active schema. Archived records cannot be updated.

### `record upsert`

```bash
agentcrm --idempotency-key import-ana-v1 \
  record upsert person \
  --match email=ana@example.com \
  --values '{"name":"Ana","role":"CTO"}' --json
```

Behavior:

- zero active exact matches: create;
- one active exact match: partially update;
- multiple active exact matches: `MULTIPLE_UPSERT_MATCHES`;
- archived exact match: `RECORD_ARCHIVED`.

The match field must be a supported active scalar field. Blank values, JSON fields, and multi-select fields cannot be used for matching. If the values object includes the match field, it must agree with `--match`.

The result includes `outcome: "created"` or `"updated"` and `replayed`.

### `record list`

```bash
agentcrm record list person \
  --sort display_name:asc \
  --limit 50 \
  --offset 0 \
  --json
```

Options:

| Option | Default | Constraint |
| --- | --- | --- |
| `--filter <json>` | none | Typed filter AST |
| `--filter-file <path-or-->` | none | Alternative to `--filter`; 256 KiB limit |
| `--sort <field:asc\|desc>` | `updated_at:desc`, then ID | Active scalar or built-in field |
| `--limit <number>` | `50` | 1–500 |
| `--offset <number>` | `0` | 0–1,000,000 |
| `--include-archived` | false | Include active and archived records |

Built-in sort fields are `created_at`, `updated_at`, and `display_name`. JSON and multi-select fields cannot be sorted.

The result includes `pagination.count` and `pagination.hasMore`. Use the next offset rather than assuming all matches were returned.

#### Filter AST

A predicate has exactly `field`, `op`, and `value`:

```json
{"field":"status","op":"eq","value":"open"}
```

Combine predicates with one non-empty `all` or `any` group:

```json
{
  "all": [
    {"field":"status","op":"eq","value":"open"},
    {"field":"due_at","op":"lte","value":"2026-09-06T23:59:59Z"}
  ]
}
```

Operators:

| Field type | Operators |
| --- | --- |
| `text` | `eq`, `neq`, `contains`, `starts_with`, `in`, `exists` |
| `number`, `date`, `datetime` | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `exists` |
| `boolean`, `enum` | `eq`, `neq`, `in`, `exists` |
| `multi_select` | `contains`, `exists` |
| `json` | `exists` |

`exists` requires a boolean value. `in` requires 1–100 values. Filters support at most 25 predicates and nesting depth 5.

### `record archive|restore`

```bash
agentcrm record archive <record-id> --json
agentcrm record restore <record-id> --json
```

Archive retains values, IDs, relationships, and history but removes the record from normal list, search, relationships, and context visibility. Restore validates the record against current active schema and rebuilds FTS.

## Relationship commands

Relationships are directed. Choose source and target according to the meaning of the internal type:

```bash
agentcrm relationship add <person-id> works_at <organization-id> --json
```

A relationship type must start with a lowercase letter and contain only lowercase letters, numbers, and underscores. Self-links and duplicate active source/target/type edges are rejected. Both endpoints must be active.

### `relationship list`

```bash
agentcrm relationship list <record-id> --json
agentcrm relationship list <record-id> --include-archived --json
```

Results include incoming/outgoing direction and summaries of both endpoints. Normal output excludes archived links and archived endpoints.

### `relationship archive|restore`

```bash
agentcrm relationship archive <relationship-id> --json
agentcrm relationship restore <relationship-id> --json
```

Restore requires active endpoints and fails if it would duplicate an active relationship.

## Search

```bash
agentcrm search "pricing proposal" --object person --limit 20 --offset 0 --json
```

`--object` is optional. Limit is 1–500; offset is 0–1,000,000. Search requires 1–20 whitespace-separated terms and returns active records only, ordered by FTS5 rank. Results include a bounded preview of active searchable values.

Search treats terms as literal quoted FTS terms rather than accepting arbitrary caller-provided FTS syntax.

## History

### Subject history

```bash
agentcrm history <record-id-or-prefix> --limit 50 --json
```

Limit is 1–500. Events are returned newest first with audit summaries.

### Full event

```bash
agentcrm history event <event-id-or-prefix> --json
```

Returns one immutable event, including before/after data and metadata. Event history may contain sensitive historical values, working directory, actor/source, idempotency key, and a Pi session ID when supplied by the host.

Events cannot be updated or deleted through supported commands.

## Context

```bash
agentcrm context <record-id> \
  --max-related 20 \
  --max-interactions 20 \
  --max-followups 20 \
  --max-chars 12000 \
  --json
```

Options:

| Option | Default | Range |
| --- | --- | --- |
| `--max-related` | 20 | 0–500 |
| `--max-interactions` | 20 | 0–500 |
| `--max-followups` | 20 | 0–500 |
| `--max-chars` | 12,000 | 1,000–1,000,000 |

Context is bounded relationship memory for one active record. It excludes archived records and reports truncation when the approximate character budget is reached.

## Native export and import

Native backup is distinct from CSV.

### `export`

```bash
agentcrm export --output ./backup.json --json
agentcrm export --output ./backup-without-history.json --without-history --json
```

`--output` is required. Export refuses to overwrite an existing path unless `--force` is explicit:

```bash
agentcrm export --output ./backup.json --force --json
```

The output cannot be the selected database file. Native JSON preserves schema, IDs, values, relationships, timestamps, archived data, and history unless omitted. Export files use mode `0600` on POSIX systems.

### `import`

Initialize a new target, validate, then restore:

```bash
agentcrm --db ./restored.db init --json
agentcrm --db ./restored.db import ./backup.json --dry-run --json
agentcrm --db ./restored.db --idempotency-key restore-backup-v1 \
  import ./backup.json --json
```

The input must be a regular file in the versioned `agentcrm-export` format and cannot exceed 100 MiB. The target must be initialized and pristine. Import never merges with a working CRM.

Real import is transactional, preserves IDs/timestamps/history, and rebuilds FTS. Dry-run validates without mutation.

See [Native import and export](import-export.md).

## CSV import

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

Syntax:

```text
csv import <input-file-or-->
  --object <object-key>
  --map <CSV Header=field> [--map ...]
  [--match <field>]
  [--multi-value-separator <separator>]
  [--dry-run]
```

Mappings are explicit and repeatable. Every mapped header and field must exist exactly once. Unmapped CSV columns are ignored; duplicate headers are rejected.

`--match` names a mapped supported scalar field used for exact upsert. Without it, rows create records. The default multi-select separator is `;`.

Use `-` to read CSV from stdin:

```bash
cat contacts.csv | agentcrm csv import - \
  --object person --map 'Name=name' --map 'Email=email' \
  --match email --dry-run --json
```

CSV limits are 25 MiB and 100,000 data rows. Dry-run performs real validation and decisions but rolls back. A real import is atomic: any failed row rolls back the complete import. Summaries include created, updated, skipped, failed, and replayed counts.

See [CSV import](csv-import.md).

## Agent Skill integration

### Install

Default portable Skill root:

```bash
agentcrm integration install-skill --json
```

This installs:

```text
~/.agents/skills/agentcrm/SKILL.md
```

Select a host-specific root explicitly:

```bash
# Hermes
agentcrm integration install-skill --destination ~/.hermes/skills --json

# Claude Code destination
agentcrm integration install-skill --destination ~/.claude/skills --json
```

The installer records a managed hash. Reinstalling identical content is a no-op. An unmodified managed copy can be upgraded. An unowned or locally modified target is protected unless `--force` is explicit.

```bash
agentcrm integration install-skill --destination ~/.hermes/skills --force --json
```

### Uninstall

```bash
agentcrm integration uninstall-skill --json
agentcrm integration uninstall-skill --destination ~/.hermes/skills --json
```

Uninstall removes only its managed Skill. A locally modified Skill requires `--force`. Skill and npm uninstall never remove the CRM database.

Restart or start a fresh agent session after changing Skills so the host reloads discovery state.

## Idempotent mutations

Use a stable key when a mutation may be retried:

```bash
agentcrm --idempotency-key telegram-message-123:create-ana \
  record create person --values '{"name":"Ana"}' --json
```

Reuse the key only for the exact same normalized operation, actor, source, IDs, and values. An identical retry returns the original result. Different intent with the same key fails with `IDEMPOTENCY_CONFLICT`.

Recommended keys are scoped to a durable external request or import row. Do not reuse one global key across operations.

Read commands ignore idempotency options. Schema, record, relationship, native-import, and CSV mutations support audited idempotent behavior through their domain operations.

## Common workflows

### Create and link a contact

```bash
agentcrm search "ana@example.com" --object person --json
agentcrm search "Acme" --object organization --json

agentcrm --idempotency-key ana-v1 record create person \
  --values '{"name":"Ana","email":"ana@example.com","role":"CTO"}' --json
agentcrm --idempotency-key acme-v1 record create organization \
  --values '{"name":"Acme","domain":"example.com"}' --json
agentcrm --idempotency-key ana-works-at-acme-v1 \
  relationship add <person-id> works_at <organization-id> --json
```

### List open due follow-ups

```bash
agentcrm record list followup \
  --filter '{"all":[{"field":"status","op":"eq","value":"open"},{"field":"due_at","op":"lte","value":"2026-09-06T23:59:59Z"}]}' \
  --sort due_at:asc --json
```

### Prepare relationship context

```bash
agentcrm search "Ana" --object person --json
agentcrm context <person-id> --json
agentcrm history <person-id> --json
```

## Safety notes

- Search before creating people and organizations.
- Retain full returned IDs for later mutation.
- Use `--values-file -` rather than sensitive JSON arguments when shell history/process exposure matters.
- Dry-run CSV and native imports before applying them.
- Native import requires a pristine target; do not use it as merge.
- Archive is reversible retention, not permanent erasure.
- Protect the database, SQLite sidecars, CSV files, and native exports.
- Treat JSON as private tool output when an agent is presenting results to a person.
- Do not edit the SQLite database directly.

See [Privacy and security](privacy-security.md) for the complete trust and retention model.
