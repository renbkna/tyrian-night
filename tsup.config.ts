import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/extension.ts', 'src/islandCli.ts'],
  outDir: 'out',
  format: ['esm'],
  platform: 'node',
  target: 'esnext',
  external: ['vscode'],
  minify: true,
  sourcemap: true,
  clean: true,
  splitting: false,
});
