import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasUnsafePathComponent } from '../../src/config/path-safety.js';

// Exercise macOS path traversal on every CI host, including Windows.
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { default: actual.posix };
});

const directory = { isSymbolicLink: () => false, isDirectory: () => true } as fs.Stats;
const link = { isSymbolicLink: () => true, isDirectory: () => false } as fs.Stats;

beforeEach(() => {
  vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('macOS system aliases', () => {
  it.each(['/var', '/tmp', '/etc'])('allows only the standard %s alias', (alias) => {
    vi.spyOn(fs, 'lstatSync').mockImplementation((current) =>
      String(current) === alias ? link : directory,
    );
    const realpath = vi.spyOn(fs.realpathSync, 'native').mockReturnValue(`/private${alias}`);
    expect(hasUnsafePathComponent(`${alias}/skills`)).toBe(false);
    expect(realpath).toHaveBeenCalledExactlyOnceWith(alias);

    realpath.mockReturnValue('/unexpected');
    expect(hasUnsafePathComponent(`${alias}/skills`)).toBe(true);
  });

  it('rejects a dangling descendant without resolving it after an allowed /var alias', () => {
    vi.spyOn(fs, 'lstatSync').mockImplementation((current) =>
      ['/var', '/var/folders/skills'].includes(String(current)) ? link : directory,
    );
    const realpath = vi.spyOn(fs.realpathSync, 'native').mockImplementation((current) => {
      if (String(current) === '/var') return '/private/var';
      throw Object.assign(new Error('dangling link'), { code: 'ENOENT' });
    });

    expect(hasUnsafePathComponent('/var/folders/skills/agentcrm')).toBe(true);
    expect(realpath).toHaveBeenCalledExactlyOnceWith('/var');
  });

  it('propagates resolution errors for a system alias rather than accepting it', () => {
    vi.spyOn(fs, 'lstatSync').mockReturnValue(link);
    const error = Object.assign(new Error('cannot resolve alias'), { code: 'ENOENT' });
    vi.spyOn(fs.realpathSync, 'native').mockImplementation(() => {
      throw error;
    });
    expect(() => hasUnsafePathComponent('/var/skills')).toThrow(error);
  });
});
