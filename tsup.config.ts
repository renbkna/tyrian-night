import { defineConfig } from 'tsup';

const VSCODE_EXTENSION_HOST_NODE_TARGET = 'node22';

export default defineConfig({
  entry: [
    'apps/vscode/src/extension.ts',
    'apps/vscode/src/islandBroker.ts',
    'apps/vscode/src/islandCli.ts',
  ],
  outDir: 'out',
  format: ['esm'],
  platform: 'node',
  target: VSCODE_EXTENSION_HOST_NODE_TARGET,
  external: ['vscode'],
  minify: true,
  sourcemap: true,
  clean: true,
  splitting: false,
});
