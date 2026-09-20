import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasUnsafePathComponent } from '../config/path-safety.js';
import { AppError } from '../core/errors.js';

const SKILL_NAME = 'agentcrm';
const SKILL_FILE = 'SKILL.md';
const MANIFEST_FILE = '.agentcrm-managed.json';

interface ManagedManifest {
  schemaVersion: 1;
  owner: 'agentcrm';
  skill: 'agentcrm';
  sha256: string;
  databasePath?: string;
}

export interface SkillIntegrationOptions {
  destination?: string;
  force?: boolean;
  sourcePath?: string;
  /** Setup's resolved database; omitted direct installs preserve an existing managed binding. */
  databasePath?: string;
}

export interface SkillIntegrationResult {
  action: 'installed' | 'uninstalled';
  path: string;
  changed: boolean;
  forced: boolean;
}

export type SkillState =
  | 'absent'
  | 'managed-current'
  | 'managed-outdated'
  | 'locally-modified'
  | 'unowned'
  | 'unsafe-target'
  | 'unreadable';

export interface SkillInspection {
  root: string;
  directory: string;
  skill: string;
  manifest: string;
  state: SkillState;
  databasePath?: string;
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function defaultSkillsRoot(): string {
  return path.join(os.homedir(), '.agents', 'skills');
}

function bundledSkillPath(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDirectory, '..', 'skills', SKILL_NAME, SKILL_FILE),
    path.resolve(moduleDirectory, '..', '..', 'skills', SKILL_NAME, SKILL_FILE),
    path.resolve(process.cwd(), 'skills', SKILL_NAME, SKILL_FILE),
  ];
  const source = candidates.find((candidate) => fs.existsSync(candidate));
  if (!source) {
    throw new AppError('INTEGRATION_ERROR', 'The bundled Agent Skill is missing');
  }
  return source;
}

function hash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function targetPaths(destination?: string): {
  root: string;
  directory: string;
  skill: string;
  manifest: string;
} {
  const root = path.resolve(expandHome(destination ?? defaultSkillsRoot()));
  const directory = path.join(root, SKILL_NAME);
  return {
    root,
    directory,
    skill: path.join(directory, SKILL_FILE),
    manifest: path.join(directory, MANIFEST_FILE),
  };
}

function readManagedManifest(manifestPath: string): ManagedManifest | undefined {
  try {
    const stat = fs.lstatSync(manifestPath);
    if (!stat.isFile()) return undefined;
    const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Partial<ManagedManifest>;
    if (
      value.schemaVersion === 1 &&
      value.owner === 'agentcrm' &&
      value.skill === 'agentcrm' &&
      typeof value.sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(value.sha256) &&
      (value.databasePath === undefined ||
        (typeof value.databasePath === 'string' && path.isAbsolute(value.databasePath)))
    ) {
      return value as ManagedManifest;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readManagedHash(manifestPath: string): string | undefined {
  return readManagedManifest(manifestPath)?.sha256;
}

function skillContent(source: string, databasePath?: string): Buffer {
  const content = fs.readFileSync(source);
  if (databasePath === undefined) return content;
  // JSON is data, not a shell command. Escape Markdown delimiters even inside the JSON string.
  const args = JSON.stringify(['--db', databasePath]).replace(
    /[`<>]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  const binding = [
    '## Managed database binding',
    '',
    'This installation selects a local database. For every CRM invocation, insert these two',
    'arguments immediately after agentcrm and before the command (including doctor and init):',
    '',
    '```json',
    args,
    '```',
    '',
    'This JSON array is literal argument data, not shell source. Decode it and pass the path',
    'as one argument using an argv-capable process tool with shell execution disabled.',
    'On Windows, use node with the resolved agentcrm CLI .js entry point rather than a .cmd',
    'shell shim. If only a shell tool is available, quote for that specific shell; never',
    'paste the JSON as shell syntax or interpolate the path into executable code.',
    'Apply this binding to all examples below; it overrides their generic environment/default',
    'guidance unless the user explicitly selects another database for an operation.',
    'If this database is unavailable, report the error; do not silently use another database.',
    'This is installation-local agent guidance: it does not change bare CLI database discovery,',
    'set environment variables, or separate data by chat identity. Rebinding this installation',
    'requires administrator setup preview and consent.',
    '',
  ].join('\n');
  const text = content.toString('utf8');
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text)?.[0] ?? '';
  return Buffer.from(`${frontmatter}\n${binding}\n${text.slice(frontmatter.length)}`);
}

function atomicWrite(file: string, content: Buffer | string, mode: number): void {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { mode, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The rename succeeded or no temporary file was created.
    }
  }
}

function ensureSafeTargetDirectory(root: string, directory: string): void {
  if (hasUnsafePathComponent(directory)) {
    throw new AppError('INTEGRATION_CONFLICT', 'Skill destination has an unsafe path component', {
      path: directory,
    });
  }
  try {
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new AppError(
        'INTEGRATION_CONFLICT',
        `Skill root '${root}' is not a regular directory`,
        {
          path: root,
        },
      );
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    fs.mkdirSync(root, { recursive: true, mode: 0o755 });
  }

  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new AppError(
        'INTEGRATION_CONFLICT',
        `Skill destination '${directory}' is not a regular directory`,
        { path: directory },
      );
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
    fs.mkdirSync(directory, { mode: 0o755 });
  }
}

export function inspectSkill(options: SkillIntegrationOptions = {}): SkillInspection {
  const target = targetPaths(options.destination);
  const source = options.sourcePath ?? bundledSkillPath();

  try {
    if (hasUnsafePathComponent(target.skill) || hasUnsafePathComponent(target.manifest)) {
      return { ...target, state: 'unsafe-target' };
    }
    try {
      if (!fs.lstatSync(target.manifest).isFile()) return { ...target, state: 'unsafe-target' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  } catch {
    return { ...target, state: 'unreadable' };
  }

  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(target.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...target, state: 'absent' };
    }
    return { ...target, state: 'unreadable' };
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return { ...target, state: 'unsafe-target' };
  }

  let directoryStat: fs.Stats;
  try {
    directoryStat = fs.lstatSync(target.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...target, state: 'absent' };
    }
    return { ...target, state: 'unreadable' };
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    return { ...target, state: 'unsafe-target' };
  }

  let skillStat: fs.Stats;
  try {
    skillStat = fs.lstatSync(target.skill);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...target, state: 'absent' };
    }
    return { ...target, state: 'unreadable' };
  }
  if (skillStat.isSymbolicLink() || !skillStat.isFile()) {
    return { ...target, state: 'unsafe-target' };
  }

  try {
    const existingHash = hash(fs.readFileSync(target.skill));
    const managed = readManagedManifest(target.manifest);
    const managedHash = managed?.sha256;
    const databasePath = managed?.databasePath;
    const binding = databasePath === undefined ? {} : { databasePath };
    const sourceHash = hash(skillContent(source, options.databasePath ?? databasePath));
    if (existingHash === sourceHash && managedHash === sourceHash) {
      return { ...target, ...binding, state: 'managed-current' };
    }
    if (managedHash !== undefined && existingHash === managedHash) {
      return { ...target, ...binding, state: 'managed-outdated' };
    }
    return {
      ...target,
      ...binding,
      state: managedHash === undefined ? 'unowned' : 'locally-modified',
    };
  } catch {
    return { ...target, state: 'unreadable' };
  }
}

export function installSkill(options: SkillIntegrationOptions = {}): SkillIntegrationResult {
  const target = targetPaths(options.destination);
  const source = options.sourcePath ?? bundledSkillPath();
  const force = options.force === true;

  try {
    if (hasUnsafePathComponent(target.manifest)) {
      throw new AppError('INTEGRATION_CONFLICT', 'Skill manifest has an unsafe path component', {
        path: target.manifest,
      });
    }
    try {
      if (!fs.lstatSync(target.manifest).isFile()) {
        throw new AppError('INTEGRATION_CONFLICT', 'Skill manifest is not a regular file', {
          path: target.manifest,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const databasePath = options.databasePath ?? readManagedManifest(target.manifest)?.databasePath;
    const content = skillContent(source, databasePath);
    const sourceHash = hash(content);
    ensureSafeTargetDirectory(target.root, target.directory);

    let changed = true;
    try {
      const stat = fs.lstatSync(target.skill);
      if (stat.isSymbolicLink()) {
        if (!force) {
          throw new AppError(
            'INTEGRATION_CONFLICT',
            'Refusing to replace a symbolic-link skill without --force',
            { path: target.skill },
          );
        }
        fs.unlinkSync(target.skill);
      } else if (!stat.isFile()) {
        throw new AppError('INTEGRATION_CONFLICT', 'The skill path is not a regular file', {
          path: target.skill,
        });
      } else {
        const existingHash = hash(fs.readFileSync(target.skill));
        if (existingHash === sourceHash) {
          changed = false;
        } else {
          const managedHash = readManagedHash(target.manifest);
          if (!force && existingHash !== managedHash) {
            throw new AppError(
              'INTEGRATION_CONFLICT',
              'A different or locally modified Agent Skill already exists; use --force to replace it',
              { path: target.skill },
            );
          }
        }
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    if (changed) atomicWrite(target.skill, content, 0o644);
    const manifest: ManagedManifest = {
      schemaVersion: 1,
      owner: 'agentcrm',
      skill: 'agentcrm',
      sha256: sourceHash,
      ...(databasePath === undefined ? {} : { databasePath }),
    };
    atomicWrite(target.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);

    return { action: 'installed', path: target.skill, changed, forced: force };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('INTEGRATION_ERROR', 'Could not install the Agent Skill', {
      path: target.skill,
    });
  }
}

export function uninstallSkill(options: SkillIntegrationOptions = {}): SkillIntegrationResult {
  const target = targetPaths(options.destination);
  const force = options.force === true;

  try {
    try {
      const directoryStat = fs.lstatSync(target.directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw new AppError(
          'INTEGRATION_CONFLICT',
          `Skill destination '${target.directory}' is not a regular directory`,
          { path: target.directory },
        );
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { action: 'uninstalled', path: target.skill, changed: false, forced: force };
    }

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target.skill);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { action: 'uninstalled', path: target.skill, changed: false, forced: force };
    }

    if (stat.isSymbolicLink()) {
      if (!force) {
        throw new AppError(
          'INTEGRATION_CONFLICT',
          'Refusing to remove a symbolic-link skill without --force',
          { path: target.skill },
        );
      }
    } else if (!stat.isFile()) {
      throw new AppError('INTEGRATION_CONFLICT', 'The skill path is not a regular file', {
        path: target.skill,
      });
    } else if (!force) {
      const existingHash = hash(fs.readFileSync(target.skill));
      const managedHash = readManagedHash(target.manifest);
      let bundledHash: string | undefined;
      try {
        bundledHash = hash(fs.readFileSync(options.sourcePath ?? bundledSkillPath()));
      } catch {
        bundledHash = undefined;
      }
      if (existingHash !== managedHash && existingHash !== bundledHash) {
        throw new AppError(
          'INTEGRATION_CONFLICT',
          'The installed Agent Skill was modified; use --force to remove it',
          { path: target.skill },
        );
      }
    }

    fs.unlinkSync(target.skill);
    try {
      fs.unlinkSync(target.manifest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      fs.rmdirSync(target.directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'ENOENT') throw error;
    }
    return { action: 'uninstalled', path: target.skill, changed: true, forced: force };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('INTEGRATION_ERROR', 'Could not uninstall the Agent Skill', {
      path: target.skill,
    });
  }
}
