import type { DatabaseSync } from 'node:sqlite';
import { getRecord } from './records.js';
import { type ListedRelationship, listRelationships } from './relationships.js';
import type { RecordData } from './types.js';

export interface ContextOptions {
  maxRelated: number;
  maxInteractions: number;
  maxFollowups: number;
  maxChars: number;
}

export interface ContextResult {
  record: RecordData;
  relationships: {
    outgoing: ListedRelationship[];
    incoming: ListedRelationship[];
  };
  relatedRecords: RecordData[];
  recentInteractions: RecordData[];
  openFollowups: RecordData[];
  truncation: {
    truncated: boolean;
    maxChars: number;
    omitted: Record<string, number>;
  };
}

function increment(omitted: Record<string, number>, key: string, amount = 1): void {
  omitted[key] = (omitted[key] ?? 0) + amount;
}

function relatedId(relationship: ListedRelationship): string {
  return relationship.direction === 'outgoing' ? relationship.target.id : relationship.source.id;
}

function queryLinkedRecordIds(
  database: DatabaseSync,
  objectKey: 'interaction' | 'followup',
  relationshipType: 'involves' | 'concerns',
  targetIds: string[],
  limit: number,
  orderField: 'occurred_at' | 'due_at',
  requireOpen: boolean,
): string[] {
  if (targetIds.length === 0 || limit < 0) return [];
  const placeholders = targetIds.map(() => '?').join(', ');
  const statusClause = requireOpen ? "AND json_extract(r.values_json, '$.status') = 'open'" : '';
  const rows = database
    .prepare(`
      SELECT DISTINCT r.id, json_extract(r.values_json, '$.${orderField}') AS ordered_value
      FROM records r
      JOIN object_types object_type ON object_type.id = r.object_type_id
      JOIN relationships rel ON rel.source_record_id = r.id
      JOIN records target ON target.id = rel.target_record_id
      WHERE object_type.key = ?
        AND r.archived_at IS NULL
        AND target.archived_at IS NULL
        AND rel.archived_at IS NULL
        AND rel.type = ?
        AND rel.target_record_id IN (${placeholders})
        ${statusClause}
      ORDER BY ordered_value ${objectKey === 'interaction' ? 'DESC' : 'ASC'}, r.id ASC
      LIMIT ?
    `)
    .all(objectKey, relationshipType, ...targetIds, limit + 1) as unknown as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function enforceCharacterLimit(result: ContextResult): void {
  const size = () => JSON.stringify(result).length;
  while (size() > result.truncation.maxChars) {
    if (result.recentInteractions.length > 0) {
      result.recentInteractions.pop();
      increment(result.truncation.omitted, 'recentInteractions');
    } else if (result.openFollowups.length > 0) {
      result.openFollowups.pop();
      increment(result.truncation.omitted, 'openFollowups');
    } else if (result.relatedRecords.length > 0) {
      result.relatedRecords.pop();
      increment(result.truncation.omitted, 'relatedRecords');
    } else if (result.relationships.incoming.length > 0) {
      result.relationships.incoming.pop();
      increment(result.truncation.omitted, 'relationships');
    } else if (result.relationships.outgoing.length > 0) {
      result.relationships.outgoing.pop();
      increment(result.truncation.omitted, 'relationships');
    } else {
      increment(
        result.truncation.omitted,
        'primaryRecordCharacters',
        size() - result.truncation.maxChars,
      );
      result.truncation.truncated = true;
      break;
    }
    result.truncation.truncated = true;
  }
}

export function getContext(
  database: DatabaseSync,
  recordId: string,
  options: ContextOptions,
): ContextResult {
  const record = getRecord(database, recordId);
  const allRelationships = listRelationships(database, record.id);
  const selectedRelationships = allRelationships.slice(0, options.maxRelated);
  const relatedIds = [...new Set(selectedRelationships.map(relatedId))];
  const relatedRecords = relatedIds.map((id) => getRecord(database, id));

  const interactionTargets = [
    ...(record.object === 'person' || record.object === 'organization' ? [record.id] : []),
    ...relatedRecords
      .filter((related) => related.object === 'person' || related.object === 'organization')
      .map((related) => related.id),
  ];
  const interactionIds = queryLinkedRecordIds(
    database,
    'interaction',
    'involves',
    [...new Set(interactionTargets)],
    options.maxInteractions,
    'occurred_at',
    false,
  );
  const followupIds = queryLinkedRecordIds(
    database,
    'followup',
    'concerns',
    [record.id],
    options.maxFollowups,
    'due_at',
    true,
  );

  const omitted: Record<string, number> = {};
  if (allRelationships.length > selectedRelationships.length) {
    omitted.relationships = allRelationships.length - selectedRelationships.length;
  }
  if (interactionIds.length > options.maxInteractions) {
    omitted.recentInteractions = interactionIds.length - options.maxInteractions;
  }
  if (followupIds.length > options.maxFollowups) {
    omitted.openFollowups = followupIds.length - options.maxFollowups;
  }

  const result: ContextResult = {
    record,
    relationships: {
      outgoing: selectedRelationships.filter(
        (relationship) => relationship.direction === 'outgoing',
      ),
      incoming: selectedRelationships.filter(
        (relationship) => relationship.direction === 'incoming',
      ),
    },
    relatedRecords,
    recentInteractions: interactionIds
      .slice(0, options.maxInteractions)
      .map((id) => getRecord(database, id)),
    openFollowups: followupIds.slice(0, options.maxFollowups).map((id) => getRecord(database, id)),
    truncation: {
      truncated: Object.keys(omitted).length > 0,
      maxChars: options.maxChars,
      omitted,
    },
  };

  enforceCharacterLimit(result);
  return result;
}
