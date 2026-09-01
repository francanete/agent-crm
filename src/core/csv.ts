import type { DatabaseSync } from 'node:sqlite';
import { AppError, toAppError } from './errors.js';
import {
  type CreateRecordOptions,
  createRecord,
  type UpsertRecordResult,
  upsertRecord,
} from './records.js';
import { describeSchema } from './schema.js';
import type { FieldDefinition, ObjectDefinition } from './types.js';

export const MAX_CSV_BYTES = 25 * 1024 * 1024;
export const MAX_CSV_ROWS = 100_000;
const MAX_REPORTED_ERRORS = 1_000;

interface ParsedCsvRow {
  line: number;
  values: string[];
}

interface ParsedCsv {
  headers: string[];
  rows: ParsedCsvRow[];
}

export interface CsvFieldMapping {
  header: string;
  field: string;
}

export interface CsvImportOptions extends CreateRecordOptions {
  matchField?: string;
  dryRun: boolean;
  multiValueSeparator?: string;
}

export interface CsvImportError {
  row: number;
  line: number;
  code: string;
  message: string;
  details?: unknown;
}

export interface CsvImportResult {
  dryRun: boolean;
  valid: boolean;
  object: string;
  matchField: string | null;
  mapping: CsvFieldMapping[];
  rows: {
    total: number;
    processed: number;
    created: number;
    updated: number;
    skipped: number;
    failed: number;
    replayed: number;
  };
  errors: CsvImportError[];
  errorsTruncated: boolean;
}

function csvError(message: string, details?: Record<string, unknown>): never {
  throw new AppError('CSV_IMPORT_INVALID', message, details);
}

function finishRow(rows: ParsedCsvRow[], values: string[], line: number): void {
  if (rows.length >= MAX_CSV_ROWS + 1) {
    csvError(`CSV input exceeds the ${MAX_CSV_ROWS.toLocaleString('en-US')} data row limit`, {
      maxRows: MAX_CSV_ROWS,
    });
  }
  rows.push({ line, values: [...values] });
}

export function parseCsv(input: string): ParsedCsv {
  const source = input.startsWith('\uFEFF') ? input.slice(1) : input;
  if (source.includes('\0')) csvError('CSV input contains a NUL byte');

  const parsedRows: ParsedCsvRow[] = [];
  let row: string[] = [];
  let field = '';
  let line = 1;
  let rowLine = 1;
  let inQuotes = false;
  let afterQuote = false;

  const endField = () => {
    row.push(field);
    field = '';
    afterQuote = false;
  };
  const endRow = () => {
    endField();
    finishRow(parsedRows, row, rowLine);
    row = [];
    rowLine = line + 1;
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] as string;
    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else if (character === '\r') {
        if (source[index + 1] === '\n') index += 1;
        field += '\n';
        line += 1;
      } else {
        field += character;
        if (character === '\n') line += 1;
      }
      continue;
    }

    if (afterQuote && character !== ',' && character !== '\r' && character !== '\n') {
      csvError(`Unexpected character after closing quote on line ${line}`, { line });
    }
    if (character === '"') {
      if (field.length !== 0) csvError(`Unexpected quote on line ${line}`, { line });
      inQuotes = true;
    } else if (character === ',') {
      endField();
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      endRow();
      line += 1;
    } else {
      field += character;
    }
  }

  if (inQuotes) csvError(`Unclosed quoted field starting on line ${rowLine}`, { line: rowLine });
  if (field.length > 0 || row.length > 0 || afterQuote) {
    endField();
    finishRow(parsedRows, row, rowLine);
  }
  const headerRow = parsedRows.shift();
  if (!headerRow || headerRow.values.every((value) => value.length === 0)) {
    csvError('CSV input must contain a non-empty header row');
  }
  const headers = headerRow.values;
  if (headers.some((header) => header.length === 0)) csvError('CSV headers cannot be blank');
  const duplicates = headers.filter((header, index) => headers.indexOf(header) !== index);
  if (duplicates.length > 0) {
    csvError('CSV headers must be unique', { duplicates: [...new Set(duplicates)] });
  }
  for (const current of parsedRows) {
    if (current.values.length !== headers.length) {
      csvError(
        `CSV line ${current.line} has ${current.values.length} columns; expected ${headers.length}`,
        {
          line: current.line,
          expected: headers.length,
          actual: current.values.length,
        },
      );
    }
  }
  return { headers, rows: parsedRows };
}

function validateMapping(
  object: ObjectDefinition,
  headers: string[],
  mapping: CsvFieldMapping[],
  matchField: string | undefined,
): Array<{ headerIndex: number; field: FieldDefinition }> {
  if (mapping.length === 0) csvError('At least one --map Header=field mapping is required');
  const seenHeaders = new Set<string>();
  const seenFields = new Set<string>();
  const resolved = mapping.map((entry) => {
    if (seenHeaders.has(entry.header))
      csvError(`CSV header '${entry.header}' is mapped more than once`);
    if (seenFields.has(entry.field))
      csvError(`CRM field '${entry.field}' is mapped more than once`);
    seenHeaders.add(entry.header);
    seenFields.add(entry.field);
    const headerIndex = headers.indexOf(entry.header);
    if (headerIndex === -1) csvError(`Mapped CSV header '${entry.header}' was not found`);
    const field = object.fields.find((candidate) => candidate.key === entry.field);
    if (!field) csvError(`CRM field '${entry.field}' was not found on object '${object.key}'`);
    if (field.archivedAt !== null) csvError(`CRM field '${entry.field}' is archived`);
    return { headerIndex, field };
  });
  if (matchField && !seenFields.has(matchField)) {
    csvError(`Match field '${matchField}' must be included in --map`);
  }
  return resolved;
}

function convertCell(field: FieldDefinition, cell: string, separator: string): unknown {
  switch (field.type) {
    case 'number': {
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(cell)) {
        throw new AppError('INVALID_FIELD_VALUE', `Field '${field.key}' must be a finite number`, {
          field: field.key,
          value: cell,
        });
      }
      return Number(cell);
    }
    case 'boolean': {
      const normalized = cell.toLowerCase();
      if (normalized === 'true' || normalized === '1') return true;
      if (normalized === 'false' || normalized === '0') return false;
      throw new AppError(
        'INVALID_FIELD_VALUE',
        `Field '${field.key}' must be true, false, 1, or 0`,
        {
          field: field.key,
          value: cell,
        },
      );
    }
    case 'multi_select':
      return cell.split(separator).map((value) => value.trim());
    case 'json':
      try {
        return JSON.parse(cell) as unknown;
      } catch {
        throw new AppError('INVALID_FIELD_VALUE', `Field '${field.key}' must contain valid JSON`, {
          field: field.key,
        });
      }
    default:
      return cell;
  }
}

function rowValues(
  row: ParsedCsvRow,
  mapping: Array<{ headerIndex: number; field: FieldDefinition }>,
  separator: string,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const entry of mapping) {
    const cell = row.values[entry.headerIndex] as string;
    if (cell === '') continue;
    values[entry.field.key] = convertCell(entry.field, cell, separator);
  }
  return values;
}

function rowError(error: unknown, row: number, line: number): CsvImportError {
  const appError = toAppError(error);
  return {
    row,
    line,
    code: appError.code,
    message: appError.message,
    ...(appError.details === undefined ? {} : { details: appError.details }),
  };
}

export function importCsv(
  database: DatabaseSync,
  input: string,
  objectKey: string,
  mapping: CsvFieldMapping[],
  options: CsvImportOptions,
): CsvImportResult {
  if (Buffer.byteLength(input, 'utf8') > MAX_CSV_BYTES) {
    csvError(`CSV input exceeds the ${MAX_CSV_BYTES} byte limit`, { maxBytes: MAX_CSV_BYTES });
  }
  const multiValueSeparator = options.multiValueSeparator ?? ';';
  if (multiValueSeparator.length === 0) csvError('The multi-value separator cannot be empty');
  const parsed = parseCsv(input);
  const object = describeSchema(database, objectKey)[0] as ObjectDefinition;
  if (object.archivedAt !== null) csvError(`Object '${objectKey}' is archived`);
  const resolvedMapping = validateMapping(object, parsed.headers, mapping, options.matchField);
  const matchMapping = options.matchField
    ? resolvedMapping.find((entry) => entry.field.key === options.matchField)
    : undefined;
  if (matchMapping && ['json', 'multi_select'].includes(matchMapping.field.type)) {
    csvError(`Field '${matchMapping.field.key}' cannot be used as an exact upsert match`);
  }

  const result: CsvImportResult = {
    dryRun: options.dryRun,
    valid: true,
    object: object.key,
    matchField: options.matchField ?? null,
    mapping,
    rows: {
      total: parsed.rows.length,
      processed: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      replayed: 0,
    },
    errors: [],
    errorsTruncated: false,
  };

  database.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 0; index < parsed.rows.length; index += 1) {
      const row = parsed.rows[index] as ParsedCsvRow;
      if (row.values.every((value) => value === '')) {
        result.rows.skipped += 1;
        continue;
      }
      result.rows.processed += 1;
      database.exec('SAVEPOINT csv_import_row');
      try {
        const values = rowValues(row, resolvedMapping, multiValueSeparator);
        const rowOptions: CreateRecordOptions = {
          actor: options.actor,
          cliVersion: options.cliVersion,
          source: options.source ?? 'csv-import',
          ...(options.idempotencyKey
            ? { idempotencyKey: `${options.idempotencyKey}:row:${index + 1}` }
            : {}),
        };
        let outcome: UpsertRecordResult['outcome'];
        let replayed = false;
        if (matchMapping) {
          const matchValue = values[matchMapping.field.key];
          if (matchValue === undefined) {
            throw new AppError('VALIDATION_ERROR', 'The exact match cell cannot be blank', {
              field: matchMapping.field.key,
            });
          }
          const record = upsertRecord(
            database,
            object.key,
            matchMapping.field.key,
            matchValue,
            values,
            rowOptions,
          );
          outcome = record.outcome;
          replayed = record.replayed;
        } else {
          const record = createRecord(database, object.key, values, rowOptions);
          outcome = 'created';
          replayed = record.replayed;
        }
        result.rows[outcome] += 1;
        if (replayed) result.rows.replayed += 1;
        database.exec('RELEASE SAVEPOINT csv_import_row');
      } catch (error) {
        database.exec('ROLLBACK TO SAVEPOINT csv_import_row');
        database.exec('RELEASE SAVEPOINT csv_import_row');
        result.rows.failed += 1;
        if (result.errors.length < MAX_REPORTED_ERRORS) {
          result.errors.push(rowError(error, index + 1, row.line));
        } else {
          result.errorsTruncated = true;
        }
      }
    }
    result.valid = result.rows.failed === 0;
    if (options.dryRun || !result.valid) database.exec('ROLLBACK');
    else database.exec('COMMIT');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  }

  if (!options.dryRun && !result.valid) {
    throw new AppError(
      'CSV_IMPORT_INVALID',
      'CSV import validation failed; no rows were imported',
      {
        result,
      },
    );
  }
  return result;
}
