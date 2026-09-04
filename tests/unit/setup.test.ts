import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

  it('inspects WAL-mode databases without creating sidecar files', () => {
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

    try {
      const plan = createSetupPlan({
        databaseOverride: database,
        home: path.join(directory, 'home'),
        platform: 'linux',
        env: {},
        sourcePath: source,
      });
      expect(plan.database).toMatchObject({ state: 'agentcrm-ready', databaseVersion: 1 });
      expect(fs.existsSync(`${database}-wal`)).toBe(false);
      expect(fs.existsSync(`${database}-shm`)).toBe(false);
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
