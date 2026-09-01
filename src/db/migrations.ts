import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../core/errors.js';
import { now } from '../core/time.js';
import { inImmediateTransaction } from './transaction.js';

export const CURRENT_DATABASE_VERSION = 1;

const initialSchema = `
CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE object_types (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  plural_label TEXT NOT NULL,
  description TEXT,
  title_field_key TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  system INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE field_definitions (
  id TEXT PRIMARY KEY,
  object_type_id TEXT NOT NULL REFERENCES object_types(id),
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,
  format TEXT,
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  options_json TEXT CHECK (options_json IS NULL OR json_valid(options_json)),
  default_value_json TEXT CHECK (default_value_json IS NULL OR json_valid(default_value_json)),
  position INTEGER NOT NULL DEFAULT 0,
  system INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE(object_type_id, key)
);
CREATE INDEX field_definitions_object_idx ON field_definitions(object_type_id);

CREATE TABLE records (
  id TEXT PRIMARY KEY,
  object_type_id TEXT NOT NULL REFERENCES object_types(id),
  display_name TEXT NOT NULL,
  values_json TEXT NOT NULL CHECK (json_valid(values_json) AND json_type(values_json) = 'object'),
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX records_object_idx ON records(object_type_id, archived_at);
CREATE INDEX records_display_name_idx ON records(display_name);
CREATE INDEX records_updated_idx ON records(updated_at);

CREATE TABLE relationships (
  id TEXT PRIMARY KEY,
  source_record_id TEXT NOT NULL REFERENCES records(id),
  target_record_id TEXT NOT NULL REFERENCES records(id),
  type TEXT NOT NULL,
  properties_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(properties_json) AND json_type(properties_json) = 'object'
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  CHECK (source_record_id <> target_record_id)
);
CREATE INDEX relationships_source_idx ON relationships(source_record_id, archived_at);
CREATE INDEX relationships_target_idx ON relationships(target_record_id, archived_at);
CREATE INDEX relationships_type_idx ON relationships(type);
CREATE UNIQUE INDEX relationships_active_unique_idx
  ON relationships(source_record_id, target_record_id, type)
  WHERE archived_at IS NULL;

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  source TEXT,
  idempotency_key TEXT,
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(metadata_json) AND json_type(metadata_json) = 'object'
  ),
  created_at TEXT NOT NULL
);
CREATE INDEX events_subject_idx ON events(subject_type, subject_id, created_at);
CREATE INDEX events_created_idx ON events(created_at);
CREATE UNIQUE INDEX events_idempotency_unique_idx
  ON events(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TRIGGER events_no_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are immutable');
END;

CREATE TRIGGER events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are immutable');
END;

CREATE VIRTUAL TABLE records_fts USING fts5(
  record_id UNINDEXED,
  object_key UNINDEXED,
  display_name,
  content
);
`;

function tableExists(database: DatabaseSync, table: string): boolean {
  const row = database
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { present: number } | undefined;
  return row?.present === 1;
}

export function readDatabaseVersion(database: DatabaseSync): number | null {
  if (!tableExists(database, 'metadata')) return null;
  const row = database.prepare("SELECT value FROM metadata WHERE key = 'database_version'").get() as
    | { value: string }
    | undefined;
  if (!row || !/^\d+$/.test(row.value)) {
    throw new AppError('DATABASE_INVALID', 'Database metadata is missing a valid version');
  }
  return Number(row.value);
}

export function validateExistingDatabase(database: DatabaseSync): number {
  const version = readDatabaseVersion(database);
  if (version === null) {
    throw new AppError('DATABASE_INVALID', 'The file is not an Agent CRM database');
  }
  const instance = database.prepare("SELECT value FROM metadata WHERE key = 'instance_id'").get();
  if (!instance) {
    throw new AppError('DATABASE_INVALID', 'Database metadata is missing an instance ID');
  }
  if (version > CURRENT_DATABASE_VERSION) {
    throw new AppError(
      'DATABASE_VERSION_UNSUPPORTED',
      `Database version ${version} is newer than supported version ${CURRENT_DATABASE_VERSION}`,
      { databaseVersion: version, supportedVersion: CURRENT_DATABASE_VERSION },
    );
  }
  return version;
}

export function applyMigrations(database: DatabaseSync, startingVersion: number): number {
  if (startingVersion > CURRENT_DATABASE_VERSION) {
    throw new AppError('DATABASE_VERSION_UNSUPPORTED', 'The database version is unsupported');
  }

  let version = startingVersion;
  if (version < 1) {
    inImmediateTransaction(database, () => {
      database.exec(initialSchema);
      const insert = database.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)');
      insert.run('database_version', '1');
      insert.run('created_at', now());
      insert.run('instance_id', randomUUID());
    });
    version = 1;
  }

  return version;
}
