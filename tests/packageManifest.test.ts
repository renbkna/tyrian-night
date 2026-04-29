import fs from 'node:fs';

import { expect, test } from 'bun:test';

type ExtensionPackage = {
  activationEvents?: string[];
  contributes: {
    commands: Array<{ command: string }>;
    themes: Array<{ label: string; path: string; uiTheme: string }>;
  };
  engines: {
    vscode: string;
  };
  extensionKind?: string[];
  main: string;
};

test('manifest declares the VS Code host and contribution contracts this extension depends on', () => {
  const manifest = readJson<ExtensionPackage>('package.json');
  const extensionSource = fs.readFileSync('src/extension.ts', 'utf8');

  expect(manifest.engines.vscode).toBe('^1.116.0');
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

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function stripRelativePrefix(filePath: string): string {
  return filePath.replace(/^\.\//, '');
}
