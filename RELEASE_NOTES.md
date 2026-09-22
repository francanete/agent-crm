# Agent CRM 0.1.1

Draft GitHub release notes — not yet published.

## Setup improvements

- Add consent-based, host-aware setup with interactive prompts and deterministic `setup plan` / `setup apply` commands.
- Bind setup-installed Agent Skills to the selected CRM database, including explicit guidance for custom paths.
- Respect the active Hermes home and profile when selecting the Skill installation directory.

## Safety and reliability

- Fix data loss during concurrent database initialization.
- Prevent exports from overwriting aliased CRM database files.
- Publish exports atomically without clobbering concurrently created files.
- Prevent Skill uninstall through unsafe directory aliases.
- Ignore inherited properties when normalizing record fields.
- Improve CRM integrity checks and regression coverage.

## Documentation

- Add a public product website and documentation.
- Expand setup, database-binding, and safety guidance.

## Install or upgrade

After publication:

```bash
npm install --global agent-crm@0.1.1
agentcrm --version
```

Back up important CRM data before upgrading. To refresh managed Skills, run `agentcrm setup` with the intended database selection and review the proposed changes before confirming.

Agent CRM remains experimental. Node.js 24 or newer is required. Claude Code Skill discovery is not yet verified by clean-host acceptance testing.

**Full comparison:** https://github.com/francanete/agent-crm/compare/v0.1.0...v0.1.1
