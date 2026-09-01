import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { AppError } from './errors.js';
import { mapStoredRecord, type StoredRecordRow } from './records.js';
import { getActiveObject } from './schema.js';
import type { FieldDefinition, ObjectDefinition, RecordData } from './types.js';
import { validateAndNormalizeFieldValue } from './validation.js';

const MAX_FILTER_DEPTH = 5;
const MAX_PREDICATES = 25;
const MAX_IN_VALUES = 100;

const operators = [
  'eq',
  'neq',
  'contains',
  'starts_with',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'exists',
] as const;

type FilterOperator = (typeof operators)[number];

interface CompileState {
  predicates: number;
}

interface CompiledFilter {
  sql: string;
  parameters: SQLInputValue[];
}

export interface ListRecordsOptions {
  filter?: unknown;
  sort?: string;
  limit: number;
  offset: number;
  includeArchived: boolean;
}

export interface ListRecordsResult {
  records: RecordData[];
  pagination: {
    limit: number;
    offset: number;
    count: number;
    hasMore: boolean;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonPath(field: FieldDefinition): string {
  return `$.${field.key}`;
}

function sqlValue(value: unknown): SQLInputValue {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return value;
  }
  throw new AppError('INVALID_FIELD_VALUE', 'Filter value is not a supported scalar', { value });
}

function allowedOperators(field: FieldDefinition): FilterOperator[] {
  switch (field.type) {
    case 'text':
      return ['eq', 'neq', 'contains', 'starts_with', 'in', 'exists'];
    case 'number':
    case 'date':
    case 'datetime':
      return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'exists'];
    case 'boolean':
    case 'enum':
      return ['eq', 'neq', 'in', 'exists'];
    case 'multi_select':
      return ['contains', 'exists'];
    case 'json':
      return ['exists'];
  }
}

function requireOperator(field: FieldDefinition, value: unknown): FilterOperator {
  if (typeof value !== 'string' || !operators.includes(value as FilterOperator)) {
    throw new AppError('INVALID_OPERATOR', `Unknown filter operator '${String(value)}'`, {
      field: field.key,
      operator: value,
    });
  }
  const operator = value as FilterOperator;
  if (!allowedOperators(field).includes(operator)) {
    throw new AppError(
      'INVALID_OPERATOR',
      `Operator '${operator}' is not valid for ${field.type} field '${field.key}'`,
      { field: field.key, fieldType: field.type, operator },
    );
  }
  return operator;
}

function normalizePredicateValue(
  field: FieldDefinition,
  operator: FilterOperator,
  value: unknown,
): SQLInputValue | SQLInputValue[] {
  if (operator === 'exists') {
    if (typeof value !== 'boolean') {
      throw new AppError('INVALID_FIELD_VALUE', "Operator 'exists' requires a boolean value", {
        field: field.key,
        value,
      });
    }
    return sqlValue(value);
  }

  if (operator === 'in') {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IN_VALUES) {
      throw new AppError(
        'INVALID_FIELD_VALUE',
        `Operator 'in' requires an array of 1 to ${MAX_IN_VALUES} values`,
        { field: field.key },
      );
    }
    return value.map((entry) => sqlValue(validateAndNormalizeFieldValue(field, entry)));
  }

  if (field.type === 'multi_select' && operator === 'contains') {
    if (typeof value !== 'string') {
      throw new AppError(
        'INVALID_FIELD_VALUE',
        `Operator 'contains' requires a string for field '${field.key}'`,
      );
    }
    const normalized = validateAndNormalizeFieldValue(field, [value]);
    return sqlValue((normalized as string[])[0]);
  }

  return sqlValue(validateAndNormalizeFieldValue(field, value));
}

function compilePredicate(
  node: Record<string, unknown>,
  fields: Map<string, FieldDefinition>,
  state: CompileState,
): CompiledFilter {
  const keys = Object.keys(node);
  if (!keys.every((key) => key === 'field' || key === 'op' || key === 'value')) {
    throw new AppError('VALIDATION_ERROR', 'Filter predicate contains unknown properties', {
      properties: keys,
    });
  }
  if (typeof node.field !== 'string') {
    throw new AppError('VALIDATION_ERROR', 'Filter predicate requires a field name');
  }
  const field = fields.get(node.field);
  if (!field) {
    throw new AppError('UNKNOWN_FIELD', `Field '${node.field}' is not an active field`, {
      field: node.field,
    });
  }

  state.predicates += 1;
  if (state.predicates > MAX_PREDICATES) {
    throw new AppError('VALIDATION_ERROR', `Filters support at most ${MAX_PREDICATES} predicates`);
  }

  const operator = requireOperator(field, node.op);
  const value = normalizePredicateValue(field, operator, node.value);
  const path = jsonPath(field);

  if (operator === 'exists') {
    return {
      sql: `json_type(r.values_json, ?) IS ${value === 1 ? 'NOT ' : ''}NULL`,
      parameters: [path],
    };
  }
  if (operator === 'contains' && field.type === 'multi_select') {
    return {
      sql: 'EXISTS (SELECT 1 FROM json_each(r.values_json, ?) item WHERE item.value = ?)',
      parameters: [path, value as SQLInputValue],
    };
  }
  if (operator === 'contains') {
    return {
      sql: `json_type(r.values_json, ?) IS NOT NULL
        AND instr(lower(CAST(json_extract(r.values_json, ?) AS TEXT)), lower(?)) > 0`,
      parameters: [path, path, value as SQLInputValue],
    };
  }
  if (operator === 'starts_with') {
    return {
      sql: `json_type(r.values_json, ?) IS NOT NULL
        AND substr(lower(CAST(json_extract(r.values_json, ?) AS TEXT)), 1, length(?)) = lower(?)`,
      parameters: [path, path, value as SQLInputValue, value as SQLInputValue],
    };
  }
  if (operator === 'in') {
    const values = value as SQLInputValue[];
    return {
      sql: `json_type(r.values_json, ?) IS NOT NULL
        AND json_extract(r.values_json, ?) IN (${values.map(() => '?').join(', ')})`,
      parameters: [path, path, ...values],
    };
  }

  const sqlOperator = {
    eq: '=',
    neq: '<>',
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
  }[operator];
  return {
    sql: `json_type(r.values_json, ?) IS NOT NULL
      AND json_extract(r.values_json, ?) ${sqlOperator} ?`,
    parameters: [path, path, value as SQLInputValue],
  };
}

function compileNode(
  value: unknown,
  fields: Map<string, FieldDefinition>,
  depth: number,
  state: CompileState,
): CompiledFilter {
  if (depth > MAX_FILTER_DEPTH) {
    throw new AppError('VALIDATION_ERROR', `Filter depth exceeds ${MAX_FILTER_DEPTH}`);
  }
  if (!isObject(value)) {
    throw new AppError('VALIDATION_ERROR', 'Every filter node must be an object');
  }

  const groupKeys = ['all', 'any'].filter((key) => Object.hasOwn(value, key));
  if (groupKeys.length === 0) return compilePredicate(value, fields, state);
  if (groupKeys.length !== 1 || Object.keys(value).length !== 1) {
    throw new AppError('VALIDATION_ERROR', 'A filter group must contain exactly one of all or any');
  }

  const groupKey = groupKeys[0] as 'all' | 'any';
  const children = value[groupKey];
  if (!Array.isArray(children) || children.length === 0) {
    throw new AppError('VALIDATION_ERROR', `Filter group '${groupKey}' must be a non-empty array`);
  }
  const compiled = children.map((child) => compileNode(child, fields, depth + 1, state));
  return {
    sql: `(${compiled.map((entry) => entry.sql).join(groupKey === 'all' ? ' AND ' : ' OR ')})`,
    parameters: compiled.flatMap((entry) => entry.parameters),
  };
}

export function compileFilter(object: ObjectDefinition, filter?: unknown): CompiledFilter {
  if (filter === undefined) return { sql: '1 = 1', parameters: [] };
  const fields = new Map(
    object.fields.filter((field) => field.archivedAt === null).map((field) => [field.key, field]),
  );
  return compileNode(filter, fields, 1, { predicates: 0 });
}

function compileSort(object: ObjectDefinition, sort?: string): string {
  if (sort === undefined) return 'r.updated_at DESC, r.id ASC';
  const match = /^([a-z][a-z0-9_]*):(asc|desc)$/.exec(sort);
  if (!match) {
    throw new AppError('VALIDATION_ERROR', "Sort must use the form 'field:asc' or 'field:desc'", {
      sort,
    });
  }
  const fieldKey = match[1] as string;
  const direction = (match[2] as string).toUpperCase();
  const builtIn = {
    created_at: 'r.created_at',
    updated_at: 'r.updated_at',
    display_name: 'r.display_name',
  }[fieldKey];
  if (builtIn) return `${builtIn} ${direction}, r.id ASC`;

  const field = object.fields.find((entry) => entry.key === fieldKey && entry.archivedAt === null);
  if (!field) {
    throw new AppError('UNKNOWN_FIELD', `Sort field '${fieldKey}' is not an active field`, {
      field: fieldKey,
    });
  }
  if (field.type === 'json' || field.type === 'multi_select') {
    throw new AppError('VALIDATION_ERROR', `Field '${fieldKey}' cannot be sorted`, {
      field: fieldKey,
      fieldType: field.type,
    });
  }

  const path = jsonPath(field).replaceAll("'", "''");
  return `json_type(r.values_json, '${path}') IS NULL ASC,
    json_extract(r.values_json, '${path}') ${direction}, r.id ASC`;
}

export function listRecords(
  database: DatabaseSync,
  objectKey: string,
  options: ListRecordsOptions,
): ListRecordsResult {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 500) {
    throw new AppError('VALIDATION_ERROR', 'Limit must be an integer from 1 through 500');
  }
  if (!Number.isInteger(options.offset) || options.offset < 0) {
    throw new AppError('VALIDATION_ERROR', 'Offset must be a non-negative integer');
  }

  const object = getActiveObject(database, objectKey);
  const filter = compileFilter(object, options.filter);
  const sort = compileSort(object, options.sort);
  const archiveClause = options.includeArchived ? '' : 'AND r.archived_at IS NULL';
  const parameters: SQLInputValue[] = [
    object.id,
    ...filter.parameters,
    options.limit + 1,
    options.offset,
  ];
  const rows = database
    .prepare(`
      SELECT r.*, object_type.key AS object_key
      FROM records r
      JOIN object_types object_type ON object_type.id = r.object_type_id
      WHERE r.object_type_id = ?
        ${archiveClause}
        AND ${filter.sql}
      ORDER BY ${sort}
      LIMIT ? OFFSET ?
    `)
    .all(...parameters) as unknown as StoredRecordRow[];
  const hasMore = rows.length > options.limit;
  const records = rows.slice(0, options.limit).map(mapStoredRecord);

  return {
    records,
    pagination: {
      limit: options.limit,
      offset: options.offset,
      count: records.length,
      hasMore,
    },
  };
}
