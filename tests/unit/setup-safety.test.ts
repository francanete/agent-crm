import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/database.js';
import { applySetup, createSetupPlan } from '../../src/integrations/setup.js';
import { installSkill } from '../../src/integrations/skill.js';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-setup-safety-'));
  const home = path.join(directory, 'home');
  const database = path.join(directory, 'crm.db');
  const outside = path.join(directory, 'outside');
  fs.mkdirSync(home);
  fs.mkdirSync(outside);
  const options = { databaseOverride: database, home, env: {} };
  return { directory, home, database, outside, options };
}

describe('setup path safety', () => {
  it.each(['.agents', '.agents/skills', '.agents/skills/agentcrm'])(
    'rejects a symlink at %s before database or Skill writes, even with force',
    (component) => {
      const { directory, home, database, outside, options } = fixture();
      const target = path.join(home, component);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
      try {
        for (const forceSkill of [false, true]) {
          expect(() =>
            applySetup({ ...options, initialize: true, agents: ['pi'], yes: true, forceSkill }),
          ).toThrowError(expect.objectContaining({ code: 'SETUP_DESTINATION_CONFLICT' }));
        }
        expect(fs.existsSync(database)).toBe(false);
        expect(fs.readdirSync(outside)).toEqual([]);
        expect(() =>
          installSkill({ destination: path.join(home, '.agents', 'skills'), force: true }),
        ).toThrowError(expect.objectContaining({ code: 'INTEGRATION_CONFLICT' }));
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32').each(['SKILL.md', '.agentcrm-managed.json'])(
    'rejects a symlinked %s even with force',
    (file) => {
      const { directory, home, database, outside, options } = fixture();
      const skillDirectory = path.join(home, '.agents', 'skills', 'agentcrm');
      fs.mkdirSync(skillDirectory, { recursive: true });
      const externalFile = path.join(outside, file);
      fs.writeFileSync(externalFile, 'preserve me');
      fs.symlinkSync(externalFile, path.join(skillDirectory, file));
      try {
        for (const forceSkill of [false, true]) {
          expect(() =>
            applySetup({ ...options, initialize: true, agents: ['pi'], yes: true, forceSkill }),
          ).toThrowError(expect.objectContaining({ code: 'SETUP_DESTINATION_CONFLICT' }));
        }
        expect(fs.existsSync(database)).toBe(false);
        expect(fs.readFileSync(externalFile, 'utf8')).toBe('preserve me');
        expect(fs.lstatSync(path.join(skillDirectory, file)).isSymbolicLink()).toBe(true);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('rejects a database beneath a symlinked parent', () => {
    const { directory, home, outside, options } = fixture();
    const link = path.join(home, 'data');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const linkedOptions = { ...options, databaseOverride: path.join(link, 'crm.db') };
      for (const existing of [false, true]) {
        if (existing) initializeDatabase(path.join(outside, 'crm.db'));
        const before = fs.readdirSync(outside);
        expect(createSetupPlan(linkedOptions).database.state).toBe('not-a-regular-file');
        expect(() =>
          applySetup({ ...linkedOptions, initialize: true, noSkill: true, yes: true }),
        ).toThrowError(expect.objectContaining({ code: 'SETUP_DATABASE_CONFLICT' }));
        expect(fs.readdirSync(outside)).toEqual(before);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses the same canonical destination key for hosts and groups', () => {
    const { directory, home, outside, options } = fixture();
    fs.mkdirSync(path.join(home, '.pi'));
    fs.mkdirSync(path.join(outside, 'skills'));
    fs.symlinkSync(
      outside,
      path.join(home, '.agents'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    try {
      const plan = createSetupPlan(options);
      const host = plan.hosts.find((item) => item.key === 'pi');
      expect(host?.destinationKey).toBe(fs.realpathSync.native(path.join(outside, 'skills')));
      expect(plan.destinationGroups[0]?.destinationKey).toBe(host?.destinationKey);
      expect(host?.skillState).toBe('unsafe-target');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports unchanged when initialization makes no logical changes', () => {
    const { directory, database, options } = fixture();
    initializeDatabase(database);
    try {
      expect(
        applySetup({ ...options, initialize: true, noSkill: true, yes: true }).database,
      ).toMatchObject({
        action: 'unchanged',
        initialization: { created: false, migrated: false, seeded: false },
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('protects unowned and modified Skills unless replacement is explicit', () => {
    const { directory, home, database, options } = fixture();
    const skill = path.join(home, '.agents', 'skills', 'agentcrm', 'SKILL.md');
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(skill, 'unowned instructions');
    try {
      expect(() =>
        applySetup({ ...options, initialize: true, agents: ['pi'], yes: true }),
      ).toThrowError(expect.objectContaining({ code: 'SETUP_DESTINATION_CONFLICT' }));
      expect(fs.existsSync(database)).toBe(false);
      applySetup({ ...options, initialize: true, agents: ['pi'], yes: true, forceSkill: true });
      fs.appendFileSync(skill, '\nlocal modification');
      expect(() => applySetup({ ...options, agents: ['pi'], yes: true })).toThrowError(
        expect.objectContaining({ code: 'SETUP_DESTINATION_CONFLICT' }),
      );
      expect(
        applySetup({ ...options, agents: ['pi'], yes: true, forceSkill: true }).skillInstallations,
      ).toEqual([expect.objectContaining({ changed: true })]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
