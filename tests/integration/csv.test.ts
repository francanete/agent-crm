import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importCsv, parseCsv } from '../../src/core/csv.js';
import { listRecords } from '../../src/core/query.js';
import { searchRecords } from '../../src/core/search.js';
import { initializeDatabase, openDatabase } from '../../src/db/index.js';

const directories: string[] = [];

function databasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-csv-'));
  directories.push(directory);
  return path.join(directory, 'crm.db');
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const mapping = [
  { header: 'Full Name', field: 'name' },
  { header: 'Email', field: 'email' },
  { header: 'Role', field: 'role' },
  { header: 'Tags', field: 'tags' },
];
const options = {
  actor: 'csv-test',
  source: 'integration-csv',
  cliVersion: 'test',
  matchField: 'email',
  dryRun: false,
  multiValueSeparator: ';',
};

describe('CSV parsing and import', () => {
  it('parses RFC-style quoting, CRLF, BOM, escaped quotes, and embedded newlines', () => {
    const parsed = parseCsv(
      '\uFEFFName,Notes,Empty\r\n"Ana, Jr.","Said ""hello""\nand left",\r\nBob,Plain,\r\n',
    );
    expect(parsed.headers).toEqual(['Name', 'Notes', 'Empty']);
    expect(parsed.rows).toEqual([
      { line: 2, values: ['Ana, Jr.', 'Said "hello"\nand left', ''] },
      { line: 4, values: ['Bob', 'Plain', ''] },
    ]);
    expect(() => parseCsv('Name,Name\nAna,Ana')).toThrowError(/unique/);
    expect(() => parseCsv('Name,Email\nAna')).toThrowError(/columns/);
    expect(() => parseCsv('Name\n"Ana')).toThrowError(/Unclosed/);
  });

  it('dry-runs every row and rolls back successful rows when another row is invalid', () => {
    const file = databasePath();
    initializeDatabase(file);
    const database = openDatabase(file);
    const csv = [
      'Full Name,Email,Role,Tags',
      'Ana,ana@example.com,Founder,customer;founder',
      'Broken,not-an-email,Unknown,',
      'Ana Updated,ana@example.com,CEO,customer',
      '',
    ].join('\n');

    try {
      const dryRun = importCsv(database, csv, 'person', mapping, { ...options, dryRun: true });
      expect(dryRun).toMatchObject({
        dryRun: true,
        valid: false,
        rows: { total: 3, processed: 3, created: 1, updated: 1, failed: 1 },
        errors: [{ row: 2, line: 3, code: 'INVALID_FIELD_VALUE' }],
      });
      expect(
        listRecords(database, 'person', { limit: 50, offset: 0, includeArchived: false }).records,
      ).toEqual([]);
      expect(database.prepare('SELECT COUNT(*) AS count FROM events').get()).toMatchObject({
        count: 0,
      });

      expect(() => importCsv(database, csv, 'person', mapping, options)).toThrowError(
        expect.objectContaining({ code: 'CSV_IMPORT_INVALID' }),
      );
      expect(
        listRecords(database, 'person', { limit: 50, offset: 0, includeArchived: false }).records,
      ).toEqual([]);
      expect(database.prepare('SELECT COUNT(*) AS count FROM events').get()).toMatchObject({
        count: 0,
      });
    } finally {
      database.close();
    }
  });

  it('atomically imports, upserts duplicate rows, converts types, and supports retry keys', () => {
    const file = databasePath();
    initializeDatabase(file);
    const database = openDatabase(file);
    const csv = [
      'Full Name,Email,Role,Tags',
      'Ana,ana@example.com,Founder,customer;founder',
      'Bob,bob@example.com,Engineer,technical',
      'Ana Updated,ana@example.com,CEO,customer',
      ',,,',
    ].join('\n');
    const keyed = { ...options, idempotencyKey: 'contacts-september' };

    try {
      const imported = importCsv(database, csv, 'person', mapping, keyed);
      expect(imported).toMatchObject({
        valid: true,
        rows: {
          total: 4,
          processed: 3,
          created: 2,
          updated: 1,
          skipped: 1,
          failed: 0,
          replayed: 0,
        },
      });
      const records = listRecords(database, 'person', {
        sort: 'name:asc',
        limit: 50,
        offset: 0,
        includeArchived: false,
      }).records;
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        displayName: 'Ana Updated',
        values: { email: 'ana@example.com', role: 'CEO', tags: ['customer'] },
      });
      expect(records[1]).toMatchObject({ displayName: 'Bob' });
      expect(searchRecords(database, 'Ana Updated', { limit: 20, offset: 0 }).results).toHaveLength(
        1,
      );

      const replay = importCsv(database, csv, 'person', mapping, keyed);
      expect(replay.rows).toMatchObject({ created: 2, updated: 1, replayed: 3, failed: 0 });
      expect(
        listRecords(database, 'person', { limit: 50, offset: 0, includeArchived: false }).records,
      ).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it('requires explicit, active mappings and a mapped scalar match field', () => {
    const file = databasePath();
    initializeDatabase(file);
    const database = openDatabase(file);

    try {
      expect(() => importCsv(database, 'Name\nAna', 'person', [], options)).toThrowError(/--map/);
      expect(() =>
        importCsv(database, 'Name\nAna', 'person', [{ header: 'Missing', field: 'name' }], {
          actor: options.actor,
          source: options.source,
          cliVersion: options.cliVersion,
          dryRun: false,
          multiValueSeparator: ';',
        }),
      ).toThrowError(/was not found/);
      expect(() =>
        importCsv(
          database,
          'Name,Tags\nAna,founder',
          'person',
          [
            { header: 'Name', field: 'name' },
            { header: 'Tags', field: 'tags' },
          ],
          { ...options, matchField: 'tags' },
        ),
      ).toThrowError(/cannot be used/);
    } finally {
      database.close();
    }
  });
});
