# ADR 0002: CLI-first agent integration

- Status: Accepted
- Date: 2026-09-01

## Decision

Expose deterministic domain operations through a CLI with a stable JSON envelope. Agents use
shell access and a portable Agent Skill; the application does not embed a language model.

## Consequences

The domain layer must remain independent from Commander and output formatting. Human text is a
convenience interface, while JSON is the versioned machine contract. MCP remains an optional
adapter after the CLI is stable.
