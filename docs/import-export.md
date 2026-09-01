# Native import and export

Agent CRM uses a versioned logical JSON document for backup and transfer between installations.
This is distinct from importing vendor-specific CSV or API exports.

## Export

```bash
agentcrm export --output backup.json --json
```

The export contains:

- export format and physical database versions
- export timestamp
- all object and field definitions, including archived definitions
- all records, including archived records and legacy field values
- all relationships, including archived relationships
- immutable events and idempotency metadata

Use `--without-history` to omit events. Use `--force` only to replace an existing regular output
file. Export files are created with mode `0600` on POSIX systems. Export reads from one SQLite
snapshot, so its logical contents are consistent.

The top-level contract is:

```json
{
  "format": "agentcrm-export",
  "formatVersion": 1,
  "exportedAt": "2026-09-01T14:32:05.123Z",
  "databaseVersion": 1,
  "historyIncluded": true,
  "data": {
    "objects": [],
    "records": [],
    "relationships": [],
    "events": []
  }
}
```

The export-format version is independent from the physical database migration version.

## Import

Initialize a separate target database, then validate before writing:

```bash
agentcrm --db restored.db init --json
agentcrm --db restored.db import backup.json --dry-run --json
agentcrm --db restored.db import backup.json --json
```

Version 1 imports only into a pristine target: no records, relationships, or events, and an
untouched default logical schema. Import replaces that default logical schema with the exported
schema while preserving local physical migrations and database instance metadata.

Before mutation, import validates the complete document, including:

- format version and shape
- unique object, field, record, relationship, and event IDs
- schema ownership and title-field invariants
- field types, formats, enum options, and defaults
- record values, required fields, display names, and schema versions
- relationship endpoints and active uniqueness
- event and idempotency-key uniqueness

The write runs in one immediate transaction. Any failure rolls back the schema, records,
relationships, events, and FTS rebuild. Imported IDs, timestamps, archived state, and source
history are preserved. One new local `database/imported` event records the restore operation.
An import may use a global `--idempotency-key` for safe retry.

`--dry-run` parses and validates the full file and inspects the target through a read-only
connection. It does not open a write transaction.

## Limits and privacy

Import files are limited to 100 MiB in version 1. JSON exports are plaintext and may contain
sensitive contact details. Protect them like the SQLite database and use encrypted storage when
required. Agent CRM performs no upload or network request.

## Other CRM formats

The native importer accepts only `agentcrm-export` documents. HubSpot, Salesforce, Google
Contacts, and generic CSV files require explicit mapping adapters that are not implemented yet.
Keeping those adapters separate prevents ambiguous field mapping or silent data loss.
