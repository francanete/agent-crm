import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { now } from '../core/time.js';
import type { FieldFormat, FieldType } from '../core/types.js';
import { inImmediateTransaction } from './transaction.js';

export interface SeedField {
  key: string;
  label: string;
  type: FieldType;
  format?: FieldFormat;
  required?: boolean;
  options?: string[];
  defaultValue?: unknown;
}

export interface SeedObject {
  key: string;
  label: string;
  pluralLabel: string;
  titleFieldKey: string;
  fields: SeedField[];
}

export const DEFAULT_SCHEMA: SeedObject[] = [
  {
    key: 'person',
    label: 'Person',
    pluralLabel: 'People',
    titleFieldKey: 'name',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'email', label: 'Email', type: 'text', format: 'email' },
      { key: 'phone', label: 'Phone', type: 'text', format: 'phone' },
      { key: 'role', label: 'Role', type: 'text' },
      { key: 'notes', label: 'Notes', type: 'text' },
      { key: 'tags', label: 'Tags', type: 'multi_select' },
    ],
  },
  {
    key: 'organization',
    label: 'Organization',
    pluralLabel: 'Organizations',
    titleFieldKey: 'name',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'domain', label: 'Domain', type: 'text' },
      { key: 'website', label: 'Website', type: 'text', format: 'url' },
      { key: 'notes', label: 'Notes', type: 'text' },
      { key: 'tags', label: 'Tags', type: 'multi_select' },
    ],
  },
  {
    key: 'interaction',
    label: 'Interaction',
    pluralLabel: 'Interactions',
    titleFieldKey: 'summary',
    fields: [
      { key: 'summary', label: 'Summary', type: 'text', required: true },
      {
        key: 'kind',
        label: 'Kind',
        type: 'enum',
        options: ['meeting', 'call', 'email', 'message', 'note', 'other'],
      },
      { key: 'occurred_at', label: 'Occurred at', type: 'datetime', required: true },
      { key: 'details', label: 'Details', type: 'text' },
      { key: 'tags', label: 'Tags', type: 'multi_select' },
    ],
  },
  {
    key: 'followup',
    label: 'Follow-up',
    pluralLabel: 'Follow-ups',
    titleFieldKey: 'title',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'due_at', label: 'Due at', type: 'datetime', required: true },
      {
        key: 'status',
        label: 'Status',
        type: 'enum',
        required: true,
        options: ['open', 'done', 'cancelled'],
        defaultValue: 'open',
      },
      { key: 'completed_at', label: 'Completed at', type: 'datetime' },
      { key: 'notes', label: 'Notes', type: 'text' },
    ],
  },
];

export function seedDefaultSchema(database: DatabaseSync): boolean {
  const countRow = database.prepare('SELECT COUNT(*) AS count FROM object_types').get() as {
    count: number;
  };
  if (countRow.count > 0) return false;

  inImmediateTransaction(database, () => {
    const insertObject = database.prepare(`
      INSERT INTO object_types(
        id, key, label, plural_label, description, title_field_key,
        schema_version, system, created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, NULL)
    `);
    const insertField = database.prepare(`
      INSERT INTO field_definitions(
        id, object_type_id, key, label, description, type, format, required,
        options_json, default_value_json, position, system, created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)
    `);

    const timestamp = now();
    for (const object of DEFAULT_SCHEMA) {
      const objectId = randomUUID();
      insertObject.run(
        objectId,
        object.key,
        object.label,
        object.pluralLabel,
        null,
        object.titleFieldKey,
        timestamp,
        timestamp,
      );

      object.fields.forEach((field, position) => {
        insertField.run(
          randomUUID(),
          objectId,
          field.key,
          field.label,
          null,
          field.type,
          field.format ?? null,
          field.required ? 1 : 0,
          field.options ? JSON.stringify(field.options) : null,
          field.defaultValue === undefined ? null : JSON.stringify(field.defaultValue),
          position,
          timestamp,
          timestamp,
        );
      });
    }
  });

  return true;
}
