import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import { inImmediateTransaction } from '../db/transaction.js';
import { requestHash } from './canonical.js';
import { AppError } from './errors.js';
import { appendMutationEvent } from './events.js';
import { findIdempotentReplay } from './idempotency.js';
import { describeSchema, getActiveObject } from './schema.js';
import { now } from './time.js';
import type { FieldDefinition, ObjectDefinition, RecordData } from './types.js';
import { validateAndNormalizeFieldValue } from './validation.js';

const valuesSchema = z.record(z.string(), z.unknown());

export interface StoredRecordRow {
  id: string;
  object_key: string;
  display_name: string;
  values_json: string;
  schema_version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface CreateRecordOptions {
  actor: string;
  source?: string;
  idempotencyKey?: string;
  cliVersion: string;
}

export interface CreateRecordResult extends RecordData {
  replayed: boolean;
}

export type UpdateRecordResult = CreateRecordResult;
export type RecordLifecycleResult = CreateRecordResult;

export interface UpsertRecordResult extends RecordData {
  outcome: 'created' | 'updated';
  replayed: boolean;
}

function normalizeValues(
  fields: FieldDefinition[],
  input: Record<string, unknown>,
  applyDefaults = true,
): Record<string, unknown> {
  const activeFields = fields.filter((field) => field.archivedAt === null);
  const fieldsByKey = new Map(fields.map((field) => [field.key, field]));

  for (const key of Object.keys(input)) {
    const field = fieldsByKey.get(key);
    if (!field || field.archivedAt !== null) {
      throw new AppError('UNKNOWN_FIELD', `Field '${key}' is not an active field`, { field: key });
    }
  }

  const values: Record<string, unknown> = {};
  for (const field of activeFields) {
    let value = input[field.key];
    const supplied = Object.hasOwn(input, field.key);

    if (
      applyDefaults &&
      (!supplied || value === undefined) &&
      Object.hasOwn(field, 'defaultValue')
    ) {
      value = field.defaultValue;
    }

    if (!supplied && value === undefined) {
      if (field.required) {
        throw new AppError('REQUIRED_FIELD_MISSING', `Required field '${field.key}' is missing`, {
          field: field.key,
        });
      }
      continue;
    }

    if (value === null || value === undefined) {
      if (field.required) {
        throw new AppError('REQUIRED_FIELD_MISSING', `Required field '${field.key}' is missing`, {
          field: field.key,
        });
      }
      continue;
    }

    values[field.key] = validateAndNormalizeFieldValue(field, value);
  }
  return values;
}

function flattenSearchValue(value: unknown, output: string[], depth = 0): void {
  if (depth > 20 || value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    output.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) flattenSearchValue(entry, output, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      flattenSearchValue(entry, output, depth + 1);
    }
  }
}

export function mapStoredRecord(row: StoredRecordRow): RecordData {
  return {
    id: row.id,
    object: row.object_key,
    displayName: row.display_name,
    values: JSON.parse(row.values_json) as Record<string, unknown>,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function parseInputValues(input: unknown): Record<string, unknown> {
  const parsed = valuesSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 'Record values must be a JSON object', {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

export function createRecord(
  database: DatabaseSync,
  objectKey: string,
  rawValues: unknown,
  options: CreateRecordOptions,
): CreateRecordResult {
  const object = getActiveObject(database, objectKey);
  const input = parseInputValues(rawValues);
  const values = normalizeValues(object.fields, input);
  const displayName = values[object.titleFieldKey];
  if (typeof displayName !== 'string' || displayName.trim().length === 0) {
    throw new AppError('REQUIRED_FIELD_MISSING', 'The title field must contain non-blank text', {
      field: object.titleFieldKey,
    });
  }

  const hash = requestHash({
    operation: 'record.create',
    object: object.key,
    values,
    actor: options.actor,
    source: options.source ?? null,
  });

  return inImmediateTransaction(database, () => {
    if (options.idempotencyKey) {
      const existing = database
        .prepare('SELECT metadata_json FROM events WHERE idempotency_key = ?')
        .get(options.idempotencyKey) as { metadata_json: string } | undefined;
      if (existing) {
        const metadata = JSON.parse(existing.metadata_json) as {
          requestHash?: string;
          result?: RecordData;
        };
        if (metadata.requestHash !== hash || !metadata.result) {
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            'The idempotency key was already used for a different operation',
            { idempotencyKey: options.idempotencyKey },
          );
        }
        return { ...metadata.result, replayed: true };
      }
    }

    const timestamp = now();
    const record: RecordData = {
      id: randomUUID(),
      object: object.key,
      displayName,
      values,
      schemaVersion: object.schemaVersion,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    };

    database
      .prepare(`
        INSERT INTO records(
          id, object_type_id, display_name, values_json, schema_version,
          created_at, updated_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      `)
      .run(
        record.id,
        object.id,
        record.displayName,
        JSON.stringify(record.values),
        record.schemaVersion,
        record.createdAt,
        record.updatedAt,
      );

    const searchParts: string[] = [];
    for (const field of object.fields.filter((entry) => entry.archivedAt === null)) {
      if (Object.hasOwn(values, field.key)) flattenSearchValue(values[field.key], searchParts);
    }
    database
      .prepare(
        'INSERT INTO records_fts(record_id, object_key, display_name, content) VALUES (?, ?, ?, ?)',
      )
      .run(record.id, object.key, record.displayName, searchParts.join(' '));

    const metadata: Record<string, unknown> = {
      operation: 'record.create',
      requestHash: hash,
      result: record,
      cliVersion: options.cliVersion,
      workingDirectory: process.cwd(),
    };
    if (process.env.PI_SESSION_ID) metadata.piSessionId = process.env.PI_SESSION_ID;

    database
      .prepare(`
        INSERT INTO events(
          id, subject_type, subject_id, action, actor, source, idempotency_key,
          before_json, after_json, metadata_json, created_at
        ) VALUES (?, 'record', ?, 'created', ?, ?, ?, NULL, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        record.id,
        options.actor,
        options.source ?? null,
        options.idempotencyKey ?? null,
        JSON.stringify(record),
        JSON.stringify(metadata),
        timestamp,
      );

    return { ...record, replayed: false };
  });
}

export function updateRecord(
  database: DatabaseSync,
  idPrefix: string,
  rawValues: unknown,
  options: CreateRecordOptions,
): UpdateRecordResult {
  const patch = parseInputValues(rawValues);

  return inImmediateTransaction(database, () => {
    const current = getRecord(database, idPrefix);
    const hash = requestHash({
      operation: 'record.update',
      recordId: current.id,
      values: patch,
      actor: options.actor,
      source: options.source ?? null,
    });
    const replay = findIdempotentReplay<RecordData>(database, options.idempotencyKey, hash);
    if (replay) return { ...replay, replayed: true };
    if (current.archivedAt !== null) {
      throw new AppError('RECORD_ARCHIVED', `Record '${idPrefix}' is archived`, {
        id: current.id,
        archivedAt: current.archivedAt,
      });
    }

    const object = getActiveObject(database, current.object);
    const activeFields = object.fields.filter((field) => field.archivedAt === null);
    const activeKeys = new Set(activeFields.map((field) => field.key));
    for (const key of Object.keys(patch)) {
      if (!activeKeys.has(key)) {
        throw new AppError('UNKNOWN_FIELD', `Field '${key}' is not an active field`, {
          field: key,
        });
      }
    }

    const merged: Record<string, unknown> = {};
    const legacy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(current.values)) {
      if (activeKeys.has(key)) merged[key] = value;
      else legacy[key] = value;
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    const activeValues = normalizeValues(activeFields, merged, false);
    const values = { ...legacy, ...activeValues };
    const displayName = values[object.titleFieldKey];
    if (typeof displayName !== 'string' || displayName.trim().length === 0) {
      throw new AppError('REQUIRED_FIELD_MISSING', 'The title field must contain non-blank text', {
        field: object.titleFieldKey,
      });
    }

    const timestamp = now();
    const updated: RecordData = {
      ...current,
      displayName,
      values,
      schemaVersion: object.schemaVersion,
      updatedAt: timestamp,
    };
    database
      .prepare(`
        UPDATE records
        SET display_name = ?, values_json = ?, schema_version = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        updated.displayName,
        JSON.stringify(updated.values),
        updated.schemaVersion,
        updated.updatedAt,
        updated.id,
      );

    const searchParts: string[] = [];
    for (const field of activeFields) {
      if (Object.hasOwn(values, field.key)) flattenSearchValue(values[field.key], searchParts);
    }
    database.prepare('DELETE FROM records_fts WHERE record_id = ?').run(updated.id);
    database
      .prepare(
        'INSERT INTO records_fts(record_id, object_key, display_name, content) VALUES (?, ?, ?, ?)',
      )
      .run(updated.id, object.key, updated.displayName, searchParts.join(' '));

    const metadata: Record<string, unknown> = {
      operation: 'record.update',
      requestHash: hash,
      result: updated,
      cliVersion: options.cliVersion,
      workingDirectory: process.cwd(),
    };
    if (process.env.PI_SESSION_ID) metadata.piSessionId = process.env.PI_SESSION_ID;
    database
      .prepare(`
        INSERT INTO events(
          id, subject_type, subject_id, action, actor, source, idempotency_key,
          before_json, after_json, metadata_json, created_at
        ) VALUES (?, 'record', ?, 'updated', ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        updated.id,
        options.actor,
        options.source ?? null,
        options.idempotencyKey ?? null,
        JSON.stringify(current),
        JSON.stringify(updated),
        JSON.stringify(metadata),
        timestamp,
      );

    return { ...updated, replayed: false };
  });
}

function normalizeUpsertMatch(field: FieldDefinition, rawValue: unknown): unknown {
  let value = rawValue;
  if (typeof rawValue === 'string' && field.type === 'number') {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(rawValue)) {
      throw new AppError('INVALID_FIELD_VALUE', `Field '${field.key}' must be a finite number`, {
        field: field.key,
        value: rawValue,
      });
    }
    value = Number(rawValue);
  } else if (typeof rawValue === 'string' && field.type === 'boolean') {
    if (rawValue !== 'true' && rawValue !== 'false') {
      throw new AppError('INVALID_FIELD_VALUE', `Field '${field.key}' must be a boolean`, {
        field: field.key,
        value: rawValue,
      });
    }
    value = rawValue === 'true';
  }
  const normalized = validateAndNormalizeFieldValue(field, value);
  if (typeof normalized === 'string' && normalized.trim().length === 0) {
    throw new AppError('VALIDATION_ERROR', 'Upsert match values cannot be blank', {
      field: field.key,
    });
  }
  return normalized;
}

function matchSqlValue(value: unknown): SQLInputValue {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' || typeof value === 'number') return value;
  throw new AppError('VALIDATION_ERROR', 'Upsert match values must be scalar');
}

export function upsertRecord(
  database: DatabaseSync,
  objectKey: string,
  matchFieldKey: string,
  rawMatchValue: unknown,
  rawValues: unknown,
  options: CreateRecordOptions,
): UpsertRecordResult {
  const input = parseInputValues(rawValues);
  return inImmediateTransaction(database, () => {
    const object = describeSchema(database, objectKey)[0] as ObjectDefinition;
    const matchField = object.fields.find((field) => field.key === matchFieldKey);
    if (!matchField) {
      throw new AppError('UNKNOWN_FIELD', `Field '${matchFieldKey}' was not found`, {
        field: matchFieldKey,
      });
    }
    if (matchField.type === 'multi_select' || matchField.type === 'json') {
      throw new AppError(
        'VALIDATION_ERROR',
        `Field '${matchFieldKey}' cannot be used as an exact upsert match`,
        { field: matchFieldKey, type: matchField.type },
      );
    }
    const matchValue = normalizeUpsertMatch(matchField, rawMatchValue);
    if (Object.hasOwn(input, matchFieldKey)) {
      const inputMatch = validateAndNormalizeFieldValue(matchField, input[matchFieldKey]);
      if (JSON.stringify(inputMatch) !== JSON.stringify(matchValue)) {
        throw new AppError(
          'VALIDATION_ERROR',
          'The match field in record values must equal the --match value',
          { field: matchFieldKey },
        );
      }
    }
    const valuesInput = { ...input, [matchFieldKey]: matchValue };
    const hash = requestHash({
      operation: 'record.upsert',
      object: object.key,
      match: { field: matchFieldKey, value: matchValue },
      values: valuesInput,
      actor: options.actor,
      source: options.source ?? null,
    });
    const replay = findIdempotentReplay<UpsertRecordResult>(database, options.idempotencyKey, hash);
    if (replay) return { ...replay, replayed: true };
    if (object.archivedAt !== null) {
      throw new AppError('OBJECT_ARCHIVED', `Object '${objectKey}' is archived`, {
        object: objectKey,
        archivedAt: object.archivedAt,
      });
    }
    if (matchField.archivedAt !== null) {
      throw new AppError('FIELD_ARCHIVED', `Field '${matchFieldKey}' is archived`, {
        field: matchFieldKey,
        archivedAt: matchField.archivedAt,
      });
    }

    const matches = database
      .prepare(`
        SELECT r.*, object_type.key AS object_key
        FROM records r
        JOIN object_types object_type ON object_type.id = r.object_type_id
        WHERE r.object_type_id = ?
          AND json_type(r.values_json, '$.${matchFieldKey}') IS NOT NULL
          AND json_extract(r.values_json, '$.${matchFieldKey}') = ?
        ORDER BY r.id ASC
        LIMIT 3
      `)
      .all(object.id, matchSqlValue(matchValue)) as unknown as StoredRecordRow[];
    if (matches.length > 1) {
      throw new AppError(
        'MULTIPLE_UPSERT_MATCHES',
        `Exact match on '${matchFieldKey}' found multiple records`,
        {
          object: object.key,
          field: matchFieldKey,
          matches: matches.map((row) => ({ id: row.id, archivedAt: row.archived_at })),
        },
      );
    }

    const matchedRow = matches[0];
    const timestamp = now();
    let before: RecordData | null = null;
    let record: RecordData;
    let outcome: UpsertRecordResult['outcome'];
    if (!matchedRow) {
      const values = normalizeValues(object.fields, valuesInput);
      const displayName = values[object.titleFieldKey];
      if (typeof displayName !== 'string' || displayName.trim().length === 0) {
        throw new AppError(
          'REQUIRED_FIELD_MISSING',
          'The title field must contain non-blank text',
          { field: object.titleFieldKey },
        );
      }
      record = {
        id: randomUUID(),
        object: object.key,
        displayName,
        values,
        schemaVersion: object.schemaVersion,
        createdAt: timestamp,
        updatedAt: timestamp,
        archivedAt: null,
      };
      database
        .prepare(`
          INSERT INTO records(
            id, object_type_id, display_name, values_json, schema_version,
            created_at, updated_at, archived_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        `)
        .run(
          record.id,
          object.id,
          record.displayName,
          JSON.stringify(record.values),
          record.schemaVersion,
          timestamp,
          timestamp,
        );
      insertRecordFts(database, object, record);
      outcome = 'created';
    } else {
      before = mapStoredRecord(matchedRow);
      if (before.archivedAt !== null) {
        throw new AppError(
          'RECORD_ARCHIVED',
          'The exact upsert match is archived and will not be reactivated automatically',
          { id: before.id, archivedAt: before.archivedAt, field: matchFieldKey },
        );
      }
      const split = activeAndLegacyValues(object, before.values);
      const merged = { ...split.active, ...valuesInput };
      const active = normalizeValues(object.fields, merged, false);
      const values = { ...split.legacy, ...active };
      const displayName = values[object.titleFieldKey];
      if (typeof displayName !== 'string' || displayName.trim().length === 0) {
        throw new AppError(
          'REQUIRED_FIELD_MISSING',
          'The title field must contain non-blank text',
          { field: object.titleFieldKey },
        );
      }
      record = {
        ...before,
        displayName,
        values,
        schemaVersion: object.schemaVersion,
        updatedAt: timestamp,
      };
      database
        .prepare(`
          UPDATE records
          SET display_name = ?, values_json = ?, schema_version = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(displayName, JSON.stringify(values), object.schemaVersion, timestamp, before.id);
      database.prepare('DELETE FROM records_fts WHERE record_id = ?').run(record.id);
      insertRecordFts(database, object, record);
      outcome = 'updated';
    }

    const result: UpsertRecordResult = { ...record, outcome, replayed: false };
    appendMutationEvent(
      database,
      {
        subjectType: 'record',
        subjectId: record.id,
        action: outcome,
        operation: 'record.upsert',
        requestHash: hash,
        before,
        result: record,
        replayResult: result,
        timestamp,
      },
      options,
    );
    return result;
  });
}

function activeAndLegacyValues(
  object: ObjectDefinition,
  values: Record<string, unknown>,
): { active: Record<string, unknown>; legacy: Record<string, unknown> } {
  const activeKeys = new Set(
    object.fields.filter((field) => field.archivedAt === null).map((field) => field.key),
  );
  const active: Record<string, unknown> = {};
  const legacy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (activeKeys.has(key)) active[key] = value;
    else legacy[key] = value;
  }
  return { active, legacy };
}

function insertRecordFts(
  database: DatabaseSync,
  object: ObjectDefinition,
  record: RecordData,
): void {
  const searchParts: string[] = [];
  for (const field of object.fields) {
    if (field.archivedAt === null && Object.hasOwn(record.values, field.key)) {
      flattenSearchValue(record.values[field.key], searchParts);
    }
  }
  database
    .prepare(
      'INSERT INTO records_fts(record_id, object_key, display_name, content) VALUES (?, ?, ?, ?)',
    )
    .run(record.id, object.key, record.displayName, searchParts.join(' '));
}

export function archiveRecord(
  database: DatabaseSync,
  idPrefix: string,
  options: CreateRecordOptions,
): RecordLifecycleResult {
  return inImmediateTransaction(database, () => {
    const current = getRecord(database, idPrefix);
    const hash = requestHash({
      operation: 'record.archive',
      recordId: current.id,
      actor: options.actor,
      source: options.source ?? null,
    });
    const replay = findIdempotentReplay<RecordData>(database, options.idempotencyKey, hash);
    if (replay) return { ...replay, replayed: true };
    if (current.archivedAt !== null) {
      throw new AppError('RECORD_ARCHIVED', `Record '${idPrefix}' is already archived`, {
        id: current.id,
        archivedAt: current.archivedAt,
      });
    }
    const timestamp = now();
    const result: RecordData = { ...current, updatedAt: timestamp, archivedAt: timestamp };
    database
      .prepare('UPDATE records SET updated_at = ?, archived_at = ? WHERE id = ?')
      .run(timestamp, timestamp, current.id);
    database.prepare('DELETE FROM records_fts WHERE record_id = ?').run(current.id);
    appendMutationEvent(
      database,
      {
        subjectType: 'record',
        subjectId: current.id,
        action: 'archived',
        operation: 'record.archive',
        requestHash: hash,
        before: current,
        result,
        timestamp,
      },
      options,
    );
    return { ...result, replayed: false };
  });
}

export function restoreRecord(
  database: DatabaseSync,
  idPrefix: string,
  options: CreateRecordOptions,
): RecordLifecycleResult {
  return inImmediateTransaction(database, () => {
    const current = getRecord(database, idPrefix);
    const hash = requestHash({
      operation: 'record.restore',
      recordId: current.id,
      actor: options.actor,
      source: options.source ?? null,
    });
    const replay = findIdempotentReplay<RecordData>(database, options.idempotencyKey, hash);
    if (replay) return { ...replay, replayed: true };
    if (current.archivedAt === null) {
      throw new AppError('VALIDATION_ERROR', `Record '${idPrefix}' is not archived`, {
        id: current.id,
      });
    }
    const object = getActiveObject(database, current.object);
    const split = activeAndLegacyValues(object, current.values);
    const active = normalizeValues(object.fields, split.active, false);
    const values = { ...split.legacy, ...active };
    const displayName = values[object.titleFieldKey];
    if (typeof displayName !== 'string' || displayName.trim().length === 0) {
      throw new AppError('REQUIRED_FIELD_MISSING', 'The title field must contain non-blank text', {
        field: object.titleFieldKey,
      });
    }
    const timestamp = now();
    const result: RecordData = {
      ...current,
      displayName,
      values,
      schemaVersion: object.schemaVersion,
      updatedAt: timestamp,
      archivedAt: null,
    };
    database
      .prepare(`
        UPDATE records
        SET display_name = ?, values_json = ?, schema_version = ?, updated_at = ?, archived_at = NULL
        WHERE id = ?
      `)
      .run(displayName, JSON.stringify(values), object.schemaVersion, timestamp, current.id);
    database.prepare('DELETE FROM records_fts WHERE record_id = ?').run(current.id);
    insertRecordFts(database, object, result);
    appendMutationEvent(
      database,
      {
        subjectType: 'record',
        subjectId: current.id,
        action: 'restored',
        operation: 'record.restore',
        requestHash: hash,
        before: current,
        result,
        timestamp,
      },
      options,
    );
    return { ...result, replayed: false };
  });
}

export function getRecord(database: DatabaseSync, idPrefix: string): RecordData {
  const normalized = idPrefix.toLowerCase();
  if (normalized.length < 8 || !/^[0-9a-f-]+$/.test(normalized)) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Record IDs require a valid prefix of at least 8 characters',
      {
        id: idPrefix,
      },
    );
  }

  const rows = database
    .prepare(`
      SELECT r.*, o.key AS object_key
      FROM records r
      JOIN object_types o ON o.id = r.object_type_id
      WHERE lower(r.id) LIKE ?
      ORDER BY r.id ASC
      LIMIT 3
    `)
    .all(`${normalized}%`) as unknown as StoredRecordRow[];

  if (rows.length === 0) {
    throw new AppError('RECORD_NOT_FOUND', `Record '${idPrefix}' was not found`, { id: idPrefix });
  }
  if (rows.length > 1) {
    throw new AppError('AMBIGUOUS_ID', 'The ID prefix matches more than one record', {
      id: idPrefix,
      matches: rows.map((row) => row.id),
    });
  }

  const row = rows[0];
  if (!row) throw new AppError('RECORD_NOT_FOUND', `Record '${idPrefix}' was not found`);
  return mapStoredRecord(row);
}
