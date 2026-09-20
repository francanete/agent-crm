import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const cli = path.resolve('dist/cli.js');

describe('Hermes profile targeting', () => {
  it.each(['--agent', '--all-detected'])('uses the active profile with %s', (selection) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-hermes-'));
    const home = path.join(directory, 'home');
    const profile = path.join(home, '.hermes', 'profiles', 'work profile');
    const destination = path.join(profile, 'skills');
    const skill = path.join(destination, 'agentcrm', 'SKILL.md');
    const database = path.join(directory, 'crm.db');
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      HERMES_HOME: profile,
      CLAUDE_CONFIG_DIR: '',
      PATH: '',
    };
    const run = (...args: string[]) => {
      const result = spawnSync(process.execPath, [cli, '--db', database, ...args, '--json'], {
        encoding: 'utf8',
        env,
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      return JSON.parse(result.stdout).data;
    };
    fs.mkdirSync(profile, { recursive: true });
    const defaultSkills = path.join(home, '.hermes', 'skills');
    const sibling = path.join(home, '.hermes', 'profiles', 'other', 'skills');
    for (const root of [defaultSkills, sibling]) {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'sentinel'), 'untouched');
    }
    try {
      const plan = run('setup', 'plan');
      expect(plan.hosts.find((host: { key: string }) => host.key === 'hermes')).toMatchObject({
        destination,
        detection: 'detected',
        evidence: ['state-directory'],
        skillState: 'absent',
      });
      expect(fs.existsSync(database)).toBe(false);
      expect(fs.existsSync(destination)).toBe(false);
      const selectionArgs = selection === '--agent' ? ['--agent', 'hermes'] : ['--all-detected'];
      expect(
        run('setup', 'apply', '--initialize', ...selectionArgs, '--yes').skillInstallations,
      ).toEqual([{ destination, hosts: ['hermes'], action: 'installed', changed: true }]);
      expect(fs.existsSync(skill)).toBe(true);
      expect(run('setup', 'apply', ...selectionArgs, '--yes').skillInstallations[0].changed).toBe(
        false,
      );
      expect(
        run('setup', 'plan').hosts.find((host: { key: string }) => host.key === 'hermes')
          .skillState,
      ).toBe('managed-current');
      expect(run('integration', 'uninstall-skill', '--destination', destination).path).toBe(skill);
      expect(fs.existsSync(skill)).toBe(false);
      const explicit = path.join(directory, 'explicit skills');
      const explicitSkill = path.join(explicit, 'agentcrm', 'SKILL.md');
      expect(run('integration', 'install-skill', '--destination', explicit).path).toBe(
        explicitSkill,
      );
      expect(fs.existsSync(explicitSkill)).toBe(true);
      expect(fs.existsSync(skill)).toBe(false);
      expect(run('integration', 'uninstall-skill', '--destination', explicit).path).toBe(
        explicitSkill,
      );
      expect(fs.existsSync(explicitSkill)).toBe(false);
      for (const root of [defaultSkills, sibling]) {
        expect(fs.readdirSync(root)).toEqual(['sentinel']);
        expect(fs.readFileSync(path.join(root, 'sentinel'), 'utf8')).toBe('untouched');
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
