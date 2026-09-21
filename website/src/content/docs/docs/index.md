---
title: Relationship memory, on your machine
description: A practical guide to the experimental Agent CRM CLI for shell-capable agents.
---

Agent CRM is a **local-first, schema-aware relationship database for shell-capable AI agents**. It is a CLI backed by SQLite, not a hosted app or an agent itself. There is no account, CRM server, synchronization service, or runtime network dependency.

:::caution[These docs track unreleased main]
The published npm package is **0.1.0**. Some pages also document newer fixes and setup behavior from unreleased `main`; those pages are labelled. CLI and database formats are experimental and may change before 1.0. Back up important data before upgrades.
:::

## A short path to your first record

1. [Install the npm package and try a temporary database](/docs/getting-started/).
2. [Select an agent profile and bind its database](/docs/agent-setup/).
3. [Search, remember, and prepare with context](/docs/workflows/).
4. Read the [privacy boundary](/docs/privacy-security/) and establish [tested backups](/docs/import-export/) before using real data.

## What you get

People, organizations, interactions, and follow-ups are built in. Typed custom objects and fields, directed relationships, FTS5 search, immutable mutation history, and exact-retry idempotency extend the same local store.

The [CLI reference](/docs/cli-reference/), [CSV guide](/docs/csv-import/), [backup guide](/docs/import-export/), and [privacy guide](/docs/privacy-security/) are rendered from the repository's authoritative documents at build time—not separately maintained copies.

## What you do not get

No hosted dashboard, MCP server, automatic duplicate merge, embeddings, or cloud sync. Your agent host may still send retrieved data to a model provider or messaging channel. Local storage is **not** a promise that all agent activity is private.

[Read the architecture](https://github.com/francanete/agent-crm/blob/main/docs/architecture.md) · [Return to the homepage](/)
