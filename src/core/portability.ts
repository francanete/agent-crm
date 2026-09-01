import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { CURRENT_DATABASE_VERSION } from '../db/migrations.js';
import { DEFAULT_SCHEMA } from '../db/seed.js';
import { inImmediateTransaction } from '../db/transaction.js';
import { canonicalJson, requestHash } from './canonical.js';
import { AppError } from './errors.js';
import { findIdempotentReplay } from './idempotency.js';
import { describeSchema } from './schema.js';
import { now } from './time.js';
import type { FieldDefinition, ObjectDefinition } from './types.js';
import { validateAndNormalizeFieldValue } from './validation.js';

export const EXPORT_FORMAT = 'agentcrm-export';
export const EXPORT_FORMAT_VERSION = 1;
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

const nullableString = z.string().nullable();
const fieldSchema = z
  .object({
    id: z.string().min(1),
    objectTypeId: z.string().min(1),
    key: z.string().regex(/^[a-z][a-z0-9_]*$/),
    label: z.string().min(1),
    description: nullableString,
    type: z.enum(['text', 'number', 'boolean', 'date', 'datetime', 'enum', 'multi_select', 'json']),
    format: z.enum(['email', 'phone', 'url', 'currency', 'percentage']).nullable(),
    required: z.boolean(),
    options: z.array(z.string()).nullable(),
    defaultValue: z.unknown().optional(),
    position: z.number().int().nonnegative(),
    system: z.boolean(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    archivedAt: nullableString,
  })
  .strict();
const objectSchema = z
  .object({
    id: z.string().min(1),
    key: z.string().regex(/^[a-z][a-z0-9_]*$/),
    label: z.string().min(1),
    pluralLabel: z.string().min(1),
    description: nullableString,
    titleFieldKey: z.string().min(1),
    schemaVersion: z.number().int().positive(),
    system: z.boolean(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    archivedAt: nullableString,
    fields: z.array(fieldSchema),
  })
  .strict();
const recordSchema = z
  .object({
    id: z.string().min(1),
    object: z.string().min(1),
    displayName: z.string(),
    values: z.record(z.string(), z.unknown()),
    schemaVersion: z.number().int().positive(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    archivedAt: nullableString,
  })
  .strict();
const relationshipSchema = z
  .object({
    id: z.string().min(1),
    sourceRecordId: z.string().min(1),
    targetRecordId: z.string().min(1),
    type: z.string().regex(/^[a-z][a-z0-9_]*$/),
    properties: z.record(z.string(), z.unknown()),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    archivedAt: nullableString,
  })
  .strict();
const eventSchema = z
  .object({
    id: z.string().min(1),
    subjectType: z.string().min(1),
    subjectId: z.string().min(1),
    action: z.string().min(1),
    actor: z.string().min(1),
    source: nullableString,
    idempotencyKey: nullableString,
    before: z.unknown(),
    after: z.unknown(),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: z.string().min(1),
  })
  .strict();
const exportDocumentSchema = z
  .object({
    format: z.literal(EXPORT_FORMAT),
    formatVersion: z.number().int(),
    exportedAt: z.string().min(1),
    databaseVersion: z.number().int().positive(),
    historyIncluded: z.boolean(),
    data: z
      .object({
        objects: z.array(objectSchema),
        records: z.array(recordSchema),
        relationships: z.array(relationshipSchema),
        events: z.array(eventSchema),
      })
      .strict(),
  })
  .strict();

export type ExportDocument = z.infer<typeof exportDocumentSchema>;
type ExportField = z.infer<typeof fieldSchema>;
type ExportObject = z.infer<typeof objectSchema>;
type ExportRecord = z.infer<typeof recordSchema>;
type ExportRelationship = z.infer<typeof relationshipSchema>;
type ExportEvent = z.infer<typeof eventSchema>;

export interface ExportOptions {
  withoutHistory?: boolean;
}

export interface ImportOptions {
  actor: string;
  source?: string;
  idempotencyKey?: string;
  cliVersion: string;
}

export interface ImportResult {
  formatVersion: number;
  imported: {
    objects: number;
    fields: number;
    records: number;
    relationships: number;
    events: number;
  };
  historyIncluded: boolean;
  dryRun: boolean;
  replayed: boolean;
}

interface RecordRow {
  id: string;
  object_key: string;
  display_name: string;
  values_json: string;
  schema_version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface RelationshipRow {
  id: string;
  source_record_id: string;
  target_record_id: string;
  type: string;
  properties_json: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface EventRow {
  id: string;
  subject_type: string;
  subject_id: string;
  action: string;
  actor: string;
  source: string | null;
  idempotency_key: string | null;
  before_json: string | null;
  after_json: string | null;
  metadata_json: string;
  created_at: string;
}

function invalidImport(message: string, details: Record<string, unknown> = {}): never {
  throw new AppError('IMPORT_INVALID', message, details);
}

function parseJson(text: string, context: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError('DATABASE_INVALID', `Stored ${context} contains invalid JSON`);
  }
}

function loadExportData(database: DatabaseSync, includeHistory: boolean): ExportDocument['data'] {
  const objects = describeSchema(database) as ExportObject[];
  const recordRows = database
    .prepare(`
      SELECT r.*, object_type.key AS object_key
      FROM records r
      JOIN object_types object_type ON object_type.id = r.object_type_id
      ORDER BY r.id ASC
    `)
    .all() as unknown as RecordRow[];
  const records: ExportRecord[] = recordRows.map((row) => ({
    id: row.id,
    object: row.object_key,
    displayName: row.display_name,
    values: parseJson(row.values_json, 'record values') as Record<string, unknown>,
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  }));
  const relationshipRows = database
    .prepare('SELECT * FROM relationships ORDER BY id ASC')
    .all() as unknown as RelationshipRow[];
  const relationships: ExportRelationship[] = relationshipRows.map((row) => ({
    id: row.id,
    sourceRecordId: row.source_record_id,
    targetRecordId: row.target_record_id,
    type: row.type,
    properties: parseJson(row.properties_json, 'relationship properties') as Record<
      string,
      unknown
    >,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  }));
  let events: ExportEvent[] = [];
  if (includeHistory) {
    const eventRows = database
      .prepare('SELECT * FROM events ORDER BY created_at ASC, rowid ASC')
      .all() as unknown as EventRow[];
    events = eventRows.map((row) => ({
      id: row.id,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      action: row.action,
      actor: row.actor,
      source: row.source,
      idempotencyKey: row.idempotency_key,
      before: row.before_json === null ? null : parseJson(row.before_json, 'event before snapshot'),
      after: row.after_json === null ? null : parseJson(row.after_json, 'event after snapshot'),
      metadata: parseJson(row.metadata_json, 'event metadata') as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }
  return { objects, records, relationships, events };
}

export function createExport(database: DatabaseSync, options: ExportOptions = {}): ExportDocument {
  database.exec('BEGIN');
  try {
    const versionRow = database
      .prepare("SELECT value FROM metadata WHERE key = 'database_version'")
      .get() as { value: string } | undefined;
    if (!versionRow || !/^\d+$/.test(versionRow.value)) {
      throw new AppError('DATABASE_INVALID', 'Database metadata has no valid version');
    }
    const historyIncluded = options.withoutHistory !== true;
    const document: ExportDocument = {
      format: EXPORT_FORMAT,
      formatVersion: EXPORT_FORMAT_VERSION,
      exportedAt: now(),
      databaseVersion: Number(versionRow.value),
      historyIncluded,
      data: loadExportData(database, historyIncluded),
    };
    database.exec('COMMIT');
    return document;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function writeExportFile(
  outputPath: string,
  document: ExportDocument,
  force = false,
): { output: string; bytes: number } {
  const output = path.resolve(outputPath);
  let exists = false;
  try {
    const stat = fs.lstatSync(output);
    exists = true;
    if (!force) {
      throw new AppError('EXPORT_TARGET_EXISTS', `Export target '${output}' already exists`, {
        output,
      });
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new AppError('VALIDATION_ERROR', 'Export target is not a regular file', { output });
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new AppError('DATABASE_ERROR', 'Could not inspect the export target', { output });
    }
  }

  const content = `${JSON.stringify(document, null, 2)}\n`;
  const temporary = path.join(
    path.dirname(output),
    `.${path.basename(output)}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    if (exists) fs.unlinkSync(output);
    fs.renameSync(temporary, output);
    if (process.platform !== 'win32') fs.chmodSync(output, 0o600);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Preserve the original filesystem error.
    }
    if (error instanceof AppError) throw error;
    throw new AppError('DATABASE_ERROR', 'Could not write the export file', { output });
  }
  return { output, bytes: Buffer.byteLength(content) };
}

export function readExportFile(inputPath: string): ExportDocument {
  const input = path.resolve(inputPath);
  let text: string;
  try {
    const stat = fs.statSync(input);
    if (!stat.isFile()) invalidImport('Import source must be a regular file', { input });
    if (stat.size > MAX_IMPORT_BYTES) {
      invalidImport('Import exceeds the 100 MiB limit', {
        input,
        bytes: stat.size,
        maximumBytes: MAX_IMPORT_BYTES,
      });
    }
    text = fs.readFileSync(input, 'utf8');
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('IMPORT_INVALID', 'Could not read the import file', { input });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    invalidImport('Import file is not valid JSON', { input });
  }
  const result = exportDocumentSchema.safeParse(parsed);
  if (!result.success) {
    invalidImport('Import document does not match the Agent CRM export schema', {
      issues: result.error.issues.slice(0, 25),
    });
  }
  if (result.data.formatVersion !== EXPORT_FORMAT_VERSION) {
    invalidImport(`Export format version ${result.data.formatVersion} is not supported`, {
      formatVersion: result.data.formatVersion,
      supportedFormatVersion: EXPORT_FORMAT_VERSION,
    });
  }
  validateLogicalDocument(result.data);
  return result.data;
}

function assertUnique(values: string[], subject: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) invalidImport(`Import contains a duplicate ${subject}`, { value });
    seen.add(value);
  }
}

function isUtcTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function validateTimestamps(
  subject: string,
  createdAt: string,
  updatedAt?: string,
  archivedAt?: string | null,
): void {
  if (
    !isUtcTimestamp(createdAt) ||
    (updatedAt !== undefined && !isUtcTimestamp(updatedAt)) ||
    (archivedAt !== undefined && archivedAt !== null && !isUtcTimestamp(archivedAt))
  ) {
    invalidImport(`${subject} contains an invalid application timestamp`);
  }
}

function validateFieldDefinition(field: ExportField): void {
  const validFormat =
    field.format === null ||
    (field.type === 'text' && ['email', 'phone', 'url'].includes(field.format)) ||
    (field.type === 'number' && ['currency', 'percentage'].includes(field.format));
  if (!validFormat) invalidImport(`Field '${field.key}' has an incompatible format`);
  if (field.options !== null) {
    if (field.type !== 'enum' && field.type !== 'multi_select') {
      invalidImport(`Field '${field.key}' cannot have options`);
    }
    if (field.options.length === 0 || new Set(field.options).size !== field.options.length) {
      invalidImport(`Field '${field.key}' has empty or duplicate options`);
    }
  } else if (field.type === 'enum') {
    invalidImport(`Enum field '${field.key}' requires options`);
  }
  if (Object.hasOwn(field, 'defaultValue')) {
    if (field.defaultValue === null || field.defaultValue === undefined) {
      invalidImport(`Field '${field.key}' has an invalid null default`);
    }
    try {
      const normalized = validateAndNormalizeFieldValue(
        field as FieldDefinition,
        field.defaultValue,
      );
      if (canonicalJson(normalized) !== canonicalJson(field.defaultValue)) {
        invalidImport(`Field '${field.key}' has a non-normalized default value`);
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'IMPORT_INVALID') throw error;
      invalidImport(`Field '${field.key}' has an invalid default value`);
    }
  }
  validateTimestamps(`Field '${field.key}'`, field.createdAt, field.updatedAt, field.archivedAt);
}

export function validateLogicalDocument(document: ExportDocument): void {
  if (document.databaseVersion > CURRENT_DATABASE_VERSION) {
    invalidImport('Export was created by a newer physical database version', {
      databaseVersion: document.databaseVersion,
      supportedDatabaseVersion: CURRENT_DATABASE_VERSION,
    });
  }
  if (!isUtcTimestamp(document.exportedAt)) invalidImport('Export timestamp is invalid');
  if (!document.historyIncluded && document.data.events.length > 0) {
    invalidImport('An export without history cannot contain events');
  }
  assertUnique(
    document.data.objects.map((object) => object.id),
    'object ID',
  );
  assertUnique(
    document.data.objects.map((object) => object.key),
    'object key',
  );
  const fieldIds: string[] = [];
  const objects = new Map<string, ExportObject>();
  for (const object of document.data.objects) {
    validateTimestamps(
      `Object '${object.key}'`,
      object.createdAt,
      object.updatedAt,
      object.archivedAt,
    );
    objects.set(object.key, object);
    assertUnique(
      object.fields.map((field) => field.key),
      `field key on '${object.key}'`,
    );
    for (const field of object.fields) {
      fieldIds.push(field.id);
      if (field.objectTypeId !== object.id) {
        invalidImport(`Field '${field.key}' references the wrong object`);
      }
      validateFieldDefinition(field);
    }
    const title = object.fields.find(
      (field) => field.key === object.titleFieldKey && field.archivedAt === null,
    );
    if (title?.type !== 'text' || !title.required) {
      invalidImport(`Object '${object.key}' has an invalid title field`);
    }
  }
  assertUnique(fieldIds, 'field ID');

  assertUnique(
    document.data.records.map((record) => record.id),
    'record ID',
  );
  const recordIds = new Set(document.data.records.map((record) => record.id));
  for (const record of document.data.records) {
    const object = objects.get(record.object);
    if (!object) invalidImport(`Record '${record.id}' references an unknown object`);
    if (object.archivedAt !== null) {
      invalidImport(`Archived object '${object.key}' cannot contain records`);
    }
    if (record.schemaVersion > object.schemaVersion) {
      invalidImport(`Record '${record.id}' has a future schema version`);
    }
    const fields = new Map(object.fields.map((field) => [field.key, field]));
    for (const [key, value] of Object.entries(record.values)) {
      const field = fields.get(key);
      if (!field) invalidImport(`Record '${record.id}' contains unknown field '${key}'`);
      if (value === null || value === undefined) {
        invalidImport(`Record '${record.id}' contains a null field value`, { field: key });
      }
      try {
        const normalized = validateAndNormalizeFieldValue(field as FieldDefinition, value);
        if (canonicalJson(normalized) !== canonicalJson(value)) {
          invalidImport(`Record '${record.id}' contains a non-normalized field value`, {
            field: key,
          });
        }
      } catch (error) {
        if (error instanceof AppError && error.code === 'IMPORT_INVALID') throw error;
        invalidImport(`Record '${record.id}' contains an invalid field value`, { field: key });
      }
    }
    for (const field of object.fields) {
      if (field.archivedAt === null && field.required && !Object.hasOwn(record.values, field.key)) {
        invalidImport(`Record '${record.id}' is missing required field '${field.key}'`);
      }
    }
    if (record.values[object.titleFieldKey] !== record.displayName) {
      invalidImport(`Record '${record.id}' has an inconsistent display name`);
    }
    validateTimestamps(
      `Record '${record.id}'`,
      record.createdAt,
      record.updatedAt,
      record.archivedAt,
    );
  }

  assertUnique(
    document.data.relationships.map((relationship) => relationship.id),
    'relationship ID',
  );
  const activeRelationships = new Set<string>();
  for (const relationship of document.data.relationships) {
    validateTimestamps(
      `Relationship '${relationship.id}'`,
      relationship.createdAt,
      relationship.updatedAt,
      relationship.archivedAt,
    );
    if (
      !recordIds.has(relationship.sourceRecordId) ||
      !recordIds.has(relationship.targetRecordId)
    ) {
      invalidImport(`Relationship '${relationship.id}' references an unknown record`);
    }
    if (relationship.sourceRecordId === relationship.targetRecordId) {
      invalidImport(`Relationship '${relationship.id}' links a record to itself`);
    }
    if (relationship.archivedAt === null) {
      const key = `${relationship.sourceRecordId}\0${relationship.targetRecordId}\0${relationship.type}`;
      if (activeRelationships.has(key)) {
        invalidImport('Import contains duplicate active relationships', {
          relationshipId: relationship.id,
        });
      }
      activeRelationships.add(key);
    }
  }

  assertUnique(
    document.data.events.map((event) => event.id),
    'event ID',
  );
  assertUnique(
    document.data.events.flatMap((event) =>
      event.idempotencyKey === null ? [] : [event.idempotencyKey],
    ),
    'event idempotency key',
  );
  const objectIds = new Set(document.data.objects.map((object) => object.id));
  const relationshipIds = new Set(
    document.data.relationships.map((relationship) => relationship.id),
  );
  const fieldIdSet = new Set(fieldIds);
  for (const event of document.data.events) {
    validateTimestamps(`Event '${event.id}'`, event.createdAt);
    const knownSubject =
      event.subjectType === 'object'
        ? objectIds.has(event.subjectId)
        : event.subjectType === 'field'
          ? fieldIdSet.has(event.subjectId)
          : event.subjectType === 'record'
            ? recordIds.has(event.subjectId)
            : event.subjectType === 'relationship'
              ? relationshipIds.has(event.subjectId)
              : true;
    if (!knownSubject) {
      invalidImport(`Event '${event.id}' references an unknown ${event.subjectType} subject`);
    }
  }
}

function schemaFingerprint(objects: ObjectDefinition[]): string {
  return canonicalJson(
    objects.map((object) => ({
      key: object.key,
      label: object.label,
      pluralLabel: object.pluralLabel,
      description: object.description,
      titleFieldKey: object.titleFieldKey,
      schemaVersion: object.schemaVersion,
      system: object.system,
      archivedAt: object.archivedAt,
      fields: object.fields.map((field) => ({
        key: field.key,
        label: field.label,
        description: field.description,
        type: field.type,
        format: field.format,
        required: field.required,
        options: field.options,
        ...(Object.hasOwn(field, 'defaultValue') ? { defaultValue: field.defaultValue } : {}),
        position: field.position,
        system: field.system,
        archivedAt: field.archivedAt,
      })),
    })),
  );
}

function expectedDefaultFingerprint(): string {
  return canonicalJson(
    [...DEFAULT_SCHEMA]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((object) => ({
        key: object.key,
        label: object.label,
        pluralLabel: object.pluralLabel,
        description: null,
        titleFieldKey: object.titleFieldKey,
        schemaVersion: 1,
        system: true,
        archivedAt: null,
        fields: object.fields.map((field, position) => ({
          key: field.key,
          label: field.label,
          description: null,
          type: field.type,
          format: field.format ?? null,
          required: field.required === true,
          options: field.options ?? null,
          ...(Object.hasOwn(field, 'defaultValue') ? { defaultValue: field.defaultValue } : {}),
          position,
          system: true,
          archivedAt: null,
        })),
      })),
  );
}

function assertPristineTarget(database: DatabaseSync): void {
  const counts = database
    .prepare(`
    SELECT
      (SELECT COUNT(*) FROM records) AS records,
      (SELECT COUNT(*) FROM relationships) AS relationships,
      (SELECT COUNT(*) FROM events) AS events
  `)
    .get() as unknown as { records: number; relationships: number; events: number };
  const pristine =
    counts.records === 0 &&
    counts.relationships === 0 &&
    counts.events === 0 &&
    schemaFingerprint(describeSchema(database)) === expectedDefaultFingerprint();
  if (!pristine) {
    throw new AppError(
      'IMPORT_TARGET_NOT_EMPTY',
      'Import requires an initialized database with an untouched default schema and no user data',
      counts,
    );
  }
}

function importCounts(document: ExportDocument): ImportResult['imported'] {
  return {
    objects: document.data.objects.length,
    fields: document.data.objects.reduce((count, object) => count + object.fields.length, 0),
    records: document.data.records.length,
    relationships: document.data.relationships.length,
    events: document.data.events.length,
  };
}

export function dryRunImport(database: DatabaseSync, document: ExportDocument): ImportResult {
  assertPristineTarget(database);
  return {
    formatVersion: document.formatVersion,
    imported: importCounts(document),
    historyIncluded: document.historyIncluded,
    dryRun: true,
    replayed: false,
  };
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

function insertDocument(database: DatabaseSync, document: ExportDocument): void {
  database.exec(`
    DELETE FROM records_fts;
    DELETE FROM relationships;
    DELETE FROM records;
    DELETE FROM field_definitions;
    DELETE FROM object_types;
  `);
  const insertObject = database.prepare(`
    INSERT INTO object_types(
      id, key, label, plural_label, description, title_field_key, schema_version,
      system, created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertField = database.prepare(`
    INSERT INTO field_definitions(
      id, object_type_id, key, label, description, type, format, required,
      options_json, default_value_json, position, system, created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const object of document.data.objects) {
    insertObject.run(
      object.id,
      object.key,
      object.label,
      object.pluralLabel,
      object.description,
      object.titleFieldKey,
      object.schemaVersion,
      object.system ? 1 : 0,
      object.createdAt,
      object.updatedAt,
      object.archivedAt,
    );
    for (const field of object.fields) {
      insertField.run(
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
        field.system ? 1 : 0,
        field.createdAt,
        field.updatedAt,
        field.archivedAt,
      );
    }
  }

  const objectIds = new Map(document.data.objects.map((object) => [object.key, object.id]));
  const objects = new Map(document.data.objects.map((object) => [object.key, object]));
  const insertRecord = database.prepare(`
    INSERT INTO records(
      id, object_type_id, display_name, values_json, schema_version,
      created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = database.prepare(
    'INSERT INTO records_fts(record_id, object_key, display_name, content) VALUES (?, ?, ?, ?)',
  );
  for (const record of document.data.records) {
    insertRecord.run(
      record.id,
      objectIds.get(record.object) as string,
      record.displayName,
      JSON.stringify(record.values),
      record.schemaVersion,
      record.createdAt,
      record.updatedAt,
      record.archivedAt,
    );
    const object = objects.get(record.object) as ExportObject;
    if (record.archivedAt === null && object.archivedAt === null) {
      const content: string[] = [];
      for (const field of object.fields) {
        if (field.archivedAt === null && Object.hasOwn(record.values, field.key)) {
          flattenSearchValue(record.values[field.key], content);
        }
      }
      insertFts.run(record.id, record.object, record.displayName, content.join(' '));
    }
  }

  const insertRelationship = database.prepare(`
    INSERT INTO relationships(
      id, source_record_id, target_record_id, type, properties_json,
      created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const relationship of document.data.relationships) {
    insertRelationship.run(
      relationship.id,
      relationship.sourceRecordId,
      relationship.targetRecordId,
      relationship.type,
      JSON.stringify(relationship.properties),
      relationship.createdAt,
      relationship.updatedAt,
      relationship.archivedAt,
    );
  }

  const insertEvent = database.prepare(`
    INSERT INTO events(
      id, subject_type, subject_id, action, actor, source, idempotency_key,
      before_json, after_json, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const event of document.data.events) {
    insertEvent.run(
      event.id,
      event.subjectType,
      event.subjectId,
      event.action,
      event.actor,
      event.source,
      event.idempotencyKey,
      event.before === null ? null : JSON.stringify(event.before),
      event.after === null ? null : JSON.stringify(event.after),
      JSON.stringify(event.metadata),
      event.createdAt,
    );
  }
}

export function importDocument(
  database: DatabaseSync,
  document: ExportDocument,
  options: ImportOptions,
): ImportResult {
  const hash = requestHash({
    operation: 'import',
    document,
    actor: options.actor,
    source: options.source ?? null,
  });
  return inImmediateTransaction(database, () => {
    const replay = findIdempotentReplay<ImportResult>(database, options.idempotencyKey, hash);
    if (replay) return { ...replay, replayed: true };
    if (
      options.idempotencyKey &&
      document.data.events.some((event) => event.idempotencyKey === options.idempotencyKey)
    ) {
      throw new AppError(
        'IDEMPOTENCY_CONFLICT',
        'The import idempotency key is already present in imported history',
        { idempotencyKey: options.idempotencyKey },
      );
    }
    assertPristineTarget(database);
    insertDocument(database, document);

    const result: ImportResult = {
      formatVersion: document.formatVersion,
      imported: importCounts(document),
      historyIncluded: document.historyIncluded,
      dryRun: false,
      replayed: false,
    };
    const instance = database
      .prepare("SELECT value FROM metadata WHERE key = 'instance_id'")
      .get() as { value: string };
    const timestamp = now();
    database
      .prepare(`
        INSERT INTO events(
          id, subject_type, subject_id, action, actor, source, idempotency_key,
          before_json, after_json, metadata_json, created_at
        ) VALUES (?, 'database', ?, 'imported', ?, ?, ?, NULL, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        instance.value,
        options.actor,
        options.source ?? null,
        options.idempotencyKey ?? null,
        JSON.stringify(result),
        JSON.stringify({
          operation: 'import',
          requestHash: hash,
          result,
          cliVersion: options.cliVersion,
          workingDirectory: process.cwd(),
        }),
        timestamp,
      );
    return result;
  });
}
