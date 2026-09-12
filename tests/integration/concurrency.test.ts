import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExport } from '../../src/core/portability.js';
import { archiveRecord, createRecord } from '../../src/core/records.js';
import { addRelationship } from '../../src/core/relationships.js';
import { addField } from '../../src/core/schema.js';
import { initializeDatabase, openDatabase } from '../../src/db/index.js';

const directories: string[] = [];
const mutation = { actor: 'concurrency-test', cliVersion: 'test' };

function databasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-concurrency-'));
  directories.push(directory);
  return path.join(directory, 'crm.db');
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('creation transaction boundaries', () => {
  it('validates required fields after obtaining the write lock', () => {
    const file = databasePath();
    initializeDatabase(file);
    const database = openDatabase(file);
    const writer = openDatabase(file);
    const exec = database.exec.bind(database);
    let expected = createExport(writer).data;
    // Commit another connection's mutation immediately before this connection takes its lock.
    const boundary = vi.spyOn(database, 'exec').mockImplementationOnce((sql) => {
      expect(sql).toBe('BEGIN IMMEDIATE');
      addField(
        writer,
        {
          objectKey: 'person',
          key: 'code',
          label: 'Code',
          type: 'text',
          required: true,
        },
        mutation,
      );
      expected = createExport(writer).data;
      exec(sql);
    });

    try {
      expect(() => createRecord(database, 'person', { name: 'Ana' }, mutation)).toThrowError(
        expect.objectContaining({ code: 'REQUIRED_FIELD_MISSING' }),
      );
      expect(createExport(database).data).toEqual(expected);
      expect(database.prepare('SELECT COUNT(*) AS count FROM records_fts').get()).toMatchObject({
        count: 0,
      });
      expect(database.isTransaction).toBe(false);
    } finally {
      boundary.mockRestore();
      database.close();
      writer.close();
    }
  });

  it('validates relationship endpoints after obtaining the write lock', () => {
    const file = databasePath();
    initializeDatabase(file);
    const database = openDatabase(file);
    const writer = openDatabase(file);
    const person = createRecord(writer, 'person', { name: 'Ana' }, mutation);
    const organization = createRecord(writer, 'organization', { name: 'Acme' }, mutation);
    const exec = database.exec.bind(database);
    let expected = createExport(writer).data;
    const boundary = vi.spyOn(database, 'exec').mockImplementationOnce((sql) => {
      expect(sql).toBe('BEGIN IMMEDIATE');
      archiveRecord(writer, organization.id, mutation);
      expected = createExport(writer).data;
      exec(sql);
    });

    try {
      expect(() =>
        addRelationship(database, person.id, 'works_at', organization.id, mutation),
      ).toThrowError(expect.objectContaining({ code: 'RECORD_ARCHIVED' }));
      expect(createExport(database).data).toEqual(expected);
      expect(database.prepare('SELECT record_id FROM records_fts').all()).toEqual([
        { record_id: person.id },
      ]);
      expect(database.isTransaction).toBe(false);
    } finally {
      boundary.mockRestore();
      database.close();
      writer.close();
    }
  });
});
