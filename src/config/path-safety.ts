import fs from 'node:fs';
import path from 'node:path';

// macOS exposes these system directories through standard /private aliases.
const macosSystemAliases = new Map([
  ['/tmp', '/private/tmp'],
  ['/var', '/private/var'],
  ['/etc', '/private/etc'],
]);

export function hasUnsafePathComponent(target: string): boolean {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  const components = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') return true;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      if (
        process.platform === 'darwin' &&
        macosSystemAliases.get(current) === fs.realpathSync.native(current)
      ) {
        continue;
      }
      return true;
    }
    if (index < components.length - 1 && !stat.isDirectory()) return true;
  }
  return false;
}
