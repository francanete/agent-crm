---
title: Agents, profiles & databases
description: Choose a local database and install the bundled Skill only into intended agent profiles.
---

:::caution[Next-release preview]
The profile and database-binding behavior on this page is planned for the next npm release and is not part of 0.1.0. Administer Skills in a trusted local terminal, not an ordinary agent conversation.
:::

## Choose the database deliberately

Selection precedence is **`--db` → `AGENTCRM_DB` → platform default**. Use an absolute path you control. The [CLI reference lists platform defaults](/docs/cli-reference/#database-path-precedence).

For a disposable Bash trial, use a temporary directory and preview without writing:

```bash
export AGENTCRM_DB="$(mktemp -d -t agentcrm-setup-XXXXXX)/crm.db"
agentcrm --db "$AGENTCRM_DB" setup plan --json
```

Review the resolved path, proposed Skill destinations, previous database bindings, and privacy notice. Planning creates neither a database nor a Skill directory.

To initialize **only this database**, without installing Skills:

```bash
agentcrm --db "$AGENTCRM_DB" setup apply --initialize --no-skill --yes --json
agentcrm --db "$AGENTCRM_DB" doctor --json
```

## Select a host and profile

`agentcrm setup` offers guided terminal-only confirmation. For explicit automation, use the plan/apply workflow from the [authoritative setup reference](/docs/cli-reference/#setup). Only apply after the local administrator approves the exact database and hosts; `--yes` confirms supplied actions, not every host.

| Host | Skill location | Reload |
| --- | --- | --- |
| Pi | `~/.agents/skills` | Fresh session |
| Hermes | `$HERMES_HOME/skills`, otherwise `~/.hermes/skills` | Fresh session or gateway restart |
| Claude Code | `$CLAUDE_CONFIG_DIR/skills`, otherwise `~/.claude/skills` | Fresh session |

For Hermes, run setup in the intended profile's environment. `HERMES_HOME` identifies its active root, including a selected profile. **Do not assume your terminal and gateway use the same profile.** Pi and Hermes have prior direct-agent acceptance coverage; Claude Code is a candidate requiring clean-host acceptance before being called verified.

Setup binds the selected Skill to the resolved absolute database path. This is **agent guidance, not automatic discovery by bare CLI commands**. The agent must supply the bound `--db` on every invocation, including `init` and `doctor`. Direct manual installs are generic unless preserving a previous managed binding.

Setup does not edit `PATH`, environment variables, service files, or gateway configuration, and never restarts a host. It protects modified or unowned Skills; review conflicts rather than forcing replacement by default.

## Shared gateway warning

Different chat identities on one gateway may share the selected database. Agent CRM does not provide per-chat authorization or automatic identity-to-profile mapping. Enable it only where that sharing is intentional. Read [privacy and security](/docs/privacy-security/#agent-and-model-privacy) before storing real data.
