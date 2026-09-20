import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExport } from '../../src/core/portability.js';
import { createRecord, getRecord, updateRecord } from '../../src/core/records.js';
import { addField } from '../../src/core/schema.js';
import { initializeDatabase, openDatabase } from '../../src/db/index.js';

const temporaryDirectories: string[] = [];
const mutation = { actor: 'test', cliVersion: 'test' };

function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-field-presence-'));
  temporaryDirectories.push(directory);
  const file = path.join(directory, 'crm.db');
  initializeDatabase(file);
  return openDatabase(file);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// constructor is an Object.prototype key allowed by the lowercase schema-key grammar.
// Keep a normal field as a control for the same presence/default/required semantics.
describe.each(['constructor', 'custom_text'])('record field presence: %s', (key) => {
  it('omits optional values and validates explicitly supplied values', () => {
    const database = temporaryDatabase();
    try {
      addField(
        database,
        { objectKey: 'person', key, label: key, type: 'text', required: false },
        mutation,
      );
      for (const values of [{ name: 'Ana' }, { name: 'Ana', [key]: null }]) {
        const created = createRecord(database, 'person', values, mutation);
        expect(Object.hasOwn(created.values, key)).toBe(false);
        expect(getRecord(database, created.id).values).toEqual({ name: 'Ana' });
      }
      const explicit = createRecord(database, 'person', { name: 'Bea', [key]: 'value' }, mutation);
      expect(Object.hasOwn(explicit.values, key)).toBe(true);
      expect(getRecord(database, explicit.id).values).toEqual({ name: 'Bea', [key]: 'value' });
      const before = createExport(database).data;
      expect(() =>
        createRecord(database, 'person', { name: 'Invalid', [key]: 42 }, mutation),
      ).toThrowError(
        expect.objectContaining({
          code: 'INVALID_FIELD_VALUE',
          details: expect.objectContaining({ field: key }),
        }),
      );
      expect(createExport(database).data).toEqual(before);
    } finally {
      database.close();
    }
  });

  it('preserves omitted values on update and permits setting and clearing optional values', () => {
    const database = temporaryDatabase();
    try {
      const created = createRecord(database, 'person', { name: 'Ana' }, mutation);
      addField(
        database,
        { objectKey: 'person', key, label: key, type: 'text', required: false },
        mutation,
      );
      expect(updateRecord(database, created.id, { name: 'Bea' }, mutation).values).toEqual({
        name: 'Bea',
      });
      expect(updateRecord(database, created.id, { [key]: 'value' }, mutation).values).toEqual({
        name: 'Bea',
        [key]: 'value',
      });
      expect(updateRecord(database, created.id, { name: 'Cara' }, mutation).values).toEqual({
        name: 'Cara',
        [key]: 'value',
      });
      const before = createExport(database).data;
      expect(() => updateRecord(database, created.id, { [key]: 42 }, mutation)).toThrowError(
        expect.objectContaining({
          code: 'INVALID_FIELD_VALUE',
          details: expect.objectContaining({ field: key }),
        }),
      );
      expect(createExport(database).data).toEqual(before);
      const cleared = updateRecord(database, created.id, { [key]: null }, mutation);
      expect(Object.hasOwn(cleared.values, key)).toBe(false);
      expect(getRecord(database, created.id).values).toEqual({ name: 'Cara' });
    } finally {
      database.close();
    }
  });

  it('applies defaults only on create and respects explicit values and null', () => {
    const database = temporaryDatabase();
    try {
      const existing = createRecord(database, 'person', { name: 'Existing' }, mutation);
      addField(
        database,
        {
          objectKey: 'person',
          key,
          label: key,
          type: 'text',
          required: false,
          defaultValue: 'default',
        },
        mutation,
      );
      expect(updateRecord(database, existing.id, { name: 'Updated' }, mutation).values).toEqual({
        name: 'Updated',
      });
      for (const values of [{ name: 'Ana' }, { name: 'Ana', [key]: undefined }]) {
        expect(createRecord(database, 'person', values, mutation).values).toEqual({
          name: 'Ana',
          [key]: 'default',
        });
      }
      const explicit = createRecord(database, 'person', { name: 'Bea', [key]: 'own' }, mutation);
      expect(explicit.values).toEqual({ name: 'Bea', [key]: 'own' });
      expect(
        createRecord(database, 'person', { name: 'Cara', [key]: null }, mutation).values,
      ).toEqual({ name: 'Cara' });
      expect(updateRecord(database, explicit.id, { [key]: null }, mutation).values).toEqual({
        name: 'Bea',
      });
      expect(getRecord(database, explicit.id).values).toEqual({ name: 'Bea' });
    } finally {
      database.close();
    }
  });

  it.each([false, true])(
    'enforces required values with default=%s and rolls back failures',
    (withDefault) => {
      const database = temporaryDatabase();
      try {
        addField(
          database,
          {
            objectKey: 'person',
            key,
            label: key,
            type: 'text',
            required: true,
            ...(withDefault ? { defaultValue: 'default' } : {}),
          },
          mutation,
        );
        const before = createExport(database).data;
        const missing = expect.objectContaining({
          code: 'REQUIRED_FIELD_MISSING',
          details: expect.objectContaining({ field: key }),
        });
        expect(() =>
          createRecord(database, 'person', { name: 'Ana', [key]: null }, mutation),
        ).toThrowError(missing);
        if (!withDefault) {
          expect(() => createRecord(database, 'person', { name: 'Ana' }, mutation)).toThrowError(
            missing,
          );
        }
        expect(createExport(database).data).toEqual(before);
        if (withDefault) {
          expect(createRecord(database, 'person', { name: 'Ana' }, mutation).values).toEqual({
            name: 'Ana',
            [key]: 'default',
          });
        }
        const created = createRecord(database, 'person', { name: 'Bea', [key]: 'own' }, mutation);
        expect(updateRecord(database, created.id, { name: 'Cara' }, mutation).values).toEqual({
          name: 'Cara',
          [key]: 'own',
        });
        const beforeUpdate = createExport(database).data;
        expect(() => updateRecord(database, created.id, { [key]: null }, mutation)).toThrowError(
          missing,
        );
        expect(createExport(database).data).toEqual(beforeUpdate);
      } finally {
        database.close();
      }
    },
  );
});
