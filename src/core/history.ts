import type { DatabaseSync } from 'node:sqlite';
import { AppError } from './errors.js';

export interface EventSummary {
  id: string;
  subjectType: string;
  subjectId: string;
  action: string;
  actor: string;
  source: string | null;
  createdAt: string;
}

export interface EventDetail extends EventSummary {
  idempotencyKey: string | null;
  before: unknown;
  after: unknown;
  metadata: Record<string, unknown>;
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

function validatePrefix(idPrefix: string): string {
  const normalized = idPrefix.toLowerCase();
  if (normalized.length < 8 || !/^[0-9a-f-]+$/.test(normalized)) {
    throw new AppError('VALIDATION_ERROR', 'IDs require a valid prefix of at least 8 characters', {
      id: idPrefix,
    });
  }
  return normalized;
}

function summary(row: EventRow): EventSummary {
  return {
    id: row.id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    action: row.action,
    actor: row.actor,
    source: row.source,
    createdAt: row.created_at,
  };
}

export function getHistory(
  database: DatabaseSync,
  subjectId: string,
  limit: number,
): EventSummary[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new AppError('VALIDATION_ERROR', 'History limit must be an integer from 1 through 500');
  }
  const prefix = validatePrefix(subjectId);
  const subjects = database
    .prepare(`
      SELECT DISTINCT subject_type, subject_id
      FROM events
      WHERE lower(subject_id) LIKE ?
      ORDER BY subject_id ASC
      LIMIT 3
    `)
    .all(`${prefix}%`) as unknown as Array<{ subject_type: string; subject_id: string }>;
  if (subjects.length === 0) {
    throw new AppError('EVENT_NOT_FOUND', `No history was found for subject '${subjectId}'`, {
      id: subjectId,
    });
  }
  if (subjects.length > 1) {
    throw new AppError('AMBIGUOUS_ID', 'The ID prefix matches more than one history subject', {
      id: subjectId,
      matches: subjects,
    });
  }
  const subject = subjects[0];
  if (!subject) {
    throw new AppError('EVENT_NOT_FOUND', `No history was found for subject '${subjectId}'`);
  }
  const rows = database
    .prepare(`
      SELECT * FROM events
      WHERE subject_type = ? AND subject_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `)
    .all(subject.subject_type, subject.subject_id, limit) as unknown as EventRow[];
  return rows.map(summary);
}

export function getEvent(database: DatabaseSync, eventId: string): EventDetail {
  const prefix = validatePrefix(eventId);
  const rows = database
    .prepare('SELECT * FROM events WHERE lower(id) LIKE ? ORDER BY id ASC LIMIT 3')
    .all(`${prefix}%`) as unknown as EventRow[];
  if (rows.length === 0) {
    throw new AppError('EVENT_NOT_FOUND', `Event '${eventId}' was not found`, { id: eventId });
  }
  if (rows.length > 1) {
    throw new AppError('AMBIGUOUS_ID', 'The ID prefix matches more than one event', {
      id: eventId,
      matches: rows.map((row) => row.id),
    });
  }
  const row = rows[0];
  if (!row) throw new AppError('EVENT_NOT_FOUND', `Event '${eventId}' was not found`);
  return {
    ...summary(row),
    idempotencyKey: row.idempotency_key,
    before: row.before_json === null ? null : (JSON.parse(row.before_json) as unknown),
    after: row.after_json === null ? null : (JSON.parse(row.after_json) as unknown),
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
  };
}
