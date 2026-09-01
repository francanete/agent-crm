import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultDatabasePath } from '../../src/config/paths.js';

describe('database paths', () => {
  it('uses XDG_DATA_HOME on Linux', () => {
    expect(defaultDatabasePath('linux', { XDG_DATA_HOME: '/tmp/data home' })).toBe(
      path.join('/tmp/data home', 'agentcrm', 'crm.db'),
    );
  });

  it('uses Application Support on macOS', () => {
    expect(defaultDatabasePath('darwin', {})).toBe(
      path.join(os.homedir(), 'Library', 'Application Support', 'agentcrm', 'crm.db'),
    );
  });

  it('uses LOCALAPPDATA on Windows', () => {
    expect(defaultDatabasePath('win32', { LOCALAPPDATA: 'C:\\Local Data' })).toBe(
      path.join('C:\\Local Data', 'agentcrm', 'crm.db'),
    );
  });
});
