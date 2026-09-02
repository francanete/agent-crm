import os from 'node:os';
import path from 'node:path';

function expandHome(value: string, home: string = os.homedir()): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(home, value.slice(2));
  }
  return value;
}

export function defaultDatabasePath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'agentcrm', 'crm.db');
  }

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    return path.join(localAppData, 'agentcrm', 'crm.db');
  }

  const dataHome = env.XDG_DATA_HOME ?? path.join(home, '.local', 'share');
  return path.join(dataHome, 'agentcrm', 'crm.db');
}

export function resolveDatabasePath(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  const selected = override ?? env.AGENTCRM_DB ?? defaultDatabasePath(platform, env, home);
  return path.resolve(expandHome(selected, home));
}
