# Privacy and security

Agent CRM is designed as a local command-line database. It does not provide a hosted account, synchronization service, telemetry endpoint, or remote API. This reduces the default network attack surface, but it does not make all CRM usage private automatically: the agent host, model provider, messaging channel, local operating system, and files chosen by the user remain part of the trust boundary.

## Security summary

- CRM data is stored locally in one SQLite database.
- Agent CRM makes no runtime network requests.
- Data is not encrypted by Agent CRM at rest.
- POSIX database and native-export files use restrictive permissions where supported.
- Mutations use schema validation, parameterized SQL, immediate transactions, and immutable audit events.
- Archive preserves data; it is not permanent deletion.
- npm and Skill uninstall intentionally preserve the database.
- A shell-capable agent can disclose any data it is allowed to read. Agent permissions and channel privacy matter as much as CLI security.

## Trust model

Agent CRM assumes these components are trusted for the data they can access:

1. The local operating-system account running `agentcrm`
2. The installed Agent CRM package and its runtime dependencies
3. The shell-capable agent host
4. The selected model provider
5. Any messaging transport used to talk to the agent
6. Other local processes running with the same user privileges

The CLI validates requests and protects against accidental or malformed operations. It is not a sandbox for a compromised local account or malicious agent host.

### In scope

The `0.1.0` security design addresses:

- malformed and incompatible database files;
- unsafe query construction;
- invalid schema and field values;
- duplicate retries and conflicting idempotency keys;
- partial mutations and imports;
- accidental overwrites of exports and managed Skills;
- restoration into incompatible or ambiguous state;
- bounded CLI, native-import, and CSV input;
- visibility of archived data through normal commands;
- basic local file-permission diagnostics.

### Out of scope

Agent CRM does not attempt to defend against:

- root, administrator, or another process with equivalent file access;
- a compromised agent host or model provider;
- malicious changes to the installed CLI package;
- direct SQLite modification by the database owner;
- filesystem rollback, disk corruption, or hardware failure;
- denial of service through exhaustion of local disk or memory outside documented limits;
- data copied into shell history, terminal logs, screenshots, backups, or third-party channels;
- network exposure created by a future gateway or by unrelated software.

## Local-only runtime

Normal CLI operations use local files and Node.js built-ins. Runtime dependencies provide command parsing and validation; Agent CRM does not call external APIs, download schemas, send analytics, or check for updates.

Installation and publication are separate concerns: npm may access the npm registry when installing or updating the package. Agent hosts and model providers may use networks independently of Agent CRM.

No MCP server or network listener is included in `0.1.0`.

## Data at rest

The SQLite database contains CRM values, schema, relationships, archived data, and immutable event history in readable form. Agent CRM does not encrypt the database.

Use operating-system full-disk or home-directory encryption when at-rest confidentiality is required. Do not store passwords, API keys, recovery codes, private keys, or other high-impact secrets merely because the database is local.

### Default locations

Database path precedence is:

1. `--db`
2. `AGENTCRM_DB`
3. Platform default

| Platform | Default |
| --- | --- |
| Linux/XDG | `$XDG_DATA_HOME/agentcrm/crm.db`, or `~/.local/share/agentcrm/crm.db` |
| macOS | `~/Library/Application Support/agentcrm/crm.db` |
| Windows | `%LOCALAPPDATA%\agentcrm\crm.db` |

A user-selected path may have different filesystem, backup, synchronization, or access-control behavior. In particular, placing the database inside a cloud-synchronized folder changes the local-only privacy assumption.

### File permissions

On POSIX systems, initialization creates a new parent data directory with mode `0700` and sets the database file to `0600`. Native exports are written with mode `0600`. `doctor` warns when the database is accessible to group or other users.

These modes are not encryption and do not restrict root. Windows uses filesystem ACLs rather than POSIX modes; Agent CRM relies on the current user's Windows profile and directory ACL configuration.

SQLite may create `-wal` and `-shm` sidecar files next to a writable database. Protect the complete database directory, not only `crm.db`.

## Information recorded in history

Mutation events intentionally retain provenance. Depending on the operation, history can contain:

- before and after values;
- actor and source labels;
- idempotency key;
- operation and normalized request metadata;
- CLI version;
- process working directory;
- Pi session ID when `PI_SESSION_ID` is present;
- timestamps and stable subject IDs.

History is useful for audit and retry safety, but it increases retained sensitive data. Archiving a record does not remove its history. Native exports include history by default.

`agentcrm export --without-history` omits events from a backup, but current record values, schema, relationships, timestamps, and archived records remain. It is not a general redaction tool.

Events are protected from update and deletion by SQLite triggers and are append-only through supported operations. They are not cryptographically signed or tamper-evident against a database owner who can alter the SQLite schema directly.

## Agent and model privacy

The CLI returns requested CRM data to the process that invoked it. When an AI agent executes the CLI, that information may enter the agent's context and may be sent to its configured model provider.

The bundled Skill instructs agents to keep JSON envelopes private and summarize results naturally. This improves user experience; it is not a data-loss-prevention boundary. A compromised or incorrectly configured host can still reveal tool output.

Before using real CRM data, understand the privacy and retention terms of:

- the model provider;
- the agent host;
- plugins and MCP servers loaded by the host;
- observability or session-history features;
- the user-facing channel.

For example, Agent CRM does not send data to Telegram, but a Hermes agent may include CRM-derived information in Telegram messages and model prompts. Telegram and the model provider are then part of the data path.

Use fake contacts and an isolated `--db` path for acceptance tests.

## Shell and process exposure

Values supplied directly on a command line can be retained in shell history or briefly visible in local process listings:

```bash
agentcrm record create person --values '{"name":"Sensitive value"}'
```

For sensitive or large values, prefer standard input:

```bash
printf '%s' '{"name":"Sensitive value"}' | \
  agentcrm record create person --values-file - --json
```

This avoids placing the JSON value in the argument list, although the agent host and receiving process still see it. Protect CSV and native-export files separately and remove temporary files when they are no longer needed.

Stable record IDs and idempotency keys should not be treated as authentication secrets.

## SQL and query safety

Agent CRM does not accept arbitrary SQL from CLI callers. Structured list filters are validated as a typed JSON abstract syntax tree. Object keys, field keys, operators, sort keys, and values are checked against active schema before compilation.

SQL values are bound through SQLite parameters. Dynamic SQL structure is selected only from validated internal vocabulary.

Directly editing the SQLite database bypasses application validation and is unsupported.

## Mutation integrity

Mutations use `BEGIN IMMEDIATE` transactions. Domain changes, FTS updates, and audit events commit together or roll back together.

Idempotency keys are unique in event history. Reusing a key with the same normalized request returns the recorded result; using it for a different request fails. Idempotency protects retries but does not authenticate the caller.

Foreign-key enforcement is enabled on application connections. Active relationship uniqueness prevents duplicate source/target/type edges.

## Archive is retention, not erasure

Archive operations set lifecycle timestamps and hide data from normal list, search, context, and relationship results. They preserve:

- record values;
- stable IDs;
- relationships;
- archived schema values;
- immutable history.

Therefore, archive does not satisfy a request for permanent erasure. Agent CRM `0.1.0` has no supported permanent record-delete or selective history-redaction command.

To erase an entire CRM, first make intentional decisions about required backups, stop processes using the database, and remove the selected database plus its SQLite sidecars and all exports through operating-system tools. Verify the path carefully. npm or Skill uninstall does not perform this operation.

Selective permanent deletion requires a future audited design because records may be referenced by relationships, events, exports, and external backups.

## Full-text search

FTS5 contains derived text from active records and is stored inside the SQLite database. Archive removes a record from FTS in the same transaction; restore rebuilds its entry after validation.

`doctor` detects missing, extra, and duplicate FTS rows. Native import rebuilds FTS from validated records rather than accepting a serialized search index.

Archived data is absent from FTS but remains in normal database tables and history.

## Native exports

Native export is a logical backup containing sensitive CRM information as JSON. It is not encrypted.

Export protections include:

- refusal to overwrite an existing target;
- temporary-file write followed by atomic rename;
- POSIX mode `0600`;
- complete versioned structure;
- explicit optional history omission.

Store exports with controls appropriate for the source database. Encrypt them before placing them in shared storage or sending them across a network.

Do not rely on copying a live `crm.db` file alone while WAL mode is active. Use `agentcrm export` for application-level portability, or use a SQLite-aware backup procedure that handles WAL consistently.

## Native imports

Native import accepts only the versioned `agentcrm-export` format and enforces a 100 MiB limit. It validates structure, IDs, schema, values, relationships, timestamps, archived state, and history references before commit.

Import requires a pristine initialized target. It does not merge with active user data. Restoration is transactional, preserves stable IDs, and rebuilds FTS.

Dry-run uses the real validation and transaction path but rolls back. Invalid input cannot intentionally produce a partial supported import.

## CSV imports

CSV import requires explicit header-to-field mappings. Optional upsert matching is exact and limited to supported scalar fields.

Protections include:

- strict UTF-8 decoding;
- a 25 MiB input limit;
- a 100,000-row limit;
- schema-aware conversion;
- bounded reported errors;
- dry-run through the real transaction path;
- complete rollback when any real-import row fails;
- idempotency support.

CSV is untrusted input. Review mappings and dry-run results before import. Agent CRM stores text; it does not execute spreadsheet formulas or CSV cells as code.

## Skill installation and trust

The Agent Skill is a Markdown instruction file. Installing it grants no operating-system permissions by itself, but an agent that follows it must already have permission to execute the local CLI.

The managed installer records a content hash. It refuses to replace or remove an unowned or locally modified Skill without explicit `--force`. This prevents silent loss of local instructions; it does not prove that the original package is trustworthy.

Review package and Skill changes before upgrading. Install Skills only into intended host directories. `agentcrm setup` is an explicit local-administrator operation: it previews targets, asks before creating a database or writing a Skill, and does not modify hosts during npm installation.

The setup catalog uses `~/.agents/skills` for Pi, `$CLAUDE_CONFIG_DIR/skills` or `~/.claude/skills` for Claude Code, and `~/.hermes/skills` for Hermes. Setup never edits `PATH`, shell profiles, systemd/launchd services, or gateway configuration, and never restarts a host. A background gateway may have a different `PATH` than the invoking terminal; its administrator must diagnose and correct that environment separately.

A normal agent conversation must not administer Skill destinations. It may ask for consent to initialize its already-selected CRM database, but it must not use chat consent to detect hosts, install Skills, force replacement, or select every agent. Hermes and similar gateways may serve multiple chat identities under one OS user; absent an explicit future identity-to-profile mapping, those identities share the one selected local CRM.

## Input and resource bounds

The CLI bounds large JSON values and filter input before parsing. Native and CSV import have explicit byte and row limits. Query limits and pagination bound normal list operations. Error reporting is capped for large CSV failures.

These controls reduce accidental resource exhaustion; they do not provide a hardened multi-tenant denial-of-service boundary.

## Backups and recovery

A local-only database still needs backups. Recommended practice:

1. Run `agentcrm doctor --json`.
2. Create a native export to a protected location.
3. Test `import --dry-run` against a pristine temporary database.
4. Periodically perform a real test restoration.
5. Protect or encrypt backup media.
6. Keep more than one generation when the data matters.

Do not assume npm reinstall, package caches, or the managed Skill are CRM backups. They intentionally contain no user database.

## Dependency and release security

Runtime dependencies are intentionally small. Release qualification runs lockfile-based installation, linting, type checking, tests, package-content inspection, clean-tarball installation, cross-platform CI, and `npm audit`.

The lockfile improves reproducibility but is not a guarantee against supply-chain compromise. Review dependency updates and publication-account security. The initial npm publication requires two-factor authentication; later releases may use npm trusted publishing and provenance.

## Future MCP and remote access

A future local MCP adapter can reuse domain services without making the SQLite database remotely accessible by default. It should bind locally, use least privilege, and preserve the existing validation and audit paths.

Connecting a hosted ChatGPT, Claude, or other remote client to a local CRM requires a gateway or tunnel and changes the threat model. Such a feature must be explicitly opt-in and define:

- authentication and client identity;
- authorization by tool and data scope;
- transport encryption;
- origin and replay protection;
- confirmation for sensitive mutations;
- logging and secret redaction;
- rate and input limits;
- revocation and incident response.

No remote MCP gateway is part of `0.1.0`.

## Operational checklist

Before storing real data:

- [ ] Confirm the selected database path.
- [ ] Confirm disk/home-directory encryption if required.
- [ ] Run `agentcrm doctor --json`.
- [ ] Review agent-host, model-provider, and channel privacy settings.
- [ ] Ensure only intended users/processes can access the database directory.
- [ ] Decide what event-history retention is acceptable.
- [ ] Establish and test encrypted backups.
- [ ] Avoid secrets in command-line arguments and CRM fields.
- [ ] Keep the CLI and managed Skill updated together.

If unexpected disclosure or modification occurs, stop the relevant agent/gateway, preserve a protected copy for investigation if appropriate, inspect immutable history and host logs, rotate any exposed secrets outside Agent CRM, and restore from a verified backup when necessary.
