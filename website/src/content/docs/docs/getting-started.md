---
title: Getting started
description: Install Agent CRM from npm and try fake data in an isolated local database.
---

:::note[Published package and main]
These instructions are for the published **agent-crm 0.1.0** npm package. Pages that preview behavior planned for a later release are labelled. This is experimental software, so use fake data first and back up important data.
:::

## Install from npm

Install **Node.js 24** and npm. No external SQLite server or native SQLite npm package is needed. Then install the published package in a trusted local terminal:

```bash
npm install --global agent-crm
agentcrm --version
agentcrm --help
```

Installing the npm package does not initialize a database or modify an agent profile.

## Try an isolated database

The following shell examples use **Bash on Linux/macOS**. On Windows, use PowerShell with an explicit temporary absolute `--db` path for every invocation; do not paste Bash environment assignments into PowerShell.

```bash
export AGENTCRM_DB="$(mktemp -d -t agentcrm-trial-XXXXXX)/crm.db"
node dist/cli.js init --json
node dist/cli.js doctor --json
node dist/cli.js schema show person --json
node dist/cli.js search "ana@example.com" --object person --json
node dist/cli.js --idempotency-key trial-ana-v1 record create person \
  --values '{"name":"Ana","email":"ana@example.com","role":"CTO"}' --json
node dist/cli.js search "Ana" --object person --json
```

Use fake data only. Inspect both the process status and JSON `ok`; retain the full returned record ID. The temporary database remains on disk until you intentionally remove it. `unset AGENTCRM_DB` ends this shell's selection but does not delete data.

Continue to [agent and profile setup](/docs/agent-setup/). A background gateway may have a different `PATH` from this terminal.
