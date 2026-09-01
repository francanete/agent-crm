# Agent CRM

A local, schema-aware relationship database designed for shell-capable AI agents.

> Early implementation: the CLI and data format are not yet stable.

## Development

Requires Node.js 24 or newer.

```bash
npm install
npm run build
node dist/cli.js --help
```

## Implemented vertical slices

```bash
agentcrm --db ./crm.db init --json
agentcrm --db ./crm.db doctor --json
agentcrm --db ./crm.db schema show --json

agentcrm --db ./crm.db record create person --values '{"name":"Ana"}' --json
agentcrm --db ./crm.db record create organization --values '{"name":"Acme"}' --json
agentcrm --db ./crm.db relationship add <person-id> works_at <organization-id> --json
agentcrm --db ./crm.db relationship list <person-id> --json
agentcrm --db ./crm.db context <person-id> --json

agentcrm --db ./crm.db record list followup \
  --filter '{"all":[{"field":"status","op":"eq","value":"open"},{"field":"due_at","op":"lte","value":"2026-09-06T23:59:59Z"}]}' \
  --sort due_at:asc --json

agentcrm --db ./crm.db schema field add person priority \
  --label Priority --type enum --options '["high","normal","low"]' --json
agentcrm --db ./crm.db record update <person-id> --values '{"priority":"high"}' --json
agentcrm --db ./crm.db record upsert person --match email=ana@example.com \
  --values '{"name":"Ana","role":"CTO"}' --json
agentcrm --db ./crm.db search "proposal" --object person --json
agentcrm --db ./crm.db history <person-id> --json

agentcrm --db ./crm.db record archive <person-id> --json
agentcrm --db ./crm.db record list person --include-archived --json
agentcrm --db ./crm.db record restore <person-id> --json
agentcrm --db ./crm.db relationship archive <relationship-id> --json
agentcrm --db ./crm.db relationship restore <relationship-id> --json
```

Exact-field upsert creates on zero matches and updates one active match. It refuses multiple or
archived matches, making it suitable for retryable imports keyed by stable email or domain.

Archive operations preserve values and immutable history. Archived records are hidden from normal
lists, search, relationships, and context until restored. Schema fields can also be archived while
retaining legacy values; restoration validates active records before making the field searchable.

## CSV import

Map CSV headers explicitly and dry-run before the atomic import:

```bash
agentcrm --db ./crm.db csv import contacts.csv --object person \
  --map 'Full Name=name' --map 'Email=email' --map 'Role=role' \
  --match email --dry-run --json
agentcrm --db ./crm.db --idempotency-key contacts-2026-09 \
  csv import contacts.csv --object person \
  --map 'Full Name=name' --map 'Email=email' --map 'Role=role' \
  --match email --json
```

The adapter validates every row and rolls back the entire import if any row fails. See
[`docs/csv-import.md`](docs/csv-import.md) for type conversion, limits, and retry behavior.

## Backup and portability

Create a complete native logical export, validate it against a pristine target, then import it:

```bash
agentcrm --db ./crm.db export --output backup.json --json
agentcrm --db ./restored.db init --json
agentcrm --db ./restored.db import backup.json --dry-run --json
agentcrm --db ./restored.db import backup.json --json
```

Exports preserve schema, records, archived data, relationships, IDs, timestamps, and immutable
history. Use `--without-history` for a smaller export. Import is fully validated and transactional;
it refuses non-pristine targets. See [`docs/import-export.md`](docs/import-export.md). Vendor CRM
adapters are not implemented yet; CSV remains a separate explicitly mapped adapter.

## Agent Skill

Install the bundled standards-compatible Agent Skill:

```bash
agentcrm integration install-skill --json
```

The default destination is `~/.agents/skills/agentcrm/SKILL.md`. Installation is idempotent,
upgrades an unmodified managed copy, and refuses to overwrite local changes unless `--force`
is explicit. A harness-specific root can be selected without changing the skill:

```bash
agentcrm integration install-skill --destination ~/.claude/skills --json
```

Discovery status:

| Harness | Skills root | Status |
| --- | --- | --- |
| Pi | `~/.agents/skills` | Documented and covered by the install smoke test |
| Codex | harness-configured skills root | Not yet manually verified |
| Claude Code | `~/.claude/skills` | Destination supported; not yet manually verified |
| Hermes | harness-configured skills root | Not yet manually verified |

Shell-capable agents can still use the CLI without automatic skill discovery. Do not claim a
harness integration is verified until its release checklist has been run.

Remove only the managed skill with:

```bash
agentcrm integration uninstall-skill --json
```

Uninstall refuses to remove a modified skill without `--force`. Removing the skill or npm
package never removes the SQLite database. CRM data remains at the selected `--db`,
`AGENTCRM_DB`, or platform-default data path.

All runtime data remains in the selected local SQLite database. The application makes no
network requests.
