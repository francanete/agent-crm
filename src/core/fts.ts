export function flattenSearchValue(value: unknown, output: string[], depth = 0): void {
  if (depth > 20 || value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    output.push(String(value));
  } else if (Array.isArray(value)) {
    for (const entry of value) flattenSearchValue(entry, output, depth + 1);
  } else if (typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      flattenSearchValue(entry, output, depth + 1);
    }
  }
}
