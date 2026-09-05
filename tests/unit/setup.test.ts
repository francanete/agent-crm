import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/index.js';
import { applySetup, createSetupPlan } from '../../src/integrations/setup.js';
import {
  installSkill,
  type SkillIntegrationOptions,
  type SkillIntegrationResult,
} from '../../src/integrations/skill.js';

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-setup-'));
}

describe('setup plan', () => {
  it('is read-only and reports absent database and Skill targets', () => {
    const directory = temporaryDirectory();
    const home = path.join(directory, 'home');
    const database = path.join(home, 'data', 'crm.db');
    const source = path.join(directory, 'SKILL.md');
    fs.writeFileSync(source, 'bundled skill');

    try {
      const plan = createSetupPlan({
        databaseOverride: database,
        home,
        platform: 'linux',
        env: {},
        sourcePath: source,
      });

      expect(plan.database).toMatchObject({
        path: database,
        selection: 'explicit',
        state: 'absent',
      });
      expect(plan.hosts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'pi', detection: 'not-detected', skillState: 'absent' }),
          expect.objectContaining({ key: 'claude-code', skillState: 'absent' }),
          expect.objectContaining({ key: 'hermes', skillState: 'absent' }),
        ]),
      );
      expect(fs.existsSync(home)).toBe(false);
      expect(plan.actions.canInitializeDatabase).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('recognizes an initialized Agent CRM database without migrating it', () => {
    const directory = temporaryDirectory();
    const database = path.join(directory, 'crm.db');
    const source = path.join(directory, 'SKILL.md');
    fs.writeFileSync(source, 'bundled skill');
    initializeDatabase(database);
    const before = fs.statSync(database).mtimeMs;

    try {
      const plan = createSetupPlan({
        databaseOverride: database,
        home: path.join(directory, 'home'),
        platform: 'linux',
        env: {},
        sourcePath: source,
      });
      expect(plan.database).toMatchObject({ state: 'agentcrm-ready', databaseVersion: 1 });
      expect(fs.statSync(database).mtimeMs).toBe(before);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])('keeps checkpointed files unchanged (empty WAL: %s)', (emptyWal) => {
    const directory = temporaryDirectory();
    const database = path.join(directory, 'crm.db');
    const source = path.join(directory, 'SKILL.md');
    fs.writeFileSync(source, 'bundled skill');
    initializeDatabase(database);
    const writable = new DatabaseSync(database);
    writable.prepare('PRAGMA journal_mode=WAL').get();
    writable.close();
    fs.rmSync(`${database}-wal`, { force: true });
    fs.rmSync(`${database}-shm`, { force: true });
    if (emptyWal) fs.writeFileSync(`${database}-wal`, '');

    try {
      const plan = createSetupPlan({
        databaseOverride: database,
        home: path.join(directory, 'home'),
        platform: 'linux',
        env: {},
        sourcePath: source,
      });
      expect(plan.database).toMatchObject({ state: 'agentcrm-ready', databaseVersion: 1 });
      expect(fs.existsSync(`${database}-wal`)).toBe(emptyWal);
      if (emptyWal) expect(fs.statSync(`${database}-wal`).size).toBe(0);
      expect(fs.existsSync(`${database}-shm`)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses to inspect committed WAL metadata until SQLite checkpoints it', () => {
    const directory = temporaryDirectory();
    const database = path.join(directory, 'crm.db');
    const home = path.join(directory, 'home');
    const options = { databaseOverride: database, home, env: {} };
    initializeDatabase(database);
    const writable = new DatabaseSync(database);

    try {
      writable.exec('PRAGMA wal_autocheckpoint=0');
      writable.prepare("UPDATE metadata SET value = '2' WHERE key = 'database_version'").run();
      const files = fs.readdirSync(directory);
      const before = files.map((file) => fs.readFileSync(path.join(directory, file)));
      expect(fs.statSync(`${database}-wal`).size).toBeGreaterThan(0);

      const plan = createSetupPlan(options);
      expect(plan.database).toMatchObject({
        state: 'wal-present',
        hint: expect.stringContaining('Do not delete WAL files'),
      });
      expect(plan.database.databaseVersion).toBeUndefined();
      expect(plan.actions.canInitializeDatabase).toBe(false);
      for (const initialize of [false, true]) {
        expect(() =>
          applySetup({ ...options, initialize, agents: ['pi'], yes: true }),
        ).toThrowError(
          expect.objectContaining({
            code: 'SETUP_DATABASE_CONFLICT',
            message: expect.stringContaining('Do not delete WAL files'),
            details: expect.objectContaining({ state: 'wal-present' }),
          }),
        );
      }
      expect(fs.existsSync(home)).toBe(false);
      expect(fs.readdirSync(directory)).toEqual(files);
      expect(files.map((file) => fs.readFileSync(path.join(directory, file)))).toEqual(before);

      writable.close();
      expect(createSetupPlan(options).database).toMatchObject({
        state: 'unsupported-version',
        databaseVersion: 2,
      });
    } finally {
      if (writable.isOpen) writable.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('accepts a clean persistent rollback journal', () => {
    const directory = temporaryDirectory();
    const database = path.join(directory, 'crm.db');
    initializeDatabase(database);
    const writable = new DatabaseSync(database);
    writable.prepare('PRAGMA journal_mode=PERSIST').get();
    writable.prepare("UPDATE metadata SET value = '1' WHERE key = 'database_version'").run();
    writable.close();

    try {
      const journal = `${database}-journal`;
      expect(fs.statSync(journal).size).toBeGreaterThan(512);
      expect(fs.readFileSync(journal).subarray(0, 8)).toEqual(Buffer.alloc(8));
      const before = fs.readFileSync(journal);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(createSetupPlan({ databaseOverride: database, env: {} }).database).toMatchObject({
          state: 'agentcrm-ready',
          databaseVersion: 1,
        });
      }
      expect(fs.readFileSync(journal)).toEqual(before);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses to inspect metadata covered by a hot rollback journal', () => {
    const directory = temporaryDirectory();
    const database = path.join(directory, 'crm.db');
    const home = path.join(directory, 'home');
    initializeDatabase(database);
    const seed = new DatabaseSync(database);
    seed.exec('CREATE TABLE rollback_journal_filler (value TEXT)');
    seed.close();
    const transaction = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          import { DatabaseSync } from 'node:sqlite';
          const database = new DatabaseSync(${JSON.stringify(database)});
          database.exec('PRAGMA journal_mode=DELETE; PRAGMA cache_size=1; BEGIN IMMEDIATE');
          database.prepare("UPDATE metadata SET value = '2' WHERE key = 'database_version'").run();
          const insert = database.prepare('INSERT INTO rollback_journal_filler VALUES (?)');
          for (let index = 0; index < 100; index += 1) insert.run('x'.repeat(3000));
          process.kill(process.pid, 'SIGKILL');
        `,
      ],
      { encoding: 'utf8' },
    );

    try {
      expect(
        transaction.signal === 'SIGKILL' ||
          (transaction.status !== null && transaction.status !== 0),
      ).toBe(true);
      expect(fs.statSync(`${database}-journal`).size).toBeGreaterThan(512);
      const immutable = new DatabaseSync(`${pathToFileURL(database).href}?mode=ro&immutable=1`, {
        readOnly: true,
      });
      expect(
        immutable.prepare("SELECT value FROM metadata WHERE key = 'database_version'").get(),
      ).toMatchObject({ value: '2' });
      immutable.close();
      const files = fs.readdirSync(directory);
      const before = files.map((file) => fs.readFileSync(path.join(directory, file)));

      const plan = createSetupPlan({ databaseOverride: database, home, env: {} });
      expect(plan.database).toMatchObject({
        state: 'journal-present',
        hint: expect.stringContaining('Do not delete journal files'),
      });
      expect(plan.database.databaseVersion).toBeUndefined();
      expect(plan.actions.canInitializeDatabase).toBe(false);
      expect(fs.existsSync(home)).toBe(false);
      expect(fs.readdirSync(directory)).toEqual(files);
      expect(files.map((file) => fs.readFileSync(path.join(directory, file)))).toEqual(before);

      const recovered = new DatabaseSync(database);
      expect(
        recovered.prepare("SELECT value FROM metadata WHERE key = 'database_version'").get(),
      ).toMatchObject({ value: '1' });
      recovered.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('requires explicit initialization and confirmation before creating a database', () => {
    const directory = temporaryDirectory();
    const database = path.join(directory, 'crm.db');
    const source = path.join(directory, 'SKILL.md');
    fs.writeFileSync(source, 'bundled skill');

    try {
      expect(() =>
        applySetup({ databaseOverride: database, home: directory, env: {}, sourcePath: source }),
      ).toThrowError(expect.objectContaining({ code: 'SETUP_CONFIRMATION_REQUIRED' }));
      expect(() =>
        applySetup({
          databaseOverride: database,
          home: directory,
          env: {},
          sourcePath: source,
          initialize: true,
        }),
      ).toThrowError(expect.objectContaining({ code: 'SETUP_CONFIRMATION_REQUIRED' }));

      const result = applySetup({
        databaseOverride: database,
        home: directory,
        env: {},
        sourcePath: source,
        initialize: true,
        noSkill: true,
        yes: true,
      });
      expect(result.database).toMatchObject({ action: 'initialized', path: database });
      expect(fs.existsSync(database)).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('installs selected hosts once per distinct destination', () => {
    const directory = temporaryDirectory();
    const home = path.join(directory, 'home');
    const database = path.join(directory, 'crm.db');
    const source = path.join(directory, 'SKILL.md');
    fs.writeFileSync(source, 'bundled skill');
    initializeDatabase(database);

    try {
      const result = applySetup({
        databaseOverride: database,
        home,
        env: {},
        sourcePath: source,
        agents: ['pi', 'claude-code', 'pi'],
        yes: true,
      });
      expect(result.database).toMatchObject({ action: 'unchanged', path: database });
      expect(result.skillInstallations).toEqual([
        expect.objectContaining({ hosts: ['pi'], changed: true }),
        expect.objectContaining({ hosts: ['claude-code'], changed: true }),
      ]);
      expect(
        fs.readFileSync(path.join(home, '.agents', 'skills', 'agentcrm', 'SKILL.md'), 'utf8'),
      ).toBe('bundled skill');
      expect(
        fs.readFileSync(path.join(home, '.claude', 'skills', 'agentcrm', 'SKILL.md'), 'utf8'),
      ).toBe('bundled skill');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves completed Skill installations after a later failure and retries safely', () => {
    const directory = temporaryDirectory();
    const home = path.join(directory, 'home');
    const database = path.join(directory, 'crm.db');
    const source = path.join(directory, 'SKILL.md');
    const claudeRoot = path.join(home, '.claude', 'skills');
    fs.writeFileSync(source, 'bundled skill');
    initializeDatabase(database);

    const failingInstaller = (options: SkillIntegrationOptions): SkillIntegrationResult => {
      if (options.destination === claudeRoot) {
        throw new Error('simulated Claude Code installation failure');
      }
      return installSkill(options);
    };

    try {
      let failure: unknown;
      try {
        applySetup({
          databaseOverride: database,
          home,
          env: {},
          sourcePath: source,
          agents: ['pi', 'claude-code'],
          skillInstaller: failingInstaller,
          yes: true,
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({
        code: 'SETUP_PARTIAL_FAILURE',
        details: {
          skillInstallations: [expect.objectContaining({ hosts: ['pi'], changed: true })],
          failures: [expect.objectContaining({ hosts: ['claude-code'] })],
        },
      });
      expect(fs.existsSync(path.join(home, '.agents', 'skills', 'agentcrm', 'SKILL.md'))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(home, '.claude', 'skills', 'agentcrm'))).toBe(false);

      const retried = applySetup({
        databaseOverride: database,
        home,
        env: {},
        sourcePath: source,
        agents: ['pi', 'claude-code'],
        yes: true,
      });
      expect(retried.skillInstallations).toEqual([
        expect.objectContaining({ hosts: ['pi'], action: 'already-current', changed: false }),
        expect.objectContaining({ hosts: ['claude-code'], action: 'installed', changed: true }),
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports an existing non-Agent CRM file without opening it for writes', () => {
    const directory = temporaryDirectory();
    const database = path.join(directory, 'other.db');
    const source = path.join(directory, 'SKILL.md');
    fs.writeFileSync(database, 'not sqlite');
    fs.writeFileSync(source, 'bundled skill');

    try {
      const plan = createSetupPlan({
        databaseOverride: database,
        home: path.join(directory, 'home'),
        platform: 'linux',
        env: {},
        sourcePath: source,
      });
      expect(plan.database.state).toBe('non-agentcrm-file');
      expect(fs.readFileSync(database, 'utf8')).toBe('not sqlite');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
