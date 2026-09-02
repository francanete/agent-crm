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
  it('resolves documented skills roots', () => {
    const home = '/home/agent';
    const context = hostDetectionContext('linux', {}, home);

    expect(getHostAdapter('pi')?.skillsRoot(context)).toBe('/home/agent/.agents/skills');
    expect(getHostAdapter('claude-code')?.skillsRoot(context)).toBe('/home/agent/.claude/skills');
    expect(getHostAdapter('hermes')?.skillsRoot(context)).toBe('/home/agent/.hermes/skills');
    expect(
      getHostAdapter('claude-code')?.skillsRoot(
        hostDetectionContext(
          'linux',
          {
            CLAUDE_CONFIG_DIR: '~/custom-claude',
          },
          home,
        ),
      ),
    ).toBe('/home/agent/custom-claude/skills');
  });

  it('groups hosts sharing a skills destination', () => {
    expect(
      groupHostDestinations([
        { key: 'pi', destination: '/tmp/shared' },
        { key: 'claude-code', destination: '/tmp/claude' },
        { key: 'hermes', destination: '/tmp/hermes' },
      ]),
    ).toMatchObject([
      { destination: '/tmp/shared', hosts: ['pi'] },
      { destination: '/tmp/claude', hosts: ['claude-code'] },
      { destination: '/tmp/hermes', hosts: ['hermes'] },
    ]);
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
