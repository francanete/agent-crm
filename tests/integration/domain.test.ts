import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getContext } from '../../src/core/context.js';
import { diagnoseDatabase } from '../../src/core/doctor.js';
import { AppError } from '../../src/core/errors.js';
import { getEvent, getHistory } from '../../src/core/history.js';
import { listRecords } from '../../src/core/query.js';
import { createRecord, getRecord, updateRecord } from '../../src/core/records.js';
import { addRelationship, listRelationships } from '../../src/core/relationships.js';
import { addField, addObject, describeSchema } from '../../src/core/schema.js';
import { searchRecords } from '../../src/core/search.js';
import { initializeDatabase, openDatabase, openReadOnlyDatabase } from '../../src/db/index.js';

const temporaryDirectories: string[] = [];

function temporaryDatabase(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-test-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'crm.db');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('database domain slices', () => {
  it('initializes idempotently and seeds the default schema', () => {
    const databasePath = temporaryDatabase();

    const first = initializeDatabase(databasePath);
    const second = initializeDatabase(databasePath);

    expect(first).toMatchObject({
      created: true,
      migrated: true,
      seeded: true,
      databaseVersion: 1,
    });
    expect(second).toMatchObject({
      created: false,
      migrated: false,
      seeded: false,
      databaseVersion: 1,
    });

    const database = openDatabase(databasePath);
    try {
      const objects = describeSchema(database);
      expect(objects.map((object) => object.key)).toEqual([
        'followup',
        'interaction',
        'organization',
        'person',
      ]);
      expect(objects.find((object) => object.key === 'person')?.fields).toHaveLength(6);
      expect(objects.find((object) => object.key === 'followup')?.fields).toContainEqual(
        expect.objectContaining({
          key: 'status',
          required: true,
          defaultValue: 'open',
        }),
      );
    } finally {
      database.close();
    }
  });

  it('creates, audits, indexes, and retrieves a validated person', () => {
    const databasePath = temporaryDatabase();
    initializeDatabase(databasePath);
    const database = openDatabase(databasePath);

    try {
      const created = createRecord(
        database,
        'person',
        { name: 'Ana García', email: 'ana@example.com', tags: ['founder'] },
        { actor: 'test', source: 'test fixture', idempotencyKey: 'create-ana', cliVersion: 'test' },
      );
      const fetched = getRecord(database, created.id.slice(0, 8));

      expect(created).toMatchObject({
        object: 'person',
        displayName: 'Ana García',
        replayed: false,
      });
      expect(fetched).toEqual(expect.objectContaining({ id: created.id, values: created.values }));

      const eventCount = database.prepare('SELECT COUNT(*) AS count FROM events').get() as {
        count: number;
      };
      const ftsCount = database.prepare('SELECT COUNT(*) AS count FROM records_fts').get() as {
        count: number;
      };
      expect(eventCount.count).toBe(1);
      expect(ftsCount.count).toBe(1);
    } finally {
      database.close();
    }
  });

  it('rejects unknown and missing fields without writing partial data', () => {
    const databasePath = temporaryDatabase();
    initializeDatabase(databasePath);
    const database = openDatabase(databasePath);

    try {
      expect(() =>
        createRecord(
          database,
          'person',
          { name: 'Ana', invented: 'guess' },
          { actor: 'test', cliVersion: 'test' },
        ),
      ).toThrowError(AppError);
      expect(() =>
        createRecord(database, 'person', {}, { actor: 'test', cliVersion: 'test' }),
      ).toThrowError(/Required field 'name'/);

      const count = database.prepare('SELECT COUNT(*) AS count FROM records').get() as {
        count: number;
      };
      expect(count.count).toBe(0);
    } finally {
      database.close();
    }
  });

  it('replays an equivalent idempotent create and rejects conflicting reuse', () => {
    const databasePath = temporaryDatabase();
    initializeDatabase(databasePath);
    const database = openDatabase(databasePath);

    try {
      const options = { actor: 'test', idempotencyKey: 'retry-key', cliVersion: 'test' };
      const first = createRecord(database, 'person', { name: 'Ana' }, options);
      const replay = createRecord(database, 'person', { name: 'Ana' }, options);

      expect(replay).toMatchObject({ id: first.id, replayed: true });
      expect(() => createRecord(database, 'person', { name: 'Bea' }, options)).toThrowError(
        /different operation/,
      );

      const count = database.prepare('SELECT COUNT(*) AS count FROM records').get() as {
        count: number;
      };
      expect(count.count).toBe(1);
    } finally {
      database.close();
    }
  });

  it('refuses an incompatible existing file without overwriting it', () => {
    const databasePath = temporaryDatabase();
    fs.writeFileSync(databasePath, 'not a database');

    expect(() => initializeDatabase(databasePath)).toThrowError(/compatible Agent CRM database/);
    expect(fs.readFileSync(databasePath, 'utf8')).toBe('not a database');
  });

  it('does not create a database when a normal command opens a missing path', () => {
    const databasePath = temporaryDatabase();
    expect(() => openDatabase(databasePath)).toThrowError(/has not been initialized/);
    expect(fs.existsSync(databasePath)).toBe(false);
  });

  it('runs healthy diagnostics through a read-only connection', () => {
    const databasePath = temporaryDatabase();
    initializeDatabase(databasePath);
    const before = fs.readFileSync(databasePath);
    const database = openReadOnlyDatabase(databasePath);

    try {
      const result = diagnoseDatabase(database, databasePath);
      expect(result.healthy).toBe(true);
      expect(result.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'foreignKeys', status: 'pass' }),
          expect.objectContaining({ name: 'fts5', status: 'pass' }),
          expect.objectContaining({ name: 'defaultSchema', status: 'pass' }),
        ]),
      );
    } finally {
      database.close();
    }

    expect(fs.readFileSync(databasePath)).toEqual(before);
  });

  it('links records and assembles relationship, interaction, and follow-up context', () => {
    const databasePath = temporaryDatabase();
    initializeDatabase(databasePath);
    const database = openDatabase(databasePath);
    const mutation = { actor: 'test', cliVersion: 'test' };

    try {
      const person = createRecord(database, 'person', { name: 'Ana' }, mutation);
      const organization = createRecord(database, 'organization', { name: 'Acme' }, mutation);
      const interaction = createRecord(
        database,
        'interaction',
        { summary: 'Discussed the proposal', occurred_at: '2026-09-01T12:00:00Z' },
        mutation,
      );
      const followup = createRecord(
        database,
        'followup',
        { title: 'Send proposal', due_at: '2026-09-05T12:00:00Z' },
        mutation,
      );

      const worksAt = addRelationship(database, person.id, 'works_at', organization.id, mutation);
      addRelationship(database, interaction.id, 'involves', person.id, mutation);
      addRelationship(database, followup.id, 'concerns', person.id, mutation);

      expect(listRelationships(database, person.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: worksAt.id, direction: 'outgoing', type: 'works_at' }),
          expect.objectContaining({ direction: 'incoming', type: 'involves' }),
          expect.objectContaining({ direction: 'incoming', type: 'concerns' }),
        ]),
      );

      const context = getContext(database, person.id, {
        maxRelated: 20,
        maxInteractions: 20,
        maxFollowups: 20,
        maxChars: 12_000,
      });
      expect(context.relatedRecords.map((record) => record.id)).toContain(organization.id);
      expect(context.recentInteractions.map((record) => record.id)).toContain(interaction.id);
      expect(context.openFollowups.map((record) => record.id)).toContain(followup.id);
      expect(context.openFollowups[0]?.values.status).toBe('open');
      expect(context.truncation.truncated).toBe(false);
    } finally {
      database.close();
    }
  });

  it('filters, sorts, and paginates due follow-ups through the typed AST', () => {
    const databasePath = temporaryDatabase();
    initializeDatabase(databasePath);
    const database = openDatabase(databasePath);
    const mutation = { actor: 'test', cliVersion: 'test' };

    try {
      createRecord(
        database,
        'followup',
        { title: 'Later', due_at: '2026-09-10T12:00:00Z' },
        mutation,
      );
      const soon = createRecord(
        database,
        'followup',
        { title: 'Soon', due_at: '2026-09-05T12:00:00Z' },
        mutation,
      );
      createRecord(
        database,
        'followup',
        { title: 'Done', due_at: '2026-09-04T12:00:00Z', status: 'done' },
        mutation,
      );

      const due = listRecords(database, 'followup', {
        filter: {
          all: [
            { field: 'status', op: 'eq', value: 'open' },
            { field: 'due_at', op: 'lte', value: '2026-09-06T23:59:59Z' },
          ],
        },
        sort: 'due_at:asc',
        limit: 50,
        offset: 0,
        includeArchived: false,
      });
      expect(due.records.map((record) => record.id)).toEqual([soon.id]);
      expect(due.pagination).toEqual({ limit: 50, offset: 0, count: 1, hasMore: false });

      const firstPage = listRecords(database, 'followup', {
        sort: 'due_at:asc',
        limit: 1,
        offset: 0,
        includeArchived: false,
      });
      expect(firstPage.records[0]?.displayName).toBe('Done');
      expect(firstPage.pagination.hasMore).toBe(true);
    } finally {
      database.close();
    }
  });

  it('rejects unknown fields, incompatible operators, and excessive filter depth', () => {
    const databasePath = temporaryDatabase();
    initializeDatabase(databasePath);
    const database = openDatabase(databasePath);
    const baseOptions = { limit: 50, offset: 0, includeArchived: false };

    try {
      expect(() =>
        listRecords(database, 'person', {
          ...baseOptions,
          filter: { field: 'role', op: 'gt', value: 'CTO' },
        }),
      ).toThrowError(/not valid for text field/);
      expect(() =>
        listRecords(database, 'person', {
          ...baseOptions,
          filter: { field: "name') OR 1=1 --", op: 'eq', value: 'Ana' },
        }),
      ).toThrowError(/not an active field/);

      let nested: unknown = { field: 'name', op: 'eq', value: 'Ana' };
      for (let depth = 0; depth < 6; depth += 1) nested = { all: [nested] };
      expect(() =>
        listRecords(database, 'person', { ...baseOptions, filter: nested }),
      ).toThrowError(/depth exceeds/);
    } finally {
      database.close();
    }
  });

  it('adds custom schema, updates a record, searches FTS, and exposes immutable history', () => {
    const databasePath = temporaryDatabase();
    initializeDatabase(databasePath);
    const database = openDatabase(databasePath);
    const mutation = { actor: 'test-agent', source: 'portfolio test', cliVersion: 'test' };

    try {
      const person = createRecord(
        database,
        'person',
        { name: 'Ana', email: 'ana@example.com', notes: 'Interested in distributed databases' },
        mutation,
      );
      const field = addField(
        database,
        {
          objectKey: 'person',
          key: 'priority',
          label: 'Priority',
          type: 'enum',
          required: false,
          options: ['high', 'normal', 'low'],
          defaultValue: 'normal',
        },
        mutation,
      );
      expect(field).toMatchObject({ key: 'priority', defaultValue: 'normal', replayed: false });

      const roleOnly = updateRecord(database, person.id, { role: 'CTO' }, mutation);
      expect(roleOnly.values).not.toHaveProperty('priority');
      const updated = updateRecord(database, person.id, { priority: 'high' }, mutation);
      expect(updated).toMatchObject({ values: { priority: 'high' }, schemaVersion: 2 });

      const search = searchRecords(database, 'distributed databases', { limit: 20, offset: 0 });
      expect(search.results).toEqual([
        expect.objectContaining({ id: person.id, object: 'person', displayName: 'Ana' }),
      ]);
      const emailSearch = searchRecords(database, 'ana@example.com', { limit: 20, offset: 0 });
      expect(emailSearch.results[0]?.id).toBe(person.id);

      const history = getHistory(database, person.id, 50);
      expect(history.map((event) => event.action)).toEqual(['updated', 'updated', 'created']);
      expect(history[0]).toMatchObject({ actor: 'test-agent', source: 'portfolio test' });
      const event = getEvent(database, history[0]?.id as string);
      expect(event.before).toEqual(expect.objectContaining({ id: person.id }));
      expect(event.after).toEqual(expect.objectContaining({ values: updated.values }));
      expect(() =>
        database.prepare('UPDATE events SET actor = ? WHERE id = ?').run('tampered', event.id),
      ).toThrowError(/immutable/);

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
      expect(project).toMatchObject({ key: 'project', titleFieldKey: 'name', schemaVersion: 1 });
      expect(getHistory(database, project.id, 10)[0]).toMatchObject({
        subjectType: 'object',
        action: 'created',
      });
      expect(getHistory(database, field.id, 10)[0]).toMatchObject({
        subjectType: 'field',
        action: 'created',
      });
      const createdProject = createRecord(database, 'project', { name: 'Agent CRM' }, mutation);
      expect(createdProject.object).toBe('project');
      expect(() =>
        addField(
          database,
          {
            objectKey: 'project',
            key: 'owner',
            label: 'Owner',
            type: 'text',
            required: true,
          },
          mutation,
        ),
      ).toThrowError(/required field cannot be added/);
    } finally {
      database.close();
    }
  });

  it('safely rejects duplicate relationships and replays an idempotent link', () => {
    const databasePath = temporaryDatabase();
    initializeDatabase(databasePath);
    const database = openDatabase(databasePath);

    try {
      const mutation = { actor: 'test', cliVersion: 'test' };
      const person = createRecord(database, 'person', { name: 'Ana' }, mutation);
      const organization = createRecord(database, 'organization', { name: 'Acme' }, mutation);
      const idempotent = { ...mutation, idempotencyKey: 'link-ana-acme' };
      const first = addRelationship(database, person.id, 'works_at', organization.id, idempotent);
      const replay = addRelationship(database, person.id, 'works_at', organization.id, idempotent);

      expect(replay).toMatchObject({ id: first.id, replayed: true });
      expect(() =>
        addRelationship(database, person.id, 'works_at', organization.id, mutation),
      ).toThrowError(/already exists/);
    } finally {
      database.close();
    }
  });
});
