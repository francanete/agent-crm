import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { inImmediateTransaction } from '../db/transaction.js';
import { canonicalJson, requestHash } from './canonical.js';
import { AppError } from './errors.js';
import { appendMutationEvent } from './events.js';
import { findIdempotentReplay } from './idempotency.js';
import { now } from './time.js';
import type { FieldDefinition, FieldFormat, FieldType, ObjectDefinition } from './types.js';
import { validateAndNormalizeFieldValue } from './validation.js';

interface ObjectRow {
  id: string;
  key: string;
  label: string;
  plural_label: string;
  description: string | null;
  title_field_key: string;
  schema_version: number;
  system: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface FieldRow {
  id: string;
  object_type_id: string;
  key: string;
  label: string;
  description: string | null;
  type: FieldDefinition['type'];
  format: FieldDefinition['format'];
  required: number;
  options_json: string | null;
  default_value_json: string | null;
  position: number;
  system: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

function mapField(row: FieldRow): FieldDefinition {
  const base: FieldDefinition = {
    id: row.id,
    objectTypeId: row.object_type_id,
    key: row.key,
    label: row.label,
    description: row.description,
    type: row.type,
    format: row.format,
    required: row.required === 1,
    options: row.options_json === null ? null : (JSON.parse(row.options_json) as string[]),
    position: row.position,
    system: row.system === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };

  if (row.default_value_json !== null) {
    base.defaultValue = JSON.parse(row.default_value_json) as unknown;
  }
  return base;
}

function mapObject(row: ObjectRow, fields: FieldDefinition[]): ObjectDefinition {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    pluralLabel: row.plural_label,
    description: row.description,
    titleFieldKey: row.title_field_key,
    schemaVersion: row.schema_version,
    system: row.system === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    fields,
  };
}

export function describeSchema(database: DatabaseSync, objectKey?: string): ObjectDefinition[] {
  const objectRows = (objectKey
    ? database.prepare('SELECT * FROM object_types WHERE key = ?').all(objectKey)
    : database
        .prepare('SELECT * FROM object_types ORDER BY key ASC')
        .all()) as unknown as ObjectRow[];

  if (objectKey && objectRows.length === 0) {
    throw new AppError('OBJECT_NOT_FOUND', `Object '${objectKey}' was not found`, {
      object: objectKey,
    });
  }

  const fieldStatement = database.prepare(`
    SELECT * FROM field_definitions
    WHERE object_type_id = ?
    ORDER BY position ASC, key ASC
  `);

  return objectRows.map((objectRow) => {
    const fieldRows = fieldStatement.all(objectRow.id) as unknown as FieldRow[];
    return mapObject(objectRow, fieldRows.map(mapField));
  });
}

export function getActiveObject(database: DatabaseSync, objectKey: string): ObjectDefinition {
  const [object] = describeSchema(database, objectKey);
  if (!object) {
    throw new AppError('OBJECT_NOT_FOUND', `Object '${objectKey}' was not found`, {
      object: objectKey,
    });
  }
  if (object.archivedAt !== null) {
    throw new AppError('OBJECT_ARCHIVED', `Object '${objectKey}' is archived`, {
      object: objectKey,
      archivedAt: object.archivedAt,
    });
  }
  return object;
}

export interface SchemaMutationOptions {
  actor: string;
  source?: string;
  idempotencyKey?: string;
  cliVersion: string;
}

export interface AddObjectInput {
  key: string;
  label: string;
  pluralLabel: string;
  description?: string;
  titleFieldKey: string;
  titleFieldLabel: string;
}

export interface AddFieldInput {
  objectKey: string;
  key: string;
  label: string;
  description?: string;
  type: FieldType;
  format?: FieldFormat;
  required: boolean;
  options?: string[];
  defaultValue?: unknown;
}

const fieldTypes = new Set<FieldType>([
  'text',
  'number',
  'boolean',
  'date',
  'datetime',
  'enum',
  'multi_select',
  'json',
]);

function validateKey(key: string, subject: 'Object' | 'Field'): void {
  if (!/^[a-z][a-z0-9_]*$/.test(key)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `${subject} key must start with a letter and contain lowercase letters, numbers, or underscores`,
      { key },
    );
  }
}

function requireLabel(value: string, name: string): string {
  const label = value.trim();
  if (label.length === 0 || label.length > 200) {
    throw new AppError('VALIDATION_ERROR', `${name} must contain 1 to 200 characters`);
  }
  return label;
}

function appendSchemaEvent(
  database: DatabaseSync,
  subjectType: 'object' | 'field',
  subjectId: string,
  actor: string,
  source: string | undefined,
  idempotencyKey: string | undefined,
  after: unknown,
  metadata: Record<string, unknown>,
  timestamp: string,
): void {
  database
    .prepare(`
      INSERT INTO events(
        id, subject_type, subject_id, action, actor, source, idempotency_key,
        before_json, after_json, metadata_json, created_at
      ) VALUES (?, ?, ?, 'created', ?, ?, ?, NULL, ?, ?, ?)
    `)
    .run(
      randomUUID(),
      subjectType,
      subjectId,
      actor,
      source ?? null,
      idempotencyKey ?? null,
      JSON.stringify(after),
      JSON.stringify(metadata),
      timestamp,
    );
}

export function addObject(
  database: DatabaseSync,
  input: AddObjectInput,
  options: SchemaMutationOptions,
): ObjectDefinition & { replayed: boolean } {
  validateKey(input.key, 'Object');
  validateKey(input.titleFieldKey, 'Field');
  const label = requireLabel(input.label, 'Object label');
  const pluralLabel = requireLabel(input.pluralLabel, 'Plural label');
  const titleFieldLabel = requireLabel(input.titleFieldLabel, 'Title field label');
  const normalizedInput = {
    ...input,
    label,
    pluralLabel,
    titleFieldLabel,
    description: input.description?.trim() || null,
  };
  const hash = requestHash({
    operation: 'schema.object.add',
    input: normalizedInput,
    actor: options.actor,
    source: options.source ?? null,
  });

  return inImmediateTransaction(database, () => {
    const replay = findIdempotentReplay<ObjectDefinition>(database, options.idempotencyKey, hash);
    if (replay) return { ...replay, replayed: true };

    const duplicate = database.prepare('SELECT id FROM object_types WHERE key = ?').get(input.key);
    if (duplicate) {
      throw new AppError('SCHEMA_CONFLICT', `Object '${input.key}' already exists`, {
        object: input.key,
      });
    }

    const timestamp = now();
    const objectId = randomUUID();
    database
      .prepare(`
        INSERT INTO object_types(
          id, key, label, plural_label, description, title_field_key,
          schema_version, system, created_at, updated_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, NULL)
      `)
      .run(
        objectId,
        input.key,
        label,
        pluralLabel,
        normalizedInput.description,
        input.titleFieldKey,
        timestamp,
        timestamp,
      );
    database
      .prepare(`
        INSERT INTO field_definitions(
          id, object_type_id, key, label, description, type, format, required,
          options_json, default_value_json, position, system, created_at, updated_at, archived_at
        ) VALUES (?, ?, ?, ?, NULL, 'text', NULL, 1, NULL, NULL, 0, 0, ?, ?, NULL)
      `)
      .run(randomUUID(), objectId, input.titleFieldKey, titleFieldLabel, timestamp, timestamp);

    const object = describeSchema(database, input.key)[0] as ObjectDefinition;
    const metadata = {
      operation: 'schema.object.add',
      requestHash: hash,
      result: object,
      cliVersion: options.cliVersion,
      workingDirectory: process.cwd(),
    };
    appendSchemaEvent(
      database,
      'object',
      object.id,
      options.actor,
      options.source,
      options.idempotencyKey,
      object,
      metadata,
      timestamp,
    );
    return { ...object, replayed: false };
  });
}

export function addField(
  database: DatabaseSync,
  input: AddFieldInput,
  options: SchemaMutationOptions,
): FieldDefinition & { replayed: boolean } {
  validateKey(input.key, 'Field');
  if (!fieldTypes.has(input.type)) {
    throw new AppError('VALIDATION_ERROR', `Unsupported field type '${input.type}'`, {
      type: input.type,
    });
  }
  const label = requireLabel(input.label, 'Field label');
  const format = input.format ?? null;
  const validFormat =
    format === null ||
    (input.type === 'text' && ['email', 'phone', 'url'].includes(format)) ||
    (input.type === 'number' && ['currency', 'percentage'].includes(format));
  if (!validFormat) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Format '${String(format)}' is invalid for ${input.type}`,
    );
  }

  let fieldOptions: string[] | null = null;
  if (input.options) {
    if (input.type !== 'enum' && input.type !== 'multi_select') {
      throw new AppError('VALIDATION_ERROR', 'Only enum and multi_select fields accept options');
    }
    if (
      input.options.length === 0 ||
      input.options.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)
    ) {
      throw new AppError('VALIDATION_ERROR', 'Field options must be a non-empty string array');
    }
    fieldOptions = [...new Set(input.options)];
  } else if (input.type === 'enum') {
    throw new AppError('VALIDATION_ERROR', 'Enum fields require at least one option');
  }

  const normalizedInput = {
    ...input,
    label,
    description: input.description?.trim() || null,
    format,
    options: fieldOptions,
  };
  const hash = requestHash({
    operation: 'schema.field.add',
    input: normalizedInput,
    actor: options.actor,
    source: options.source ?? null,
  });

  return inImmediateTransaction(database, () => {
    const replay = findIdempotentReplay<FieldDefinition>(database, options.idempotencyKey, hash);
    if (replay) return { ...replay, replayed: true };

    const object = getActiveObject(database, input.objectKey);
    if (object.fields.some((field) => field.key === input.key)) {
      throw new AppError('SCHEMA_CONFLICT', `Field '${input.key}' already exists`, {
        object: input.objectKey,
        field: input.key,
      });
    }
    if (input.required) {
      const row = database
        .prepare('SELECT COUNT(*) AS count FROM records WHERE object_type_id = ?')
        .get(object.id) as unknown as { count: number };
      if (row.count > 0) {
        throw new AppError(
          'SCHEMA_CONFLICT',
          'A required field cannot be added to an object that already has records',
          { object: input.objectKey, recordCount: row.count },
        );
      }
    }

    const timestamp = now();
    const fieldId = randomUUID();
    const field: FieldDefinition = {
      id: fieldId,
      objectTypeId: object.id,
      key: input.key,
      label,
      description: normalizedInput.description,
      type: input.type,
      format,
      required: input.required,
      options: fieldOptions,
      position: object.fields.length,
      system: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    };
    if (Object.hasOwn(input, 'defaultValue')) {
      if (input.defaultValue === null || input.defaultValue === undefined) {
        throw new AppError('INVALID_FIELD_VALUE', 'A field default cannot be null');
      }
      field.defaultValue = validateAndNormalizeFieldValue(field, input.defaultValue);
    }

    database
      .prepare(`
        INSERT INTO field_definitions(
          id, object_type_id, key, label, description, type, format, required,
          options_json, default_value_json, position, system, created_at, updated_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)
      `)
      .run(
        field.id,
        field.objectTypeId,
        field.key,
        field.label,
        field.description,
        field.type,
        field.format,
        field.required ? 1 : 0,
        field.options === null ? null : JSON.stringify(field.options),
        Object.hasOwn(field, 'defaultValue') ? JSON.stringify(field.defaultValue) : null,
        field.position,
        timestamp,
        timestamp,
      );
    database
      .prepare(
        'UPDATE object_types SET schema_version = schema_version + 1, updated_at = ? WHERE id = ?',
      )
      .run(timestamp, object.id);

    const metadata = {
      operation: 'schema.field.add',
      requestHash: hash,
      result: field,
      cliVersion: options.cliVersion,
      workingDirectory: process.cwd(),
    };
    appendSchemaEvent(
      database,
      'field',
      field.id,
      options.actor,
      options.source,
      options.idempotencyKey,
      field,
      metadata,
      timestamp,
    );
    return { ...field, replayed: false };
  });
}

export type ObjectLifecycleResult = ObjectDefinition & { replayed: boolean };
export type FieldLifecycleResult = FieldDefinition & { replayed: boolean };

function objectDefinition(database: DatabaseSync, objectKey: string): ObjectDefinition {
  const object = describeSchema(database, objectKey)[0];
  if (!object) {
    throw new AppError('OBJECT_NOT_FOUND', `Object '${objectKey}' was not found`, {
      object: objectKey,
    });
  }
  return object;
}

function fieldDefinition(object: ObjectDefinition, fieldKey: string): FieldDefinition {
  const field = object.fields.find((candidate) => candidate.key === fieldKey);
  if (!field) {
    throw new AppError('FIELD_NOT_FOUND', `Field '${fieldKey}' was not found`, {
      object: object.key,
      field: fieldKey,
    });
  }
  return field;
}

function flattenSearchValue(value: unknown, output: string[], depth = 0): void {
  if (depth > 20 || value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    output.push(String(value));
  } else if (Array.isArray(value)) {
    for (const entry of value) flattenSearchValue(entry, output, depth + 1);
  } else if (typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      flattenSearchValue(entry, output, depth + 1);
    }
  }
}

function reindexObjectRecords(database: DatabaseSync, object: ObjectDefinition): void {
  const rows = database
    .prepare(`
      SELECT id, display_name, values_json
      FROM records
      WHERE object_type_id = ? AND archived_at IS NULL
      ORDER BY id ASC
    `)
    .all(object.id) as unknown as Array<{
    id: string;
    display_name: string;
    values_json: string;
  }>;
  database
    .prepare(
      'DELETE FROM records_fts WHERE record_id IN (SELECT id FROM records WHERE object_type_id = ?)',
    )
    .run(object.id);
  const insert = database.prepare(
    'INSERT INTO records_fts(record_id, object_key, display_name, content) VALUES (?, ?, ?, ?)',
  );
  const activeFields = object.fields.filter((field) => field.archivedAt === null);
  for (const row of rows) {
    const values = JSON.parse(row.values_json) as Record<string, unknown>;
    const content: string[] = [];
    for (const field of activeFields) {
      if (Object.hasOwn(values, field.key)) flattenSearchValue(values[field.key], content);
    }
    insert.run(row.id, object.key, row.display_name, content.join(' '));
  }
}

export function archiveObject(
  database: DatabaseSync,
  objectKey: string,
  options: SchemaMutationOptions,
): ObjectLifecycleResult {
  return inImmediateTransaction(database, () => {
    const current = objectDefinition(database, objectKey);
    const hash = requestHash({
      operation: 'schema.object.archive',
      objectId: current.id,
      actor: options.actor,
      source: options.source ?? null,
    });
    const replay = findIdempotentReplay<ObjectDefinition>(database, options.idempotencyKey, hash);
    if (replay) return { ...replay, replayed: true };
    if (current.archivedAt !== null) {
      throw new AppError('OBJECT_ARCHIVED', `Object '${objectKey}' is already archived`, {
        object: objectKey,
        archivedAt: current.archivedAt,
      });
    }
    const count = database
      .prepare('SELECT COUNT(*) AS count FROM records WHERE object_type_id = ?')
      .get(current.id) as unknown as { count: number };
    if (count.count > 0) {
      throw new AppError(
        'SCHEMA_CONFLICT',
        'An object with active or archived records cannot be archived',
        { object: objectKey, recordCount: count.count },
      );
    }
    const timestamp = now();
    database
      .prepare('UPDATE object_types SET updated_at = ?, archived_at = ? WHERE id = ?')
      .run(timestamp, timestamp, current.id);
    const result = objectDefinition(database, objectKey);
    appendMutationEvent(
      database,
      {
        subjectType: 'object',
        subjectId: current.id,
        action: 'archived',
        operation: 'schema.object.archive',
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

export function restoreObject(
  database: DatabaseSync,
  objectKey: string,
  options: SchemaMutationOptions,
): ObjectLifecycleResult {
  return inImmediateTransaction(database, () => {
    const current = objectDefinition(database, objectKey);
    const hash = requestHash({
      operation: 'schema.object.restore',
      objectId: current.id,
      actor: options.actor,
      source: options.source ?? null,
    });
    const replay = findIdempotentReplay<ObjectDefinition>(database, options.idempotencyKey, hash);
    if (replay) return { ...replay, replayed: true };
    if (current.archivedAt === null) {
      throw new AppError('VALIDATION_ERROR', `Object '${objectKey}' is not archived`, {
        object: objectKey,
      });
    }
    const title = current.fields.find(
      (field) => field.key === current.titleFieldKey && field.archivedAt === null,
    );
    if (title?.type !== 'text' || !title.required) {
      throw new AppError('SCHEMA_CONFLICT', 'The object title field is not restorable');
    }
    const count = database
      .prepare('SELECT COUNT(*) AS count FROM records WHERE object_type_id = ?')
      .get(current.id) as unknown as { count: number };
    if (count.count > 0) {
      throw new AppError('SCHEMA_CONFLICT', 'Archived objects cannot contain records', {
        object: objectKey,
        recordCount: count.count,
      });
    }
    const timestamp = now();
    database
      .prepare('UPDATE object_types SET updated_at = ?, archived_at = NULL WHERE id = ?')
      .run(timestamp, current.id);
    const result = objectDefinition(database, objectKey);
    appendMutationEvent(
      database,
      {
        subjectType: 'object',
        subjectId: current.id,
        action: 'restored',
        operation: 'schema.object.restore',
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

export function archiveField(
  database: DatabaseSync,
  objectKey: string,
  fieldKey: string,
  options: SchemaMutationOptions,
): FieldLifecycleResult {
  return inImmediateTransaction(database, () => {
    const object = objectDefinition(database, objectKey);
    const current = fieldDefinition(object, fieldKey);
    const hash = requestHash({
      operation: 'schema.field.archive',
      fieldId: current.id,
      actor: options.actor,
      source: options.source ?? null,
    });
    const replay = findIdempotentReplay<FieldDefinition>(database, options.idempotencyKey, hash);
    if (replay) return { ...replay, replayed: true };
    if (object.archivedAt !== null) {
      throw new AppError('OBJECT_ARCHIVED', `Object '${objectKey}' is archived`, {
        object: objectKey,
        archivedAt: object.archivedAt,
      });
    }
    if (current.archivedAt !== null) {
      throw new AppError('FIELD_ARCHIVED', `Field '${fieldKey}' is already archived`, {
        object: objectKey,
        field: fieldKey,
        archivedAt: current.archivedAt,
      });
    }
    if (fieldKey === object.titleFieldKey) {
      throw new AppError('SCHEMA_CONFLICT', 'The active title field cannot be archived', {
        object: objectKey,
        field: fieldKey,
      });
    }
    const timestamp = now();
    database
      .prepare('UPDATE field_definitions SET updated_at = ?, archived_at = ? WHERE id = ?')
      .run(timestamp, timestamp, current.id);
    database
      .prepare(
        'UPDATE object_types SET schema_version = schema_version + 1, updated_at = ? WHERE id = ?',
      )
      .run(timestamp, object.id);
    const updatedObject = objectDefinition(database, objectKey);
    const result = fieldDefinition(updatedObject, fieldKey);
    reindexObjectRecords(database, updatedObject);
    appendMutationEvent(
      database,
      {
        subjectType: 'field',
        subjectId: current.id,
        action: 'archived',
        operation: 'schema.field.archive',
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

export function restoreField(
  database: DatabaseSync,
  objectKey: string,
  fieldKey: string,
  options: SchemaMutationOptions,
): FieldLifecycleResult {
  return inImmediateTransaction(database, () => {
    const object = objectDefinition(database, objectKey);
    const current = fieldDefinition(object, fieldKey);
    const hash = requestHash({
      operation: 'schema.field.restore',
      fieldId: current.id,
      actor: options.actor,
      source: options.source ?? null,
    });
    const replay = findIdempotentReplay<FieldDefinition>(database, options.idempotencyKey, hash);
    if (replay) return { ...replay, replayed: true };
    if (object.archivedAt !== null) {
      throw new AppError('OBJECT_ARCHIVED', `Object '${objectKey}' is archived`, {
        object: objectKey,
        archivedAt: object.archivedAt,
      });
    }
    if (current.archivedAt === null) {
      throw new AppError('VALIDATION_ERROR', `Field '${fieldKey}' is not archived`, {
        object: objectKey,
        field: fieldKey,
      });
    }
    const rows = database
      .prepare(
        'SELECT id, values_json FROM records WHERE object_type_id = ? AND archived_at IS NULL',
      )
      .all(object.id) as unknown as Array<{ id: string; values_json: string }>;
    for (const row of rows) {
      const values = JSON.parse(row.values_json) as Record<string, unknown>;
      if (!Object.hasOwn(values, fieldKey)) {
        if (current.required) {
          throw new AppError(
            'SCHEMA_CONFLICT',
            `Active record '${row.id}' is missing required field '${fieldKey}'`,
            { recordId: row.id, field: fieldKey },
          );
        }
        continue;
      }
      try {
        const normalized = validateAndNormalizeFieldValue(current, values[fieldKey]);
        if (canonicalJson(normalized) !== canonicalJson(values[fieldKey])) {
          throw new Error('not normalized');
        }
      } catch {
        throw new AppError(
          'SCHEMA_CONFLICT',
          `Active record '${row.id}' is invalid for restored field '${fieldKey}'`,
          { recordId: row.id, field: fieldKey },
        );
      }
    }
    const timestamp = now();
    database
      .prepare('UPDATE field_definitions SET updated_at = ?, archived_at = NULL WHERE id = ?')
      .run(timestamp, current.id);
    database
      .prepare(
        'UPDATE object_types SET schema_version = schema_version + 1, updated_at = ? WHERE id = ?',
      )
      .run(timestamp, object.id);
    const updatedObject = objectDefinition(database, objectKey);
    const result = fieldDefinition(updatedObject, fieldKey);
    reindexObjectRecords(database, updatedObject);
    appendMutationEvent(
      database,
      {
        subjectType: 'field',
        subjectId: current.id,
        action: 'restored',
        operation: 'schema.field.restore',
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
