# Architecture

Agent CRM is a local-first, schema-aware relationship database for shell-capable AI agents. It is a command-line application, not a hosted CRM service: SQLite is the system of record, the CLI is the public integration boundary, and no runtime operation requires an Agent CRM server or network connection.

## Design goals

- Keep CRM data under the user's control in one portable local database.
- Give agents stable, machine-readable commands and JSON contracts.
- Validate all schema, values, filters, and lifecycle transitions before mutation.
- Make retries deterministic through idempotency keys and immutable events.
- Preserve records and history through archive/restore instead of destructive deletion.
- Support complete native backup/restore and atomic mapped CSV ingestion.
- Remain independent of any particular agent host, model provider, or user-interface channel.

## System boundary

```text
User
  │
  ▼
Agent host (Pi, Hermes, or another shell-capable agent)
  │  reads Agent CRM Skill
  │  executes local commands
  ▼
agentcrm CLI
  │
  ├── command parsing and stable output envelopes
  ├── schema-aware domain services
  ├── validation, idempotency, and transactions
  └── SQLite access through node:sqlite
       │
       ▼
  Local Agent CRM database
```

The agent host may itself use a networked model or messaging channel, but Agent CRM does not initiate those connections. The Agent Skill is guidance for the host; it is not executable CRM logic and does not contain user data.

## Runtime layers

### CLI adapter

`src/cli/program.ts` defines commands, options, input-size checks, exit behavior, and output selection. Machine callers use `--json` and receive one of two stable envelope shapes:

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "database": "/path/to/crm.db",
    "cliVersion": "0.1.0"
  }
}
```

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

Domain errors are converted to stable error codes rather than exposing SQLite exceptions or stack traces. Human-readable and quiet output modes are separate from the JSON contract.

### Domain services

Modules under `src/core/` implement schema, records, relationships, queries, search, context, history, lifecycle operations, CSV ingestion, and native portability. They receive validated options and a database handle rather than depending on an agent framework.

The current npm package exposes the CLI, not a supported JavaScript library API. A future MCP adapter can reuse these internal domain boundaries or promote a versioned application API without changing the database model or CLI contracts.

### Database layer

Modules under `src/db/` own database initialization, migrations, seed schema, connection configuration, and transactions. Agent CRM uses Node.js `node:sqlite` and requires Node.js 24 or newer.

Writable connections enable:

- foreign-key enforcement;
- SQLite WAL journal mode;
- `synchronous = NORMAL`;
- a 5-second busy timeout.

Read-only diagnostics use a read-only SQLite connection and do not apply migrations.

## Database selection and ownership

Database-path precedence is:

1. Global CLI option `--db`
2. `AGENTCRM_DB`
3. Platform default

Defaults are:

| Platform | Default |
| --- | --- |
| Linux and other XDG platforms | `$XDG_DATA_HOME/agentcrm/crm.db`, or `~/.local/share/agentcrm/crm.db` |
| macOS | `~/Library/Application Support/agentcrm/crm.db` |
| Windows | `%LOCALAPPDATA%\agentcrm\crm.db` |

Initialization creates parent directories and, on POSIX systems, restricts a newly created data directory to mode `0700` and the database to `0600`. Uninstalling the npm package or Agent Skill never removes the selected database.

## Logical data model

### Metadata and migrations

The `metadata` table records the database format version, creation time, and a stable instance ID. Every database is validated before normal use. A database newer than the CLI supports is rejected rather than opened unsafely.

Migrations run in ordered immediate transactions. The `0.1.0` release uses database format version 1.

### Object types and fields

`object_types` describes logical CRM object types. `field_definitions` describes their fields, including:

- stable key and user-facing label;
- type and optional format;
- required state;
- enum options or default value;
- ordering and lifecycle timestamps;
- schema version.

The initial schema seeds `person`, `organization`, `interaction`, and `followup`. Custom objects and fields use the same storage and validation path as seeded schema.

### Records

A record stores:

- a UUID;
- its object type;
- a materialized display name derived from the object's title field;
- schema-aware values as a validated JSON object;
- the schema version used for validation;
- creation, update, and optional archive timestamps.

Values remain flexible enough for custom schema while field definitions provide typed validation. Supported MVP field types include text, number, boolean, enum, date, datetime, multi-select, and JSON.

### Relationships

Relationships are directed edges between records with:

- a UUID;
- source and target record IDs;
- a concise semantic type;
- optional JSON properties;
- lifecycle timestamps.

Self-links are rejected. A partial unique index prevents duplicate active edges with the same source, target, and type. Archived relationships can coexist with a later active edge but cannot be restored into a duplicate.

The relationship type is domain vocabulary chosen by trusted agent/application logic. Users should discuss real-world meaning rather than internal type identifiers.

### Immutable events

Every successful mutation appends an event in the same transaction as the domain change. Events contain:

- subject type and ID;
- action;
- actor and optional source;
- optional idempotency key;
- before/after data;
- operation metadata and timestamp.

SQLite triggers reject event updates and deletes. History is therefore append-only through supported and direct SQL paths. Event metadata may include CLI version, working directory, and a Pi session ID when the host provides one.

## Validation and query safety

All writes are checked against the active object and field definitions before SQL mutation. Validation covers required values, field types and formats, enum membership, date/datetime syntax, unknown fields, and archived schema elements.

Record-list filters are a typed JSON abstract syntax tree. Agent CRM validates object fields, operators, values, sort keys, and limits, then compiles only approved structure into parameterized SQL. User values are never interpolated into SQL text.

Stable IDs are UUIDs. Commands may accept an unambiguous ID prefix of at least eight characters, but they reject ambiguous prefixes rather than selecting an arbitrary record.

## Mutation flow

A typical mutation follows this sequence:

```text
Parse bounded CLI input
  → resolve and validate database
  → resolve active schema and IDs
  → canonicalize request
  → check idempotency replay/conflict
  → begin immediate transaction
  → validate current state
  → mutate domain tables
  → synchronize FTS when applicable
  → append immutable event
  → commit
  → return stable envelope
```

An exception rolls back the entire transaction before the CLI emits an error envelope.

`inImmediateTransaction()` participates in an existing transaction when needed. This allows composite workflows such as CSV import to call normal record mutation services without committing partial work.

## Idempotency

Mutating commands can receive `--idempotency-key`. The mutation computes a hash from the normalized operation and intent. If the key is new, the change and event commit together. If the same key and request hash already exist, Agent CRM returns the recorded result as a replay. If the key was used for a different normalized request, the operation fails with `IDEMPOTENCY_CONFLICT`.

Idempotency protects retries; it does not replace identity resolution. Agents should still search before creating people and organizations. Exact-field upsert handles deterministic import-style identity separately.

## Exact-field upsert

Upsert matches one validated scalar field exactly:

- zero active matches creates a record;
- one active match partially updates that record;
- multiple active matches fail;
- an archived match fails rather than silently restoring or duplicating it.

Blank matches and ambiguous JSON or multi-select matching are rejected. Creation/update, FTS synchronization, event creation, and idempotency all share one transaction.

## Full-text search

SQLite FTS5 indexes active records only. Each entry contains the stable record ID, object key, display name, and searchable field content.

Record create/update/restore operations rebuild the corresponding entry inside the mutation transaction. Archive removes it. Field lifecycle operations reindex affected records. Native import rebuilds the complete index from restored records rather than trusting imported index state.

Normal search, context, and relationships exclude archived records. `doctor` compares active records with FTS rows and reports missing, extra, or duplicate entries.

## Archive and restore

Agent CRM has no general destructive record-delete command. Lifecycle operations set or clear archive timestamps while preserving values, edges, IDs, and history.

Restore validates current conditions:

- records must still satisfy active schema;
- relationships require active endpoints and no duplicate active edge;
- fields validate affected active records before becoming active;
- title fields cannot be archived;
- objects can be archived only when they contain no active or archived records.

These constraints avoid making legacy data visible under incompatible current schema.

## Context and history

`context` builds bounded relationship memory around one active record. It combines the record, related active records, and relevant recent interactions/follow-ups without requiring embeddings or an external retrieval service.

`history` reads immutable events for a subject. A separate event lookup exposes one event for audit and debugging. Context is operational relationship memory; history is provenance and mutation audit.

## Native backup and restore

The versioned `agentcrm-export` format is a logical, application-level backup. It preserves IDs, schema, values, relationships, timestamps, archived data, and optionally immutable history.

Native import:

- applies strict structure and semantic validation;
- enforces a 100 MiB input limit;
- requires an initialized but pristine target;
- restores all content in one transaction;
- preserves IDs and timestamps;
- rebuilds FTS;
- supports idempotent replay.

It intentionally does not merge into an active CRM. This keeps complete restoration deterministic and separates backup semantics from migration/adapters.

## CSV ingestion

CSV is an external ingestion workflow, not the native backup format. The caller must map every imported header explicitly to a known active field and may choose one exact-match field for upsert.

The parser supports quoted fields, escaped quotes, embedded newlines, CRLF, UTF-8 BOM, and strict UTF-8. Schema conversion happens before mutation decisions. Limits bound bytes, rows, and reported errors.

Dry-run and real import use the same transactional path. Dry-run always rolls back. A real import commits only when every row succeeds; any failed row rolls back records, FTS, events, and idempotency effects for the complete file.

## Agent Skill integration

The bundled `skills/agentcrm/SKILL.md` teaches shell-capable agents safe workflows: inspect schema, search before creation, use stable IDs, apply idempotency keys to retries, ask semantic questions, and keep raw JSON private.

Installation copies the Skill to a selected host directory and records a managed content hash. Reinstalling the same Skill is idempotent. Upgrades replace only an unmodified managed copy. Removal or replacement of local edits requires explicit `--force`.

Different hosts can use different Skill roots while sharing the same executable and database. For example, Pi can use `~/.agents/skills`, while Hermes uses `~/.hermes/skills`.

## Diagnostics

`doctor` verifies:

- database format version;
- restrictive POSIX permissions;
- foreign-key integrity;
- FTS5 availability and consistency;
- availability and validity of seeded object/title fields.

Warnings do not necessarily make the database unhealthy; failed integrity or FTS checks do.

## Extension boundaries

Future integrations should remain adapters around the domain layer:

```text
                  ┌── CLI adapter
Domain services ──┼── future MCP adapter
                  └── future presentation adapters
                        ├── A2UI
                        ├── channel-native UI
                        └── readable text fallback
```

MCP is optional and must not become a prerequisite for local CLI use. Presentation metadata must remain separate from canonical CRM data and must not be stored as business records. Rich UI should be capability-negotiated, declarative, non-executable, and accompanied by a readable fallback, as recorded in ADR 0003.

A remote MCP gateway would cross the current local-only trust boundary and requires an explicit security, authentication, and privacy design. It is not part of `0.1.0`.

## Deliberate non-goals for 0.1.0

- Hosted service or synchronization
- Embeddings or vector search
- Vendor-specific CRM adapters
- Automatic duplicate merging
- MCP server
- Generative UI renderer
- Arbitrary generated SQL or executable UI code

These features can be added through explicit versioned boundaries without changing SQLite's role as the authoritative local store.
