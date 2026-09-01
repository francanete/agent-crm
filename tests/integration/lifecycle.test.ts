import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getContext } from '../../src/core/context.js';
import { getHistory } from '../../src/core/history.js';
import { listRecords } from '../../src/core/query.js';
import {
  archiveRecord,
  createRecord,
  getRecord,
  restoreRecord,
  updateRecord,
} from '../../src/core/records.js';
import {
  addRelationship,
  archiveRelationship,
  listRelationships,
  restoreRelationship,
} from '../../src/core/relationships.js';
import {
  addField,
  addObject,
  archiveField,
  archiveObject,
  describeSchema,
  restoreField,
  restoreObject,
} from '../../src/core/schema.js';
import { searchRecords } from '../../src/core/search.js';
import { initializeDatabase, openDatabase } from '../../src/db/index.js';

const directories: string[] = [];

function databasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-lifecycle-'));
  directories.push(directory);
  return path.join(directory, 'crm.db');
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const mutation = { actor: 'lifecycle-test', source: 'integration', cliVersion: 'test' };

describe('archive and restore lifecycle', () => {
  it('archives records without rewriting links, then validates and restores visibility', () => {
    const file = databasePath();
    initializeDatabase(file);
    const database = openDatabase(file);

    try {
      const person = createRecord(
        database,
        'person',
        { name: 'Ana', notes: 'Lifecycle searchable phrase' },
        mutation,
      );
      const organization = createRecord(database, 'organization', { name: 'Acme' }, mutation);
      const relationship = addRelationship(
        database,
        person.id,
        'works_at',
        organization.id,
        mutation,
      );
      const archiveOptions = { ...mutation, idempotencyKey: 'archive-ana' };
      const archived = archiveRecord(database, person.id, archiveOptions);
      expect(archived.archivedAt).not.toBeNull();
      expect(archiveRecord(database, person.id, archiveOptions)).toMatchObject({
        id: person.id,
        replayed: true,
      });
      expect(getRecord(database, person.id).values.notes).toBe('Lifecycle searchable phrase');
      expect(
        listRecords(database, 'person', { limit: 50, offset: 0, includeArchived: false }).records,
      ).toEqual([]);
      expect(
        listRecords(database, 'person', { limit: 50, offset: 0, includeArchived: true }).records[0],
      ).toMatchObject({ id: person.id, archivedAt: archived.archivedAt });
      expect(
        searchRecords(database, 'Lifecycle searchable', { limit: 20, offset: 0 }).results,
      ).toEqual([]);
      expect(() => listRelationships(database, person.id)).toThrowError(/archived/);
      expect(listRelationships(database, person.id, { includeArchived: true })[0]).toMatchObject({
        id: relationship.id,
        archivedAt: null,
        source: { id: person.id, archivedAt: archived.archivedAt },
      });
      expect(() => updateRecord(database, person.id, { role: 'CTO' }, mutation)).toThrowError(
        /archived/,
      );
      expect(() =>
        getContext(database, person.id, {
          maxRelated: 20,
          maxInteractions: 20,
          maxFollowups: 20,
          maxChars: 12000,
        }),
      ).toThrowError(/archived/);
      expect(() =>
        addRelationship(database, person.id, 'knows', organization.id, mutation),
      ).toThrowError(/archived/);

      addField(
        database,
        {
          objectKey: 'person',
          key: 'timezone',
          label: 'Timezone',
          type: 'text',
          required: false,
        },
        mutation,
      );
      const restoreOptions = { ...mutation, idempotencyKey: 'restore-ana' };
      const restored = restoreRecord(database, person.id, restoreOptions);
      expect(restored).toMatchObject({ id: person.id, archivedAt: null, schemaVersion: 2 });
      expect(restoreRecord(database, person.id, restoreOptions)).toMatchObject({ replayed: true });
      expect(
        searchRecords(database, 'Lifecycle searchable', { limit: 20, offset: 0 }).results[0],
      ).toMatchObject({ id: person.id });
      expect(listRelationships(database, person.id)[0]?.id).toBe(relationship.id);
      expect(getHistory(database, person.id, 20).map((event) => event.action)).toEqual([
        'restored',
        'archived',
        'created',
      ]);
    } finally {
      database.close();
    }
  });

  it('archives relationships and safely rejects duplicate or archived-endpoint restoration', () => {
    const file = databasePath();
    initializeDatabase(file);
    const database = openDatabase(file);

    try {
      const person = createRecord(database, 'person', { name: 'Ana' }, mutation);
      const organization = createRecord(database, 'organization', { name: 'Acme' }, mutation);
      const first = addRelationship(database, person.id, 'works_at', organization.id, mutation);
      const archived = archiveRelationship(database, first.id, {
        ...mutation,
        idempotencyKey: 'archive-link',
      });
      expect(archived.archivedAt).not.toBeNull();
      expect(listRelationships(database, person.id)).toEqual([]);
      expect(listRelationships(database, person.id, { includeArchived: true })[0]?.id).toBe(
        first.id,
      );

      const second = addRelationship(database, person.id, 'works_at', organization.id, mutation);
      expect(() => restoreRelationship(database, first.id, mutation)).toThrowError(/equivalent/);
      archiveRelationship(database, second.id, mutation);
      archiveRecord(database, organization.id, mutation);
      expect(() => restoreRelationship(database, first.id, mutation)).toThrowError(/endpoints/);
      restoreRecord(database, organization.id, mutation);
      const restored = restoreRelationship(database, first.id, {
        ...mutation,
        idempotencyKey: 'restore-link',
      });
      expect(restored.archivedAt).toBeNull();
      expect(
        restoreRelationship(database, first.id, {
          ...mutation,
          idempotencyKey: 'restore-link',
        }).replayed,
      ).toBe(true);
      expect(getHistory(database, first.id, 20).map((event) => event.action)).toEqual([
        'restored',
        'archived',
        'linked',
      ]);
    } finally {
      database.close();
    }
  });

  it('archives fields with FTS reindexing and validates restoration', () => {
    const file = databasePath();
    initializeDatabase(file);
    const database = openDatabase(file);

    try {
      const person = createRecord(
        database,
        'person',
        { name: 'Ana', notes: 'Field archive secret phrase' },
        mutation,
      );
      const beforeVersion = describeSchema(database, 'person')[0]?.schemaVersion;
      const archiveFieldOptions = { ...mutation, idempotencyKey: 'archive-person-notes' };
      const archived = archiveField(database, 'person', 'notes', archiveFieldOptions);
      expect(archived.archivedAt).not.toBeNull();
      expect(archiveField(database, 'person', 'notes', archiveFieldOptions).replayed).toBe(true);
      expect(describeSchema(database, 'person')[0]?.schemaVersion).toBe((beforeVersion ?? 0) + 1);
      expect(getRecord(database, person.id).values.notes).toBe('Field archive secret phrase');
      expect(
        searchRecords(database, 'Field archive secret', { limit: 20, offset: 0 }).results,
      ).toEqual([]);
      expect(() => updateRecord(database, person.id, { notes: 'changed' }, mutation)).toThrowError(
        /active field/,
      );
      expect(() => archiveField(database, 'person', 'name', mutation)).toThrowError(/title field/);

      const restoreFieldOptions = { ...mutation, idempotencyKey: 'restore-person-notes' };
      restoreField(database, 'person', 'notes', restoreFieldOptions);
      expect(restoreField(database, 'person', 'notes', restoreFieldOptions).replayed).toBe(true);
      expect(
        searchRecords(database, 'Field archive secret', { limit: 20, offset: 0 }).results[0],
      ).toMatchObject({ id: person.id });

      const project = addObject(
        database,
        {
          key: 'project',
          label: 'Project',
          pluralLabel: 'Projects',
          titleFieldKey: 'name',
          titleFieldLabel: 'Name',
        },
        mutation,
      );
      addField(
        database,
        {
          objectKey: 'project',
          key: 'code',
          label: 'Code',
          type: 'text',
          required: true,
        },
        mutation,
      );
      archiveField(database, 'project', 'code', mutation);
      createRecord(database, 'project', { name: 'No code yet' }, mutation);
      expect(() => restoreField(database, 'project', 'code', mutation)).toThrowError(
        /missing required field/,
      );
      expect(
        describeSchema(database, 'project')[0]?.fields.find((field) => field.key === 'code')
          ?.archivedAt,
      ).not.toBeNull();
      expect(project.key).toBe('project');
    } finally {
      database.close();
    }
  });

  it('archives and restores only empty objects', () => {
    const file = databasePath();
    initializeDatabase(file);
    const database = openDatabase(file);

    try {
      addObject(
        database,
        {
          key: 'project',
          label: 'Project',
          pluralLabel: 'Projects',
          titleFieldKey: 'name',
          titleFieldLabel: 'Name',
        },
        mutation,
      );
      const archiveOptions = { ...mutation, idempotencyKey: 'archive-project' };
      expect(archiveObject(database, 'project', archiveOptions).archivedAt).not.toBeNull();
      expect(archiveObject(database, 'project', archiveOptions).replayed).toBe(true);
      expect(() => createRecord(database, 'project', { name: 'Blocked' }, mutation)).toThrowError(
        /archived/,
      );
      const restoreOptions = { ...mutation, idempotencyKey: 'restore-project' };
      expect(restoreObject(database, 'project', restoreOptions).archivedAt).toBeNull();
      expect(restoreObject(database, 'project', restoreOptions).replayed).toBe(true);
      createRecord(database, 'project', { name: 'Agent CRM' }, mutation);
      expect(() => archiveObject(database, 'project', mutation)).toThrowError(/cannot be archived/);
    } finally {
      database.close();
    }
  });
});
