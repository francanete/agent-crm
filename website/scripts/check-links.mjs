import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';

const root = resolve('dist');
async function walk(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory()
    ? walk(resolve(path, entry.name)) : [resolve(path, entry.name)]))).flat();
}
const files = await walk(root);
const pages = files.filter((file) => file.endsWith('.html'));
const html = new Map(await Promise.all(pages.map(async (file) => [file, await readFile(file, 'utf8')])));
const origin = 'https://internal.invalid';
const failures = [];
let checked = 0;
for (const [file, content] of html) {
  const route = `/${relative(root, file).split(sep).join('/').replace(/index\.html$/, '')}`;
  assert.match(content, /<html[^>]*lang="en"/, `${route}: missing language`);
  assert.match(content, /<title>[^<]+<\/title>/, `${route}: missing title`);
  assert.match(content, /name="description"/, `${route}: missing description`);
  assert.equal((content.match(/<h1(?:\s|>)/g) || []).length, 1, `${route}: expected one h1`);
  assert.doesNotMatch(content, /(?:https?:\/\/localhost|https?:\/\/example\.com)/, `${route}: placeholder domain leaked`);
  assert.doesNotMatch(content, /<(?:script|link)[^>]*(?:src|href)="https?:\/\//, `${route}: remote script/style`);
  for (const match of content.matchAll(/\b(href|src)="([^"]+)"/g)) {
    const raw = match[2].replaceAll('&amp;', '&');
    if (/^(?:https?:|mailto:|tel:|data:|javascript:|\/\/)/.test(raw)) continue;
    const url = new URL(raw, `${origin}${route}`);
    let target = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (!target.startsWith(`${root}${sep}`) && target !== root) throw new Error('Link escapes build');
    try {
      if ((await stat(target)).isDirectory()) target = resolve(target, 'index.html');
      await stat(target);
      if (url.hash && html.has(target)) {
        const id = decodeURIComponent(url.hash.slice(1));
        const ids = [...html.get(target).matchAll(/\bid="([^"]*)"/g)].map((m) => m[1]);
        if (!ids.includes(id)) throw new Error(`missing anchor ${id}`);
      }
      checked++;
    } catch (error) { failures.push(`${route}: ${raw} (${error.message})`); }
  }
}
for (const route of ['index.html', 'docs/index.html', 'docs/getting-started/index.html', 'docs/agent-setup/index.html', 'docs/workflows/index.html', 'docs/cli-reference/index.html', 'docs/import-export/index.html', 'docs/csv-import/index.html', 'docs/privacy-security/index.html']) {
  assert(html.has(resolve(root, route)), `Missing required route ${route}`);
}
assert.equal(failures.length, 0, failures.join('\n'));
console.log(`Checked ${pages.length} HTML pages and ${checked} local links/assets/anchors; metadata and route checks passed.`);
