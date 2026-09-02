import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import packageMetadata from '../package.json' with { type: 'json' };

const expectedVersion = packageMetadata.version;
const npmCli = process.env.npm_execpath;

if (!npmCli) throw new Error('npm_execpath is required; run this smoke test through npm');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcrm-package-smoke-'));
const packageDirectory = path.join(temporaryRoot, 'package');
const installDirectory = path.join(temporaryRoot, 'install');
const dataDirectory = path.join(temporaryRoot, 'data with spaces');
const database = path.join(dataDirectory, 'crm.db');
const restoredDatabase = path.join(dataDirectory, 'restored.db');
const exportFile = path.join(temporaryRoot, 'backup.json');
const skillDestination = path.join(temporaryRoot, 'skills');
let cliPath = '';

function npm(args) {
  return execFileSync(process.execPath, [npmCli, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function installPackage(tarball) {
  npm([
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--prefix',
    installDirectory,
    tarball,
  ]);
  cliPath = path.join(installDirectory, 'node_modules', 'agent-crm', 'dist', 'cli.js');
  assert.ok(fs.existsSync(cliPath), 'the installed package must contain dist/cli.js');

  const binName = process.platform === 'win32' ? 'agentcrm.cmd' : 'agentcrm';
  assert.ok(
    fs.existsSync(path.join(installDirectory, 'node_modules', '.bin', binName)),
    `the installed package must expose ${binName}`,
  );
}

function runCli(args, input) {
  return execFileSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function crm(selectedDatabase, args, input) {
  const output = runCli(['--db', selectedDatabase, ...args, '--json'], input);
  const lines = output.trim().split(/\r?\n/);
  assert.equal(lines.length, 1, `expected JSON-only stdout, received: ${output}`);
  const envelope = JSON.parse(lines[0]);
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.equal(envelope.meta.cliVersion, expectedVersion);
  return envelope.data;
}

try {
  fs.mkdirSync(packageDirectory);
  fs.mkdirSync(installDirectory);

  npm(['pack', '--silent', '--pack-destination', packageDirectory]);
  const archives = fs.readdirSync(packageDirectory).filter((file) => file.endsWith('.tgz'));
  assert.deepEqual(archives, [`agent-crm-${expectedVersion}.tgz`]);
  const tarball = path.join(packageDirectory, archives[0]);

  installPackage(tarball);
  assert.equal(runCli(['--version']).trim(), expectedVersion);
  assert.match(runCli(['--help']), /Usage: agentcrm/);

  assert.equal(crm(database, ['init']).created, true);
  const person = crm(database, [
    'record',
    'create',
    'person',
    '--values',
    '{"name":"Package Ana","email":"package-ana@example.com"}',
  ]);
  const organization = crm(database, [
    'record',
    'create',
    'organization',
    '--values',
    '{"name":"Package Acme"}',
  ]);
  crm(database, ['relationship', 'add', person.id, 'works_at', organization.id]);

  const search = crm(database, ['search', 'Package Ana', '--object', 'person']);
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].id, person.id);

  const context = crm(database, ['context', person.id]);
  assert.equal(context.relatedRecords.length, 1);
  assert.equal(context.relatedRecords[0].id, organization.id);

  crm(database, ['export', '--output', exportFile]);
  assert.ok(fs.existsSync(exportFile));
  crm(restoredDatabase, ['init']);
  crm(restoredDatabase, ['import', exportFile]);
  const restoredSearch = crm(restoredDatabase, ['search', 'Package Ana', '--object', 'person']);
  assert.equal(restoredSearch.results[0].id, person.id);

  const skillInstall = JSON.parse(
    runCli(['integration', 'install-skill', '--destination', skillDestination, '--json']),
  );
  assert.equal(skillInstall.ok, true);
  const skillPath = path.join(skillDestination, 'agentcrm', 'SKILL.md');
  assert.ok(fs.existsSync(skillPath));
  const repeatedSkillInstall = JSON.parse(
    runCli(['integration', 'install-skill', '--destination', skillDestination, '--json']),
  );
  assert.equal(repeatedSkillInstall.data.changed, false);

  const packagedSkillPath = path.join(
    installDirectory,
    'node_modules',
    'agent-crm',
    'skills',
    'agentcrm',
    'SKILL.md',
  );
  const simulatedUpgradeMarker = '<!-- simulated package upgrade -->';
  fs.appendFileSync(packagedSkillPath, `\n${simulatedUpgradeMarker}\n`);
  const upgradedSkillInstall = JSON.parse(
    runCli(['integration', 'install-skill', '--destination', skillDestination, '--json']),
  );
  assert.equal(upgradedSkillInstall.data.changed, true);
  assert.match(fs.readFileSync(skillPath, 'utf8'), new RegExp(simulatedUpgradeMarker));

  fs.appendFileSync(skillPath, '\nlocal package-smoke customization\n');
  assert.throws(
    () => runCli(['integration', 'uninstall-skill', '--destination', skillDestination, '--json']),
    (error) => {
      const envelope = JSON.parse(error.stdout);
      return error.status !== 0 && envelope.error.code === 'INTEGRATION_CONFLICT';
    },
  );
  assert.ok(fs.existsSync(skillPath), 'conflict protection must preserve a modified skill');
  const skillUninstall = JSON.parse(
    runCli([
      'integration',
      'uninstall-skill',
      '--destination',
      skillDestination,
      '--force',
      '--json',
    ]),
  );
  assert.equal(skillUninstall.ok, true);
  assert.equal(fs.existsSync(skillPath), false);
  assert.ok(fs.existsSync(database), 'skill uninstall must preserve the CRM database');

  npm([
    'uninstall',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--prefix',
    installDirectory,
    'agent-crm',
  ]);
  assert.equal(fs.existsSync(cliPath), false, 'npm uninstall must remove the installed CLI');
  assert.ok(fs.existsSync(database), 'npm uninstall must preserve the CRM database');

  installPackage(tarball);
  assert.equal(crm(database, ['doctor']).healthy, true);

  process.stdout.write('Packaged Agent CRM end-to-end smoke test passed.\n');
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
