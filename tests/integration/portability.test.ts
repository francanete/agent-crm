import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createExport,
  dryRunImport,
  importDocument,
  readExportFile,
  writeExportFile,
} from '../../src/core/portability.js';
import {
  archiveRecord,
  createRecord,
  restoreRecord,
  updateRecord,
} from '../../src/core/records.js';
import { addRelationship, archiveRelationship } from '../../src/core/relationships.js';
import { addField, archiveField, restoreField } from '../../src/core/schema.js';
import { searchRecords } from '../../src/core/search.js';
import { initializeDatabase, openDatabase } from '../../src/db/index.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-portability-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('native export and import', () => {
  it('round-trips schema, records, relationships, history, and FTS with idempotent import', () => {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, 'source.db');
    const targetPath = path.join(directory, 'target.db');
    initializeDatabase(sourcePath);
    initializeDatabase(targetPath);
    const source = openDatabase(sourcePath);
    const target = openDatabase(targetPath);
    const mutation = { actor: 'test-agent', source: 'round trip', cliVersion: 'test' };

    try {
      addField(
        source,
        {
          objectKey: 'person',
          key: 'priority',
          label: 'Priority',
          type: 'enum',
          required: false,
          options: ['high', 'normal'],
        },
        mutation,
      );
      const person = createRecord(
        source,
        'person',
        { name: 'Ana', notes: 'Portable relationship memory', priority: 'normal' },
        mutation,
      );
      const organization = createRecord(source, 'organization', { name: 'Acme' }, mutation);
      updateRecord(source, person.id, { priority: 'high' }, mutation);
      addRelationship(source, person.id, 'works_at', organization.id, mutation);
      const formerLink = addRelationship(
        source,
        person.id,
        'formerly_worked_at',
        organization.id,
        mutation,
      );
      archiveRelationship(source, formerLink.id, mutation);
      const archivedFollowup = createRecord(
        source,
        'followup',
        { title: 'Obsolete reminder', due_at: '2026-09-10T12:00:00Z' },
        mutation,
      );
      archiveRecord(source, archivedFollowup.id, mutation);

      const exported = createExport(source);
      expect(exported).toMatchObject({
        format: 'agentcrm-export',
        formatVersion: 1,
        historyIncluded: true,
      });
      const dryRun = dryRunImport(target, exported);
      expect(dryRun).toMatchObject({
        dryRun: true,
        imported: { records: 3, relationships: 2 },
      });

      const importOptions = {
        actor: 'test-importer',
        source: 'native backup',
        idempotencyKey: 'round-trip-import',
        cliVersion: 'test',
      };
      const imported = importDocument(target, exported, importOptions);
      expect(imported).toMatchObject({ dryRun: false, replayed: false });
      expect(importDocument(target, exported, importOptions)).toMatchObject({ replayed: true });

      const restored = createExport(target);
      expect(restored.data.objects).toEqual(exported.data.objects);
      expect(restored.data.records).toEqual(exported.data.records);
      expect(restored.data.relationships).toEqual(exported.data.relationships);
      expect(restored.data.events.slice(0, exported.data.events.length)).toEqual(
        exported.data.events,
      );
      expect(restored.data.events.at(-1)).toMatchObject({
        subjectType: 'database',
        action: 'imported',
        actor: 'test-importer',
      });
      expect(
        searchRecords(target, 'Portable relationship', { limit: 20, offset: 0 }).results[0],
      ).toMatchObject({ id: person.id, displayName: 'Ana' });
    } finally {
      source.close();
      target.close();
    }
  });

  it.each([false, true])(
    'round-trips archived records missing a restored required field (withoutHistory=%s)',
    (withoutHistory) => {
      const directory = temporaryDirectory();
      const sourcePath = path.join(directory, 'source.db');
      const targetPath = path.join(directory, 'target.db');
      const output = path.join(directory, 'backup.json');
      initializeDatabase(sourcePath);
      initializeDatabase(targetPath);
      const source = openDatabase(sourcePath);
      const target = openDatabase(targetPath);
      const mutation = { actor: 'test', cliVersion: 'test' };

      try {
        addField(
          source,
          {
            objectKey: 'person',
            key: 'code',
            label: 'Code',
            type: 'text',
            required: true,
          },
          mutation,
        );
        archiveField(source, 'person', 'code', mutation);
        const person = createRecord(source, 'person', { name: 'Historical Ana' }, mutation);
        archiveRecord(source, person.id, mutation);
        restoreField(source, 'person', 'code', mutation);

        const exported = createExport(source, { withoutHistory });
        writeExportFile(output, exported);
        const document = readExportFile(output);
        expect(dryRunImport(target, document).dryRun).toBe(true);
        importDocument(target, document, mutation);
        const restored = createExport(target);
        expect(restored.data.objects).toEqual(exported.data.objects);
        expect(restored.data.records).toEqual(exported.data.records);
        expect(restored.data.events.slice(0, -1)).toEqual(exported.data.events);
        expect(target.prepare('SELECT COUNT(*) AS count FROM records_fts').get()).toMatchObject({
          count: 0,
        });
        expect(() => restoreRecord(target, person.id, mutation)).toThrowError(
          expect.objectContaining({ code: 'REQUIRED_FIELD_MISSING' }),
        );
        expect(createExport(target).data).toEqual(restored.data);

        const invalid = structuredClone(exported);
        const record = invalid.data.records[0];
        if (!record) throw new Error('Expected an archived record');
        record.archivedAt = null;
        fs.writeFileSync(output, JSON.stringify(invalid));
        expect(() => readExportFile(output)).toThrowError(/missing required field 'code'/);

        record.archivedAt = person.createdAt;
        record.values.code = 42;
        fs.writeFileSync(output, JSON.stringify(invalid));
        expect(() => readExportFile(output)).toThrowError(/invalid field value/);
        delete record.values.code;
        delete record.values.name;
        fs.writeFileSync(output, JSON.stringify(invalid));
        expect(() => readExportFile(output)).toThrowError(
          expect.objectContaining({ code: 'IMPORT_INVALID' }),
        );
      } finally {
        source.close();
        target.close();
      }
    },
  );

  it('keeps nested search text consistent through writes, lifecycle changes, and import', () => {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, 'source.db');
    const targetPath = path.join(directory, 'target.db');
    const output = path.join(directory, 'backup.json');
    initializeDatabase(sourcePath);
    initializeDatabase(targetPath);
    const source = openDatabase(sourcePath);
    const target = openDatabase(targetPath);
    const mutation = { actor: 'test', cliVersion: 'test' };

    try {
      addField(
        source,
        {
          objectKey: 'person',
          key: 'details',
          label: 'Details',
          type: 'json',
          required: false,
        },
        mutation,
      );
      const person = createRecord(
        source,
        'person',
        {
          name: 'Ana',
          role: 'Founder',
          tags: ['customer'],
          details: { nested: ['indexable', 42, true, null] },
        },
        mutation,
      );
      const indexed = () =>
        source.prepare('SELECT * FROM records_fts WHERE record_id = ?').get(person.id);
      const original = indexed();
      expect(
        searchRecords(source, 'indexable 42 true customer', { limit: 20, offset: 0 }).results[0]
          ?.id,
      ).toBe(person.id);
      archiveField(source, 'person', 'details', mutation);
      expect(searchRecords(source, 'indexable', { limit: 20, offset: 0 }).results).toEqual([]);
      updateRecord(source, person.id, { role: null }, mutation);
      restoreField(source, 'person', 'details', mutation);
      expect(searchRecords(source, 'indexable', { limit: 20, offset: 0 }).results[0]?.id).toBe(
        person.id,
      );
      expect(searchRecords(source, 'Founder', { limit: 20, offset: 0 }).results).toEqual([]);
      updateRecord(source, person.id, { role: 'Founder' }, mutation);
      expect(indexed()).toEqual(original);
      archiveRecord(source, person.id, mutation);
      expect(indexed()).toBeUndefined();
      restoreRecord(source, person.id, mutation);
      expect(indexed()).toEqual(original);
      writeExportFile(output, createExport(source));
      importDocument(target, readExportFile(output), mutation);
      expect(
        target.prepare('SELECT * FROM records_fts WHERE record_id = ?').get(person.id),
      ).toEqual(original);
    } finally {
      source.close();
      target.close();
    }
  });

  it('preserves create retry intent across schema changes and a native round trip', () => {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, 'source.db');
    const targetPath = path.join(directory, 'target.db');
    const output = path.join(directory, 'backup.json');
    initializeDatabase(sourcePath);
    initializeDatabase(targetPath);
    const source = openDatabase(sourcePath);
    const target = openDatabase(targetPath);
    const mutation = { actor: 'test', cliVersion: 'test' };
    const options = { ...mutation, idempotencyKey: 'portable-create' };
    const values = { name: 'Ana', notes: 'Original note' };

    try {
      const first = createRecord(source, 'person', values, options);
      archiveField(source, 'person', 'notes', mutation);
      writeExportFile(output, createExport(source));
      importDocument(target, readExportFile(output), mutation);
      const before = createExport(target).data;
      expect(createRecord(target, 'person', values, options)).toEqual({ ...first, replayed: true });
      expect(createExport(target).data).toEqual(before);
    } finally {
      source.close();
      target.close();
    }
  });

  it('writes private exports, protects existing files, and supports history-free exports', () => {
    const directory = temporaryDirectory();
    const databasePath = path.join(directory, 'crm.db');
    const output = path.join(directory, 'backup.json');
    initializeDatabase(databasePath);
    const database = openDatabase(databasePath);

    try {
      createRecord(database, 'person', { name: 'Ana' }, { actor: 'test', cliVersion: 'test' });
      const document = createExport(database, { withoutHistory: true });
      expect(document).toMatchObject({ historyIncluded: false, data: { events: [] } });
      const written = writeExportFile(output, document);
      expect(written.bytes).toBeGreaterThan(0);
      if (process.platform !== 'win32') {
        expect(fs.statSync(output).mode & 0o777).toBe(0o600);
      }
      expect(readExportFile(output)).toEqual(document);
      expect(() => writeExportFile(output, document)).toThrowError(
        expect.objectContaining({ code: 'EXPORT_TARGET_EXISTS' }),
      );
      expect(writeExportFile(output, document, true).output).toBe(path.resolve(output));
    } finally {
      database.close();
    }
  });

  it('preserves an existing forced-export target when final replacement fails', () => {
    const directory = temporaryDirectory();
    const databasePath = path.join(directory, 'crm.db');
    const output = path.join(directory, 'backup.json');
    initializeDatabase(databasePath);
    const database = openDatabase(databasePath);
    fs.writeFileSync(output, 'previous backup');
    const rename = fs.renameSync.bind(fs);
    let renameCalls = 0;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      renameCalls += 1;
      if (renameCalls === 2) throw new Error('simulated final rename failure');
      return rename(source, target);
    });

    try {
      expect(() => writeExportFile(output, createExport(database), true)).toThrowError(
        expect.objectContaining({ code: 'DATABASE_ERROR' }),
      );
      expect(fs.readFileSync(output, 'utf8')).toBe('previous backup');
      expect(fs.readdirSync(directory).filter((file) => file.includes('.previous'))).toEqual([]);
    } finally {
      renameSpy.mockRestore();
      database.close();
    }
  });

  it('rejects invalid documents and non-pristine targets before mutation', () => {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, 'source.db');
    const targetPath = path.join(directory, 'target.db');
    const invalidPath = path.join(directory, 'invalid.json');
    initializeDatabase(sourcePath);
    initializeDatabase(targetPath);
    const source = openDatabase(sourcePath);
    const target = openDatabase(targetPath);

    try {
      const document = createExport(source);
      createRecord(target, 'person', { name: 'Existing' }, { actor: 'test', cliVersion: 'test' });
      expect(() => dryRunImport(target, document)).toThrowError(
        expect.objectContaining({ code: 'IMPORT_TARGET_NOT_EMPTY' }),
      );
      expect(() =>
        importDocument(target, document, { actor: 'test', cliVersion: 'test' }),
      ).toThrowError(expect.objectContaining({ code: 'IMPORT_TARGET_NOT_EMPTY' }));

      fs.writeFileSync(invalidPath, '{"format":"unknown"}');
      expect(() => readExportFile(invalidPath)).toThrowError(
        expect.objectContaining({ code: 'IMPORT_INVALID' }),
      );

      const malformedIdDocument = structuredClone(document);
      const malformedObject = malformedIdDocument.data.objects[0];
      if (!malformedObject) throw new Error('Expected the default schema in the export');
      malformedObject.id = 'not-a-uuid';
      fs.writeFileSync(invalidPath, JSON.stringify(malformedIdDocument));
      expect(() => readExportFile(invalidPath)).toThrowError(
        expect.objectContaining({ code: 'IMPORT_INVALID' }),
      );
      expect(createExport(target).data.records).toHaveLength(1);
    } finally {
      source.close();
      target.close();
    }
  });
});
