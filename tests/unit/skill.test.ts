import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installSkill, uninstallSkill } from '../../src/integrations/skill.js';

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-skill-'));
}

describe('Agent Skill integration', () => {
  it('installs, upgrades, and uninstalls only the managed skill', () => {
    const directory = temporaryDirectory();
    const destination = path.join(directory, 'skills');
    const source = path.join(directory, 'source.md');
    const unrelated = path.join(destination, 'agentcrm', 'notes.txt');
    fs.writeFileSync(source, '---\nname: agentcrm\ndescription: first\n---\n');

    try {
      const installed = installSkill({ destination, sourcePath: source });
      expect(installed).toMatchObject({ action: 'installed', changed: true, forced: false });
      expect(fs.readFileSync(installed.path, 'utf8')).toContain('description: first');

      expect(installSkill({ destination, sourcePath: source })).toMatchObject({ changed: false });
      fs.writeFileSync(unrelated, 'preserve me');
      fs.writeFileSync(source, '---\nname: agentcrm\ndescription: upgraded\n---\n');
      expect(installSkill({ destination, sourcePath: source })).toMatchObject({ changed: true });
      expect(fs.readFileSync(installed.path, 'utf8')).toContain('description: upgraded');

      const removed = uninstallSkill({ destination, sourcePath: source });
      expect(removed).toMatchObject({ action: 'uninstalled', changed: true });
      expect(fs.existsSync(installed.path)).toBe(false);
      expect(fs.readFileSync(unrelated, 'utf8')).toBe('preserve me');
      expect(uninstallSkill({ destination, sourcePath: source })).toMatchObject({ changed: false });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('protects unowned and locally modified skills unless forced', () => {
    const directory = temporaryDirectory();
    const destination = path.join(directory, 'skills');
    const targetDirectory = path.join(destination, 'agentcrm');
    const target = path.join(targetDirectory, 'SKILL.md');
    const source = path.join(directory, 'source.md');
    fs.mkdirSync(targetDirectory, { recursive: true });
    fs.writeFileSync(target, 'local skill');
    fs.writeFileSync(source, 'bundled skill');

    try {
      expect(() => installSkill({ destination, sourcePath: source })).toThrowError(
        expect.objectContaining({ code: 'INTEGRATION_CONFLICT' }),
      );
      installSkill({ destination, sourcePath: source, force: true });
      fs.writeFileSync(target, 'local edits after installation');
      expect(() => uninstallSkill({ destination, sourcePath: source })).toThrowError(
        expect.objectContaining({ code: 'INTEGRATION_CONFLICT' }),
      );
      expect(fs.readFileSync(target, 'utf8')).toBe('local edits after installation');
      expect(uninstallSkill({ destination, sourcePath: source, force: true })).toMatchObject({
        changed: true,
        forced: true,
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['ancestor', false],
    ['ancestor', true],
    ['root', false],
    ['root', true],
    ['skill directory', false],
    ['skill directory', true],
  ] as const)('preserves a managed skill behind a redirected %s (force=%s)', (component, force) => {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, 'source.md');
    const realRoot = path.join(directory, 'real', 'skills');
    const alias = path.join(directory, 'alias');
    fs.writeFileSync(sourcePath, 'synthetic managed skill');

    try {
      const installed = installSkill({ destination: realRoot, sourcePath });
      const manifest = path.join(realRoot, 'agentcrm', '.agentcrm-managed.json');
      const beforeSkill = fs.readFileSync(installed.path);
      const beforeManifest = fs.readFileSync(manifest);
      const notes = path.join(realRoot, 'agentcrm', 'notes.txt');
      fs.writeFileSync(notes, 'unrelated notes');
      const referent =
        component === 'ancestor'
          ? path.dirname(realRoot)
          : component === 'root'
            ? realRoot
            : path.dirname(installed.path);
      const link = component === 'skill directory' ? path.join(alias, 'agentcrm') : alias;
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(referent, link, process.platform === 'win32' ? 'junction' : 'dir');
      const destination = component === 'ancestor' ? path.join(alias, 'skills') : alias;
      let failure: unknown;
      try {
        uninstallSkill({ destination, sourcePath, force });
      } catch (error) {
        failure = error;
      }

      // Check preservation first: the old implementation deletes this legitimate managed copy.
      expect(fs.existsSync(installed.path)).toBe(true);
      expect(fs.readFileSync(installed.path)).toEqual(beforeSkill);
      expect(fs.readFileSync(manifest)).toEqual(beforeManifest);
      expect(fs.readFileSync(notes, 'utf8')).toBe('unrelated notes');
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(failure).toMatchObject({ code: 'INTEGRATION_CONFLICT' });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['root', 'skill directory', 'skill file'])(
    'leaves an absent %s unchanged without creating directories',
    (missing) => {
      const directory = temporaryDirectory();
      const destination = path.join(directory, 'skills');
      const skillDirectory = path.join(destination, 'agentcrm');
      const manifest = path.join(skillDirectory, '.agentcrm-managed.json');
      try {
        if (missing === 'skill directory') fs.mkdirSync(destination);
        if (missing === 'skill file') {
          fs.mkdirSync(skillDirectory, { recursive: true });
          fs.writeFileSync(manifest, 'preserve orphaned manifest');
        }
        for (const force of [false, true]) {
          expect(uninstallSkill({ destination, force })).toEqual({
            action: 'uninstalled',
            path: path.join(skillDirectory, 'SKILL.md'),
            changed: false,
            forced: force,
          });
        }
        expect(fs.existsSync(destination)).toBe(missing !== 'root');
        expect(fs.existsSync(skillDirectory)).toBe(missing === 'skill file');
        if (missing === 'skill file') {
          expect(fs.readFileSync(manifest, 'utf8')).toBe('preserve orphaned manifest');
        }
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(['empty directory link', 'dangling directory link', 'regular file'])(
    'rejects an unsafe root even when the skill is absent: %s',
    (kind) => {
      const directory = temporaryDirectory();
      const destination = path.join(directory, 'skills');
      const referent = path.join(directory, 'outside');
      try {
        if (kind === 'regular file') {
          fs.writeFileSync(destination, 'not a directory');
        } else {
          if (kind === 'empty directory link') fs.mkdirSync(referent);
          fs.symlinkSync(referent, destination, process.platform === 'win32' ? 'junction' : 'dir');
        }
        for (const force of [false, true]) {
          expect(() => uninstallSkill({ destination, force })).toThrowError(
            expect.objectContaining({ code: 'INTEGRATION_CONFLICT' }),
          );
        }
        if (kind === 'regular file') {
          expect(fs.readFileSync(destination, 'utf8')).toBe('not a directory');
        } else {
          expect(fs.lstatSync(destination).isSymbolicLink()).toBe(true);
          expect(fs.existsSync(referent)).toBe(kind === 'empty directory link');
          if (kind === 'empty directory link') expect(fs.readdirSync(referent)).toEqual([]);
        }
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  // Windows file symlinks require Developer Mode or elevated privileges; directory tests use junctions.
  it.skipIf(process.platform === 'win32').each(['SKILL.md', '.agentcrm-managed.json'])(
    'does not follow a final %s link and preserves explicit force unlink behavior',
    (file) => {
      const directory = temporaryDirectory();
      const destination = path.join(directory, 'skills');
      const sourcePath = path.join(directory, 'source.md');
      const external = path.join(directory, 'external');
      fs.writeFileSync(sourcePath, 'synthetic bundled skill');
      try {
        // A bound skill differs from the source, so only its regular managed manifest authorizes it.
        const installed = installSkill({
          destination,
          sourcePath,
          databasePath: path.join(directory, 'unused.db'),
        });
        const target = path.join(destination, 'agentcrm', file);
        fs.renameSync(target, external);
        const before = fs.readFileSync(external);
        fs.symlinkSync(external, target, 'file');
        expect(() => uninstallSkill({ destination, sourcePath })).toThrowError(
          expect.objectContaining({ code: 'INTEGRATION_CONFLICT' }),
        );
        expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
        expect(fs.existsSync(installed.path)).toBe(true);
        expect(fs.readFileSync(external)).toEqual(before);
        expect(uninstallSkill({ destination, sourcePath, force: true })).toMatchObject({
          changed: true,
          forced: true,
        });
        expect(fs.existsSync(path.dirname(installed.path))).toBe(false);
        expect(fs.readFileSync(external)).toEqual(before);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('ships standards-compatible skill frontmatter and required workflow guidance', () => {
    const content = fs.readFileSync(path.resolve('skills/agentcrm/SKILL.md'), 'utf8');
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(content)?.[1] ?? '';
    const name = /^name:\s*(.+)$/m.exec(frontmatter)?.[1];
    const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1] ?? '';

    expect(name).toBe('agentcrm');
    expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(description.length).toBeGreaterThan(20);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(content).toContain('agentcrm doctor --json');
    expect(content).toContain('Search before creating');
    expect(content).toContain('--idempotency-key');
    expect(content).toContain('agentcrm context');
    expect(content).toContain('real-world meaning in plain language');
    expect(content).toContain('Never ask “What relationship name/type should I use?”');
    expect(content).toContain('Treat CLI JSON envelopes as private tool output');
    expect(content).toContain('Managed database binding');
    expect(content).toContain('agent guidance, not automatic CLI discovery');
  });
});
