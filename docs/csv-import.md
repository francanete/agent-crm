# CSV import

The generic CSV adapter imports UTF-8 CSV into one existing Agent CRM object. It is separate from the versioned native `agentcrm-export` backup format and never changes schema automatically.

## Safe workflow

Inspect the target schema, write explicit mappings, and dry-run before importing:

```bash
agentcrm schema show person --json
agentcrm csv import contacts.csv \
  --object person \
  --map 'Full Name=name' \
  --map 'Email=email' \
  --map 'Job Title=role' \
  --map 'Tags=tags' \
  --match email \
  --dry-run \
  --json

agentcrm --idempotency-key contacts-2026-09 \
  csv import contacts.csv \
  --object person \
  --map 'Full Name=name' \
  --map 'Email=email' \
  --map 'Job Title=role' \
  --map 'Tags=tags' \
  --match email \
  --json
```

Use `-` as the input path to read CSV from stdin.

## Mapping and matching

Every imported field requires an explicit `--map 'CSV Header=crm_field'`. Unmapped columns are ignored. Headers and CRM fields cannot be mapped more than once, and archived or unknown fields are rejected.

`--match <field>` is optional. When present, it must be a mapped scalar field:

- zero exact matches creates a record;
- one active exact match partially updates that record;
- multiple matches or an archived match fails the row;
- a blank match cell fails the row.

Without `--match`, every non-blank row creates a new record. Empty mapped cells are omitted: they do not clear fields on update, and required omitted fields still fail validation.

## Type conversion

CSV cells are converted using the active CRM schema:

- text, enum, date, and datetime remain strings and use normal field validation;
- numbers use strict decimal/scientific numeric syntax;
- booleans accept `true`, `false`, `1`, or `0`;
- multi-select values are split on `;` by default; change it with `--multi-value-separator`;
- JSON fields must contain valid JSON text.

The parser supports comma-separated RFC-style quoted fields, escaped quotes, CRLF, embedded newlines, and a UTF-8 BOM. Duplicate/blank headers, malformed quoting, and inconsistent column counts are rejected.

## Atomicity, dry-run, and retries

Dry-run executes the same schema validation and create/upsert decisions inside a transaction, then rolls everything back. It reports source row numbers, physical line numbers, and stable error codes.

A real import validates every row. If any row fails, the complete transaction is rolled back and no records, FTS entries, or events remain. Successful imports report created, updated, skipped, failed, and replayed counts.

A global `--idempotency-key` derives deterministic per-row keys. Retrying the same file and options replays prior row results without duplicate writes. Reusing the key after changing row intent produces an idempotency conflict and rolls back the entire import.

Limits:

- maximum input size: 25 MiB;
- maximum data rows: 100,000;
- up to 1,000 row errors are included in JSON; `errorsTruncated` indicates additional failures.

Use native `agentcrm export` and `agentcrm import` for complete backup and restoration. CSV does not preserve Agent CRM IDs, schema definitions, relationships, timestamps, archive state, or history.
