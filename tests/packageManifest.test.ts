import fs from 'node:fs';

import { expect, test } from 'bun:test';

import {
  DEFAULT_ISLAND_BROKER_ASSET_ROOTS,
  DEFAULT_ISLAND_BROKER_PATHS,
  ISLAND_BROKER_CHMOD_PATH,
  ISLAND_BROKER_CHOWN_PATH,
  ISLAND_BROKER_NODE_PATH,
  ISLAND_BROKER_PKEXEC_PATH,
} from '../apps/vscode/src/generated/islandBrokerInstallContract';
import { TYRIAN_THEME_CATALOG } from '../apps/vscode/src/generated/themeCatalog';
import { SOURCE_THEMES } from '../scripts/themeSources.mjs';

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
  icon: string;
  main: string;
  scripts: Record<string, string | undefined>;
};

test('manifest declares the VS Code host and contribution contracts this extension depends on', () => {
  const manifest = readJson<ExtensionPackage>('package.json');
  const extensionSource = fs.readFileSync('apps/vscode/src/extension.ts', 'utf8');

  expect(manifest.engines.vscode).toBe('^1.118.0');
  expect(manifest.extensionKind).toEqual(['ui']);
  expect(manifest.activationEvents).toContain('onStartupFinished');
  expect(fs.existsSync(stripRelativePrefix(manifest.icon))).toBe(true);
  expect(manifest.main).toBe('./out/extension.js');

  for (const { command } of manifest.contributes.commands) {
    expect(extensionSource).toContain(`registerCommand('${command}'`);
  }

  expect(manifest.contributes.themes).toEqual(
    SOURCE_THEMES.map((source) => ({
      label: source.label,
      uiTheme: source.vscodeUiTheme,
      path: source.vscodeContributionPath,
    }))
  );
  expect(
    TYRIAN_THEME_CATALOG.map((theme) => ({
      label: theme.label,
      islandCssFile: theme.islandCssFile,
    }))
  ).toEqual(
    SOURCE_THEMES.map((source) => ({
      label: source.label,
      islandCssFile: source.islandCssFile,
    }))
  );

  for (const themeContribution of manifest.contributes.themes) {
    const theme = readJson<{ name: string; type: string }>(
      stripRelativePrefix(themeContribution.path)
    );

    expect(theme.name).toBe(themeContribution.label);
    expect(theme.type).toBe(themeContribution.uiTheme === 'vs' ? 'light' : 'dark');
    expect(TYRIAN_THEME_CATALOG).toContainEqual(
      expect.objectContaining({
        label: themeContribution.label,
        islandCssFile: `${pathBasename(themeContribution.path, '.json')}.css`,
      })
    );
  }
});

test('VS Code package includes only VS Code runtime and marketplace assets', () => {
  const ignoredFiles = fs.readFileSync('.vscodeignore', 'utf8').split(/\r?\n/);

  expect(ignoredFiles).toContain('scripts/**');
  expect(ignoredFiles).toContain('out/islandBroker.js');
  expect(ignoredFiles).toContain('apps/vscode/src/**');
  expect(ignoredFiles).toContain('apps/vscode/island/base.css');
  expect(ignoredFiles).toContain('apps/zed/**');
  expect(ignoredFiles).toContain('terminal/**');
  expect(ignoredFiles).toContain('desktop/**');
  expect(ignoredFiles).toContain('rice/**');
  expect(ignoredFiles).toContain('source/themeCatalog.json');
  expect(ignoredFiles).toContain('source/islandBrokerInstallContract.json');
  expect(ignoredFiles).toContain('source/union-css/**');
  expect(ignoredFiles).toContain('assets/tyrian-fetch.webp');
  expect(ignoredFiles).toContain('assets/tyrian.png');
  expect(ignoredFiles).toContain('assets/wallpaper-tyrian.png');
  expect(ignoredFiles).toContain('assets/preview.ts');
  expect(ignoredFiles).toContain('apps/vscode/settings.example.json');
  expect(ignoredFiles).not.toContain('assets/icon.png');
  expect(ignoredFiles).not.toContain('assets/preview.png');
  expect(ignoredFiles).not.toContain('source/**');
});

test('generated Island broker contract exposes only runtime discovery defaults', () => {
  expect(DEFAULT_ISLAND_BROKER_PATHS).toEqual([
    '/usr/lib/tyrian-night/islandBroker.js',
    '/usr/local/lib/tyrian-night/islandBroker.js',
  ]);
  expect(DEFAULT_ISLAND_BROKER_ASSET_ROOTS).toEqual([
    '/usr/share/tyrian-night/vscode/island',
    '/usr/local/share/tyrian-night/vscode/island',
  ]);
  expect(ISLAND_BROKER_CHMOD_PATH).toBe('/usr/bin/chmod');
  expect(ISLAND_BROKER_CHOWN_PATH).toBe('/usr/bin/chown');
  expect(ISLAND_BROKER_NODE_PATH).toBe('/usr/bin/node');
  expect(ISLAND_BROKER_PKEXEC_PATH).toBe('/usr/bin/pkexec');
});

test('source theme catalog owns identity only and marks one explicit default', () => {
  const catalog = readJson<Array<Record<string, unknown>>>('source/themeCatalog.json');
  const defaultEntries = catalog.filter((entry) => entry.default === true);

  expect(defaultEntries).toEqual([
    expect.objectContaining({
      label: 'Tyrian Night',
      slug: 'tyrian-night',
    }),
  ]);

  for (const entry of catalog) {
    expect(entry).not.toHaveProperty('sourcePath');
    expect(entry).not.toHaveProperty('vscodeContributionPath');
    expect(entry).not.toHaveProperty('islandCssFile');
    expect(entry).not.toHaveProperty('islandCssPath');
    expect(entry).not.toHaveProperty('paletteName');
  }
});

test('generated theme catalog default does not depend on source catalog position', () => {
  expect(TYRIAN_THEME_CATALOG.find((theme) => theme.isDefault)?.label).toBe('Tyrian Night');
});

test('VS Code companion settings example is parseable and aligned with Tyrian defaults', () => {
  const settings = readJson<Record<string, unknown>>('apps/vscode/settings.example.json');

  expect(settings['workbench.colorTheme']).toBe('Tyrian Night');
  expect(settings['editor.fontFamily']).toBe(
    "'Monaspace Neon var', 'JetBrains Mono', 'IBM Plex Mono', monospace"
  );
  expect(settings['editor.fontLigatures']).toContain('ss10');
  expect(settings['editor.inlayHints.fontFamily']).toBe(
    "'Monaspace Radon var', 'Monaspace Neon var', 'IBM Plex Mono', 'SF Mono', monospace"
  );
  expect(settings['editor.lineHeight']).toBe(1.5);
  expect(settings['terminal.integrated.defaultProfile.linux']).toBe('fish');
  expect(settings['terminal.integrated.cursorStyle']).toBe('line');
  expect(settings['terminal.integrated.cursorWidth']).toBe(2);
  expect(settings['terminal.integrated.fontFamily']).toBe(
    "'Monaspace Neon var', 'IBM Plex Mono', monospace"
  );
  expect(settings['files.associations']).toEqual({
    '*.css': 'tailwindcss',
  });
  expect(settings).not.toHaveProperty('java.configuration.runtimes');
  expect(settings).not.toHaveProperty('java.jdt.ls.java.home');
  expect(settings).not.toHaveProperty('chat.tools.urls.autoApprove');
  expect(settings).not.toHaveProperty('vscord.status.details.text.editing');
  expect(settings).not.toHaveProperty('vscord.status.details.text.viewing');
});

test('preview source advertises the default Night preset', () => {
  const previewSource = fs.readFileSync('assets/preview.ts', 'utf8');

  expect(previewSource).toContain("dark: 'Tyrian Night'");
  expect(previewSource).toContain('# Tyrian Night');
  expect(previewSource).toContain("defaultMode: ThemeMode = 'night'");
  expect(previewSource).toContain("renderPreview('night')");
  expect(previewSource).not.toContain("defaultMode: ThemeMode = 'nocturne'");
  expect(previewSource).not.toContain("renderPreview('nocturne')");
});

test('repo does not keep stale packaged VSIX artifacts as proof surfaces', () => {
  expect(fs.readdirSync('.').filter((fileName) => fileName.endsWith('.vsix'))).toEqual([]);
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
  expect(manifest.scripts.verify).toContain('bun run build:generated');
  expect(manifest.scripts.verify).toContain('bun run check:generated');
  expect(manifest.scripts.verify).toContain('bun run check:rice');
  expect(manifest.scripts['build:generated']).toContain('bun run build:contracts');
  expect(manifest.scripts['build:generated']).toContain('bun run build:island-css');
  expect(manifest.scripts['build:generated']).toContain('bun run build:zed-theme');
  expect(manifest.scripts['build:generated']).toContain('bun run build:terminal-themes');
  expect(manifest.scripts['build:generated']).toContain('bun run build:desktop-themes');
  expect(manifest.scripts['check:generated']).toContain('bun run check:contracts');
  expect(manifest.scripts['check:generated']).toContain('bun run check:island-css');
  expect(manifest.scripts['check:generated']).toContain('bun run check:terminal-themes');
  expect(manifest.scripts['check:generated']).toContain('bun run check:desktop-themes');
  expect(manifest.scripts['install:island-broker']).toBeUndefined();
  expect(manifest.scripts['install:island-broker:apply']).toBeUndefined();
  expect(manifest.scripts.build).toBe('bun run build:generated && tsup');
  expect(manifest.scripts['package:check']).toBe('bun run verify && bun run build');
  expect(manifest.scripts.package).toBe(
    'bun run package:check && mkdir -p dist && vsce package --no-dependencies --out dist/tyrian-night.vsix'
  );
  expect(manifest.scripts.package).toContain('--out dist/tyrian-night.vsix');
  expect(manifest.scripts.package).not.toContain('/tmp/npm');
  expect(manifest.devDependencies['@types/node']).toBe('^22.19.17');
  expect(manifest).not.toHaveProperty('dependencies');
  expect(manifest).toHaveProperty('overrides.picomatch', '^4.0.4');
  expect(manifest.scripts.lint).toContain('apps/vscode/src/');
  expect(manifest.scripts.lint).toContain('scripts/');
  expect(tsconfig.compilerOptions.allowJs).toBe(true);
  expect(tsconfig.compilerOptions.checkJs).toBe(true);
  expect(tsconfig.include).toContain('apps/vscode/src');
  expect(tsconfig.include).toContain('scripts');
  expect(tsupConfig).toContain("VSCODE_EXTENSION_HOST_NODE_TARGET = 'node22'");
  expect(tsupConfig).toContain('apps/vscode/src/extension.ts');
  expect(tsupConfig).toContain('apps/vscode/src/islandBroker.ts');
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

function pathBasename(filePath: string, extension: string): string {
  return filePath.replace(/^\.\//, '').split('/').at(-1)!.slice(0, -extension.length);
}
