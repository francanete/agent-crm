# ADR 0001: SQLite as the system of record

- Status: Accepted
- Date: 2026-09-01

## Decision

Use the built-in Node.js `node:sqlite` module and one local SQLite database as the system of
record. Use direct prepared SQL rather than an ORM.

## Consequences

The application has no database server or native npm database dependency. Physical schema
changes require tested migrations. Logical custom objects and fields remain rows in generic
tables.
