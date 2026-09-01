import type { DatabaseSync } from 'node:sqlite';
import { AppError } from './errors.js';

export function findIdempotentReplay<T>(
  database: DatabaseSync,
  idempotencyKey: string | undefined,
  requestHash: string,
): T | undefined {
  if (!idempotencyKey) return undefined;
  const existing = database
    .prepare('SELECT metadata_json FROM events WHERE idempotency_key = ?')
    .get(idempotencyKey) as { metadata_json: string } | undefined;
  if (!existing) return undefined;

  const metadata = JSON.parse(existing.metadata_json) as {
    requestHash?: string;
    result?: T;
  };
  if (metadata.requestHash !== requestHash || metadata.result === undefined) {
    throw new AppError(
      'IDEMPOTENCY_CONFLICT',
      'The idempotency key was already used for a different operation',
      { idempotencyKey },
    );
  }
  return metadata.result;
}
