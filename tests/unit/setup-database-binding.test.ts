import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applySetup, createSetupPlan } from '../../src/integrations/setup.js';
import { installSkill, uninstallSkill } from '../../src/integrations/skill.js';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-binding-'));
  const home = path.join(directory, 'home');
  const profile = path.join(home, '.hermes', 'profiles', 'work');
  const destination = path.join(profile, 'skills');
  const sourcePath = path.join(directory, 'source.md');
  fs.writeFileSync(sourcePath, '---\nname: agentcrm\n---\n\n# Agent CRM\n');
  const options = {
    home,
    env: { HERMES_HOME: profile },
    sourcePath,
    databaseOverride: path.join(directory, "custom $cash & 'quoted' (data).db"),
    agents: ['hermes'],
    initialize: true,
    yes: true,
  };
  return { directory, home, destination, sourcePath, options };
}

describe('setup database binding', () => {
  it.each(['relative', 'environment', 'default'])(
    'binds the resolved %s selection',
    (selection) => {
      const { directory, destination, options } = fixture();
      try {
        const { databaseOverride, ...base } = options;
        const selected = {
          ...base,
          ...(selection === 'relative'
            ? { databaseOverride: path.relative(process.cwd(), databaseOverride) }
            : {}),
          env: {
            ...base.env,
            ...(selection === 'environment' ? { AGENTCRM_DB: databaseOverride } : {}),
          },
        };
        const plan = createSetupPlan(selected);
        applySetup(selected);
        const content = fs.readFileSync(path.join(destination, 'agentcrm', 'SKILL.md'), 'utf8');
        expect(content).toContain(JSON.stringify(['--db', plan.database.path]));
        expect(path.isAbsolute(plan.database.path)).toBe(true);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    "spaces 'quotes' $HOME $(touch nope) & %TEMP% !bang!",
    'back`ticks```<tag>\nnewline\rreturn\\backslash',
    'C:\\Users\\Some Name\\data & $cash.db',
  ])('round-trips argument data without shell or Markdown interpretation: %s', (suffix) => {
    const { directory, destination, sourcePath } = fixture();
    try {
      // Only render these values: some characters are not legal filenames on Windows.
      const databasePath = path.join(directory, suffix);
      const installed = installSkill({ destination, sourcePath, databasePath });
      const content = fs.readFileSync(installed.path, 'utf8');
      const encoded = /```json\n([^\n]+)\n```/.exec(content)?.[1] ?? '';
      expect(JSON.parse(encoded)).toEqual(['--db', databasePath]);
      expect(encoded).not.toContain('`');
      expect(encoded).not.toContain('<');
      expect(content.startsWith('---\nname: agentcrm\n---\n')).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persists the resolved database in profile-local managed instructions and previews it', () => {
    const { directory, home, destination, options } = fixture();
    try {
      const plan = createSetupPlan(options);
      expect(plan.hosts.find((host) => host.key === 'hermes')).toMatchObject({
        databaseBinding: { path: options.databaseOverride, previousPath: null },
      });
      expect(fs.existsSync(home)).toBe(false);
      applySetup(options);
      const skill = fs.readFileSync(path.join(destination, 'agentcrm', 'SKILL.md'), 'utf8');
      expect(skill).toContain(JSON.stringify(['--db', options.databaseOverride]));
      expect(skill).toContain('not shell source');
      expect(skill).toContain('does not change bare CLI');
      const manifest = JSON.parse(
        fs.readFileSync(path.join(destination, 'agentcrm', '.agentcrm-managed.json'), 'utf8'),
      );
      expect(manifest.databasePath).toBe(options.databaseOverride);
      expect(manifest.sha256).toBe(createHash('sha256').update(skill).digest('hex'));
      expect(createSetupPlan(options).hosts.find((host) => host.key === 'hermes')).toMatchObject({
        skillState: 'managed-current',
        databaseBinding: { path: options.databaseOverride, previousPath: options.databaseOverride },
      });
      expect(applySetup(options).skillInstallations[0]?.changed).toBe(false);
      expect(fs.existsSync(path.join(home, '.hermes', 'skills'))).toBe(false);
      expect(fs.existsSync(path.join(home, '.local'))).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves binding on direct upgrades, requires setup consent to rebind, and protects edits', () => {
    const { directory, destination, sourcePath, options } = fixture();
    try {
      applySetup(options);
      fs.appendFileSync(sourcePath, '\nUpgraded guidance.\n');
      const upgraded = installSkill({ destination, sourcePath });
      expect(fs.readFileSync(upgraded.path, 'utf8')).toContain(
        JSON.stringify(options.databaseOverride),
      );
      expect(installSkill({ destination, sourcePath }).changed).toBe(false);
      const next = { ...options, databaseOverride: path.join(directory, 'other.db') };
      expect(createSetupPlan(next).hosts.find((host) => host.key === 'hermes')).toMatchObject({
        skillState: 'managed-outdated',
        databaseBinding: { path: next.databaseOverride, previousPath: options.databaseOverride },
      });
      const before = fs.readFileSync(upgraded.path);
      expect(() => applySetup({ ...next, yes: false })).toThrowError(
        expect.objectContaining({ code: 'SETUP_CONFIRMATION_REQUIRED' }),
      );
      expect(fs.readFileSync(upgraded.path)).toEqual(before);
      expect(fs.existsSync(next.databaseOverride)).toBe(false);
      applySetup(next);
      expect(fs.readFileSync(upgraded.path, 'utf8')).toContain(
        JSON.stringify(next.databaseOverride),
      );
      fs.appendFileSync(upgraded.path, '\nLocal edits.\n');
      expect(() => applySetup(options)).toThrowError(
        expect.objectContaining({ code: 'SETUP_DESTINATION_CONFLICT' }),
      );
      applySetup({ ...options, forceSkill: true });
      expect(uninstallSkill({ destination, sourcePath }).changed).toBe(true);
      const generic = installSkill({ destination, sourcePath });
      expect(fs.readFileSync(generic.path)).toEqual(fs.readFileSync(sourcePath));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
