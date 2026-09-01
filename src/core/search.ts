import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { AppError } from './errors.js';
import { getRecord } from './records.js';
import { describeSchema, getActiveObject } from './schema.js';

export interface SearchOptions {
  object?: string;
  limit: number;
  offset: number;
}

export interface SearchResultItem {
  id: string;
  object: string;
  displayName: string;
  rank: number;
  preview: Record<string, unknown>;
}

export interface SearchResult {
  results: SearchResultItem[];
  pagination: {
    limit: number;
    offset: number;
    count: number;
    hasMore: boolean;
  };
}

interface SearchRow {
  record_id: string;
  object_key: string;
  display_name: string;
  rank: number;
}

function ftsQuery(query: string): string {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0 || terms.length > 20) {
    throw new AppError('VALIDATION_ERROR', 'Search requires 1 to 20 terms');
  }
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' ');
}

function previewValue(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 199)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value.slice(0, 10);
  }
  return undefined;
}

export function searchRecords(
  database: DatabaseSync,
  query: string,
  options: SearchOptions,
): SearchResult {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 500) {
    throw new AppError('VALIDATION_ERROR', 'Limit must be an integer from 1 through 500');
  }
  if (!Number.isInteger(options.offset) || options.offset < 0) {
    throw new AppError('VALIDATION_ERROR', 'Offset must be a non-negative integer');
  }
  if (options.object) getActiveObject(database, options.object);

  const parameters: SQLInputValue[] = [ftsQuery(query)];
  const objectClause = options.object ? 'AND f.object_key = ?' : '';
  if (options.object) parameters.push(options.object);
  parameters.push(options.limit + 1, options.offset);

  let rows: SearchRow[];
  try {
    rows = database
      .prepare(`
        SELECT
          f.record_id,
          f.object_key,
          f.display_name,
          bm25(records_fts) AS rank
        FROM records_fts f
        JOIN records r ON r.id = f.record_id
        WHERE records_fts MATCH ?
          AND r.archived_at IS NULL
          ${objectClause}
        ORDER BY rank ASC, f.record_id ASC
        LIMIT ? OFFSET ?
      `)
      .all(...parameters) as unknown as SearchRow[];
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Search text could not be parsed');
  }

  const hasMore = rows.length > options.limit;
  const selected = rows.slice(0, options.limit);
  const schemas = new Map(describeSchema(database).map((object) => [object.key, object]));
  const results = selected.map((row) => {
    const record = getRecord(database, row.record_id);
    const object = schemas.get(record.object);
    const preview: Record<string, unknown> = {};
    for (const field of object?.fields ?? []) {
      if (field.archivedAt !== null || !Object.hasOwn(record.values, field.key)) continue;
      const value = previewValue(record.values[field.key]);
      if (value !== undefined) preview[field.key] = value;
    }
    return {
      id: row.record_id,
      object: row.object_key,
      displayName: row.display_name,
      rank: row.rank,
      preview,
    };
  });

  return {
    results,
    pagination: {
      limit: options.limit,
      offset: options.offset,
      count: results.length,
      hasMore,
    },
  };
}
