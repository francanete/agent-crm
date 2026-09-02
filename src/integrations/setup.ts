import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveDatabasePath } from '../config/paths.js';
import { AppError } from '../core/errors.js';
import { type InitializationResult, initializeDatabase } from '../db/database.js';
import { CURRENT_DATABASE_VERSION, validateExistingDatabase } from '../db/migrations.js';
import {
  getHostAdapter,
  groupHostDestinations,
  HOST_ADAPTERS,
  hostDetectionContext,
} from './hosts.js';
import { inspectSkill, installSkill, type SkillState } from './skill.js';

export type DatabaseState =
  | 'absent'
  | 'agentcrm-ready'
  | 'not-a-regular-file'
  | 'non-agentcrm-file'
  | 'unsupported-version'
  | 'unreadable';

export interface DatabaseInspection {
  path: string;
  selection: 'default' | 'environment' | 'explicit';
  state: DatabaseState;
  databaseVersion?: number;
}

export interface SetupHostPlan {
  key: string;
  displayName: string;
  support: 'verified' | 'candidate';
  detection: 'detected' | 'not-detected' | 'unsupported-on-platform';
  evidence: string[];
  destination: string;
  destinationKey: string;
  skillState: SkillState;
  restartGuidance: string;
  sharedGatewayWarning?: string;
}

export interface SetupPlan {
  database: DatabaseInspection & {
    privacyNotice: string;
  };
  hosts: SetupHostPlan[];
  destinationGroups: Array<{
    destination: string;
    destinationKey: string;
    hosts: string[];
  }>;
  actions: {
    canInitializeDatabase: boolean;
    allowedHosts: string[];
  };
}

export interface SetupPlanOptions {
  databaseOverride?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  sourcePath?: string;
}

function databaseSelection(
  databaseOverride: string | undefined,
  env: NodeJS.ProcessEnv,
): DatabaseInspection['selection'] {
  if (databaseOverride !== undefined) return 'explicit';
  if (env.AGENTCRM_DB !== undefined) return 'environment';
  return 'default';
}

function inspectDatabase(
  databasePath: string,
  selection: DatabaseInspection['selection'],
): DatabaseInspection {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: databasePath, selection, state: 'absent' };
    }
    return { path: databasePath, selection, state: 'unreadable' };
  }

  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { path: databasePath, selection, state: 'not-a-regular-file' };
  }

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
  } catch {
    return { path: databasePath, selection, state: 'unreadable' };
  }

  try {
    const version = validateExistingDatabase(database);
    return { path: databasePath, selection, state: 'agentcrm-ready', databaseVersion: version };
  } catch (error) {
    if (error instanceof AppError && error.code === 'DATABASE_VERSION_UNSUPPORTED') {
      const version = error.details.databaseVersion;
      return {
        path: databasePath,
        selection,
        state: 'unsupported-version',
        ...(typeof version === 'number' ? { databaseVersion: version } : {}),
      };
    }
    return { path: databasePath, selection, state: 'non-agentcrm-file' };
  } finally {
    database.close();
  }
}

function inspectHost(
  adapter: (typeof HOST_ADAPTERS)[number],
  context: ReturnType<typeof hostDetectionContext>,
  sourcePath: string | undefined,
): SetupHostPlan {
  const detection = adapter.detect(context);
  const destination = path.resolve(adapter.skillsRoot(context));
  const skill = inspectSkill({
    destination,
    ...(sourcePath === undefined ? {} : { sourcePath }),
  });
  return {
    key: adapter.key,
    displayName: adapter.displayName,
    support: adapter.support,
    detection: detection.state,
    evidence: detection.evidence,
    destination,
    destinationKey: skill.root,
    skillState: skill.state,
    restartGuidance: adapter.restartGuidance,
    ...(adapter.sharedGatewayWarning ? { sharedGatewayWarning: adapter.sharedGatewayWarning } : {}),
  };
}

export interface SetupApplyOptions extends SetupPlanOptions {
  initialize?: boolean;
  agents?: string[];
  allDetected?: boolean;
  noSkill?: boolean;
  forceSkill?: boolean;
  yes?: boolean;
}

export interface SetupApplyResult {
  database: {
    action: 'initialized' | 'unchanged';
    path: string;
    initialization?: InitializationResult;
  };
  skillInstallations: Array<{
    destination: string;
    hosts: string[];
    action: 'installed' | 'already-current';
    changed: boolean;
  }>;
  nextSteps: Array<{ host: string; action: string }>;
}

function selectedHosts(plan: SetupPlan, options: SetupApplyOptions): SetupHostPlan[] {
  const agents = options.agents ?? [];
  if (options.allDetected && agents.length > 0) {
    throw new AppError('VALIDATION_ERROR', 'Use only one of --agent or --all-detected');
  }
  if (options.noSkill && (options.allDetected || agents.length > 0)) {
    throw new AppError(
      'VALIDATION_ERROR',
      '--no-skill cannot be combined with Skill host selection',
    );
  }
  if (options.noSkill) return [];
  if (options.allDetected) {
    return plan.hosts.filter(
      (host) => host.detection === 'detected' && host.support === 'verified',
    );
  }

  const keys = [...new Set(agents)];
  for (const key of keys) {
    if (!getHostAdapter(key)) {
      throw new AppError('SETUP_INVALID_HOST', `Unknown setup host '${key}'`, {
        allowedHosts: plan.actions.allowedHosts,
      });
    }
  }
  return keys.map((key) => plan.hosts.find((host) => host.key === key) as SetupHostPlan);
}

function validateSelectedDestinations(hosts: SetupHostPlan[], forceSkill: boolean): void {
  for (const host of hosts) {
    if (host.skillState === 'unsafe-target' || host.skillState === 'unreadable') {
      throw new AppError('SETUP_DESTINATION_CONFLICT', 'A selected Skill destination is unsafe', {
        host: host.key,
        destination: host.destination,
        skillState: host.skillState,
      });
    }
    if (!forceSkill && (host.skillState === 'unowned' || host.skillState === 'locally-modified')) {
      throw new AppError('SETUP_DESTINATION_CONFLICT', 'A selected Skill is unowned or modified', {
        host: host.key,
        destination: host.destination,
        skillState: host.skillState,
        hint: 'Use --force-skill only after reviewing the existing Skill.',
      });
    }
  }
}

export function applySetup(options: SetupApplyOptions): SetupApplyResult {
  const plan = createSetupPlan(options);
  const hosts = selectedHosts(plan, options);
  const hasRequestedAction = options.initialize === true || hosts.length > 0;
  if (!hasRequestedAction) {
    throw new AppError('SETUP_CONFIRMATION_REQUIRED', 'Select a setup action before applying', {
      hint: 'Use --initialize, --agent <host>, or --all-detected.',
    });
  }
  if (options.yes !== true) {
    throw new AppError('SETUP_CONFIRMATION_REQUIRED', 'Setup apply requires --yes', {
      hint: 'Review `agentcrm setup plan --json`, then rerun with explicit actions and --yes.',
    });
  }
  if (plan.database.state !== 'absent' && plan.database.state !== 'agentcrm-ready') {
    throw new AppError(
      'SETUP_DATABASE_CONFLICT',
      'The selected database cannot be initialized safely',
      {
        database: plan.database.path,
        state: plan.database.state,
      },
    );
  }
  if (plan.database.state === 'absent' && options.initialize !== true) {
    throw new AppError(
      'SETUP_CONFIRMATION_REQUIRED',
      'Creating the selected database requires --initialize',
      {
        database: plan.database.path,
      },
    );
  }
  validateSelectedDestinations(hosts, options.forceSkill === true);

  const database =
    options.initialize === true
      ? {
          action: 'initialized' as const,
          path: plan.database.path,
          initialization: initializeDatabase(plan.database.path),
        }
      : { action: 'unchanged' as const, path: plan.database.path };

  const groups = groupHostDestinations(
    hosts.map((host) => ({
      key: host.key as 'pi' | 'claude-code' | 'hermes',
      destination: host.destination,
    })),
  );
  const skillInstallations: SetupApplyResult['skillInstallations'] = [];
  const failures: Array<Record<string, unknown>> = [];
  for (const group of groups) {
    try {
      const installation = installSkill({
        destination: group.destination,
        force: options.forceSkill === true,
        ...(options.sourcePath === undefined ? {} : { sourcePath: options.sourcePath }),
      });
      skillInstallations.push({
        destination: group.destination,
        hosts: group.hosts,
        action: installation.changed ? 'installed' : 'already-current',
        changed: installation.changed,
      });
    } catch (error) {
      const appError = error instanceof AppError ? error : undefined;
      failures.push({
        destination: group.destination,
        hosts: group.hosts,
        code: appError?.code ?? 'INTEGRATION_ERROR',
        message: appError?.message ?? 'Could not install the Agent Skill',
      });
    }
  }
  if (failures.length > 0) {
    throw new AppError(
      'SETUP_PARTIAL_FAILURE',
      'Setup could not install every selected Agent Skill',
      {
        database,
        skillInstallations,
        failures,
      },
    );
  }

  return {
    database,
    skillInstallations,
    nextSteps: hosts.map((host) => ({ host: host.key, action: host.restartGuidance })),
  };
}

export function createSetupPlan(options: SetupPlanOptions = {}): SetupPlan {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const databasePath = resolveDatabasePath(options.databaseOverride, env, platform, home);
  const selection = databaseSelection(options.databaseOverride, env);
  const database = inspectDatabase(databasePath, selection);
  const context = hostDetectionContext(platform, env, home);
  const hosts = HOST_ADAPTERS.map((adapter) => inspectHost(adapter, context, options.sourcePath));
  const detectedDestinations = hosts
    .filter((host) => host.detection === 'detected')
    .map((host) => ({
      key: host.key as 'pi' | 'claude-code' | 'hermes',
      destination: host.destination,
    }));
  const destinationGroups = groupHostDestinations(detectedDestinations).map((group) => ({
    ...group,
    hosts: [...group.hosts],
  }));

  return {
    database: {
      ...database,
      privacyNotice: 'Agent CRM stores data locally in SQLite and does not encrypt the database.',
    },
    hosts,
    destinationGroups,
    actions: {
      canInitializeDatabase:
        database.state === 'absent' ||
        (database.state === 'agentcrm-ready' &&
          (database.databaseVersion ?? CURRENT_DATABASE_VERSION) <= CURRENT_DATABASE_VERSION),
      allowedHosts: HOST_ADAPTERS.map((adapter) => adapter.key),
    },
  };
}
