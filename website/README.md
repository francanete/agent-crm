# Agent CRM public website

Static Astro + Starlight homepage and documentation. This is separate from the CLI package: no CRM database, server API, account, analytics, or live customer data. Nothing here deploys automatically to Vercel.

## Local development

Use Node.js 24 and npm, starting from a full repository checkout:

```bash
cd website
npm ci
npm run dev
```

Before review:

```bash
npm run check
npm run build
npm run preview
```

`build` includes `check:links`, which checks generated local links, assets, fragments, required routes, and basic metadata. It does not check remote URLs, browser rendering, keyboard behavior, or search interaction; review those in the browser separately. The root CI has a separate website check/build job using this directory's lockfile. Root CLI checks remain independent.

## Content maintenance

- Homepage: `src/pages/index.astro`.
- Curated overview, getting-started, agent setup, and workflows: `src/content/docs/docs/`.
- CLI reference, import/export, CSV import, and privacy/security: edit the authoritative Markdown in the repository's **parent `docs/` directory**, not the ignored generated copies in this app.
- `scripts/sync-docs.mjs` regenerates those four pages before dev, check, and build. It adds an unreleased-main warning and maps repository document links.
- Docs intentionally track unreleased main, beyond published npm 0.1.0. Keep source-build instructions and version warnings until a release actually includes the documented behavior; a matching `--version` is not evidence that fixes shipped.
- Keep CLI examples aligned with `docs/cli-reference.md`, `skills/agentcrm/SKILL.md`, and current source. Exercise examples only against disposable databases with fake contacts. Global installation and Skill setup are explicit administrator actions, not website build steps.
- Add new curated routes to the Starlight sidebar and the required-route list in `scripts/check-links.mjs`.
- Local icons/social artwork are in `public/`; shared documentation styling is in `src/styles/docs.css`. SVG social previews are not supported by every social platform; do not claim universal rich-preview support.

Generated `dist/`, `.astro/`, `node_modules/`, and synced reference pages are ignored. The CLI package's root `files` allowlist excludes the website. Do not add website assets or dependencies to the CLI package.

## Later Vercel configuration (not deployed)

Import the **whole Git repository**, not a standalone copy of this directory:

| Setting | Value |
| --- | --- |
| Framework preset | Astro |
| Root Directory | `website` |
| Include source files outside the Root Directory in the Build Step | **Enabled** — document generation reads `../docs/` |
| Node.js version | 24.x |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Output directory | `dist` |

No Vercel adapter or runtime functions are required for this static build. No CRM credentials or database files should be supplied.

Leave `SITE_URL` unset until the public domain is approved. Local builds then omit explicit canonical URLs and skip sitemap generation (the sitemap warning is expected). Once approved, set `SITE_URL` to the exact HTTPS origin, without a path, query, or fragment, in the production environment; configure that same domain in Vercel's project Domains settings and complete the required DNS verification. Rebuild and inspect canonical URLs, social metadata, and the generated sitemap. Do not use a guessed domain or temporary preview URL as the public canonical origin. Keep preview environments unset unless an explicit indexing/canonical policy is approved.

Deployment, domain ownership/DNS, production indexing policy, and final desktop/mobile accessibility review are follow-up work, not completed by this implementation.
