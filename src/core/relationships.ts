import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { inImmediateTransaction } from '../db/transaction.js';
import { requestHash } from './canonical.js';
import { AppError } from './errors.js';
import { appendMutationEvent } from './events.js';
import { findIdempotentReplay } from './idempotency.js';
import { getRecord } from './records.js';
import { now } from './time.js';

export interface RecordSummary {
  id: string;
  object: string;
  displayName: string;
  archivedAt: string | null;
}

export interface RelationshipData {
  id: string;
  type: string;
  source: RecordSummary;
  target: RecordSummary;
  properties: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ListedRelationship extends RelationshipData {
  direction: 'outgoing' | 'incoming';
}

export interface AddRelationshipResult extends RelationshipData {
  replayed: boolean;
}

export interface RelationshipMutationOptions {
  actor: string;
  source?: string;
  idempotencyKey?: string;
  cliVersion: string;
}

interface RelationshipRow {
  id: string;
  type: string;
  properties_json: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  source_id: string;
  source_object: string;
  source_name: string;
  target_id: string;
  target_object: string;
  target_name: string;
  source_archived_at: string | null;
  target_archived_at: string | null;
}

const relationshipSelect = `
  SELECT
    rel.id,
    rel.type,
    rel.properties_json,
    rel.created_at,
    rel.updated_at,
    rel.archived_at,
    source.id AS source_id,
    source_object.key AS source_object,
    source.display_name AS source_name,
    target.id AS target_id,
    target_object.key AS target_object,
    target.display_name AS target_name,
    source.archived_at AS source_archived_at,
    target.archived_at AS target_archived_at
  FROM relationships rel
  JOIN records source ON source.id = rel.source_record_id
  JOIN object_types source_object ON source_object.id = source.object_type_id
  JOIN records target ON target.id = rel.target_record_id
  JOIN object_types target_object ON target_object.id = target.object_type_id
`;

function mapRelationship(row: RelationshipRow): RelationshipData {
  return {
    id: row.id,
    type: row.type,
    source: {
      id: row.source_id,
      object: row.source_object,
      displayName: row.source_name,
      archivedAt: row.source_archived_at,
    },
    target: {
      id: row.target_id,
      object: row.target_object,
      displayName: row.target_name,
      archivedAt: row.target_archived_at,
    },
    properties: JSON.parse(row.properties_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function requireActiveRecord(database: DatabaseSync, idPrefix: string): RecordSummary {
  const record = getRecord(database, idPrefix);
  if (record.archivedAt !== null) {
    throw new AppError('RECORD_ARCHIVED', `Record '${idPrefix}' is archived`, {
      id: record.id,
      archivedAt: record.archivedAt,
    });
  }
  return {
    id: record.id,
    object: record.object,
    displayName: record.displayName,
    archivedAt: record.archivedAt,
  };
}

export function addRelationship(
  database: DatabaseSync,
  sourceId: string,
  type: string,
  targetId: string,
  options: RelationshipMutationOptions,
): AddRelationshipResult {
  if (!/^[a-z][a-z0-9_]*$/.test(type)) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Relationship type must start with a letter and contain lowercase letters, numbers, or underscores',
      { type },
    );
  }

  const source = requireActiveRecord(database, sourceId);
  const target = requireActiveRecord(database, targetId);
  if (source.id === target.id) {
    throw new AppError('VALIDATION_ERROR', 'A record cannot be related to itself', {
      recordId: source.id,
    });
  }

  const hash = requestHash({
    operation: 'relationship.add',
    sourceId: source.id,
    type,
    targetId: target.id,
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
          result?: RelationshipData;
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

    const duplicate = database
      .prepare(`
        SELECT id FROM relationships
        WHERE source_record_id = ? AND target_record_id = ? AND type = ? AND archived_at IS NULL
      `)
      .get(source.id, target.id, type) as { id: string } | undefined;
    if (duplicate) {
      throw new AppError('DUPLICATE_RELATIONSHIP', 'The active relationship already exists', {
        relationshipId: duplicate.id,
        sourceId: source.id,
        targetId: target.id,
        type,
      });
    }

    const timestamp = now();
    const relationship: RelationshipData = {
      id: randomUUID(),
      type,
      source,
      target,
      properties: {},
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    };

    database
      .prepare(`
        INSERT INTO relationships(
          id, source_record_id, target_record_id, type, properties_json,
          created_at, updated_at, archived_at
        ) VALUES (?, ?, ?, ?, '{}', ?, ?, NULL)
      `)
      .run(relationship.id, source.id, target.id, type, timestamp, timestamp);

    const metadata: Record<string, unknown> = {
      operation: 'relationship.add',
      requestHash: hash,
      result: relationship,
      cliVersion: options.cliVersion,
      workingDirectory: process.cwd(),
    };
    if (process.env.PI_SESSION_ID) metadata.piSessionId = process.env.PI_SESSION_ID;

    database
      .prepare(`
        INSERT INTO events(
          id, subject_type, subject_id, action, actor, source, idempotency_key,
          before_json, after_json, metadata_json, created_at
        ) VALUES (?, 'relationship', ?, 'linked', ?, ?, ?, NULL, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        relationship.id,
        options.actor,
        options.source ?? null,
        options.idempotencyKey ?? null,
        JSON.stringify(relationship),
        JSON.stringify(metadata),
        timestamp,
      );

    return { ...relationship, replayed: false };
  });
}

function validateIdPrefix(idPrefix: string): string {
  const normalized = idPrefix.toLowerCase();
  if (normalized.length < 8 || !/^[0-9a-f-]+$/.test(normalized)) {
    throw new AppError('VALIDATION_ERROR', 'IDs require a valid prefix of at least 8 characters', {
      id: idPrefix,
    });
  }
  return normalized;
}

export function getRelationship(database: DatabaseSync, idPrefix: string): RelationshipData {
  const prefix = validateIdPrefix(idPrefix);
  const rows = database
    .prepare(`
      ${relationshipSelect}
      WHERE lower(rel.id) LIKE ?
      ORDER BY rel.id ASC
      LIMIT 3
    `)
    .all(`${prefix}%`) as unknown as RelationshipRow[];
  if (rows.length === 0) {
    throw new AppError('RELATIONSHIP_NOT_FOUND', `Relationship '${idPrefix}' was not found`, {
      id: idPrefix,
    });
  }
  if (rows.length > 1) {
    throw new AppError('AMBIGUOUS_ID', 'The ID prefix matches more than one relationship', {
      id: idPrefix,
      matches: rows.map((row) => row.id),
    });
  }
  const row = rows[0];
  if (!row)
    throw new AppError('RELATIONSHIP_NOT_FOUND', `Relationship '${idPrefix}' was not found`);
  return mapRelationship(row);
}

export interface ListRelationshipOptions {
  includeArchived?: boolean;
}

export function listRelationships(
  database: DatabaseSync,
  recordId: string,
  options: ListRelationshipOptions = {},
): ListedRelationship[] {
  const record = getRecord(database, recordId);
  if (record.archivedAt !== null && options.includeArchived !== true) {
    throw new AppError('RECORD_ARCHIVED', `Record '${recordId}' is archived`, {
      id: record.id,
      archivedAt: record.archivedAt,
    });
  }
  const visibility =
    options.includeArchived === true
      ? ''
      : 'AND rel.archived_at IS NULL AND source.archived_at IS NULL AND target.archived_at IS NULL';
  const rows = database
    .prepare(`
      ${relationshipSelect}
      WHERE (rel.source_record_id = ? OR rel.target_record_id = ?)
        ${visibility}
      ORDER BY rel.created_at DESC, rel.id ASC
    `)
    .all(record.id, record.id) as unknown as RelationshipRow[];

  return rows.map((row) => ({
    ...mapRelationship(row),
    direction: row.source_id === record.id ? 'outgoing' : 'incoming',
  }));
}

export function archiveRelationship(
  database: DatabaseSync,
  idPrefix: string,
  options: RelationshipMutationOptions,
): AddRelationshipResult {
  return inImmediateTransaction(database, () => {
    const current = getRelationship(database, idPrefix);
    const hash = requestHash({
      operation: 'relationship.archive',
      relationshipId: current.id,
      actor: options.actor,
      source: options.source ?? null,
    });
    const replay = findIdempotentReplay<RelationshipData>(database, options.idempotencyKey, hash);
    if (replay) return { ...replay, replayed: true };
    if (current.archivedAt !== null) {
      throw new AppError(
        'RELATIONSHIP_ARCHIVED',
        `Relationship '${idPrefix}' is already archived`,
        { id: current.id, archivedAt: current.archivedAt },
      );
    }
    const timestamp = now();
    const result: RelationshipData = { ...current, updatedAt: timestamp, archivedAt: timestamp };
    database
      .prepare('UPDATE relationships SET updated_at = ?, archived_at = ? WHERE id = ?')
      .run(timestamp, timestamp, current.id);
    appendMutationEvent(
      database,
      {
        subjectType: 'relationship',
        subjectId: current.id,
        action: 'archived',
        operation: 'relationship.archive',
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

export function restoreRelationship(
  database: DatabaseSync,
  idPrefix: string,
  options: RelationshipMutationOptions,
): AddRelationshipResult {
  return inImmediateTransaction(database, () => {
    const current = getRelationship(database, idPrefix);
    const hash = requestHash({
      operation: 'relationship.restore',
      relationshipId: current.id,
      actor: options.actor,
      source: options.source ?? null,
    });
    const replay = findIdempotentReplay<RelationshipData>(database, options.idempotencyKey, hash);
    if (replay) return { ...replay, replayed: true };
    if (current.archivedAt === null) {
      throw new AppError('VALIDATION_ERROR', `Relationship '${idPrefix}' is not archived`, {
        id: current.id,
      });
    }
    if (current.source.archivedAt !== null || current.target.archivedAt !== null) {
      throw new AppError(
        'RECORD_ARCHIVED',
        'Both relationship endpoints must be active before restoration',
        {
          sourceId: current.source.id,
          sourceArchivedAt: current.source.archivedAt,
          targetId: current.target.id,
          targetArchivedAt: current.target.archivedAt,
        },
      );
    }
    const duplicate = database
      .prepare(`
        SELECT id FROM relationships
        WHERE source_record_id = ? AND target_record_id = ? AND type = ?
          AND archived_at IS NULL AND id <> ?
      `)
      .get(current.source.id, current.target.id, current.type, current.id) as
      | { id: string }
      | undefined;
    if (duplicate) {
      throw new AppError(
        'DUPLICATE_RELATIONSHIP',
        'An equivalent active relationship already exists',
        { relationshipId: duplicate.id },
      );
    }
    const timestamp = now();
    const result: RelationshipData = { ...current, updatedAt: timestamp, archivedAt: null };
    database
      .prepare('UPDATE relationships SET updated_at = ?, archived_at = NULL WHERE id = ?')
      .run(timestamp, current.id);
    appendMutationEvent(
      database,
      {
        subjectType: 'relationship',
        subjectId: current.id,
        action: 'restored',
        operation: 'relationship.restore',
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
