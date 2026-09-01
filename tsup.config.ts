import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli/index.ts' },
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  external: ['node:sqlite'],
  removeNodeProtocol: false,
  clean: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
});
