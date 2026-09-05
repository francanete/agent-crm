import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { DatabaseSync } from 'node:sqlite';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import packageMetadata from '../../package.json' with { type: 'json' };
import { resolveActor } from '../config/actor.js';
import { resolveDatabasePath } from '../config/paths.js';
import { readBoundedBytes } from '../core/bounded-input.js';
import { getContext } from '../core/context.js';
import { type CsvFieldMapping, importCsv, MAX_CSV_BYTES } from '../core/csv.js';
import { diagnoseDatabase } from '../core/doctor.js';
import { AppError, toAppError } from '../core/errors.js';
import { getEvent, getHistory } from '../core/history.js';
import {
  createExport,
  dryRunImport,
  importDocument,
  readExportFile,
  writeExportFile,
} from '../core/portability.js';
import { listRecords } from '../core/query.js';
import {
  archiveRecord,
  createRecord,
  getRecord,
  restoreRecord,
  updateRecord,
  upsertRecord,
} from '../core/records.js';
import {
  addRelationship,
  archiveRelationship,
  listRelationships,
  restoreRelationship,
} from '../core/relationships.js';
import {
  addField,
  addObject,
  archiveField,
  archiveObject,
  describeSchema,
  restoreField,
  restoreObject,
} from '../core/schema.js';
import { searchRecords } from '../core/search.js';
import type { FieldFormat, FieldType } from '../core/types.js';
import { initializeDatabase, openDatabase, openReadOnlyDatabase } from '../db/index.js';
import { applySetup, createSetupPlan } from '../integrations/setup.js';
import { installSkill, uninstallSkill } from '../integrations/skill.js';
import { errorEnvelope, successEnvelope } from '../output/envelope.js';

export const CLI_VERSION = packageMetadata.version;
const MAX_VALUES_BYTES = 1024 * 1024;
const MAX_FILTER_BYTES = 256 * 1024;

interface GlobalOptions {
  db?: string;
  json?: boolean;
  text?: boolean;
  actor?: string;
  source?: string;
  idempotencyKey?: string;
  quiet?: boolean;
}

interface CreateOptions {
  values?: string;
  valuesFile?: string;
  set: string[];
}

interface UpsertCommandOptions extends CreateOptions {
  match: string;
}

interface AddObjectCommandOptions {
  label: string;
  pluralLabel: string;
  description?: string;
  titleField: string;
  titleFieldLabel: string;
}

interface AddFieldCommandOptions {
  label: string;
  description?: string;
  type: FieldType;
  format?: FieldFormat;
  required: boolean;
  options?: string;
  default?: string;
}

interface ListCommandOptions {
  filter?: string;
  filterFile?: string;
  sort?: string;
  limit: number;
  offset: number;
  includeArchived: boolean;
}

interface ExportCommandOptions {
  output: string;
  withoutHistory: boolean;
  force: boolean;
}

interface ImportCommandOptions {
  dryRun: boolean;
}

interface CsvImportCommandOptions {
  object: string;
  map: string[];
  match?: string;
  dryRun: boolean;
  multiValueSeparator: string;
}

interface SkillCommandOptions {
  destination?: string;
  force: boolean;
}

interface SetupApplyCommandOptions {
  initialize: boolean;
  agent: string[];
  allDetected: boolean;
  skill: boolean;
  forceSkill: boolean;
  yes: boolean;
}

interface ContextCommandOptions {
  maxRelated: number;
  maxInteractions: number;
  maxFollowups: number;
  maxChars: number;
}

interface OutputContext {
  json: boolean;
  quiet: boolean;
}

function integerOption(minimum: number, maximum: number) {
  return (value: string): number => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new InvalidArgumentError(`must be an integer from ${minimum} through ${maximum}`);
    }
    return parsed;
  };
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseCsvMapping(value: string): CsvFieldMapping {
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1) {
    throw new AppError('CSV_IMPORT_INVALID', `Invalid --map expression '${value}'`, {
      expected: 'CSV Header=crm_field',
    });
  }
  return { header: value.slice(0, separator), field: value.slice(separator + 1) };
}

function readCsvInput(input: string): string {
  if (input !== '-') {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(input);
    } catch (error) {
      throw new AppError('CSV_IMPORT_INVALID', `Cannot read CSV input '${input}'`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (!stat.isFile())
      throw new AppError('CSV_IMPORT_INVALID', 'CSV input must be a regular file');
    if (stat.size > MAX_CSV_BYTES) {
      throw new AppError(
        'CSV_IMPORT_INVALID',
        `CSV input exceeds the ${MAX_CSV_BYTES} byte limit`,
        {
          maxBytes: MAX_CSV_BYTES,
          actualBytes: stat.size,
        },
      );
    }
  }
  let content: Buffer;
  try {
    content = readBoundedBytes(input === '-' ? 0 : input, MAX_CSV_BYTES, () => {
      throw new AppError(
        'CSV_IMPORT_INVALID',
        `CSV input exceeds the ${MAX_CSV_BYTES} byte limit`,
        { maxBytes: MAX_CSV_BYTES },
      );
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('CSV_IMPORT_INVALID', `Cannot read CSV input '${input}'`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new AppError('CSV_IMPORT_INVALID', 'CSV input must be valid UTF-8');
  }
}

function parseMatchOption(value: string): { field: string; value: unknown } {
  const separator = value.indexOf('=');
  if (separator <= 0) {
    throw new AppError('VALIDATION_ERROR', `Invalid --match expression '${value}'`, {
      expected: 'field=value',
    });
  }
  const field = value.slice(0, separator);
  return { field, value: value.slice(separator + 1) };
}

function parseJsonOption(value: string, name: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new AppError('VALIDATION_ERROR', `${name} must be valid JSON`);
  }
}

function outputMode(options: GlobalOptions): OutputContext {
  if (options.json && options.text) {
    throw new AppError('VALIDATION_ERROR', 'Use only one of --json or --text');
  }
  return {
    json: options.json === true || (options.text !== true && process.stdout.isTTY !== true),
    quiet: options.quiet === true,
  };
}

function writeSuccess(data: unknown, database: string | undefined, options: GlobalOptions): void {
  const mode = outputMode(options);
  if (mode.quiet) return;
  if (mode.json) {
    process.stdout.write(`${JSON.stringify(successEnvelope(data, CLI_VERSION, database))}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  }
}

function readValues(options: CreateOptions): Record<string, unknown> {
  const modes = [
    options.values !== undefined,
    options.valuesFile !== undefined,
    options.set.length > 0,
  ];
  if (modes.filter(Boolean).length !== 1) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Provide exactly one of --values, --values-file, or one or more --set options',
    );
  }

  if (options.set.length > 0) {
    const values: Record<string, unknown> = {};
    for (const assignment of options.set) {
      const separator = assignment.indexOf('=');
      if (separator <= 0) {
        throw new AppError('VALIDATION_ERROR', `Invalid --set assignment '${assignment}'`, {
          expected: 'field=value',
        });
      }
      values[assignment.slice(0, separator)] = assignment.slice(separator + 1);
    }
    return values;
  }

  let input: string;
  try {
    if (options.values !== undefined) {
      input = options.values;
    } else {
      const valuesFile = options.valuesFile as string;
      if (valuesFile !== '-' && fs.statSync(valuesFile).size > MAX_VALUES_BYTES) {
        throw new AppError('VALIDATION_ERROR', 'Record input exceeds the 1 MiB limit');
      }
      input = readBoundedBytes(valuesFile === '-' ? 0 : valuesFile, MAX_VALUES_BYTES, () => {
        throw new AppError('VALIDATION_ERROR', 'Record input exceeds the 1 MiB limit');
      }).toString('utf8');
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('VALIDATION_ERROR', 'Could not read the record values file', {
      file: options.valuesFile,
    });
  }

  if (Buffer.byteLength(input, 'utf8') > MAX_VALUES_BYTES) {
    throw new AppError('VALIDATION_ERROR', 'Record input exceeds the 1 MiB limit');
  }

  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Record values must be a valid JSON object');
  }
}

function readFilter(options: ListCommandOptions): unknown {
  if (options.filter !== undefined && options.filterFile !== undefined) {
    throw new AppError('VALIDATION_ERROR', 'Use only one of --filter or --filter-file');
  }
  if (options.filter === undefined && options.filterFile === undefined) return undefined;

  let input: string;
  try {
    if (options.filter !== undefined) {
      input = options.filter;
    } else {
      const filterFile = options.filterFile as string;
      if (filterFile !== '-' && fs.statSync(filterFile).size > MAX_FILTER_BYTES) {
        throw new AppError('VALIDATION_ERROR', 'Filter input exceeds the 256 KiB limit');
      }
      input = readBoundedBytes(filterFile === '-' ? 0 : filterFile, MAX_FILTER_BYTES, () => {
        throw new AppError('VALIDATION_ERROR', 'Filter input exceeds the 256 KiB limit');
      }).toString('utf8');
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('VALIDATION_ERROR', 'Could not read the filter file', {
      file: options.filterFile,
    });
  }

  if (Buffer.byteLength(input, 'utf8') > MAX_FILTER_BYTES) {
    throw new AppError('VALIDATION_ERROR', 'Filter input exceeds the 256 KiB limit');
  }
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Filter must be valid JSON');
  }
}

function withDatabase<T>(databasePath: string, operation: (database: DatabaseSync) => T): T {
  const database = openDatabase(databasePath);
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

function withReadOnlyDatabase<T>(
  databasePath: string,
  operation: (database: DatabaseSync) => T,
): T {
  const database = openReadOnlyDatabase(databasePath);
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

function askYesNo(question: string, defaultValue: boolean): Promise<boolean> {
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  const suffix = defaultValue ? ' [Y/n] ' : ' [y/N] ';
  return readline
    .question(`${question}${suffix}`)
    .then((answer) => {
      const normalized = answer.trim().toLowerCase();
      if (normalized === '') return defaultValue;
      return normalized === 'y' || normalized === 'yes';
    })
    .finally(() => readline.close());
}

function selectedInteractiveHosts(
  available: Array<{ key: string; displayName: string; destination: string }>,
): Promise<string[]> {
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  const defaults = available.map((host) => host.key).join(', ');
  return readline
    .question(`Hosts to enable [${defaults}; enter to keep, none to skip]: `)
    .then((answer) => {
      const normalized = answer.trim();
      if (normalized === '') return available.map((host) => host.key);
      if (normalized.toLowerCase() === 'none') return [];
      const selected = normalized
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      const allowed = new Set(available.map((host) => host.key));
      const invalid = selected.filter((key) => !allowed.has(key));
      if (invalid.length > 0) {
        throw new AppError(
          'VALIDATION_ERROR',
          `Unknown detected host selection: ${invalid.join(', ')}`,
          {
            allowedHosts: available.map((host) => host.key),
          },
        );
      }
      return [...new Set(selected)];
    })
    .finally(() => readline.close());
}

async function runInteractiveSetup(globals: GlobalOptions): Promise<void> {
  if (
    globals.json === true ||
    process.stdin.isTTY !== true ||
    process.stdout.isTTY !== true ||
    process.stderr.isTTY !== true
  ) {
    throw new AppError(
      'SETUP_INTERACTIVE_TTY_REQUIRED',
      'Interactive setup requires a terminal; use `agentcrm setup plan --json` and `agentcrm setup apply` instead',
    );
  }
  const plan = createSetupPlan(globals.db === undefined ? {} : { databaseOverride: globals.db });
  if (plan.database.state !== 'absent' && plan.database.state !== 'agentcrm-ready') {
    throw new AppError(
      'SETUP_DATABASE_CONFLICT',
      plan.database.hint ?? 'The selected database cannot be initialized safely',
      {
        database: plan.database.path,
        state: plan.database.state,
      },
    );
  }

  process.stdout.write(
    `Agent CRM stores relationship data locally in SQLite.\nDatabase: ${plan.database.path}\n${plan.database.privacyNotice}\n`,
  );
  const initialize =
    plan.database.state === 'absent'
      ? await askYesNo('Create your primary local CRM?', false)
      : false;
  if (plan.database.state === 'absent' && !initialize) {
    process.stdout.write('Setup cancelled. No files were changed.\n');
    return;
  }

  const available = plan.hosts.filter(
    (host) => host.detection === 'detected' && host.support === 'verified',
  );
  if (available.length === 0) {
    process.stdout.write('No verified agent host was detected.\n');
  } else {
    process.stdout.write('\nDetected agent hosts:\n');
    for (const host of available) {
      process.stdout.write(`  - ${host.displayName} (${host.key}): ${host.destination}\n`);
      if (host.sharedGatewayWarning)
        process.stdout.write(`    Warning: ${host.sharedGatewayWarning}\n`);
    }
  }
  const agents = available.length === 0 ? [] : await selectedInteractiveHosts(available);
  const selected = available.filter((host) => agents.includes(host.key));
  if (!initialize && selected.length === 0) {
    process.stdout.write('No setup actions were selected. No files were changed.\n');
    return;
  }

  process.stdout.write('\nSetup will:\n');
  process.stdout.write(
    initialize
      ? `  - Create the CRM database at ${plan.database.path}\n`
      : `  - Keep the existing CRM database at ${plan.database.path}\n`,
  );
  for (const host of selected) {
    process.stdout.write(`  - Install the Skill for ${host.displayName} at ${host.destination}\n`);
  }
  if (selected.length === 0) process.stdout.write('  - Install no Agent Skills\n');
  if (!(await askYesNo('Apply these actions?', false))) {
    process.stdout.write('Setup cancelled. No files were changed.\n');
    return;
  }

  const result = applySetup({
    ...(globals.db === undefined ? {} : { databaseOverride: globals.db }),
    initialize,
    agents,
    noSkill: agents.length === 0,
    yes: true,
  });
  if (result.database.action === 'initialized') process.stdout.write('Created the CRM database.\n');
  for (const installation of result.skillInstallations) {
    process.stdout.write(
      `${installation.changed ? 'Installed' : 'Kept'} the Skill for ${installation.hosts.join(', ')}.\n`,
    );
  }
  if (result.nextSteps.length > 0) {
    process.stdout.write('\nNext steps:\n');
    for (const nextStep of result.nextSteps) {
      process.stdout.write(`  - ${nextStep.action}\n`);
    }
  }
  process.stdout.write('Run `agentcrm doctor` to inspect the CRM database.\n');
}

function mutationOptions(globals: GlobalOptions) {
  return {
    actor: resolveActor(globals.actor),
    ...(globals.source === undefined ? {} : { source: globals.source }),
    ...(globals.idempotencyKey === undefined ? {} : { idempotencyKey: globals.idempotencyKey }),
    cliVersion: CLI_VERSION,
  };
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('agentcrm')
    .description('Local, schema-aware relationship memory for AI agents')
    .version(CLI_VERSION)
    .option('--db <path>', 'override the database path')
    .option('--json', 'force JSON output')
    .option('--text', 'force human-readable output')
    .option('--actor <name>', 'override the audit actor')
    .option('--source <description>', 'attach provenance to a mutation')
    .option('--idempotency-key <key>', 'safely retry a mutation')
    .option('--quiet', 'suppress result output')
    .showHelpAfterError()
    .exitOverride();

  program
    .command('version')
    .description('print the CLI version')
    .action(() => {
      writeSuccess({ version: CLI_VERSION }, undefined, program.opts<GlobalOptions>());
    });

  program
    .command('init')
    .description('initialize or upgrade the local database')
    .action(() => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const initialization = initializeDatabase(databasePath);
      const objects = withDatabase(databasePath, (database) =>
        describeSchema(database).map((object) => ({
          key: object.key,
          label: object.label,
          schemaVersion: object.schemaVersion,
        })),
      );
      writeSuccess({ ...initialization, objects }, databasePath, globals);
    });

  const setup = program
    .command('setup')
    .description('plan and apply local database and Agent Skill setup')
    .action(async () => {
      await runInteractiveSetup(program.opts<GlobalOptions>());
    });
  setup
    .command('plan')
    .description('inspect database and host setup targets')
    .action(() => {
      const globals = program.opts<GlobalOptions>();
      const plan = createSetupPlan(
        globals.db === undefined ? {} : { databaseOverride: globals.db },
      );
      writeSuccess(plan, undefined, globals);
    });
  setup
    .command('apply')
    .description('apply explicitly selected setup actions without prompting')
    .option('--initialize', 'initialize or upgrade the selected database', false)
    .option('--agent <host>', 'install the Skill for a host (repeatable)', collect, [])
    .option('--all-detected', 'install Skills for all detected verified hosts', false)
    .option('--no-skill', 'perform database initialization only')
    .option('--force-skill', 'replace a selected locally modified Skill', false)
    .option('--yes', 'confirm the explicitly selected actions', false)
    .action((commandOptions: SetupApplyCommandOptions) => {
      const globals = program.opts<GlobalOptions>();
      const result = applySetup({
        ...(globals.db === undefined ? {} : { databaseOverride: globals.db }),
        initialize: commandOptions.initialize,
        agents: commandOptions.agent,
        allDetected: commandOptions.allDetected,
        noSkill: commandOptions.skill === false,
        forceSkill: commandOptions.forceSkill,
        yes: commandOptions.yes,
      });
      writeSuccess(result, resolveDatabasePath(globals.db), globals);
    });

  program
    .command('doctor')
    .description('inspect database health without modifying data')
    .action(() => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const result = withReadOnlyDatabase(databasePath, (database) =>
        diagnoseDatabase(database, databasePath),
      );
      writeSuccess(result, databasePath, globals);
    });

  const schema = program.command('schema').description('inspect and mutate the logical schema');
  schema
    .command('show [object]')
    .description('show objects and their field definitions')
    .action((objectKey?: string) => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const objects = withDatabase(databasePath, (database) => describeSchema(database, objectKey));
      writeSuccess({ objects }, databasePath, globals);
    });

  const schemaObject = schema.command('object').description('manage object definitions');
  schemaObject
    .command('add <key>')
    .description('create an object and its required text title field')
    .requiredOption('--label <label>', 'singular object label')
    .requiredOption('--plural-label <label>', 'plural object label')
    .option('--description <description>', 'object description')
    .requiredOption('--title-field <key>', 'title field key')
    .requiredOption('--title-field-label <label>', 'title field label')
    .action((key: string, commandOptions: AddObjectCommandOptions) => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const result = withDatabase(databasePath, (database) =>
        addObject(
          database,
          {
            key,
            label: commandOptions.label,
            pluralLabel: commandOptions.pluralLabel,
            ...(commandOptions.description === undefined
              ? {}
              : { description: commandOptions.description }),
            titleFieldKey: commandOptions.titleField,
            titleFieldLabel: commandOptions.titleFieldLabel,
          },
          mutationOptions(globals),
        ),
      );
      writeSuccess(result, databasePath, globals);
    });

  schemaObject
    .command('archive <object>')
    .description('archive an object that has no active or archived records')
    .action((objectKey: string) => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const result = withDatabase(databasePath, (database) =>
        archiveObject(database, objectKey, mutationOptions(globals)),
      );
      writeSuccess(result, databasePath, globals);
    });
  schemaObject
    .command('restore <object>')
    .description('restore an archived empty object')
    .action((objectKey: string) => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const result = withDatabase(databasePath, (database) =>
        restoreObject(database, objectKey, mutationOptions(globals)),
      );
      writeSuccess(result, databasePath, globals);
    });

  const schemaField = schema.command('field').description('manage field definitions');
  schemaField
    .command('add <object> <key>')
    .description('add a validated field to an object')
    .requiredOption('--label <label>', 'field label')
    .option('--description <description>', 'field description')
    .addOption(
      new Option('--type <type>', 'field type')
        .choices(['text', 'number', 'boolean', 'date', 'datetime', 'enum', 'multi_select', 'json'])
        .makeOptionMandatory(),
    )
    .addOption(
      new Option('--format <format>', 'optional field format').choices([
        'email',
        'phone',
        'url',
        'currency',
        'percentage',
      ]),
    )
    .option('--required', 'make the field required', false)
    .option('--options <json>', 'enum or multi-select options as a JSON array')
    .option('--default <json>', 'default value as JSON')
    .action((objectKey: string, key: string, commandOptions: AddFieldCommandOptions) => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const parsedOptions =
        commandOptions.options === undefined
          ? undefined
          : parseJsonOption(commandOptions.options, 'Field options');
      if (parsedOptions !== undefined && !Array.isArray(parsedOptions)) {
        throw new AppError('VALIDATION_ERROR', 'Field options must be a JSON array');
      }
      const result = withDatabase(databasePath, (database) =>
        addField(
          database,
          {
            objectKey,
            key,
            label: commandOptions.label,
            ...(commandOptions.description === undefined
              ? {}
              : { description: commandOptions.description }),
            type: commandOptions.type,
            ...(commandOptions.format === undefined ? {} : { format: commandOptions.format }),
            required: commandOptions.required,
            ...(parsedOptions === undefined ? {} : { options: parsedOptions as string[] }),
            ...(commandOptions.default === undefined
              ? {}
              : { defaultValue: parseJsonOption(commandOptions.default, 'Field default') }),
          },
          mutationOptions(globals),
        ),
      );
      writeSuccess(result, databasePath, globals);
    });
  schemaField
    .command('archive <object> <field>')
    .description('archive a non-title field while preserving stored values')
    .action((objectKey: string, fieldKey: string) => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const result = withDatabase(databasePath, (database) =>
        archiveField(database, objectKey, fieldKey, mutationOptions(globals)),
      );
      writeSuccess(result, databasePath, globals);
    });
  schemaField
    .command('restore <object> <field>')
    .description('validate active records and restore an archived field')
    .action((objectKey: string, fieldKey: string) => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const result = withDatabase(databasePath, (database) =>
        restoreField(database, objectKey, fieldKey, mutationOptions(globals)),
      );
      writeSuccess(result, databasePath, globals);
    });

  const record = program.command('record').description('create and inspect records');
  record
    .command('create <object>')
    .description('create a validated record')
    .addOption(new Option('--values <json>', 'record values as a JSON object'))
    .addOption(
      new Option('--values-file <path>', "read record values from a file or '-' for stdin"),
    )
    .option('--set <field=value>', 'set a text field', collect, [])
    .action((objectKey: string, commandOptions: CreateOptions) => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const values = readValues(commandOptions);
      const result = withDatabase(databasePath, (database) =>
        createRecord(database, objectKey, values, mutationOptions(globals)),
      );
      writeSuccess(result, databasePath, globals);
    });

  record
    .command('upsert <object>')
    .description('create or update by one exact active scalar field')
    .requiredOption('--match <field=value>', 'one exact field match')
    .addOption(new Option('--values <json>', 'record values as a JSON object'))
    .addOption(
      new Option('--values-file <path>', "read record values from a file or '-' for stdin"),
    )
    .option('--set <field=value>', 'set a text field', collect, [])
    .action((objectKey: string, commandOptions: UpsertCommandOptions) => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const match = parseMatchOption(commandOptions.match);
      const values = readValues(commandOptions);
      const result = withDatabase(databasePath, (database) =>
        upsertRecord(
          database,
          objectKey,
          match.field,
          match.value,
          values,
          mutationOptions(globals),
        ),
      );
      writeSuccess(result, databasePath, globals);
    });

  record
    .command('update <record-id>')
    .description('partially update a validated record')
    .addOption(new Option('--values <json>', 'updated values as a JSON object'))
    .addOption(
      new Option('--values-file <path>', "read updated values from a file or '-' for stdin"),
    )
    .option('--set <field=value>', 'set a text field', collect, [])
    .action((recordId: string, commandOptions: CreateOptions) => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const values = readValues(commandOptions);
      const result = withDatabase(databasePath, (database) =>
        updateRecord(database, recordId, values, mutationOptions(globals)),
      );
      writeSuccess(result, databasePath, globals);
    });

  record
    .command('archive <record-id>')
    .description('archive a record without deleting its data or relationships')
    .action((recordId: string) => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const result = withDatabase(databasePath, (database) =>
        archiveRecord(database, recordId, mutationOptions(globals)),
      );
      writeSuccess(result, databasePath, globals);
    });

  record
    .command('restore <record-id>')
    .description('validate and restore an archived record')
    .action((recordId: string) => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const result = withDatabase(databasePath, (database) =>
        restoreRecord(database, recordId, mutationOptions(globals)),
      );
      writeSuccess(result, databasePath, globals);
    });

  record
    .command('list <object>')
    .description('list records with a safe structured filter')
    .option('--filter <json>', 'filter AST as JSON')
    .option('--filter-file <path>', "read the filter AST from a file or '-' for stdin")
    .option('--sort <field:direction>', 'sort by an active scalar field')
    .option('--limit <number>', 'maximum records', integerOption(1, 500), 50)
    .option('--offset <number>', 'records to skip', integerOption(0, 1_000_000), 0)
    .option('--include-archived', 'include archived records', false)
    .action((objectKey: string, commandOptions: ListCommandOptions) => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const filter = readFilter(commandOptions);
      const result = withDatabase(databasePath, (database) =>
        listRecords(database, objectKey, {
          ...(filter === undefined ? {} : { filter }),
          ...(commandOptions.sort === undefined ? {} : { sort: commandOptions.sort }),
          limit: commandOptions.limit,
          offset: commandOptions.offset,
          includeArchived: commandOptions.includeArchived,
        }),
      );
      writeSuccess(result, databasePath, globals);
    });

  record
    .command('get <record-id>')
    .description('get a record by UUID or an unambiguous prefix')
    .action((recordId: string) => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const result = withDatabase(databasePath, (database) => getRecord(database, recordId));
      writeSuccess(result, databasePath, globals);
    });

  const relationship = program.command('relationship').description('manage links between records');
  relationship
    .command('add <source-record-id> <type> <target-record-id>')
    .description('create a directed relationship')
    .action((sourceId: string, type: string, targetId: string) => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const result = withDatabase(databasePath, (database) =>
        addRelationship(database, sourceId, type, targetId, mutationOptions(globals)),
      );
      writeSuccess(result, databasePath, globals);
    });

  relationship
    .command('list <record-id>')
    .description('list incoming and outgoing relationships')
    .option('--include-archived', 'include archived links and archived endpoints', false)
    .action((recordId: string, commandOptions: { includeArchived: boolean }) => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const relationships = withDatabase(databasePath, (database) =>
        listRelationships(database, recordId, {
          includeArchived: commandOptions.includeArchived,
        }),
      );
      writeSuccess({ relationships }, databasePath, globals);
    });
  relationship
    .command('archive <relationship-id>')
    .description('archive a relationship without deleting it')
    .action((relationshipId: string) => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const result = withDatabase(databasePath, (database) =>
        archiveRelationship(database, relationshipId, mutationOptions(globals)),
      );
      writeSuccess(result, databasePath, globals);
    });
  relationship
    .command('restore <relationship-id>')
    .description('restore a relationship when both endpoints are active')
    .action((relationshipId: string) => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const result = withDatabase(databasePath, (database) =>
        restoreRelationship(database, relationshipId, mutationOptions(globals)),
      );
      writeSuccess(result, databasePath, globals);
    });

  program
    .command('export')
    .description('write a complete, versioned logical JSON export')
    .requiredOption('--output <path>', 'output JSON file')
    .option('--without-history', 'omit immutable event history', false)
    .option('--force', 'replace an existing regular output file', false)
    .action((commandOptions: ExportCommandOptions) => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const output = path.resolve(commandOptions.output);
      if (output === databasePath) {
        throw new AppError('VALIDATION_ERROR', 'Export output cannot be the CRM database file');
      }
      const document = withReadOnlyDatabase(databasePath, (database) =>
        createExport(database, { withoutHistory: commandOptions.withoutHistory }),
      );
      const written = writeExportFile(output, document, commandOptions.force);
      writeSuccess(
        {
          ...written,
          formatVersion: document.formatVersion,
          exportedAt: document.exportedAt,
          historyIncluded: document.historyIncluded,
          counts: {
            objects: document.data.objects.length,
            fields: document.data.objects.reduce(
              (count, object) => count + object.fields.length,
              0,
            ),
            records: document.data.records.length,
            relationships: document.data.relationships.length,
            events: document.data.events.length,
          },
        },
        databasePath,
        globals,
      );
    });

  program
    .command('import <input>')
    .description('validate and transactionally restore a native Agent CRM export')
    .option('--dry-run', 'validate without opening a write transaction', false)
    .action((input: string, commandOptions: ImportCommandOptions) => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const document = readExportFile(input);
      const result = commandOptions.dryRun
        ? withReadOnlyDatabase(databasePath, (database) => dryRunImport(database, document))
        : withDatabase(databasePath, (database) =>
            importDocument(database, document, mutationOptions(globals)),
          );
      writeSuccess(result, databasePath, globals);
    });

  const csv = program.command('csv').description('import explicitly mapped CSV data');
  csv
    .command('import <input>')
    .description('validate and atomically create or upsert records from CSV')
    .requiredOption('--object <key>', 'target CRM object')
    .requiredOption('--map <header=field>', 'map a CSV header to a CRM field', collect, [])
    .option('--match <field>', 'mapped scalar field used for exact upsert matching')
    .option('--multi-value-separator <separator>', 'multi-select cell separator', ';')
    .option('--dry-run', 'execute validation and roll back every change', false)
    .action((input: string, commandOptions: CsvImportCommandOptions) => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const content = readCsvInput(input);
      const mapping = commandOptions.map.map(parseCsvMapping);
      const result = withDatabase(databasePath, (database) =>
        importCsv(database, content, commandOptions.object, mapping, {
          ...mutationOptions(globals),
          ...(commandOptions.match === undefined ? {} : { matchField: commandOptions.match }),
          dryRun: commandOptions.dryRun,
          multiValueSeparator: commandOptions.multiValueSeparator,
        }),
      );
      writeSuccess(result, databasePath, globals);
    });

  program
    .command('search <query>')
    .description('search active record values with SQLite FTS5')
    .option('--object <key>', 'restrict search to one object')
    .option('--limit <number>', 'maximum results', integerOption(1, 500), 20)
    .option('--offset <number>', 'results to skip', integerOption(0, 1_000_000), 0)
    .action((query: string, commandOptions: { object?: string; limit: number; offset: number }) => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const result = withDatabase(databasePath, (database) =>
        searchRecords(database, query, {
          ...(commandOptions.object === undefined ? {} : { object: commandOptions.object }),
          limit: commandOptions.limit,
          offset: commandOptions.offset,
        }),
      );
      writeSuccess(result, databasePath, globals);
    });

  const history = program
    .command('history')
    .description('inspect immutable record history')
    .argument('[subject-id]', 'record ID or unambiguous prefix')
    .option('--limit <number>', 'maximum events', integerOption(1, 500), 50)
    .action((subjectId: string | undefined, commandOptions: { limit: number }) => {
      if (subjectId === undefined) {
        throw new AppError(
          'VALIDATION_ERROR',
          'History requires a subject ID or the event subcommand',
        );
      }
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const events = withDatabase(databasePath, (database) =>
        getHistory(database, subjectId, commandOptions.limit),
      );
      writeSuccess({ events }, databasePath, globals);
    });
  history
    .command('event <event-id>')
    .description('show a full immutable event')
    .action((eventId: string) => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const event = withDatabase(databasePath, (database) => getEvent(database, eventId));
      writeSuccess(event, databasePath, globals);
    });

  const integration = program
    .command('integration')
    .description('manage optional agent integrations');
  integration
    .command('install-skill')
    .description('install the bundled Agent Skill')
    .option('--destination <skills-root>', 'skills root directory')
    .option('--force', 'replace a different or locally modified skill', false)
    .action((commandOptions: SkillCommandOptions) => {
      const globals = program.opts<GlobalOptions>();
      const result = installSkill({
        ...(commandOptions.destination === undefined
          ? {}
          : { destination: commandOptions.destination }),
        force: commandOptions.force,
      });
      writeSuccess(result, undefined, globals);
    });
  integration
    .command('uninstall-skill')
    .description('safely remove the managed Agent Skill without touching CRM data')
    .option('--destination <skills-root>', 'skills root directory')
    .option('--force', 'remove a locally modified installed skill', false)
    .action((commandOptions: SkillCommandOptions) => {
      const globals = program.opts<GlobalOptions>();
      const result = uninstallSkill({
        ...(commandOptions.destination === undefined
          ? {}
          : { destination: commandOptions.destination }),
        force: commandOptions.force,
      });
      writeSuccess(result, undefined, globals);
    });

  program
    .command('context <record-id>')
    .description('assemble bounded relationship context for a record')
    .option('--max-related <number>', 'maximum related records', integerOption(0, 500), 20)
    .option('--max-interactions <number>', 'maximum interactions', integerOption(0, 500), 20)
    .option('--max-followups <number>', 'maximum follow-ups', integerOption(0, 500), 20)
    .option(
      '--max-chars <number>',
      'approximate JSON character budget',
      integerOption(1000, 1000000),
      12000,
    )
    .action((recordId: string, commandOptions: ContextCommandOptions) => {
      const globals = program.opts<GlobalOptions>();
      const databasePath = resolveDatabasePath(globals.db);
      const result = withDatabase(databasePath, (database) =>
        getContext(database, recordId, commandOptions),
      );
      writeSuccess(result, databasePath, globals);
    });

  return program;
}

function requestedJson(argv: string[]): boolean {
  if (argv.includes('--text')) return false;
  return argv.includes('--json') || process.stdout.isTTY !== true;
}

export async function runCli(argv: string[]): Promise<number> {
  const program = buildProgram();
  let commanderError = '';
  program.configureOutput({
    writeOut: (text) => process.stdout.write(text),
    writeErr: (text) => {
      commanderError += text;
    },
  });

  if (argv.length === 0) {
    program.outputHelp();
    return 0;
  }

  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    const appError =
      error instanceof CommanderError
        ? new AppError('VALIDATION_ERROR', error.message, {
            ...(commanderError ? { usage: commanderError.trim() } : {}),
          })
        : toAppError(error);

    if (requestedJson(argv)) {
      process.stdout.write(`${JSON.stringify(errorEnvelope(appError))}\n`);
    } else {
      process.stderr.write(`Error [${appError.code}]: ${appError.message}\n`);
      if (commanderError) process.stderr.write(commanderError);
    }
    return appError.exitCode;
  }
}
