import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type HostKey = 'pi' | 'claude-code' | 'hermes';
export type HostSupport = 'verified' | 'candidate';
export type HostDetectionState = 'detected' | 'not-detected' | 'unsupported-on-platform';

export interface HostDetection {
  state: HostDetectionState;
  evidence: string[];
}

export interface HostDetectionContext {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
}

export interface HostAdapter {
  key: HostKey;
  displayName: string;
  support: HostSupport;
  detect: (context: HostDetectionContext) => HostDetection;
  skillsRoot: (context: HostDetectionContext) => string;
  restartGuidance: string;
  sharedGatewayWarning?: string;
}

function absoluteHomePath(home: string, value: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(home, value.slice(2));
  }
  return path.resolve(value);
}

function isDirectory(directory: string): boolean {
  try {
    return fs.lstatSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function executableOnPath(command: string, context: HostDetectionContext): boolean {
  const pathValue = context.env.PATH;
  if (!pathValue) return false;

  const separator = context.platform === 'win32' ? ';' : path.delimiter;
  const extensions =
    context.platform === 'win32' ? (context.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];

  for (const directory of pathValue.split(separator)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        if (context.platform === 'win32') return true;
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        // Continue searching the remaining PATH entries.
      }
    }
  }
  return false;
}

function detection(
  context: HostDetectionContext,
  executable: string,
  stateDirectory: string,
): HostDetection {
  const evidence: string[] = [];
  if (executableOnPath(executable, context)) evidence.push('executable-on-path');
  if (isDirectory(stateDirectory)) evidence.push('state-directory');
  return {
    state: evidence.length > 0 ? 'detected' : 'not-detected',
    evidence,
  };
}

export const HOST_ADAPTERS: readonly HostAdapter[] = [
  {
    key: 'pi',
    displayName: 'Pi',
    support: 'verified',
    detect: (context) => detection(context, 'pi', path.join(context.home, '.pi')),
    skillsRoot: (context) => path.join(context.home, '.agents', 'skills'),
    restartGuidance: 'Start a fresh Pi session.',
  },
  {
    key: 'claude-code',
    displayName: 'Claude Code',
    support: 'candidate',
    detect: (context) =>
      detection(
        context,
        'claude',
        context.env.CLAUDE_CONFIG_DIR
          ? absoluteHomePath(context.home, context.env.CLAUDE_CONFIG_DIR)
          : path.join(context.home, '.claude'),
      ),
    skillsRoot: (context) =>
      path.join(
        context.env.CLAUDE_CONFIG_DIR
          ? absoluteHomePath(context.home, context.env.CLAUDE_CONFIG_DIR)
          : path.join(context.home, '.claude'),
        'skills',
      ),
    restartGuidance: 'Start a fresh Claude Code session.',
  },
  {
    key: 'hermes',
    displayName: 'Hermes Agent',
    support: 'verified',
    detect: (context) => detection(context, 'hermes', path.join(context.home, '.hermes')),
    skillsRoot: (context) => path.join(context.home, '.hermes', 'skills'),
    restartGuidance: 'Restart the Hermes gateway or start a fresh Hermes session.',
    sharedGatewayWarning:
      'This host may serve multiple chat users. Agent CRM uses one local database for this OS user; it does not create separate CRM databases per chat identity.',
  },
];

export function hostDetectionContext(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): HostDetectionContext {
  return { platform, env, home };
}

export function getHostAdapter(key: string): HostAdapter | undefined {
  return HOST_ADAPTERS.find((adapter) => adapter.key === key);
}

export function resolvedDestinationKey(destination: string): string {
  const absolute = path.resolve(destination);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export interface HostDestinationGroup {
  destination: string;
  destinationKey: string;
  hosts: HostKey[];
}

export function groupHostDestinations(
  hosts: Array<{ key: HostKey; destination: string }>,
): HostDestinationGroup[] {
  const groups = new Map<string, HostDestinationGroup>();
  for (const host of hosts) {
    const destination = path.resolve(host.destination);
    const destinationKey = resolvedDestinationKey(destination);
    const existing = groups.get(destinationKey);
    if (existing) {
      existing.hosts.push(host.key);
    } else {
      groups.set(destinationKey, { destination, destinationKey, hosts: [host.key] });
    }
  }
  return [...groups.values()];
}
