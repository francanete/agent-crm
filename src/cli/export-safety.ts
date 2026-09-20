import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../core/errors.js';

function ifPresent<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function entryPath(file: string): string {
  // Resolve directory aliases, not the final symlink: export renames that entry
  // rather than writing through it. This also works for absent SQLite sidecars.
  const directory = ifPresent(() => fs.realpathSync.native(path.dirname(file)));
  const entry = directory ? path.join(directory, path.basename(file)) : file;
  return process.platform === 'win32' ? entry.toLowerCase() : entry;
}

export function assertSafeExportDestination(databasePath: string, output: string): void {
  try {
    const realDatabase = ifPresent(() => fs.realpathSync.native(databasePath));
    const protectedPaths = [databasePath, ...(realDatabase ? [realDatabase] : [])].flatMap((file) =>
      ['', '-wal', '-shm', '-journal'].map((suffix) => `${file}${suffix}`),
    );
    const outputEntry = entryPath(output);
    const outputStat = ifPresent(() => fs.lstatSync(output, { bigint: true }));
    for (const file of protectedPaths) {
      const protectedStat = ifPresent(() => fs.lstatSync(file, { bigint: true }));
      if (
        outputEntry === entryPath(file) ||
        (outputStat &&
          protectedStat &&
          outputStat.ino !== 0n &&
          outputStat.dev === protectedStat.dev &&
          outputStat.ino === protectedStat.ino)
      ) {
        // File identity also covers hard links and existing case/short-name aliases.
        throw new AppError(
          'VALIDATION_ERROR',
          'Export output cannot be the CRM database file or a SQLite sidecar',
        );
      }
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('DATABASE_ERROR', 'Could not inspect the export target', { output });
  }
}
