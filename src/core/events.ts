import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface EventMutationOptions {
  actor: string;
  source?: string;
  idempotencyKey?: string;
  cliVersion: string;
}

export function appendMutationEvent(
  database: DatabaseSync,
  input: {
    subjectType: 'object' | 'field' | 'record' | 'relationship';
    subjectId: string;
    action: 'created' | 'updated' | 'archived' | 'restored';
    operation: string;
    requestHash: string;
    before: unknown;
    result: unknown;
    replayResult?: unknown;
    timestamp: string;
  },
  options: EventMutationOptions,
): void {
  const metadata: Record<string, unknown> = {
    operation: input.operation,
    requestHash: input.requestHash,
    result: input.replayResult ?? input.result,
    cliVersion: options.cliVersion,
    workingDirectory: process.cwd(),
  };
  if (process.env.PI_SESSION_ID) metadata.piSessionId = process.env.PI_SESSION_ID;
  database
    .prepare(`
      INSERT INTO events(
        id, subject_type, subject_id, action, actor, source, idempotency_key,
        before_json, after_json, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      randomUUID(),
      input.subjectType,
      input.subjectId,
      input.action,
      options.actor,
      options.source ?? null,
      options.idempotencyKey ?? null,
      JSON.stringify(input.before),
      JSON.stringify(input.result),
      JSON.stringify(metadata),
      input.timestamp,
    );
}
