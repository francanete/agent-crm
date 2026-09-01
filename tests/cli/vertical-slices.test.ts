import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const cliPath = path.resolve('dist/cli.js');

function run(database: string, args: string[], input?: string): Record<string, unknown> {
  const stdout = execFileSync(process.execPath, [cliPath, '--db', database, ...args, '--json'], {
    encoding: 'utf8',
    input,
  });
  expect(stdout.trim().split('\n')).toHaveLength(1);
  return JSON.parse(stdout) as Record<string, unknown>;
}

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { stdio: 'pipe' });
});

describe('compiled vertical-slice CLI', () => {
  it('completes diagnostics, Slice A, and Slice B with JSON-only stdout', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-cli-'));
    const database = path.join(directory, 'path with spaces', 'crm.db');

    try {
      const initialized = run(database, ['init']);
      expect(initialized).toMatchObject({ ok: true, data: { created: true } });

      const doctor = run(database, ['doctor']);
      expect(doctor).toMatchObject({ ok: true, data: { healthy: true } });

      const schema = run(database, ['schema', 'show', 'person']);
      expect(schema).toMatchObject({ ok: true });
      expect((schema.data as { objects: unknown[] }).objects).toHaveLength(1);

      const created = run(
        database,
        ['record', 'create', 'person', '--values-file', '-'],
        '{"name":"Ana","email":"ana@example.com"}',
      );
      const id = (created.data as { id: string }).id;
      const fetched = run(database, ['record', 'get', id.slice(0, 8)]);
      expect(fetched).toMatchObject({
        ok: true,
        data: { id, object: 'person', displayName: 'Ana' },
      });

      const organization = run(database, [
        'record',
        'create',
        'organization',
        '--values',
        '{"name":"Acme"}',
      ]);
      const organizationId = (organization.data as { id: string }).id;
      const linked = run(database, ['relationship', 'add', id, 'works_at', organizationId]);
      expect(linked).toMatchObject({ ok: true, data: { type: 'works_at' } });

      const relationships = run(database, ['relationship', 'list', id]);
      expect((relationships.data as { relationships: unknown[] }).relationships).toHaveLength(1);

      const context = run(database, ['context', id]);
      expect(context).toMatchObject({
        ok: true,
        data: {
          record: { id },
          relatedRecords: [expect.objectContaining({ id: organizationId })],
        },
      });

      const field = run(database, [
        'schema',
        'field',
        'add',
        'person',
        'priority',
        '--label',
        'Priority',
        '--type',
        'enum',
        '--options',
        '["high","normal","low"]',
      ]);
      expect(field).toMatchObject({ ok: true, data: { key: 'priority' } });
      run(database, ['record', 'update', id, '--values', '{"role":"CTO","priority":"high"}']);
      const search = run(database, ['search', 'CTO', '--object', 'person']);
      expect(search).toMatchObject({
        ok: true,
        data: { results: [expect.objectContaining({ id, displayName: 'Ana' })] },
      });
      const history = run(database, ['history', id]);
      const events = (history.data as { events: Array<{ id: string; action: string }> }).events;
      expect(events.map((event) => event.action)).toEqual(['updated', 'created']);
      const event = run(database, ['history', 'event', events[0]?.id as string]);
      expect(event).toMatchObject({ ok: true, data: { action: 'updated', subjectId: id } });

      const project = run(database, [
        'schema',
        'object',
        'add',
        'project',
        '--label',
        'Project',
        '--plural-label',
        'Projects',
        '--title-field',
        'name',
        '--title-field-label',
        'Name',
      ]);
      expect(project).toMatchObject({ ok: true, data: { key: 'project' } });
      const projectRecord = run(database, [
        'record',
        'create',
        'project',
        '--values',
        '{"name":"Agent CRM"}',
      ]);
      expect(projectRecord).toMatchObject({ ok: true, data: { object: 'project' } });

      run(database, [
        'record',
        'create',
        'followup',
        '--values',
        '{"title":"Send proposal","due_at":"2026-09-05T12:00:00Z"}',
      ]);
      run(database, [
        'record',
        'create',
        'followup',
        '--values',
        '{"title":"Later","due_at":"2026-09-15T12:00:00Z"}',
      ]);
      const due = run(
        database,
        ['record', 'list', 'followup', '--filter-file', '-', '--sort', 'due_at:asc'],
        JSON.stringify({
          all: [
            { field: 'status', op: 'eq', value: 'open' },
            { field: 'due_at', op: 'lte', value: '2026-09-06T23:59:59Z' },
          ],
        }),
      );
      expect(due).toMatchObject({
        ok: true,
        data: {
          records: [expect.objectContaining({ displayName: 'Send proposal' })],
          pagination: { count: 1, hasMore: false },
        },
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('creates, updates, and safely replays exact-field upserts', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-upsert-cli-'));
    const database = path.join(directory, 'crm.db');
    const request = [
      '--idempotency-key',
      'cli-upsert-ana',
      'record',
      'upsert',
      'person',
      '--match',
      'email=ana@example.com',
      '--values',
      '{"name":"Ana","role":"Founder"}',
    ];

    try {
      run(database, ['init']);
      const created = run(database, request);
      const personId = (created.data as { id: string }).id;
      expect(created).toMatchObject({
        ok: true,
        data: {
          id: personId,
          outcome: 'created',
          replayed: false,
          values: { email: 'ana@example.com' },
        },
      });
      expect(run(database, request)).toMatchObject({
        data: { id: personId, outcome: 'created', replayed: true },
      });
      expect(
        run(database, [
          'record',
          'upsert',
          'person',
          '--match',
          'email=ana@example.com',
          '--values',
          '{"role":"CEO"}',
        ]),
      ).toMatchObject({
        data: { id: personId, outcome: 'updated', values: { name: 'Ana', role: 'CEO' } },
      });
      run(database, [
        'schema',
        'field',
        'add',
        'person',
        'score',
        '--label',
        'Score',
        '--type',
        'number',
      ]);
      expect(
        run(database, [
          'record',
          'upsert',
          'person',
          '--match',
          'score=42',
          '--values',
          '{"name":"Numeric Match"}',
        ]),
      ).toMatchObject({ data: { outcome: 'created', values: { score: 42 } } });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('archives and restores records, relationships, fields, and empty objects', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-lifecycle-cli-'));
    const database = path.join(directory, 'crm.db');

    try {
      run(database, ['init']);
      const person = run(database, [
        'record',
        'create',
        'person',
        '--values',
        '{"name":"Ana","notes":"CLI lifecycle phrase"}',
      ]);
      const personId = (person.data as { id: string }).id;
      const organization = run(database, [
        'record',
        'create',
        'organization',
        '--values',
        '{"name":"Acme"}',
      ]);
      const organizationId = (organization.data as { id: string }).id;
      const relationship = run(database, [
        'relationship',
        'add',
        personId,
        'works_at',
        organizationId,
      ]);
      const relationshipId = (relationship.data as { id: string }).id;

      expect(run(database, ['record', 'archive', personId])).toMatchObject({
        data: { id: personId, archivedAt: expect.any(String) },
      });
      expect(run(database, ['record', 'list', 'person'])).toMatchObject({
        data: { records: [] },
      });
      expect(run(database, ['record', 'list', 'person', '--include-archived'])).toMatchObject({
        data: { records: [expect.objectContaining({ id: personId })] },
      });
      expect(run(database, ['relationship', 'list', personId, '--include-archived'])).toMatchObject(
        {
          data: { relationships: [expect.objectContaining({ id: relationshipId })] },
        },
      );
      expect(run(database, ['record', 'restore', personId])).toMatchObject({
        data: { id: personId, archivedAt: null },
      });

      run(database, ['relationship', 'archive', relationshipId]);
      expect(run(database, ['relationship', 'list', personId])).toMatchObject({
        data: { relationships: [] },
      });
      expect(run(database, ['relationship', 'restore', relationshipId])).toMatchObject({
        data: { id: relationshipId, archivedAt: null },
      });

      run(database, ['schema', 'field', 'archive', 'person', 'notes']);
      expect(run(database, ['search', 'CLI lifecycle'])).toMatchObject({
        data: { results: [] },
      });
      run(database, ['schema', 'field', 'restore', 'person', 'notes']);
      expect(run(database, ['search', 'CLI lifecycle'])).toMatchObject({
        data: { results: [expect.objectContaining({ id: personId })] },
      });

      run(database, [
        'schema',
        'object',
        'add',
        'project',
        '--label',
        'Project',
        '--plural-label',
        'Projects',
        '--title-field',
        'name',
        '--title-field-label',
        'Name',
      ]);
      expect(run(database, ['schema', 'object', 'archive', 'project'])).toMatchObject({
        data: { key: 'project', archivedAt: expect.any(String) },
      });
      expect(run(database, ['schema', 'object', 'restore', 'project'])).toMatchObject({
        data: { key: 'project', archivedAt: null },
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('dry-runs and atomically imports explicitly mapped CSV contacts', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-csv-cli-'));
    const database = path.join(directory, 'crm.db');
    const input = path.join(directory, 'contacts.csv');
    fs.writeFileSync(
      input,
      [
        'Full Name,Email,Role,Tags',
        'Ana,ana@example.com,Founder,customer;founder',
        'Bob,bob@example.com,Engineer,technical',
      ].join('\n'),
    );
    const csvArguments = [
      'csv',
      'import',
      input,
      '--object',
      'person',
      '--map',
      'Full Name=name',
      '--map',
      'Email=email',
      '--map',
      'Role=role',
      '--map',
      'Tags=tags',
      '--match',
      'email',
    ];

    try {
      run(database, ['init']);
      expect(run(database, [...csvArguments, '--dry-run'])).toMatchObject({
        data: { dryRun: true, valid: true, rows: { created: 2, failed: 0 } },
      });
      expect(run(database, ['record', 'list', 'person'])).toMatchObject({
        data: { records: [] },
      });
      expect(run(database, ['--idempotency-key', 'cli-csv-import', ...csvArguments])).toMatchObject(
        {
          data: { dryRun: false, valid: true, rows: { created: 2, replayed: 0 } },
        },
      );
      expect(run(database, ['record', 'list', 'person'])).toMatchObject({
        data: { records: [expect.any(Object), expect.any(Object)] },
      });
      expect(run(database, ['--idempotency-key', 'cli-csv-import', ...csvArguments])).toMatchObject(
        {
          data: { rows: { created: 2, replayed: 2 } },
        },
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('exports and transactionally imports a native backup through stable JSON contracts', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-export-cli-'));
    const sourceDatabase = path.join(directory, 'source.db');
    const targetDatabase = path.join(directory, 'target.db');
    const backup = path.join(directory, 'portable backup.json');

    try {
      run(sourceDatabase, ['init']);
      const person = run(sourceDatabase, [
        'record',
        'create',
        'person',
        '--values',
        '{"name":"Ana","notes":"Native portable backup"}',
      ]);
      const personId = (person.data as { id: string }).id;
      const exported = run(sourceDatabase, ['export', '--output', backup]);
      expect(exported).toMatchObject({
        ok: true,
        data: {
          output: path.resolve(backup),
          formatVersion: 1,
          historyIncluded: true,
          counts: { records: 1, events: 1 },
        },
      });

      run(targetDatabase, ['init']);
      expect(run(targetDatabase, ['import', backup, '--dry-run'])).toMatchObject({
        ok: true,
        data: { dryRun: true, imported: { records: 1, events: 1 } },
      });
      expect(run(targetDatabase, ['import', backup])).toMatchObject({
        ok: true,
        data: { dryRun: false, imported: { records: 1, events: 1 } },
      });
      expect(run(targetDatabase, ['record', 'get', personId])).toMatchObject({
        ok: true,
        data: { id: personId, displayName: 'Ana' },
      });
      expect(run(targetDatabase, ['search', 'Native portable'])).toMatchObject({
        data: { results: [expect.objectContaining({ id: personId })] },
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('completes the skill-guided natural-language memory scenario with safe retries', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-agent-scenario-'));
    const database = path.join(directory, 'crm.db');
    const mutate = (key: string, args: string[]) =>
      run(database, [
        '--actor',
        'pi',
        '--source',
        'skill scenario',
        '--idempotency-key',
        key,
        ...args,
      ]);

    try {
      run(database, ['init']);
      expect(run(database, ['search', 'Ana', '--object', 'person'])).toMatchObject({
        data: { results: [] },
      });

      const personRequest = ['record', 'create', 'person', '--values', '{"name":"Ana"}'];
      const person = mutate('scenario-person-ana', personRequest);
      const personReplay = mutate('scenario-person-ana', personRequest);
      const personId = (person.data as { id: string }).id;
      expect(personReplay).toMatchObject({ data: { id: personId, replayed: true } });

      const organization = mutate('scenario-org-acme', [
        'record',
        'create',
        'organization',
        '--values',
        '{"name":"Acme"}',
      ]);
      const organizationId = (organization.data as { id: string }).id;
      const employmentRequest = ['relationship', 'add', personId, 'works_at', organizationId];
      mutate('scenario-employment', employmentRequest);
      expect(mutate('scenario-employment', employmentRequest)).toMatchObject({
        data: { replayed: true },
      });

      const interaction = mutate('scenario-interaction', [
        'record',
        'create',
        'interaction',
        '--values',
        '{"summary":"Met Ana at Acme","kind":"meeting","occurred_at":"2026-09-01T14:00:00Z"}',
      ]);
      const interactionId = (interaction.data as { id: string }).id;
      mutate('scenario-interaction-link', [
        'relationship',
        'add',
        interactionId,
        'involves',
        personId,
      ]);

      const followup = mutate('scenario-followup', [
        'record',
        'create',
        'followup',
        '--values',
        '{"title":"Send Ana the proposal","due_at":"2026-09-05T17:00:00Z"}',
      ]);
      const followupId = (followup.data as { id: string }).id;
      mutate('scenario-followup-link', ['relationship', 'add', followupId, 'concerns', personId]);

      const context = run(database, ['context', personId]);
      expect(context).toMatchObject({
        ok: true,
        data: {
          record: { id: personId },
          recentInteractions: [expect.objectContaining({ id: interactionId })],
          openFollowups: [expect.objectContaining({ id: followupId })],
        },
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('installs and safely uninstalls the bundled skill without touching CRM data', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-skill-cli-'));
    const database = path.join(directory, 'crm.db');
    const skillsRoot = path.join(directory, 'agent skills');

    try {
      run(database, ['init']);
      const databaseBefore = fs.readFileSync(database);
      const installed = run(database, [
        'integration',
        'install-skill',
        '--destination',
        skillsRoot,
      ]);
      const skillPath = (installed.data as { path: string }).path;
      expect(installed).toMatchObject({
        ok: true,
        data: { action: 'installed', changed: true, forced: false },
      });
      expect(fs.readFileSync(skillPath, 'utf8')).toContain('name: agentcrm');
      expect(fs.readFileSync(database)).toEqual(databaseBefore);

      fs.appendFileSync(skillPath, '\nlocal customization\n');
      const protectedRemoval = spawnSync(
        process.execPath,
        [
          cliPath,
          '--db',
          database,
          'integration',
          'uninstall-skill',
          '--destination',
          skillsRoot,
          '--json',
        ],
        { encoding: 'utf8' },
      );
      expect(protectedRemoval.status).toBe(5);
      expect(JSON.parse(protectedRemoval.stdout)).toMatchObject({
        ok: false,
        error: { code: 'INTEGRATION_CONFLICT' },
      });
      expect(fs.existsSync(database)).toBe(true);
      run(database, ['integration', 'uninstall-skill', '--destination', skillsRoot, '--force']);
      expect(run(database, ['doctor'])).toMatchObject({ ok: true, data: { healthy: true } });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
