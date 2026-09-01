import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { CURRENT_DATABASE_VERSION, readDatabaseVersion } from '../db/migrations.js';

export type DoctorStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface DoctorResult {
  healthy: boolean;
  database: string;
  databaseVersion: number;
  supportedDatabaseVersion: number;
  sqliteVersion: string;
  checks: DoctorCheck[];
}

interface CountRow {
  count: number;
}

function count(database: DatabaseSync, sql: string): number {
  return (database.prepare(sql).get() as unknown as CountRow).count;
}

function permissionsCheck(databasePath: string): DoctorCheck {
  if (process.platform === 'win32') {
    return {
      name: 'permissions',
      status: 'pass',
      message: 'POSIX permission checks do not apply on Windows',
    };
  }

  const mode = fs.statSync(databasePath).mode & 0o777;
  const permissive = (mode & 0o077) !== 0;
  return {
    name: 'permissions',
    status: permissive ? 'warn' : 'pass',
    message: permissive
      ? 'The database is readable or writable by group/other users'
      : 'Database permissions are restrictive',
    details: { mode: mode.toString(8).padStart(3, '0'), recommended: '600' },
  };
}

function migrationCheck(database: DatabaseSync): DoctorCheck {
  const version = readDatabaseVersion(database) ?? 0;
  if (version < CURRENT_DATABASE_VERSION) {
    return {
      name: 'migrations',
      status: 'warn',
      message: 'Pending migrations will be applied by the next database-backed command',
      details: { databaseVersion: version, supportedVersion: CURRENT_DATABASE_VERSION },
    };
  }
  return {
    name: 'migrations',
    status: 'pass',
    message: 'Database migrations are current',
    details: { databaseVersion: version },
  };
}

function foreignKeysCheck(database: DatabaseSync): DoctorCheck {
  const problems = database.prepare('PRAGMA foreign_key_check').all() as unknown[];
  return {
    name: 'foreignKeys',
    status: problems.length === 0 ? 'pass' : 'fail',
    message:
      problems.length === 0
        ? 'Foreign key integrity check passed'
        : 'Foreign key integrity check found violations',
    ...(problems.length === 0 ? {} : { details: { violations: problems } }),
  };
}

function ftsCheck(database: DatabaseSync): DoctorCheck {
  try {
    const indexed = count(database, 'SELECT COUNT(*) AS count FROM records_fts');
    const active = count(
      database,
      'SELECT COUNT(*) AS count FROM records WHERE archived_at IS NULL',
    );
    const missing = count(
      database,
      `SELECT COUNT(*) AS count
       FROM records r
       LEFT JOIN records_fts f ON f.record_id = r.id
       WHERE r.archived_at IS NULL AND f.record_id IS NULL`,
    );
    const extra = count(
      database,
      `SELECT COUNT(*) AS count
       FROM records_fts f
       LEFT JOIN records r ON r.id = f.record_id AND r.archived_at IS NULL
       WHERE r.id IS NULL`,
    );
    const duplicates = count(
      database,
      `SELECT COUNT(*) AS count FROM (
         SELECT record_id FROM records_fts GROUP BY record_id HAVING COUNT(*) <> 1
       )`,
    );
    const consistent = indexed === active && missing === 0 && extra === 0 && duplicates === 0;
    return {
      name: 'fts5',
      status: consistent ? 'pass' : 'fail',
      message: consistent
        ? 'FTS5 is available and the record index is consistent'
        : 'FTS5 record index is inconsistent',
      details: { activeRecords: active, indexedRecords: indexed, missing, extra, duplicates },
    };
  } catch {
    return {
      name: 'fts5',
      status: 'fail',
      message: 'FTS5 is unavailable or the record index cannot be read',
    };
  }
}

function defaultSchemaCheck(database: DatabaseSync): DoctorCheck {
  const expected = new Map([
    ['person', 'name'],
    ['organization', 'name'],
    ['interaction', 'summary'],
    ['followup', 'title'],
  ]);
  const rows = database
    .prepare(`
      SELECT o.key, o.title_field_key, o.archived_at, f.type, f.required, f.archived_at AS field_archived_at
      FROM object_types o
      LEFT JOIN field_definitions f
        ON f.object_type_id = o.id AND f.key = o.title_field_key
      WHERE o.key IN ('person', 'organization', 'interaction', 'followup')
    `)
    .all() as unknown as Array<{
    key: string;
    title_field_key: string;
    archived_at: string | null;
    type: string | null;
    required: number | null;
    field_archived_at: string | null;
  }>;

  const valid = rows.filter(
    (row) =>
      expected.get(row.key) === row.title_field_key &&
      row.archived_at === null &&
      row.type === 'text' &&
      row.required === 1 &&
      row.field_archived_at === null,
  );
  const missing = [...expected.keys()].filter((key) => !valid.some((row) => row.key === key));

  return {
    name: 'defaultSchema',
    status: missing.length === 0 ? 'pass' : 'warn',
    message:
      missing.length === 0
        ? 'Default objects and title fields are available'
        : 'Some default objects or title fields are unavailable',
    ...(missing.length === 0 ? {} : { details: { missingOrInvalid: missing } }),
  };
}

export function diagnoseDatabase(database: DatabaseSync, databasePath: string): DoctorResult {
  const sqliteRow = database.prepare('SELECT sqlite_version() AS version').get() as {
    version: string;
  };
  const databaseVersion = readDatabaseVersion(database) ?? 0;
  const checks = [
    permissionsCheck(databasePath),
    migrationCheck(database),
    foreignKeysCheck(database),
    ftsCheck(database),
    defaultSchemaCheck(database),
  ];

  return {
    healthy: checks.every((check) => check.status !== 'fail'),
    database: databasePath,
    databaseVersion,
    supportedDatabaseVersion: CURRENT_DATABASE_VERSION,
    sqliteVersion: sqliteRow.version,
    checks,
  };
}
