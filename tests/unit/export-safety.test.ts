import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { assertSafeExportDestination } from '../../src/cli/export-safety.js';

const directories: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it.each(['-wal', '-shm', '-journal'])(
  'conservatively reserves mixed-case absent sidecars on macOS: %s',
  (suffix) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-case-'));
    directories.push(directory);
    const database = path.join(directory, 'crm.db');
    fs.writeFileSync(database, 'protected fixture');
    const output = path.join(directory, `CRM.DB${suffix.toUpperCase()}`);
    expect(fs.existsSync(output)).toBe(false);
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    expect(() => assertSafeExportDestination(database, output)).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
    expect(fs.readFileSync(database, 'utf8')).toBe('protected fixture');
    expect(fs.existsSync(output)).toBe(false);
    expect(() =>
      assertSafeExportDestination(database, path.join(directory, 'backup.json')),
    ).not.toThrow();
  },
);
