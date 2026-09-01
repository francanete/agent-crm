export type FieldType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'enum'
  | 'multi_select'
  | 'json';

export type FieldFormat = 'email' | 'phone' | 'url' | 'currency' | 'percentage' | null;

export interface ObjectDefinition {
  id: string;
  key: string;
  label: string;
  pluralLabel: string;
  description: string | null;
  titleFieldKey: string;
  schemaVersion: number;
  system: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  fields: FieldDefinition[];
}

export interface FieldDefinition {
  id: string;
  objectTypeId: string;
  key: string;
  label: string;
  description: string | null;
  type: FieldType;
  format: FieldFormat;
  required: boolean;
  options: string[] | null;
  defaultValue?: unknown;
  position: number;
  system: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface RecordData {
  id: string;
  object: string;
  displayName: string;
  values: Record<string, unknown>;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}
