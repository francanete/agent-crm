import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightThemeBlack from 'starlight-theme-black';

// Set only after the public domain is approved. No preview-domain canonicals.
const site = process.env.SITE_URL;
if (site) {
  const url = new URL(site);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('SITE_URL must be an HTTPS origin with no path, query, fragment, or credentials');
  }
}
export default defineConfig({
  ...(site ? { site } : {}),
  output: 'static',
  trailingSlash: 'always',
  integrations: [starlight({
    plugins: [starlightThemeBlack({ docs: { showMarkdownActions: false } })],
    title: 'Agent CRM',
    description: 'Local relationship memory for shell-capable AI agents. Experimental, open source, and built on SQLite.',
    favicon: '/favicon.svg',
    social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/francanete/agent-crm' }],
    customCss: ['./src/styles/docs.css'],
    head: [
      { tag: 'meta', attrs: { property: 'og:image', content: site ? new URL('/social.svg', site).href : '/social.svg' } },
      { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
    ],
    sidebar: [
      { label: 'Start here', items: [
        { label: 'Overview', slug: 'docs' },
        { label: 'Getting started', slug: 'docs/getting-started' },
        { label: 'Agents, profiles & databases', slug: 'docs/agent-setup' },
        { label: 'Everyday workflows', slug: 'docs/workflows' },
      ] },
      { label: 'Reference & care', items: [
        { label: 'CLI reference', slug: 'docs/cli-reference' },
        { label: 'Backup & restore', slug: 'docs/import-export' },
        { label: 'CSV import', slug: 'docs/csv-import' },
        { label: 'Privacy & security', slug: 'docs/privacy-security' },
      ] },
    ],
  })],
});
