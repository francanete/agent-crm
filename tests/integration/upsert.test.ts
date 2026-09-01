import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getEvent, getHistory } from '../../src/core/history.js';
import { archiveRecord, createRecord, getRecord, upsertRecord } from '../../src/core/records.js';
import { initializeDatabase, openDatabase } from '../../src/db/index.js';

const directories: string[] = [];

function databasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-upsert-'));
  directories.push(directory);
  return path.join(directory, 'crm.db');
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const mutation = { actor: 'upsert-test', source: 'integration', cliVersion: 'test' };

describe('exact-field record upsert', () => {
  it('creates on zero matches, updates one match, and replays the original mutation', () => {
    const file = databasePath();
    initializeDatabase(file);
    const database = openDatabase(file);

    try {
      const createOptions = { ...mutation, idempotencyKey: 'upsert-create-ana' };
      const created = upsertRecord(
        database,
        'person',
        'email',
        'ana@example.com',
        { name: 'Ana', role: 'Founder' },
        createOptions,
      );
      expect(created).toMatchObject({
        outcome: 'created',
        replayed: false,
        values: { name: 'Ana', email: 'ana@example.com', role: 'Founder' },
      });
      expect(
        upsertRecord(
          database,
          'person',
          'email',
          'ana@example.com',
          { name: 'Ana', role: 'Founder' },
          createOptions,
        ),
      ).toMatchObject({ id: created.id, outcome: 'created', replayed: true });

      const updated = upsertRecord(
        database,
        'person',
        'email',
        'ana@example.com',
        { role: 'CEO' },
        mutation,
      );
      expect(updated).toMatchObject({
        id: created.id,
        outcome: 'updated',
        replayed: false,
        values: { name: 'Ana', email: 'ana@example.com', role: 'CEO' },
      });
      const history = getHistory(database, created.id, 20);
      expect(history.map((event) => event.action)).toEqual(['updated', 'created']);
      expect(getEvent(database, history[0]?.id as string).metadata).toMatchObject({
        operation: 'record.upsert',
        result: { id: created.id, outcome: 'updated' },
      });
    } finally {
      database.close();
    }
  });

  it('refuses archived and multiple exact matches without mutation', () => {
    const file = databasePath();
    initializeDatabase(file);
    const database = openDatabase(file);

    try {
      const archived = createRecord(
        database,
        'person',
        { name: 'Archived Ana', email: 'archived@example.com' },
        mutation,
      );
      archiveRecord(database, archived.id, mutation);
      expect(() =>
        upsertRecord(
          database,
          'person',
          'email',
          'archived@example.com',
          { name: 'Replacement' },
          mutation,
        ),
      ).toThrowError(expect.objectContaining({ code: 'RECORD_ARCHIVED' }));
      expect(getRecord(database, archived.id).displayName).toBe('Archived Ana');

      const first = createRecord(
        database,
        'person',
        { name: 'First Duplicate', email: 'duplicate@example.com' },
        mutation,
      );
      const second = createRecord(
        database,
        'person',
        { name: 'Second Duplicate', email: 'duplicate@example.com' },
        mutation,
      );
      expect(() =>
        upsertRecord(
          database,
          'person',
          'email',
          'duplicate@example.com',
          { role: 'Do not write' },
          mutation,
        ),
      ).toThrowError(expect.objectContaining({ code: 'MULTIPLE_UPSERT_MATCHES' }));
      expect(getRecord(database, first.id).values).not.toHaveProperty('role');
      expect(getRecord(database, second.id).values).not.toHaveProperty('role');
    } finally {
      database.close();
    }
  });

  it('rejects unsafe match fields and conflicting match values', () => {
    const file = databasePath();
    initializeDatabase(file);
    const database = openDatabase(file);

    try {
      expect(() =>
        upsertRecord(database, 'person', 'tags', ['founder'], { name: 'Ana' }, mutation),
      ).toThrowError(/cannot be used/);
      expect(() =>
        upsertRecord(
          database,
          'person',
          'email',
          'ana@example.com',
          { name: 'Ana', email: 'other@example.com' },
          mutation,
        ),
      ).toThrowError(/must equal/);
      expect(() =>
        upsertRecord(database, 'person', 'unknown', 'value', { name: 'Ana' }, mutation),
      ).toThrowError(expect.objectContaining({ code: 'UNKNOWN_FIELD' }));
    } finally {
      database.close();
    }
  });
});
