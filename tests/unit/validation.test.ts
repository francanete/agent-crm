import { describe, expect, it } from 'vitest';
import type { FieldDefinition } from '../../src/core/types.js';
import { validateAndNormalizeFieldValue } from '../../src/core/validation.js';

const field: FieldDefinition = {
  id: 'test-field',
  objectTypeId: 'test-object',
  key: 'due_at',
  label: 'Due at',
  description: null,
  type: 'datetime',
  format: null,
  required: true,
  options: null,
  position: 0,
  system: false,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  archivedAt: null,
};

describe('datetime validation', () => {
  it.each([
    '2026-02-30T12:00:00Z',
    '2026-02-29T12:00:00Z',
    '2026-04-31T12:00:00Z',
    '2026-00-01T12:00:00Z',
    '2026-13-01T12:00:00Z',
    '2026-01-00T12:00:00Z',
    '2026-01-32T12:00:00Z',
    '2026-09-01T24:00:00Z',
    '2026-09-01T12:60:00Z',
    '2026-09-01T12:00:60Z',
    '2026-09-01T12:00:00+24:00',
    '2026-09-01T12:00:00+01:60',
    '2026-09-01T12:00:00',
    '2026-09-01T12:00Z',
    '2026-09-01 12:00:00Z',
    '2026-09-01T12:00:00+0100',
    '0000-01-01T00:00:00+01:00',
    '9999-12-31T23:59:59-01:00',
    42,
    null,
  ])('rejects invalid RFC 3339 input %j', (value) => {
    expect(() => validateAndNormalizeFieldValue(field, value)).toThrowError(
      expect.objectContaining({ code: 'INVALID_FIELD_VALUE' }),
    );
  });

  it.each([
    ['2024-02-29T12:00:00Z', '2024-02-29T12:00:00.000Z'],
    ['2026-09-01T00:30:00+02:00', '2026-08-31T22:30:00.000Z'],
    ['2026-09-01T23:30:00-02:00', '2026-09-02T01:30:00.000Z'],
    ['2026-09-01t12:00:00z', '2026-09-01T12:00:00.000Z'],
    ['2026-09-01T12:00:00.1Z', '2026-09-01T12:00:00.100Z'],
    ['2026-09-01T12:00:00.123456Z', '2026-09-01T12:00:00.123Z'],
    ['0099-09-01T12:00:00Z', '0099-09-01T12:00:00.000Z'],
    ['0000-02-29T12:00:00Z', '0000-02-29T12:00:00.000Z'],
  ])('normalizes %s and accepts its canonical stored value', (input, expected) => {
    expect(validateAndNormalizeFieldValue(field, input)).toBe(expected);
    expect(validateAndNormalizeFieldValue(field, expected)).toBe(expected);
  });
});
