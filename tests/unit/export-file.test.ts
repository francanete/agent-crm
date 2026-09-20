import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ExportDocument, writeExportFile } from '../../src/core/portability.js';

const directories: string[] = [];
const document: ExportDocument = {
  format: 'agentcrm-export',
  formatVersion: 1,
  exportedAt: '2026-09-01T14:32:05.123Z',
  databaseVersion: 1,
  historyIncluded: true,
  data: { objects: [], records: [], relationships: [], events: [] },
};

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-export-file-'));
  directories.push(directory);
  return { directory, output: path.join(directory, 'backup.json') };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('export file publication', () => {
  it('publishes a complete private export and removes its temporary link', () => {
    const { directory, output } = fixture();
    const content = `${JSON.stringify(document, null, 2)}\n`;
    const link = fs.linkSync.bind(fs);
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
      expect(fs.existsSync(output)).toBe(false);
      expect(path.dirname(String(source))).toBe(directory);
      expect(fs.readFileSync(source, 'utf8')).toBe(content);
      if (process.platform !== 'win32') {
        expect(fs.statSync(source).mode & 0o777).toBe(0o600);
      }
      link(source, target);
    });
    expect(writeExportFile(output, document)).toEqual({
      output,
      bytes: Buffer.byteLength(content),
    });
    expect(linkSpy).toHaveBeenCalledOnce();
    expect(fs.readFileSync(output, 'utf8')).toBe(content);
    expect(fs.readdirSync(directory)).toEqual(['backup.json']);
  });

  it.skipIf(process.platform === 'win32').each([false, true])(
    'preserves a dangling symlink (created during write=%s)',
    (duringWrite) => {
      const { directory, output } = fixture();
      const missing = path.join(directory, 'missing.json');
      if (duringWrite) {
        const write = fs.writeFileSync.bind(fs);
        vi.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
          write(...args);
          fs.symlinkSync(missing, output);
        });
      } else {
        fs.symlinkSync(missing, output);
      }
      expect(() => writeExportFile(output, document)).toThrowError(
        expect.objectContaining({ code: 'EXPORT_TARGET_EXISTS', details: { output } }),
      );
      expect(fs.readlinkSync(output)).toBe(missing);
      expect(fs.existsSync(missing)).toBe(false);
      expect(fs.readdirSync(directory)).toEqual(['backup.json']);
    },
  );

  it.each(['ENOTSUP', 'EPERM', 'EIO'])('fails closed on link failure %s', (code) => {
    const { directory, output } = fixture();
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('simulated link failure'), { code });
    });
    const renameSpy = vi.spyOn(fs, 'renameSync');
    expect(() => writeExportFile(output, document)).toThrowError(
      expect.objectContaining({ code: 'DATABASE_ERROR', details: { output } }),
    );
    expect(renameSpy).not.toHaveBeenCalled();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('removes an owned partial temporary file after a write failure', () => {
    const { directory, output } = fixture();
    const write = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file) => {
      write(file, 'partial export');
      throw Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' });
    });
    const linkSpy = vi.spyOn(fs, 'linkSync');
    expect(() => writeExportFile(output, document)).toThrowError(
      expect.objectContaining({ code: 'DATABASE_ERROR' }),
    );
    expect(linkSpy).not.toHaveBeenCalled();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('does not remove a temporary path it could not exclusively create', () => {
    const { directory, output } = fixture();
    const open = fs.openSync.bind(fs);
    let unowned: fs.PathLike | undefined;
    vi.spyOn(fs, 'openSync').mockImplementationOnce((file, flags, mode) => {
      unowned = file;
      const descriptor = open(file, 'wx', 0o600);
      fs.writeSync(descriptor, 'unowned file');
      fs.closeSync(descriptor);
      return open(file, flags, mode);
    });
    expect(() => writeExportFile(output, document)).toThrowError(
      expect.objectContaining({ code: 'DATABASE_ERROR' }),
    );
    expect(unowned).toBeDefined();
    expect(fs.readFileSync(unowned as fs.PathLike, 'utf8')).toBe('unowned file');
    expect(fs.readdirSync(directory)).toHaveLength(1);
    expect(fs.existsSync(output)).toBe(false);
  });

  it('does not remove the destination if temporary cleanup fails after publication', () => {
    const { directory, output } = fixture();
    const unlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      // A subsequent writer replaces our published export before cleanup fails.
      unlink(output);
      fs.writeFileSync(output, 'subsequent valuable backup', { flag: 'wx' });
      throw Object.assign(new Error('simulated cleanup failure'), { code: 'EIO' });
    });
    expect(() => writeExportFile(output, document)).toThrowError(
      expect.objectContaining({ code: 'DATABASE_ERROR' }),
    );
    expect(fs.readFileSync(output, 'utf8')).toBe('subsequent valuable backup');
    expect(fs.readdirSync(directory)).toEqual(['backup.json']);
  });

  it.each([false, true])('keeps explicit forced replacement (existing=%s)', (existing) => {
    const { directory, output } = fixture();
    if (existing) fs.writeFileSync(output, 'previous backup');
    const linkSpy = vi.spyOn(fs, 'linkSync');
    const renameSpy = vi.spyOn(fs, 'renameSync');
    expect(writeExportFile(output, document, true).output).toBe(output);
    expect(linkSpy).not.toHaveBeenCalled();
    expect(renameSpy).toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toEqual(document);
    expect(fs.readdirSync(directory)).toEqual(['backup.json']);
  });

  it('preserves a valuable file created after the absence check', () => {
    const { directory, output } = fixture();
    const valuable = 'valuable competing backup\n';
    const write = fs.writeFileSync.bind(fs);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
      write(...args);
      // The private export has been written, but has not been published yet.
      write(output, valuable, { flag: 'wx' });
    });
    let error: unknown;
    try {
      writeExportFile(output, document);
    } catch (caught) {
      error = caught;
    }
    expect(writeSpy).toHaveBeenCalledOnce();
    expect.soft(fs.readFileSync(output, 'utf8')).toBe(valuable);
    expect(error).toMatchObject({ code: 'EXPORT_TARGET_EXISTS', details: { output } });
    expect(fs.readdirSync(directory)).toEqual(['backup.json']);
  });
});
