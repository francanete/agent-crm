---
title: Getting started
description: Build unreleased Agent CRM from source and try fake data in an isolated database.
---

:::caution[Unreleased main, not npm 0.1.0]
These guides include fixes newer than the published package. The package version still reads 0.1.0 on main, so `--version` alone cannot distinguish them. Record `git rev-parse HEAD` when testing. This is experimental software, not a production-readiness guarantee.
:::

## Build from source

Install **Node.js 24** and npm. No external SQLite server or native SQLite npm package is needed. In a trusted local terminal:

```bash
git clone https://github.com/francanete/agent-crm.git
cd agent-crm
git switch main
git rev-parse HEAD
npm ci
npm run build
node dist/cli.js --help
```

The examples below use the compiled CLI directly, from the repository root. They do not install a Skill or modify an agent profile.

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

## Make the source build available to an agent

An agent's process needs the executable on its `PATH`. To install the source build (rather than the older registry release), from the repository root:

```bash
npm pack
npm install --global ./agent-crm-0.1.0.tgz
agentcrm --help
```

A global install changes your npm prefix, but does not initialize a database or install Skills. Inspect the package and use your normal Node installation permissions; do not blindly add `sudo`. If the package version changes, use the tarball filename printed by `npm pack`.

Continue to [agent and profile setup](/docs/agent-setup/). A background gateway may have a different `PATH` from this terminal.
