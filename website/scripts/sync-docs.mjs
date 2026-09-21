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
  const intro = `:::caution[Unreleased main documentation]\nThis reference is generated from the repository's [docs/${name}.md](https://github.com/francanete/agent-crm/blob/main/docs/${name}.md) and includes changes newer than the published npm 0.1.0 package. Start with the [npm installation guide](/docs/getting-started/). If a command depends on unreleased behavior, use the source-build section there.\n:::\n`;
  await writeFile(new URL(`${name}.md`, destination), `---\ntitle: ${JSON.stringify(heading.slice(2))}\ndescription: ${JSON.stringify(`${heading.slice(2)} for Agent CRM, tracking unreleased main.`)}\n---\n\n${intro}${body}`);
}
console.log(`Synced ${names.length} authoritative repository documents.`);
