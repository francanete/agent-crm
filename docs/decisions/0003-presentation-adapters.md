# ADR 0003: Keep presentation adapters separate from domain output

- Status: accepted
- Date: 2026-09-01

## Context

Agent CRM is consumed by shell-capable agents in unknown user-facing channels, including terminals, Telegram, Discord, web applications, voice interfaces, and future MCP hosts. These channels have different rendering capabilities. Returning channel-specific markup from the core CLI would couple CRM behavior to transports it does not control, while returning an unsupported declarative UI payload risks exposing raw JSON to users.

Emerging protocols provide useful patterns:

- [A2UI](https://a2ui.org/introduction/what-is-a2ui/) defines declarative, catalog-constrained UI rendered with trusted native client components. Its current stable protocol family is v0.9.1 and v1.0 is a release candidate, but the project remains an early public preview.
- [AG-UI](https://docs.ag-ui.com/concepts/generative-ui-specs) is an event-based agent/user transport that can carry A2UI and other UI formats; it is not itself a UI description format.
- [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) provides sandboxed interactive HTML resources for MCP hosts and is appropriate when a server owns a rich web experience.
- [Adaptive Cards](https://learn.microsoft.com/en-us/adaptive-cards/authoring-cards/getting-started) demonstrates the established host-rendered JSON card pattern.

A2UI's MCP guidance also establishes two important compatibility patterns: negotiate supported catalogs before sending rich UI, and return typed UI resources alongside readable text fallback.

## Decision

1. Agent CRM domain services and stable CLI JSON envelopes remain the canonical source of truth.
2. The CLI does not emit generative UI unsolicited and does not embed presentation state in SQLite.
3. Rich presentation is implemented later as an optional adapter above domain services, alongside the CLI and future MCP adapters.
4. A2UI is the preferred first experimental wire format, but it is not a required core dependency while the standard is evolving.
5. Presentation adapters use declarative, versioned, schema-validated payloads and trusted component catalogs. They never execute model-generated UI code.
6. Rich UI is sent only after the receiving host declares compatible capabilities. Unsupported or unknown capability means plain text or channel-native agent output.
7. Every rich presentation has a concise human-readable fallback. Raw domain or UI JSON is shown only when a user explicitly requests JSON or debugging output.
8. Actions are declarative intents mapped by trusted adapter code to existing validated Agent CRM operations. They never contain generated shell commands.
9. MCP remains optional. Local MCP servers bind locally by default and use the same domain services; exposing a local CRM to a remote hosted client requires a separate explicit security and privacy decision.

## Initial adapter scope

The first renderer experiment should cover only:

- record detail;
- record collections and search results;
- context/history timelines;
- CSV dry-run validation reports.

This is enough to validate capability negotiation, fallback, actions, and channel adaptation before expanding the component catalog.

## Consequences

- Existing CLI and database contracts remain stable and do not block future UI work.
- Telegram/Hermes can continue using natural language immediately without a renderer.
- A future MCP or channel adapter can call framework-independent core services rather than shelling out to the CLI.
- Native rich UI requires host support or a channel-specific renderer; Agent CRM alone cannot guarantee rendering.
- A hosted MCP gateway would change the local-only threat model and must be opt-in rather than part of the default runtime.
