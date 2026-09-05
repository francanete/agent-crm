import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getHostAdapter,
  groupHostDestinations,
  hostDetectionContext,
} from '../../src/integrations/hosts.js';

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-hosts-'));
}

describe('host adapters', () => {
  it('resolves documented skills roots with native paths', () => {
    const home = path.resolve('agent-home');
    const context = hostDetectionContext(process.platform, {}, home);

    expect(getHostAdapter('pi')?.skillsRoot(context)).toBe(path.join(home, '.agents', 'skills'));
    expect(getHostAdapter('claude-code')?.skillsRoot(context)).toBe(
      path.join(home, '.claude', 'skills'),
    );
    expect(getHostAdapter('hermes')?.skillsRoot(context)).toBe(
      path.join(home, '.hermes', 'skills'),
    );
    expect(
      getHostAdapter('claude-code')?.skillsRoot(
        hostDetectionContext(
          process.platform,
          {
            CLAUDE_CONFIG_DIR: '~/custom-claude',
          },
          home,
        ),
      ),
    ).toBe(path.join(home, 'custom-claude', 'skills'));
  });

  it('groups hosts sharing a skills destination', () => {
    const root = path.resolve('host-destinations');
    const shared = path.join(root, 'shared');
    const claude = path.join(root, 'claude');
    const hermes = path.join(root, 'hermes');

    expect(
      groupHostDestinations([
        { key: 'pi', destination: shared },
        { key: 'claude-code', destination: claude },
        { key: 'hermes', destination: hermes },
      ]),
    ).toMatchObject([
      { destination: shared, hosts: ['pi'] },
      { destination: claude, hosts: ['claude-code'] },
      { destination: hermes, hosts: ['hermes'] },
    ]);
  });

  it('detects Windows executables using PATHEXT semantics', () => {
    const directory = temporaryDirectory();
    const bin = path.join(directory, 'bin');
    const home = path.join(directory, 'home');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'pi.CMD'), '');

    try {
      const result = getHostAdapter('pi')?.detect(
        hostDetectionContext('win32', { PATH: bin, PATHEXT: '.CMD' }, home),
      );
      expect(result).toEqual({ state: 'detected', evidence: ['executable-on-path'] });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports executable and state-directory evidence without searching the home directory', () => {
    const directory = temporaryDirectory();
    const bin = path.join(directory, 'bin');
    const home = path.join(directory, 'home');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.join(home, '.pi'), { recursive: true });
    const executable = path.join(bin, 'pi');
    fs.writeFileSync(executable, '#!/bin/sh\n');
    fs.chmodSync(executable, 0o755);

    try {
      const result = getHostAdapter('pi')?.detect(
        hostDetectionContext('linux', { PATH: bin }, home),
      );
      expect(result).toEqual({
        state: 'detected',
        evidence: ['executable-on-path', 'state-directory'],
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
