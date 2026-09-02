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

  it.skipIf(process.platform === 'win32')(
    'refuses to follow a symlinked skill directory during uninstall',
    () => {
      const directory = temporaryDirectory();
      const destination = path.join(directory, 'skills');
      const targetDirectory = path.join(destination, 'agentcrm');
      const outside = path.join(directory, 'outside');
      const outsideSkill = path.join(outside, 'SKILL.md');
      fs.mkdirSync(destination);
      fs.mkdirSync(outside);
      fs.writeFileSync(outsideSkill, 'must not be removed');
      fs.symlinkSync(outside, targetDirectory, 'dir');

      try {
        expect(() => uninstallSkill({ destination, force: true })).toThrowError(
          expect.objectContaining({ code: 'INTEGRATION_CONFLICT' }),
        );
        expect(fs.readFileSync(outsideSkill, 'utf8')).toBe('must not be removed');
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
  });
});
