import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecord } from '../../src/core/records.js';
import { initializeDatabase, openDatabase } from '../../src/db/index.js';

const cliPath = path.resolve('dist/cli.js');
const directories: string[] = [];
const connections: DatabaseSync[] = [];

afterEach(() => {
  for (const database of connections.splice(0)) database.close();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-export-safety-'));
  directories.push(directory);
  const data = path.join(directory, 'data');
  const alias = path.join(directory, 'alias');
  const databasePath = path.join(data, 'crm.db');
  initializeDatabase(databasePath);
  fs.symlinkSync(data, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const database = openDatabase(databasePath);
  connections.push(database);
  database.exec('PRAGMA wal_autocheckpoint = 0');
  createRecord(
    database,
    'person',
    { name: 'Preserved contact' },
    { actor: 'test', cliVersion: 'test' },
  );
  const before = new Map(
    ['', '-wal'].map((suffix) => [suffix, fs.readFileSync(`${databasePath}${suffix}`)]),
  );
  expect(before.get('-wal')?.length).toBeGreaterThan(0);
  return { directory, data, alias, databasePath, database, before };
}

function run(database: string, output: string, force = true) {
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      '--db',
      database,
      '--json',
      'export',
      '--output',
      output,
      ...(force ? ['--force'] : []),
    ],
    { encoding: 'utf8' },
  );
  expect(result.error).toBeUndefined();
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  return { status: result.status, envelope: JSON.parse(result.stdout) };
}

function preserved(source: ReturnType<typeof fixture>) {
  for (const [suffix, bytes] of source.before) {
    expect(fs.readFileSync(`${source.databasePath}${suffix}`)).toEqual(bytes);
  }
  expect(source.database.prepare('SELECT display_name FROM records').all()).toEqual([
    { display_name: 'Preserved contact' },
  ]);
  expect(source.database.prepare('PRAGMA integrity_check').get()).toEqual({
    integrity_check: 'ok',
  });
  const backup = path.join(source.directory, 'verified.json');
  expect(run(source.databasePath, backup).envelope.ok).toBe(true);
  expect(JSON.parse(fs.readFileSync(backup, 'utf8')).data.records).toEqual([
    expect.objectContaining({ values: { name: 'Preserved contact' } }),
  ]);
}

describe('export database destination protection', () => {
  it.skipIf(process.platform !== 'darwin' && process.platform !== 'win32')(
    'reserves mixed-case absent sidecars on macOS and Windows',
    () => {
      const source = fixture();
      connections.splice(connections.indexOf(source.database), 1);
      source.database.close();
      const before = fs.readFileSync(source.databasePath);
      for (const suffix of ['-WAL', '-SHM', '-JOURNAL']) {
        const output = path.join(source.alias, `CRM.DB${suffix}`);
        expect(fs.existsSync(output)).toBe(false);
        expect(run(source.databasePath, output)).toMatchObject({
          status: 2,
          envelope: { ok: false, error: { code: 'VALIDATION_ERROR' } },
        });
        expect(fs.existsSync(output)).toBe(false);
      }
      expect(fs.readFileSync(source.databasePath)).toEqual(before);
    },
  );
  it.each(['-wal', '-shm', '-journal'])(
    'reserves absent sidecar paths through directory aliases: %s',
    (suffix) => {
      const source = fixture();
      connections.splice(connections.indexOf(source.database), 1);
      source.database.close();
      const before = fs.readFileSync(source.databasePath);
      const output = path.join(source.alias, `crm.db${suffix}`);
      expect(fs.existsSync(output)).toBe(false);
      expect(run(source.databasePath, output)).toMatchObject({
        status: 2,
        envelope: { ok: false, error: { code: 'VALIDATION_ERROR' } },
      });
      expect(fs.existsSync(output)).toBe(false);
      expect(fs.readFileSync(source.databasePath)).toEqual(before);
    },
  );

  it.each([false, true])('rejects direct database and sidecar destinations (force=%s)', (force) => {
    const source = fixture();
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      expect(run(source.databasePath, `${source.databasePath}${suffix}`, force)).toMatchObject({
        status: 2,
        envelope: { ok: false, error: { code: 'VALIDATION_ERROR' } },
      });
    }
    preserved(source);
  });
  it.each(['', '-wal', '-shm', '-journal'])(
    'rejects directory alias destination crm.db%s',
    (suffix) => {
      const source = fixture();
      const output = path.join(source.alias, `crm.db${suffix}`);
      const existed = fs.existsSync(output);
      expect(run(source.databasePath, output)).toMatchObject({
        status: 2,
        envelope: { ok: false, error: { code: 'VALIDATION_ERROR' } },
      });
      expect(fs.existsSync(output)).toBe(existed);
      preserved(source);
    },
  );

  it.each(['', '-wal', '-shm', '-journal'])(
    'protects canonical paths when --db uses an alias: %s',
    (suffix) => {
      const source = fixture();
      expect(
        run(path.join(source.alias, 'crm.db'), `${source.databasePath}${suffix}`),
      ).toMatchObject({
        status: 2,
        envelope: { ok: false, error: { code: 'VALIDATION_ERROR' } },
      });
      preserved(source);
    },
  );

  it.each(['', '-wal', '-shm'])('rejects hard-linked database files: %s', (suffix) => {
    const source = fixture();
    const output = path.join(source.directory, 'linked-output');
    fs.linkSync(`${source.databasePath}${suffix}`, output);
    expect(run(source.databasePath, output)).toMatchObject({
      status: 2,
      envelope: { ok: false, error: { code: 'VALIDATION_ERROR' } },
    });
    expect(fs.statSync(output).ino).toBe(fs.statSync(`${source.databasePath}${suffix}`).ino);
    preserved(source);
  });

  it('retains normal force and no-overwrite behavior through directory aliases', () => {
    const source = fixture();
    const output = path.join(source.alias, 'backup.json');
    fs.writeFileSync(output, 'previous export');
    expect(run(source.databasePath, output, false)).toMatchObject({
      status: 5,
      envelope: { ok: false, error: { code: 'EXPORT_TARGET_EXISTS' } },
    });
    expect(fs.readFileSync(output, 'utf8')).toBe('previous export');
    expect(run(source.databasePath, output)).toMatchObject({ status: 0, envelope: { ok: true } });
    expect(JSON.parse(fs.readFileSync(output, 'utf8')).format).toBe('agentcrm-export');
    preserved(source);
  });

  // File symlinks require elevated privileges or Developer Mode on Windows;
  // directory alias coverage above uses unprivileged NTFS junctions there.
  it.skipIf(process.platform === 'win32')(
    'protects the real database and sidecars behind a final --db symlink',
    () => {
      const source = fixture();
      const linkedDatabase = path.join(source.directory, 'linked.db');
      fs.symlinkSync(source.databasePath, linkedDatabase);
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        expect(run(linkedDatabase, `${source.databasePath}${suffix}`)).toMatchObject({
          status: 2,
          envelope: { ok: false, error: { code: 'VALIDATION_ERROR' } },
        });
      }
      preserved(source);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'replaces a separate final output symlink, not its database referent',
    () => {
      const source = fixture();
      const output = path.join(source.directory, 'backup.json');
      fs.symlinkSync(source.databasePath, output);
      expect(run(source.databasePath, output, false).envelope.error.code).toBe(
        'EXPORT_TARGET_EXISTS',
      );
      expect(fs.lstatSync(output).isSymbolicLink()).toBe(true);
      expect(run(source.databasePath, output)).toMatchObject({ status: 0, envelope: { ok: true } });
      expect(fs.lstatSync(output).isSymbolicLink()).toBe(false);
      expect(JSON.parse(fs.readFileSync(output, 'utf8')).format).toBe('agentcrm-export');
      preserved(source);
    },
  );
});
