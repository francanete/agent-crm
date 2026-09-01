import type { AppError } from '../core/errors.js';

export interface SuccessEnvelope {
  ok: true;
  data: unknown;
  meta: {
    database?: string;
    cliVersion: string;
  };
}

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
}

export function successEnvelope(
  data: unknown,
  cliVersion: string,
  database?: string,
): SuccessEnvelope {
  return {
    ok: true,
    data,
    meta: {
      ...(database ? { database } : {}),
      cliVersion,
    },
  };
}

export function errorEnvelope(error: AppError): ErrorEnvelope {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
    },
  };
}
