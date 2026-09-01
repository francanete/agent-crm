---
name: agentcrm
description: Manage private local CRM memory with the agentcrm CLI. Use when looking up or remembering people and organizations, recording meetings/calls/messages, tracking relationship context, creating follow-up tasks, preparing from CRM history, or backing up and moving CRM data.
license: MIT
compatibility: Requires the agentcrm CLI and shell access. All CRM data stays in a local SQLite database.
metadata:
  version: "0.0.0"
---

# Agent CRM

Use `agentcrm` as durable, structured relationship memory. The CLI is local and does not invoke an LLM.

## Operating rules

1. Use `--json` for every machine invocation and inspect `ok`, `data`, and `error`.
2. If setup is uncertain, run `agentcrm doctor --json`. Do not run `init` unless the user asks to set up CRM storage.
3. Run `agentcrm schema show [object] --json` before using unfamiliar fields.
4. Search before creating a person or organization. Inspect likely matches by stable ID; do not merge people based only on similar names.
5. Never guess facts, IDs, field names, or dates. Ask when semantic ambiguity affects stored data. For relationships, ask about the real-world meaning in plain language—never ask the user to invent or choose an internal relationship-type identifier.
6. When the user's wording already makes a relationship clear (for example, “a subscription for Pepito”), link the records without an extra technical confirmation and choose a concise deterministic `snake_case` type internally.
7. Ask before changing schema unless the user explicitly requested that change.
8. Use IDs returned by the CLI for updates and relationships. Prefixes must be at least eight characters and unambiguous.
9. Add `--idempotency-key <key>` to retried mutations. Reuse a key only for the exact same normalized intent and values.
10. Use `context` before meeting preparation or relationship-sensitive follow-up.
11. Archive rather than delete. Confirm destructive-sounding requests, then use the explicit archive command so history and restoration remain available.
12. Do not edit the SQLite database directly. Do not delete or replace CRM data to resolve an error.
13. Treat CLI JSON envelopes as private tool output. Never reproduce raw JSON to the user unless they explicitly request JSON or debugging details; present the result naturally using the current channel's capabilities.
14. Report successful mutations concisely, including what was stored and any follow-up date.

Respect `AGENTCRM_DB` or a user-provided `--db`; otherwise allow the CLI to use its platform default. Put global options before the command for portability:

```bash
agentcrm --idempotency-key <stable-retry-key> record create person --values-file - --json
```

## Read workflow

```bash
agentcrm doctor --json
agentcrm schema show person --json
agentcrm search "Ana" --object person --json
agentcrm record get <person-id> --json
agentcrm context <person-id> --json
agentcrm history <record-id> --json
```

Search is plain text, not semantic search. Try known names, email addresses, domains, or distinctive terms. Use `record list` with a typed filter for exact structured conditions.

## Write workflow

Prefer JSON through stdin so shell quoting does not alter values:

```bash
agentcrm --idempotency-key <key> record create person --values-file - --json <<'JSON'
{"name":"Ana","email":"ana@example.com"}
JSON

agentcrm --idempotency-key <key> record update <person-id> --values-file - --json <<'JSON'
{"role":"CTO"}
JSON

agentcrm --idempotency-key <key> record upsert person --match email=ana@example.com --values-file - --json <<'JSON'
{"name":"Ana","role":"CTO"}
JSON

agentcrm --idempotency-key <key> relationship add <person-id> works_at <organization-id> --json
```

An update is partial. JSON `null` clears an optional active field; it cannot clear a required field. Prefer exact-field upsert when a stable email or domain is known: zero matches creates, one updates, and multiple or archived matches stop safely. Search again before creating when no stable exact field is available.

Recommended relationships:

- `person --works_at--> organization`
- `interaction --involves--> person` or `organization`
- `followup --concerns-->` any relevant record
- `person --knows--> person`

For custom objects, keep database vocabulary out of user-facing questions. If the intended meaning is unclear, ask naturally, such as “Should I link this subscription to Pepito?” or “Is this Pepito’s subscription, one he manages, or another connection?” After the user clarifies, select the internal type yourself—for example, `has_subscription`, `manages_subscription`, or `contact_for`. Never ask “What relationship name/type should I use?”

## Log an interaction and follow-up

First resolve the relevant person/organization IDs. Use an RFC 3339 timestamp with an explicit timezone; ask the user to resolve ambiguous relative dates or times.

```bash
agentcrm --idempotency-key <interaction-key> record create interaction --values-file - --json <<'JSON'
{"summary":"Met Ana at Acme","kind":"meeting","occurred_at":"2026-09-01T14:00:00Z","details":"Discussed the proposal."}
JSON
agentcrm --idempotency-key <link-key> relationship add <interaction-id> involves <person-id> --json

agentcrm --idempotency-key <followup-key> record create followup --values-file - --json <<'JSON'
{"title":"Send Ana the proposal","due_at":"2026-09-05T17:00:00Z","status":"open"}
JSON
agentcrm --idempotency-key <concerns-key> relationship add <followup-id> concerns <person-id> --json
```

If one step fails, keep successful IDs, fix only the failed request, and retry it with its original idempotency key only when the request is unchanged.

## Archive and restore

Archive keeps values, relationships, and history while hiding data from normal list, search, and context results:

```bash
agentcrm record archive <record-id> --json
agentcrm record restore <record-id> --json
agentcrm relationship archive <relationship-id> --json
agentcrm relationship restore <relationship-id> --json
```

Use `record get` or `record list <object> --include-archived` to inspect archived records. Use `relationship list <record-id> --include-archived` to inspect archived links or links hidden by an archived endpoint. Restoring a record validates it against the current schema; restoring a relationship requires active endpoints and no duplicate active link.

Schema field/object archival is an explicit schema change and requires the same confirmation as other schema mutations.

## CSV import

CSV is an explicit mapping adapter, not a native backup. Inspect schema and always dry-run first:

```bash
agentcrm schema show person --json
agentcrm csv import contacts.csv --object person \
  --map 'Full Name=name' --map 'Email=email' --map 'Role=role' \
  --match email --dry-run --json
agentcrm --idempotency-key <stable-file-key> csv import contacts.csv --object person \
  --map 'Full Name=name' --map 'Email=email' --map 'Role=role' \
  --match email --json
```

Confirm the target object, every mapping, and the match field with the user. Never infer mappings solely from similar header names. A real import is atomic: any failed row leaves the CRM unchanged. Blank mapped cells are omitted rather than clearing existing values. Without `--match`, every non-blank row creates a record, so require explicit user confirmation before omitting it.

## Backup and restore

Use the native format for complete local backup or migration:

```bash
agentcrm export --output backup.json --json
agentcrm --db restored.db init --json
agentcrm --db restored.db import backup.json --dry-run --json
agentcrm --db restored.db import backup.json --json
```

Always dry-run first and confirm the selected target database. Import intentionally refuses a target containing user data or schema changes. Never treat vendor CSV as a native export.

## Schema changes

After explicit confirmation, inspect the full object schema, then use:

```bash
agentcrm schema field add person priority --label Priority --type enum --options '["high","normal","low"]' --json
agentcrm schema object add project --label Project --plural-label Projects --title-field name --title-field-label Name --json
```

A required field cannot be added after records already exist. Enum values must match configured options exactly.

## Error recovery

- `DATABASE_NOT_INITIALIZED`: ask whether to run `agentcrm init --json`.
- `AMBIGUOUS_ID`: use a longer ID prefix; never choose a match arbitrarily.
- `UNKNOWN_FIELD` / `INVALID_FIELD_VALUE`: inspect schema and correct the request.
- `IDEMPOTENCY_CONFLICT`: do not force the operation; use the original request or a new key for a genuinely new intent.
- `MULTIPLE_UPSERT_MATCHES`: inspect every returned ID and ask before correcting duplicates; never choose one arbitrarily.
- `SCHEMA_CONFLICT`: inspect schema and existing records before proposing a change.
- Any unexpected database error: run `agentcrm doctor --json` and preserve the database for diagnosis.
