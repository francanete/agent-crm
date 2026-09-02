# Security policy

Agent CRM handles relationship data and immutable history in a local SQLite database. We take vulnerabilities that could cause unauthorized disclosure, unintended mutation, data loss, command execution, or bypass of documented safety boundaries seriously.

For architecture and operational guidance, also read [Privacy and security](docs/privacy-security.md).

## Supported versions

Agent CRM is experimental and has not reached `1.0`. Security fixes are provided for the latest published minor release only.

| Version | Supported |
| --- | --- |
| `0.1.x` | Yes |
| Pre-release builds older than `0.1.0` | No |

Users may be asked to reproduce a report with the latest patch release. Compatibility can evolve before `1.0`, but security fixes will avoid unnecessary data-format changes and will include migration guidance when a change is required.

## Reporting a vulnerability

Do not report an unpatched vulnerability in a public GitHub issue, discussion, pull request, social-media post, or shared agent conversation.

Use GitHub's private vulnerability reporting form:

**[Privately report a security vulnerability](https://github.com/francanete/agent-crm/security/advisories/new)**

If GitHub does not show the private reporting form, contact the maintainer through the [repository owner profile](https://github.com/francanete) and request a private security contact channel without including vulnerability details. Do not attach a CRM database, native export, credentials, or personal data to a public message.

### Include

Provide enough sanitized information to reproduce and assess the issue:

- affected Agent CRM version or commit;
- Node.js version and operating system;
- vulnerability class and expected impact;
- required attacker access and trust assumptions;
- minimal reproduction using a temporary database and fake data;
- relevant command shape and stable error code;
- whether interaction through an agent host is required;
- whether the issue affects confidentiality, integrity, availability, or package installation;
- any suggested mitigation or patch, if available.

For import issues, provide the smallest synthetic CSV or native-export fragment that demonstrates the problem. Never send a real CRM database or unredacted backup.

## Response process

We aim to:

1. Acknowledge a complete report within five business days.
2. Confirm scope, severity, and reproduction status within ten business days when practical.
3. Keep the reporter informed when assessment or remediation materially changes.
4. Prepare a fix and regression test before public disclosure.
5. Coordinate publication timing with the reporter when possible.
6. Credit the reporter unless they prefer to remain anonymous.

These are response goals, not guaranteed service-level agreements. Complex reports or maintainer availability may affect timing.

Please allow reasonable time for investigation and remediation before disclosure. If a report is disputed or progress stalls, communicate through the private advisory before publishing technical details.

## Coordinated disclosure

A confirmed vulnerability will normally be handled through a private GitHub security advisory. Depending on impact, remediation may include:

- a patch release;
- updated package and Skill artifacts;
- migration or restoration instructions;
- temporary mitigation guidance;
- npm deprecation of affected versions;
- a GitHub security advisory and release notes.

Public disclosure should identify affected and fixed versions, impact, required preconditions, mitigation, and upgrade instructions without exposing user data.

## Security-sensitive areas

Examples of issues appropriate for private reporting include:

- SQL injection or bypass of the structured query validator;
- command or argument injection through CLI input;
- arbitrary file read, write, overwrite, or path traversal;
- native import accepting invalid references or committing partial state;
- CSV import escaping its transaction or documented resource limits;
- archive/upsert behavior that silently exposes, restores, or duplicates protected data;
- idempotency replay returning or applying a different request;
- mutation without a corresponding audit event;
- supported modification or deletion of immutable history;
- FTS exposing archived records through normal search;
- Skill installation overwriting unowned or modified files without explicit force;
- package contents including credentials, databases, or machine-specific private data;
- unexpected runtime network communication;
- privilege-boundary or permission failures beyond documented platform limitations;
- a future MCP adapter exposing CRM data without its intended authorization checks.

This list is not exhaustive. If uncertain, report privately.

## Issues generally not considered vulnerabilities

The following normally match the documented trust model unless they demonstrate a separate bypass:

- a local administrator, root user, or same-privilege process reading the unencrypted SQLite database;
- a user intentionally giving a trusted agent or model access to CRM data;
- CRM-derived information being sent through a messaging/model provider the user configured;
- direct database modification by its filesystem owner;
- disclosure through shell history after placing sensitive values directly in command arguments;
- archived data remaining in records, history, or backups;
- lack of permanent per-record deletion in `0.1.x`;
- denial of service requiring unrestricted local disk or memory access outside documented input limits;
- unsupported Node.js versions or modified package builds;
- model-quality issues that do not bypass deterministic CLI validation;
- missing features, including encryption, synchronization, MCP, or graphical UI;
- dependency-version reports with no plausible impact on the shipped runtime path.

Report ordinary bugs through GitHub Issues using fake or redacted data.

## Local-first boundary

Agent CRM `0.1.x` does not run a server or initiate network requests. npm uses the network during package installation, and agent hosts may contact model providers or messaging services independently.

The database is not encrypted by Agent CRM. POSIX permission hardening and `doctor` checks reduce accidental local exposure but do not protect against root, equivalent local processes, compromised agent hosts, or copied backups.

A future remote MCP gateway changes this boundary and requires a separate security review. No such gateway is included in `0.1.0`.

## Handling potentially sensitive evidence

Before sharing evidence:

- reproduce with a new temporary database when possible;
- replace names, emails, domains, phone numbers, and notes with fake values;
- remove API keys, tokens, cookies, model credentials, and environment variables;
- remove absolute home paths and session identifiers unless essential;
- prefer a minimal command and fixture over a complete database;
- encrypt any sensitive attachment using a method agreed through the private report.

Immutable events may contain before/after values, actor/source labels, working directory, idempotency keys, and an optional Pi session ID. Native exports include history by default. Inspect and sanitize them before sharing.

## Research guidelines and safe harbor

We support good-faith security research that:

- uses repositories, packages, accounts, and data the researcher owns or is authorized to test;
- uses synthetic CRM data;
- avoids privacy violations and service disruption;
- stops after confirming the minimum necessary impact;
- does not retain, publish, or exploit other people's data;
- reports findings privately and allows reasonable remediation time;
- complies with applicable law.

The project does not currently operate hosted infrastructure or offer a bug bounty. This policy does not authorize testing GitHub, npm, Telegram, model providers, or other third-party services. Follow each provider's own security policy.

For research conducted within these guidelines, the maintainers will not pursue action solely because the researcher bypassed an Agent CRM control to demonstrate and privately report a vulnerability. This statement cannot authorize activity on systems or data the maintainers do not own.

## Verifying releases

Before upgrading:

- obtain the package from the documented npm package or GitHub release;
- review the release notes for security and database-format changes;
- create and test a protected native backup;
- keep the CLI and managed Agent Skill on compatible versions;
- run `agentcrm doctor --json` after upgrade.

Security releases will identify the first fixed version. Avoid copying unverified replacement binaries or Skills from issue comments.
