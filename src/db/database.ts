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

function removeDatabaseFiles(databasePath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(`${databasePath}${suffix}`, { force: true });
    } catch {
      // Keep the original initialization error.
    }
  }
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
  try {
    return validateExistingDatabase(database);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('DATABASE_INVALID', 'The file is not a compatible Agent CRM database', {
      database: databasePath,
    });
  }
}

export function initializeDatabase(databasePath: string): InitializationResult {
  const existed = fs.existsSync(databasePath);
  const directory = path.dirname(databasePath);
  const directoryExisted = fs.existsSync(directory);
  if (!existed) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  const database = openSqlite(databasePath);
  try {
    const startingVersion = existed ? validateExistingFile(database, databasePath) : 0;
    configureWritableDatabase(database);
    const finalVersion = applyMigrations(database, startingVersion);
    const seeded = seedDefaultSchema(database);

    if (process.platform !== 'win32') {
      if (!directoryExisted) fs.chmodSync(directory, 0o700);
      fs.chmodSync(databasePath, 0o600);
    }

    return {
      database: databasePath,
      created: !existed,
      migrated: finalVersion !== startingVersion,
      seeded,
      databaseVersion: finalVersion,
    };
  } catch (error) {
    database.close();
    if (!existed) removeDatabaseFiles(databasePath);
    if (error instanceof AppError) throw error;
    throw new AppError('DATABASE_ERROR', 'Failed to initialize the database', {
      database: databasePath,
    });
  } finally {
    try {
      database.close();
    } catch {
      // The database may already be closed by the error path.
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
