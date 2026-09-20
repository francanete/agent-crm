import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../core/errors.js';
import {
  applyMigrations,
  CURRENT_DATABASE_VERSION,
  validateExistingDatabase,
} from './migrations.js';
import { seedDefaultSchema } from './seed.js';

function configureWritableDatabase(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA synchronous = NORMAL');
  database.exec('PRAGMA busy_timeout = 5000');
}

function openSqlite(databasePath: string): DatabaseSync {
  try {
    return new DatabaseSync(databasePath);
  } catch {
    throw new AppError('DATABASE_INVALID', 'The selected file is not a readable SQLite database', {
      database: databasePath,
    });
  }
}

export interface InitializationResult {
  database: string;
  created: boolean;
  migrated: boolean;
  seeded: boolean;
  databaseVersion: number;
}

function validateExistingFile(database: DatabaseSync, databasePath: string): number {
  // Also covers the CLI's schema read, which reopens the database after init.
  database.exec('PRAGMA busy_timeout = 5000');
  const deadline = performance.now() + 5000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      return validateExistingDatabase(database);
    } catch (error) {
      if (error instanceof AppError) throw error;
      const sqliteError = error as { code?: string; errcode?: number } | null;
      if (
        sqliteError?.code === 'ERR_SQLITE_ERROR' &&
        typeof sqliteError.errcode === 'number' &&
        (sqliteError.errcode & 0xff) === 5
      ) {
        // WAL recovery/last-close contention can bypass SQLite's busy handler.
        // Retry only read-only validation, including extended SQLITE_BUSY codes;
        // never replay migrations or seeding and never treat contention as corruption.
        const remaining = deadline - performance.now();
        if (remaining > 0) {
          Atomics.wait(sleeper, 0, 0, Math.min(10, remaining));
          continue;
        }
        throw new AppError('DATABASE_ERROR', 'The database is busy; retry initialization', {
          database: databasePath,
        });
      }
      throw new AppError('DATABASE_INVALID', 'The file is not a compatible Agent CRM database', {
        database: databasePath,
      });
    }
  }
}

export function initializeDatabase(databasePath: string): InitializationResult {
  const existed = fs.existsSync(databasePath);
  const directory = path.dirname(databasePath);
  const directoryExisted = fs.existsSync(directory);
  if (!existed) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  // Build new databases privately: an absence check does not confer ownership of
  // the destination or its SQLite sidecars. Only publish a fully closed database.
  let temporaryDirectory: string | undefined;
  let database: DatabaseSync | undefined;
  try {
    if (!existed) {
      temporaryDirectory = fs.mkdtempSync(path.join(directory, '.agentcrm-init-'));
    }
    const workingPath = temporaryDirectory ? path.join(temporaryDirectory, 'crm.db') : databasePath;
    database = openSqlite(workingPath);
    // Validation can encounter a concurrent connection's WAL recovery/close lock.
    database.exec('PRAGMA busy_timeout = 5000');
    const startingVersion = existed ? validateExistingFile(database, databasePath) : 0;
    configureWritableDatabase(database);
    const finalVersion = applyMigrations(database, startingVersion);
    const seeded = seedDefaultSchema(database);

    if (process.platform !== 'win32') {
      if (!directoryExisted) fs.chmodSync(directory, 0o700);
      fs.chmodSync(workingPath, 0o600);
    }

    database.close();
    database = undefined;
    if (temporaryDirectory) {
      try {
        // Hard linking is atomic and refuses to replace an existing destination
        // (unlike rename). Closing first checkpoints WAL into the database file.
        fs.linkSync(workingPath, databasePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // A dangling symlink also blocks publication; do not follow it to create
        // a new target or retry publication indefinitely.
        if (!fs.existsSync(databasePath)) {
          throw new AppError('DATABASE_INVALID', 'The database destination already exists', {
            database: databasePath,
          });
        }
        return initializeDatabase(databasePath);
      }
    }

    return {
      database: databasePath,
      created: !existed,
      migrated: finalVersion !== startingVersion,
      seeded,
      databaseVersion: finalVersion,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('DATABASE_ERROR', 'Failed to initialize the database', {
      database: databasePath,
    });
  } finally {
    try {
      database?.close();
    } catch {
      // Keep the original initialization error if closing also fails.
    } finally {
      if (temporaryDirectory) {
        try {
          // Never remove the public database or sidecars, including on failure.
          fs.rmSync(temporaryDirectory, { recursive: true, force: true });
        } catch {
          // Private leftovers must not mask the initialization result.
        }
      }
    }
  }
}

function requireDatabaseFile(databasePath: string): void {
  if (!fs.existsSync(databasePath)) {
    throw new AppError(
      'DATABASE_NOT_INITIALIZED',
      'The Agent CRM database has not been initialized',
      {
        database: databasePath,
        hint: 'Run agentcrm init',
      },
    );
  }
}

export function openDatabase(databasePath: string): DatabaseSync {
  requireDatabaseFile(databasePath);
  const database = openSqlite(databasePath);
  try {
    const startingVersion = validateExistingFile(database, databasePath);
    configureWritableDatabase(database);
    const finalVersion = applyMigrations(database, startingVersion);
    if (finalVersion !== CURRENT_DATABASE_VERSION) {
      throw new AppError('DATABASE_VERSION_UNSUPPORTED', 'The database could not be upgraded');
    }
    return database;
  } catch (error) {
    database.close();
    if (error instanceof AppError) throw error;
    throw new AppError('DATABASE_ERROR', 'Failed to open the Agent CRM database', {
      database: databasePath,
    });
  }
}

export function openReadOnlyDatabase(databasePath: string): DatabaseSync {
  requireDatabaseFile(databasePath);

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
  } catch {
    throw new AppError('DATABASE_INVALID', 'The selected file is not a readable SQLite database', {
      database: databasePath,
    });
  }

  try {
    validateExistingFile(database, databasePath);
    database.exec('PRAGMA foreign_keys = ON');
    database.exec('PRAGMA busy_timeout = 5000');
    return database;
  } catch (error) {
    database.close();
    if (error instanceof AppError) throw error;
    throw new AppError('DATABASE_ERROR', 'Failed to inspect the Agent CRM database', {
      database: databasePath,
    });
  }
}
