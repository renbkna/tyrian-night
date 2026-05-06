import fs from 'node:fs';

import { expect, test } from 'bun:test';

type ExtensionPackage = {
  activationEvents?: string[];
  contributes: {
    commands: Array<{ command: string }>;
    themes: Array<{ label: string; path: string; uiTheme: string }>;
  };
  devDependencies: Record<string, string | undefined>;
  engines: {
    vscode: string;
  };
  extensionKind?: string[];
  main: string;
  scripts: Record<string, string | undefined>;
};

test('manifest declares the VS Code host and contribution contracts this extension depends on', () => {
  const manifest = readJson<ExtensionPackage>('package.json');
  const extensionSource = fs.readFileSync('src/extension.ts', 'utf8');

  expect(manifest.engines.vscode).toBe('^1.118.0');
  expect(manifest.extensionKind).toEqual(['ui']);
  expect(manifest.activationEvents).toContain('onStartupFinished');
  expect(fs.existsSync(stripRelativePrefix(manifest.main))).toBe(true);

  for (const { command } of manifest.contributes.commands) {
    expect(extensionSource).toContain(`registerCommand('${command}'`);
  }

  for (const themeContribution of manifest.contributes.themes) {
    const theme = readJson<{ name: string; type: string }>(
      stripRelativePrefix(themeContribution.path)
    );

    expect(theme.name).toBe(themeContribution.label);
    expect(theme.type).toBe(themeContribution.uiTheme === 'vs' ? 'light' : 'dark');
  }
});

test('VS Code package excludes the standalone Zed extension files', () => {
  const ignoredFiles = fs.readFileSync('.vscodeignore', 'utf8').split(/\r?\n/);

  expect(ignoredFiles).toContain('scripts/**');
  expect(ignoredFiles).toContain('themes/island/**');
  expect(ignoredFiles).toContain('zed/**');
  expect(ignoredFiles).not.toContain('zed-tyrian-night/**');
});

test('package scripts own the full verification path without npm shims', () => {
  const manifest = readJson<ExtensionPackage>('package.json');
  const ciWorkflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  const tsupConfig = fs.readFileSync('tsup.config.ts', 'utf8');
  const tsconfig = readJson<{
    compilerOptions: { allowJs?: boolean; checkJs?: boolean };
    include?: string[];
  }>('tsconfig.json');

  expect(manifest.scripts['vscode:prepublish']).toBeUndefined();
  expect(manifest.scripts.verify).toContain('bun run check:island-css');
  expect(manifest.scripts['package:check']).toBe('bun run verify && bun run build');
  expect(manifest.scripts.package).toBe('bun run package:check && vsce package --no-dependencies');
  expect(manifest.scripts.package).not.toContain('/tmp/npm');
  expect(manifest.devDependencies['@types/node']).toBe('^22.19.17');
  expect(manifest).not.toHaveProperty('dependencies');
  expect(manifest).toHaveProperty('overrides.picomatch', '^4.0.4');
  expect(manifest.scripts.lint).toContain('scripts/');
  expect(tsconfig.compilerOptions.allowJs).toBe(true);
  expect(tsconfig.compilerOptions.checkJs).toBe(true);
  expect(tsconfig.include).toContain('scripts');
  expect(tsupConfig).toContain("VSCODE_EXTENSION_HOST_NODE_TARGET = 'node22'");
  expect(tsupConfig).not.toContain("target: 'esnext'");
  expect(ciWorkflow).toContain('bun-version: 1.3.11');
  expect(ciWorkflow).toContain('run: bun install --frozen-lockfile');
  expect(ciWorkflow).toContain('run: bun run package');
});

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function stripRelativePrefix(filePath: string): string {
  return filePath.replace(/^\.\//, '');
}
