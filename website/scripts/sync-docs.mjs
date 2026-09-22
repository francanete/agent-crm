import { mkdir, readFile, writeFile } from 'node:fs/promises';

// Generated pages are ignored by Git: repository docs remain the source of truth.
const names = ['cli-reference', 'import-export', 'csv-import', 'privacy-security'];
const destination = new URL('../src/content/docs/docs/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const name of names) {
  const source = await readFile(new URL(`../../docs/${name}.md`, import.meta.url), 'utf8');
  const [heading, ...lines] = source.split('\n');
  if (!heading.startsWith('# ')) throw new Error(`Missing title: ${name}`);
  const body = lines.join('\n').replace(/\]\(([^)]+\.md)(#[^)]*)?\)/g, (_match, path, hash = '') => {
    const slug = path.replace(/^\.\//, '').replace(/\.md$/, '');
    return names.includes(slug)
      ? `](/docs/${slug}/${hash})`
      : `](https://github.com/francanete/agent-crm/blob/main/docs/${path}${hash})`;
  });
  const intro = `:::caution[Next-release preview]\nThis reference includes changes planned for a later release that are not part of the published npm 0.1.0 package. For the supported installation path, start with the [npm installation guide](/docs/getting-started/).\n:::\n`;
  await writeFile(new URL(`${name}.md`, destination), `---\ntitle: ${JSON.stringify(heading.slice(2))}\ndescription: ${JSON.stringify(`${heading.slice(2)} for Agent CRM, tracking unreleased main.`)}\n---\n\n${intro}${body}`);
}
console.log(`Synced ${names.length} authoritative repository documents.`);
