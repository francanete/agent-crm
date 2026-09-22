---
title: Everyday workflows
description: Search before creating, use bounded context, and keep retry and backup behavior explicit.
---

Start with the [published npm package and a temporary database](/docs/getting-started/). Features planned for a later release are labelled. Keep the same explicit `--db` or `AGENTCRM_DB` selection throughout.

## Shape the CRM around your work

The built-in objects are a starting point, not a fixed industry template. Add objects for the things your workflow tracks, then give them typed fields and connect them to people, organizations, or other records.

```bash
agentcrm --idempotency-key schema-project-v1 schema object add project \
  --label Project --plural-label Projects \
  --title-field name --title-field-label Name --json

agentcrm schema field add project status \
  --label Status --type enum \
  --options '["planned","active","complete"]' --json
```

Available field types are `text`, `number`, `boolean`, `date`, `datetime`, `enum`, `multi_select`, and `json`, with optional email, phone, URL, currency, and percentage formats. Use stable internal keys and user-facing labels that match the user’s language.

## Remember someone without guessing

Inspect schema, search by a known email or name, and inspect likely matches before creating a person. Idempotency prevents duplicate **exact retries**, not duplicate identities.

```bash
agentcrm schema show person --json
agentcrm search "ana@example.com" --object person --json
agentcrm --idempotency-key person-ana-v1 record create person \
  --values '{"name":"Ana","email":"ana@example.com","role":"CTO"}' --json
```

For sensitive values, prefer `--values-file -` to command-line JSON, which may be retained in shell history or process listings. The agent host still sees the supplied data.

[Create and link a contact](/docs/cli-reference/#create-and-link-a-contact) using returned IDs. Do not invent IDs or merge people based only on a similar name.

## Prepare before the next conversation

Resolve a person with search, retain the full returned ID, then use `context` for bounded relationship memory and `history` for mutation provenance. Placeholder IDs in the reference must be replaced with actual returned IDs.

[Context options and limits](/docs/cli-reference/#context) · [History commands](/docs/cli-reference/#history)

## Keep follow-ups structured

Interactions and follow-ups are records, connected to people or organizations by directed relationships. Inspect their schema before writing dates or fields. Use explicit RFC 3339 timestamps and resolve ambiguous dates with the user.

[List open due follow-ups](/docs/cli-reference/#list-open-due-follow-ups) · [Bundled Skill workflow](https://github.com/francanete/agent-crm/blob/main/skills/agentcrm/SKILL.md#log-an-interaction-and-follow-up)

## Import intentionally; restore separately

- [CSV import](/docs/csv-import/) maps headers explicitly and offers a dry-run. Real imports are atomic; CSV is not a full backup.
- [Native export and import](/docs/import-export/) preserve schema, IDs, relationships, archived data, and history. Restore only into a pristine initialized database.
- [Archive and restore](/docs/cli-reference/#record-archiverestore) preserve data and history. Archive is not permanent erasure.

The linked reference pages are generated from repository documents. Update those sources when behavior changes rather than copying their command catalogs here.
