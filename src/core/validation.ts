import { AppError } from './errors.js';
import type { FieldDefinition } from './types.js';

function invalidField(field: FieldDefinition, message: string, value?: unknown): never {
  throw new AppError('INVALID_FIELD_VALUE', message, {
    field: field.key,
    type: field.type,
    ...(value === undefined ? {} : { value }),
  });
}

function isStrictDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function validateAndNormalizeFieldValue(field: FieldDefinition, value: unknown): unknown {
  switch (field.type) {
    case 'text': {
      if (typeof value !== 'string')
        invalidField(field, `Field '${field.key}' must be text`, value);
      if (field.required && value.trim().length === 0) {
        invalidField(field, `Required field '${field.key}' cannot be blank`);
      }
      if (field.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        invalidField(field, `Field '${field.key}' must be a valid email address`, value);
      }
      if (field.format === 'phone' && value.trim().length === 0) {
        invalidField(field, `Field '${field.key}' must be a non-empty phone value`);
      }
      if (field.format === 'url') {
        try {
          new URL(value);
        } catch {
          invalidField(field, `Field '${field.key}' must be a valid URL`, value);
        }
      }
      return value;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        invalidField(field, `Field '${field.key}' must be a finite number`, value);
      }
      if (field.format === 'percentage' && (value < 0 || value > 100)) {
        invalidField(field, `Field '${field.key}' must be between 0 and 100`, value);
      }
      return value;
    }
    case 'boolean':
      if (typeof value !== 'boolean') {
        invalidField(field, `Field '${field.key}' must be a boolean`, value);
      }
      return value;
    case 'date':
      if (typeof value !== 'string' || !isStrictDate(value)) {
        invalidField(field, `Field '${field.key}' must be a valid YYYY-MM-DD date`, value);
      }
      return value;
    case 'datetime': {
      if (
        typeof value !== 'string' ||
        !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ||
        Number.isNaN(Date.parse(value))
      ) {
        invalidField(
          field,
          `Field '${field.key}' must be an RFC 3339 timestamp with a timezone`,
          value,
        );
      }
      return new Date(value).toISOString();
    }
    case 'enum':
      if (typeof value !== 'string' || value.trim().length === 0) {
        invalidField(field, `Field '${field.key}' must be a non-blank enum value`, value);
      }
      if (field.options && !field.options.includes(value)) {
        invalidField(field, `Field '${field.key}' must be one of its configured options`, value);
      }
      return value;
    case 'multi_select':
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
        invalidField(field, `Field '${field.key}' must be an array of strings`, value);
      }
      if (field.required && value.length === 0) {
        invalidField(field, `Required field '${field.key}' cannot be empty`);
      }
      if (field.options && value.some((entry) => !field.options?.includes(entry))) {
        invalidField(field, `Field '${field.key}' contains an unknown option`, value);
      }
      return [...new Set(value)];
    case 'json':
      if (value === null) invalidField(field, `JSON null clears field '${field.key}'`);
      try {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) throw new Error('not JSON');
        return JSON.parse(serialized) as unknown;
      } catch {
        invalidField(field, `Field '${field.key}' must contain JSON-compatible data`);
      }
  }
}
