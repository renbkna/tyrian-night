import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { TYRIAN_THEME_CATALOG } from '../apps/vscode/src/generated/themeCatalog';
import {
  buildVscodeThemeContributions,
  syncGeneratedContracts,
} from '../scripts/generatedContracts.mjs';
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
  files: string[];
  icon: string;
  main: string;
  scripts: Record<string, string | undefined>;
  'simple-git-hooks': Record<string, string | undefined>;
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
  const manifest = readJson<ExtensionPackage>('package.json');

  expect(manifest.files).toEqual([
    'LICENSE',
    'README.md',
    ...SOURCE_THEMES.map(({ islandCssPath }) => islandCssPath),
    'assets/icon.png',
    'assets/preview.png',
    'out/extension.js',
    'out/islandCli.js',
    ...SOURCE_THEMES.map(({ sourcePath }) => sourcePath),
  ]);
  expect(fs.existsSync('.vscodeignore')).toBe(false);
});

test('source theme catalog owns ordered membership and explicit default roles only', () => {
  const catalog = readJson<Array<Record<string, unknown>>>('source/themeCatalog.json');
  const defaultEntries = catalog.filter((entry) => entry.default === true);
  const terminalDefaultEntries = catalog.filter((entry) => entry.terminalDefault === true);

  expect(defaultEntries).toEqual([
    expect.objectContaining({
      slug: 'tyrian-night',
    }),
  ]);
  expect(terminalDefaultEntries.map(({ slug }) => slug)).toEqual([
    'tyrian-nocturne',
    'tyrian-dawn',
  ]);

  for (const entry of catalog) {
    expect(Object.keys(entry).toSorted()).toEqual(
      Object.keys(entry)
        .filter((key) => ['default', 'slug', 'terminalDefault'].includes(key))
        .toSorted()
    );
    expect(entry).not.toHaveProperty('label');
    expect(entry).not.toHaveProperty('appearance');
    expect(entry).not.toHaveProperty('vscodeUiTheme');
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

test('VS Code contribution generation resolves the injected catalog root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-contract-root-'));

  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"contributes":{}}\n');
    const themePath = path.join(root, 'source/themes/tyrian-night.json');
    const theme = readJson<Record<string, unknown>>(themePath);
    theme.name = 'Injected Tyrian Night';
    fs.writeFileSync(themePath, `${JSON.stringify(theme)}\n`);

    expect(buildVscodeThemeContributions(root)[0]?.label).toBe('Injected Tyrian Night');
    const packageBeforeCheck = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    expect(syncGeneratedContracts(root, { check: true })).toEqual([
      'apps/vscode/src/generated/themeCatalog.ts',
      'package.json contributes.themes',
      'package.json files',
    ]);
    expect(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).toBe(packageBeforeCheck);
    expect(fs.existsSync(path.join(root, 'apps/vscode/src/generated/themeCatalog.ts'))).toBe(false);

    syncGeneratedContracts(root);
    expect(
      fs.readFileSync(path.join(root, 'apps/vscode/src/generated/themeCatalog.ts'), 'utf8')
    ).toContain("label: 'Injected Tyrian Night'");
    expect(
      readJson<{ contributes: { themes: Array<{ label: string }> } }>(
        path.join(root, 'package.json')
      ).contributes.themes[0]?.label
    ).toBe('Injected Tyrian Night');
    expect(readJson<{ files: string[] }>(path.join(root, 'package.json')).files).toContain(
      'source/themes/tyrian-night.json'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test('existing build output exposes only declared runtime entrypoints', () => {
  if (!fs.existsSync('out')) {
    return;
  }

  expect(
    fs
      .readdirSync('out')
      .filter((fileName) => fileName.endsWith('.js'))
      .toSorted()
  ).toEqual(['extension.js', 'islandCli.js']);
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
  expect(manifest.scripts.verify).toStartWith(
    'bun run check:tracked-generated && bun run build:generated'
  );
  expect(manifest.scripts['check:tracked-generated']).toBe(
    'bun run check:contracts && bun run check:zed-theme'
  );
  expect(manifest.scripts['precommit:tracked-generated']).toContain(
    'git diff --quiet -- source/themeCatalog.json source/themes package.json'
  );
  expect(manifest.scripts['precommit:tracked-generated']).toContain(
    'git ls-files --error-unmatch apps/vscode/src/generated/themeCatalog.ts apps/zed/themes/tyrian-night.json'
  );
  expect(manifest['simple-git-hooks']['pre-commit']).toBe(
    'bun run precommit:tracked-generated && bun run verify'
  );
  expect(manifest.scripts.verify).toContain('bun run check:generated');
  expect(manifest.scripts.verify).toContain('bun run check:rice');
  expect(manifest.scripts['build:generated']).toContain('bun run build:contracts');
  expect(manifest.scripts['build:generated']).toContain('bun run build:island-css');
  expect(manifest.scripts['build:generated']).toContain('bun run build:zed-theme');
  expect(manifest.scripts['build:generated']).toContain('bun run build:terminal-themes');
  expect(manifest.scripts['build:generated']).toContain('bun run build:desktop-themes');
  expect(manifest.scripts['build:runtime-generated']).toBe(
    'bun run build:island-css && bun run build:terminal-themes && bun run build:desktop-themes'
  );
  expect(manifest.scripts.test).toBe('bun run build:runtime-generated && bun test ./tests');
  expect(manifest.scripts['check:generated']).toContain('bun run check:contracts');
  expect(manifest.scripts['check:generated']).toContain('bun run check:island-css');
  expect(manifest.scripts['check:generated']).toContain('bun run check:zed-theme');
  expect(manifest.scripts['check:generated']).toContain('bun run check:terminal-themes');
  expect(manifest.scripts['check:generated']).toContain('bun run check:desktop-themes');
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
  expect(tsupConfig).not.toContain("target: 'esnext'");
  expect(ciWorkflow).toContain('bun-version: 1.3.11');
  expect(ciWorkflow).toContain('run: bun install --frozen-lockfile');
  expect(ciWorkflow).toContain('run: bun run package');
});

test('clean clones retain generated projections required by typecheck and Zed development', () => {
  const gitignore = fs.readFileSync('.gitignore', 'utf8');

  expect(gitignore).not.toContain('apps/vscode/src/generated/');
  expect(gitignore).not.toContain('apps/zed/themes/tyrian-night.json');
  expect(fs.existsSync('apps/vscode/src/generated/themeCatalog.ts')).toBe(true);
  expect(fs.existsSync('apps/zed/themes/tyrian-night.json')).toBe(true);
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
