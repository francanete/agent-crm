import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExport } from '../../src/core/portability.js';
import { createRecord } from '../../src/core/records.js';
import { initializeDatabase, openDatabase, openReadOnlyDatabase } from '../../src/db/index.js';

const directories: string[] = [];
const run = promisify(execFile);

function temporaryDatabase(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-init-'));
  directories.push(directory);
  return path.join(directory, 'crm.db');
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('initialization ownership', () => {
  it('preserves a competing initializer and its committed WAL data after a stale absence check', () => {
    const file = temporaryDatabase();
    const exists = fs.existsSync;
    let writer: DatabaseSync | undefined;
    let expected: ReturnType<typeof createExport>['data'] | undefined;
    let intercepted = false;
    vi.spyOn(fs, 'existsSync').mockImplementation((candidate) => {
      const observed = exists(candidate);
      if (candidate === file && !intercepted) {
        intercepted = true;
        expect(observed).toBe(false);
        initializeDatabase(file);
        writer = openDatabase(file);
        writer.exec('PRAGMA wal_autocheckpoint = 0');
        createRecord(
          writer,
          'person',
          { name: 'Concurrent person' },
          {
            actor: 'init-test',
            cliVersion: 'test',
          },
        );
        expected = createExport(writer).data;
        expect(exists(`${file}-wal`)).toBe(true);
      }
      return observed;
    });

    try {
      let result: ReturnType<typeof initializeDatabase> | undefined;
      let failure: unknown;
      try {
        result = initializeDatabase(file);
      } catch (error) {
        failure = error;
      }
      // Check preservation first so the old implementation demonstrates actual data loss.
      expect(exists(file)).toBe(true);
      expect(exists(`${file}-wal`)).toBe(true);
      expect(failure).toBeUndefined();
      expect(result).toMatchObject({ created: false, migrated: false, seeded: false });
      const reader = openDatabase(file);
      try {
        expect(createExport(reader).data).toEqual(expected);
        expect(reader.prepare('PRAGMA integrity_check').get()).toMatchObject({
          integrity_check: 'ok',
        });
        expect(reader.prepare('SELECT COUNT(*) AS count FROM records_fts').get()).toMatchObject({
          count: 1,
        });
      } finally {
        reader.close();
      }
    } finally {
      writer?.close();
    }
  });

  it.each([5, 261])('retries transient SQLite busy validation errors (%i)', (errcode) => {
    const file = temporaryDatabase();
    initializeDatabase(file);
    const before = fs.readFileSync(file);
    const prepare = DatabaseSync.prototype.prepare;
    let failures = 0;
    const fault = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (sql.includes('sqlite_master') && failures++ < 2) {
        expect(this.prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: 5000 });
        throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode });
      }
      return prepare.call(this, sql);
    });
    expect(initializeDatabase(file)).toMatchObject({
      created: false,
      migrated: false,
      seeded: false,
    });
    expect(failures).toBe(3);
    for (const open of [openReadOnlyDatabase, openDatabase]) {
      failures = 0;
      const connection = open(file);
      connection.close();
      expect(failures).toBe(3);
    }
    fault.mockRestore();
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['crm.db']);
  });

  it('bounds persistent busy validation retries without reporting an invalid database', () => {
    const file = temporaryDatabase();
    initializeDatabase(file);
    const before = fs.readFileSync(file);
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const wait = vi.spyOn(Atomics, 'wait').mockImplementation((_array, _index, _value, timeout) => {
      elapsed += timeout ?? 0;
      return 'timed-out';
    });
    const prepare = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (sql.includes('sqlite_master')) {
        throw Object.assign(new Error('database is locked'), {
          code: 'ERR_SQLITE_ERROR',
          errcode: 261,
        });
      }
      return prepare.call(this, sql);
    });
    expect(() => initializeDatabase(file)).toThrowError(
      expect.objectContaining({ code: 'DATABASE_ERROR' }),
    );
    expect(wait).toHaveBeenCalled();
    expect(elapsed).toBe(5000);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it('does not retry non-busy SQLite validation errors', () => {
    const file = temporaryDatabase();
    initializeDatabase(file);
    const before = fs.readFileSync(file);
    const wait = vi.spyOn(Atomics, 'wait');
    const fault = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(() => {
      throw Object.assign(new Error('database disk image is malformed'), {
        code: 'ERR_SQLITE_ERROR',
        errcode: 11,
      });
    });
    expect(() => initializeDatabase(file)).toThrowError(
      expect.objectContaining({ code: 'DATABASE_INVALID' }),
    );
    expect(fault).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it('allows a clean retry after initialization fails during schema creation', () => {
    const file = temporaryDatabase();
    const exec = DatabaseSync.prototype.exec;
    const fault = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (sql.includes('CREATE TABLE metadata')) throw new Error('injected migration failure');
      return exec.call(this, sql);
    });
    expect(() => initializeDatabase(file)).toThrowError(
      expect.objectContaining({ code: 'DATABASE_ERROR' }),
    );
    fault.mockRestore();
    expect(fs.readdirSync(path.dirname(file))).toEqual([]);
    expect(initializeDatabase(file)).toMatchObject({
      created: true,
      seeded: true,
      databaseVersion: 1,
    });
  });

  it.each(['', 'not a SQLite database'])('preserves an existing invalid file (%j)', (contents) => {
    const file = temporaryDatabase();
    fs.writeFileSync(file, contents);
    expect(() => initializeDatabase(file)).toThrowError(
      expect.objectContaining({ code: 'DATABASE_INVALID' }),
    );
    expect(fs.readFileSync(file, 'utf8')).toBe(contents);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['crm.db']);
  });

  it('preserves a file created immediately before publication', () => {
    const file = temporaryDatabase();
    const link = fs.linkSync;
    vi.spyOn(fs, 'linkSync').mockImplementationOnce((source, destination) => {
      expect(destination).toBe(file);
      fs.writeFileSync(file, 'concurrently created unrelated data');
      return link(source, destination);
    });
    expect(() => initializeDatabase(file)).toThrowError(
      expect.objectContaining({ code: 'DATABASE_INVALID' }),
    );
    expect(fs.readFileSync(file, 'utf8')).toBe('concurrently created unrelated data');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['crm.db']);
  });

  it('cleans up an unpublished database and permits retry if hard linking is unavailable', () => {
    const file = temporaryDatabase();
    const fault = vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('hard links unavailable'), { code: 'ENOTSUP' });
    });
    expect(() => initializeDatabase(file)).toThrowError(
      expect.objectContaining({ code: 'DATABASE_ERROR' }),
    );
    fault.mockRestore();
    expect(fs.readdirSync(path.dirname(file))).toEqual([]);
    expect(initializeDatabase(file)).toMatchObject({ created: true, seeded: true });
  });

  it.skipIf(process.platform === 'win32')('does not follow a dangling destination symlink', () => {
    const file = temporaryDatabase();
    const target = path.join(path.dirname(file), 'missing.db');
    fs.symlinkSync(target, file);
    expect(() => initializeDatabase(file)).toThrowError(
      expect.objectContaining({ code: 'DATABASE_INVALID' }),
    );
    expect(fs.readlinkSync(file)).toBe(target);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['crm.db']);
  });

  it('initializes the same new database from concurrent compiled CLI processes', async () => {
    const file = temporaryDatabase();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        run(process.execPath, ['dist/cli.js', '--db', file, 'init', '--json']).catch(
          (error: { stdout: string }) => ({ stdout: error.stdout }),
        ),
      ),
    );
    const envelopes = results.map(({ stdout }) => JSON.parse(stdout));
    expect(envelopes).toEqual(
      Array.from({ length: 6 }, () => expect.objectContaining({ ok: true })),
    );
    expect(envelopes.filter((result) => result.data.created)).toHaveLength(1);
    const database = openDatabase(file);
    try {
      expect(database.prepare('SELECT COUNT(*) AS count FROM object_types').get()).toMatchObject({
        count: 4,
      });
      expect(database.prepare('PRAGMA integrity_check').get()).toMatchObject({
        integrity_check: 'ok',
      });
    } finally {
      database.close();
    }
    expect(fs.readdirSync(path.dirname(file))).toEqual(['crm.db']);
  });
});
