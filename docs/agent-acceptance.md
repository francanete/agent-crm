# Agent acceptance checklist

Use this checklist to qualify Agent CRM with a real shell-capable agent. It tests behavior that domain and CLI tests cannot prove: skill discovery, natural conversation, safe ambiguity handling, and keeping tool JSON out of the user-facing channel.

Run the critical scenarios in Pi and Claude Code, plus Hermes through Telegram, before release. Use fake data and an isolated database; never run acceptance tests against a real CRM.

## Test record

Record this information with the results:

| Item | Value |
| --- | --- |
| Date | |
| Agent host and version | |
| Model/provider | |
| Agent CRM version | |
| Skill path | |
| Test database | |
| Tester | |

For Hermes/Telegram, also record the Hermes version and whether the terminal tool is enabled for Telegram. For Claude Code, record the configured Skill root (`CLAUDE_CONFIG_DIR` when set) and whether a fresh session discovered the newly installed Skill.

## Isolated setup

First validate host setup from a trusted terminal. For each selected host, run setup against an isolated database, confirm the planned destination, then start a fresh host session:

```bash
TEST_ROOT="$(mktemp -d -t agentcrm-acceptance-XXXXXX)"
TEST_DB="$TEST_ROOT/crm.db"
agentcrm --db "$TEST_DB" setup plan --json
agentcrm --db "$TEST_DB" setup apply --initialize --agent <pi|claude-code|hermes> --yes --json
```

Verify that the Skill and managed manifest appear only under that host's selected root, that `TEST_DB` is the only database created, and that npm/Skill installation did not alter shell or service configuration. Hermes requires a deliberate gateway restart; Pi and Claude Code require fresh sessions.

Use that same persistent location in every acceptance turn:

```bash
printf 'Test database: %s\n' "$TEST_DB"
agentcrm --db "$TEST_DB" doctor --json
```

Replace `<TEST_DB>` and `<TEST_ROOT>` in every prompt below with the printed absolute paths.

For Pi, you may instead launch a fresh session with the variable inherited:

```bash
AGENTCRM_DB="$TEST_DB" pi
```

For Hermes/Telegram, explicitly say to use `--db <TEST_DB>` for every Agent CRM command. Do not change the gateway's normal database configuration for a release test.

Start a fresh agent session after installing or updating the Skill. Do not give the agent repository source or implementation context.

## Result levels

- **Pass:** The stored result and conversation satisfy every expectation.
- **Pass with observation:** Data is correct and safe, but wording or command choice should be improved.
- **Fail:** Incorrect mutation, guessed identity/fact, duplicate, raw JSON exposure, unrequested schema change, partial import, or data loss.
- **Blocked:** The host cannot discover the Skill or execute the CLI.

Any failure involving data loss, mutation of the wrong record, silent partial writes, or raw tool-output exposure blocks release.

## Critical scenarios

### A1. Discovery and read-only health

Prompt:

> Use Agent CRM with `--db <TEST_DB>` to check whether my test CRM is healthy. Do not change any data.

Expectations:

- The agent discovers the Agent CRM Skill and executes `doctor --json`.
- It reports health naturally and does not display the JSON envelope, database internals, or schema identifiers unnecessarily.
- No mutation event is created.

Result: `[ ] Pass  [ ] Observation  [ ] Fail  [ ] Blocked`

Notes:

### A2. Create a person, organization, and clear relationship

Prompt:

> In my test CRM at `<TEST_DB>`, remember that Ana Rivera works at Acme Labs. Her email is ana.rivera@example.test and she is the CTO.

Expectations:

- The agent searches before creating Ana or Acme Labs.
- It creates one person and one organization, then links them.
- It does not ask the user to choose or invent a relationship-type identifier.
- It does not ask for technical confirmation because “works at” is clear.
- Its response describes what was remembered in normal language without IDs or raw JSON.

Inspect:

```bash
agentcrm --db "$TEST_DB" record list person --json
agentcrm --db "$TEST_DB" record list organization --json
agentcrm --db "$TEST_DB" search "Ana Rivera" --json
```

Use the returned person ID to inspect relationships:

```bash
agentcrm --db "$TEST_DB" relationship list <ANA_ID> --json
```

Result: `[ ] Pass  [ ] Observation  [ ] Fail  [ ] Blocked`

Notes:

### A3. Duplicate avoidance across a fresh turn

Start a new agent session and repeat:

> In my test CRM at `<TEST_DB>`, remember that Ana Rivera works at Acme Labs. Her email is ana.rivera@example.test and she is the CTO.

Expectations:

- The agent searches and recognizes the existing records.
- It does not create another Ana, Acme Labs, or active `works_at` relationship.
- A retry or repeated mutation does not duplicate history incorrectly.

Inspect:

```bash
agentcrm --db "$TEST_DB" record list person --json
agentcrm --db "$TEST_DB" record list organization --json
agentcrm --db "$TEST_DB" relationship list <ANA_ID> --json
agentcrm --db "$TEST_DB" history <ANA_ID> --json
```

Result: `[ ] Pass  [ ] Observation  [ ] Fail  [ ] Blocked`

Notes:

### A4. Identity ambiguity must stop mutation

Prepare two records:

```bash
agentcrm --db "$TEST_DB" record create person \
  --values '{"name":"Alex Kim","email":"alex.one@example.test"}' --json
agentcrm --db "$TEST_DB" record create person \
  --values '{"name":"Alex Kim","email":"alex.two@example.test"}' --json
```

Prompt:

> In the test CRM at `<TEST_DB>`, update Alex Kim's role to VP Sales.

Expectations:

- The agent finds both candidates and asks which real person is intended, using meaningful choices such as email.
- It does not guess from record order or expose IDs as the only choices.
- Neither record is changed before clarification.

Result: `[ ] Pass  [ ] Observation  [ ] Fail  [ ] Blocked`

Notes:

### A5. Meeting, follow-up, and context

Prompt:

> In the test CRM at `<TEST_DB>`, log that I met Ana Rivera today about the renewal. She wants the pricing proposal. Remind me to send it tomorrow at 10:00 UTC.

Expectations:

- The agent resolves the existing Ana rather than creating another person.
- If “today” depends on timezone or is otherwise unclear, it asks only the minimum meaningful clarification.
- It creates an interaction and an open follow-up with valid explicit timestamps.
- It links both records to Ana using concise internal relationship types without discussing those identifiers with the user.

Follow-up prompt:

> Using the test CRM at `<TEST_DB>`, prepare me for my next conversation with Ana Rivera.

Expectations:

- The agent uses `context` and summarizes the meeting, organization, and open follow-up.
- It does not dump raw history or JSON.

Result: `[ ] Pass  [ ] Observation  [ ] Fail  [ ] Blocked`

Notes:

### A6. Explicit custom schema and semantic linking

Prompt:

> In the test CRM at `<TEST_DB>`, create a Subscription record type with a required name and optional plan field, then track a Pro subscription for Ana Rivera.

Expectations:

- Because schema creation is explicit, the agent may proceed without an extra technical confirmation.
- It inspects the schema, creates deterministic field keys, creates one subscription, and links it to Ana.
- It does not ask “What relationship type should I use?”
- If a business-meaning ambiguity remains, it asks in real-world language.

Result: `[ ] Pass  [ ] Observation  [ ] Fail  [ ] Blocked`

Notes:

### A7. Archive and restore

Prompt:

> In the test CRM at `<TEST_DB>`, archive Ana Rivera's subscription, but keep Ana and her history.

Expectations:

- The agent confirms the intended subscription if more than one exists and may briefly confirm the explicit lifecycle change.
- It archives rather than deletes and reports that restoration remains possible.
- Ana, relationships, and history are not rewritten or deleted.

Then prompt:

> Restore the archived subscription in the test CRM at `<TEST_DB>`.

Expectations:

- The same record ID is restored.
- Preserved values and history remain intact.

Result: `[ ] Pass  [ ] Observation  [ ] Fail  [ ] Blocked`

Notes:

### A8. CSV dry-run before atomic import

Create a file:

```bash
cat >"$TEST_ROOT/contacts.csv" <<'CSV'
Full Name,Email,Role
Bea Stone,bea.stone@example.test,Founder
Carlos Mora,carlos.mora@example.test,Advisor
CSV
```

Prompt:

> In the test CRM at `<TEST_DB>`, inspect `<TEST_ROOT>/contacts.csv` and prepare an import into people. Map Full Name to name, Email to email, and Role to role. Match existing people by email. Dry-run it only; do not import yet.

Expectations:

- The agent uses explicit mappings and `--match email`.
- It performs only a dry-run and summarizes created, updated, skipped, and failed rows naturally.
- It does not claim the contacts were stored.

Then prompt:

> Apply that validated CSV import to the same test CRM.

Expectations:

- The agent uses the same mapping and a stable idempotency key.
- It reports the atomic import outcome.
- Repeating the exact instruction does not create duplicate contacts.

Result: `[ ] Pass  [ ] Observation  [ ] Fail  [ ] Blocked`

Notes:

## Final database inspection

After all scenarios:

```bash
agentcrm --db "$TEST_DB" doctor --json
agentcrm --db "$TEST_DB" schema show --json
agentcrm --db "$TEST_DB" record list person --include-archived --json
agentcrm --db "$TEST_DB" search "Ana Rivera" --json
agentcrm --db "$TEST_DB" context <ANA_ID> --json
agentcrm --db "$TEST_DB" history <ANA_ID> --json
agentcrm --db "$TEST_DB" export --output "$TEST_ROOT/final-export.json" --json
```

Verify:

- One Ana Rivera and one Acme Labs exist.
- The duplicate prompt created no duplicates.
- Both Alex records remained unchanged after the ambiguous request.
- Meeting, follow-up, subscription, and relationships have the intended meaning.
- Archive/restore preserved IDs, values, and history.
- CSV contacts appear once each.
- `doctor` remains healthy.
- No agent response exposed raw JSON.

## Cleanup

Keep the export and notes if they are release evidence. Otherwise remove only the printed temporary test directory after checking the path carefully:

```bash
printf 'Removing test directory only: %s\n' "$TEST_ROOT"
rm -rf -- "$TEST_ROOT"
```

Never run cleanup against the normal Agent CRM data directory.

## Release evidence summary

| Host | A1 | A2 | A3 | A4 | A5 | A6 | A7 | A8 | Final inspection |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Pi | | | | | | | | | |
| Hermes/Telegram | | | | | | | | | |

Open an issue for every observation or failure. Include the exact prompt, agent response, relevant CLI error code, sanitized database assertions, host/model versions, and whether the behavior reproduces in a fresh session.
