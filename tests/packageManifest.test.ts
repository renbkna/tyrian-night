import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { TYRIAN_THEME_CATALOG } from '../apps/vscode/src/generated/themeCatalog';
import { ThemePreviewController } from '../assets/preview';
import {
  buildVscodeThemeContributions,
  syncGeneratedContracts,
} from '../scripts/generatedContracts.mjs';
import { terminalColor } from '../scripts/themeDefinition.mjs';
import { SOURCE_THEMES, readSourceTheme } from '../scripts/themeSources.mjs';
import { syncVscodePackageAssets } from '../scripts/vscodePackageAssets.mjs';

type ExtensionPackage = {
  activationEvents?: string[];
  contributes: {
    commands: Array<{ command: string }>;
    themes: Array<{ label: string; path: string; uiTheme: string }>;
  };
  devDependencies: Record<string, string | undefined>;
  engines: {
    node: string;
    vscode: string;
  };
  extensionKind?: string[];
  files: string[];
  icon: string;
  main: string;
  scripts: Record<string, string | undefined>;
};

type WorkspacePackage = {
  private: boolean;
  packageManager: string;
  engines: { node: string };
  workspaces: string[];
  scripts: Record<string, string | undefined>;
  devDependencies: Record<string, string | undefined>;
};

const VSCODE_ROOT = 'apps/vscode';
const VSCODE_PACKAGE_PATH = `${VSCODE_ROOT}/package.json`;

test('manifest declares the VS Code host and contribution contracts this extension depends on', () => {
  const manifest = readJson<ExtensionPackage>(VSCODE_PACKAGE_PATH);
  const extensionSource = fs.readFileSync('apps/vscode/src/extension.ts', 'utf8');

  expect(manifest.engines.vscode).toBe('^1.118.0');
  expect(manifest.extensionKind).toEqual(['ui']);
  expect(manifest.activationEvents).toContain('onStartupFinished');
  expect(fs.existsSync(resolveVscodePackagePath(manifest.icon))).toBe(true);
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
      resolveVscodePackagePath(themeContribution.path)
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
  const manifest = readJson<ExtensionPackage>(VSCODE_PACKAGE_PATH);

  expect(manifest.files).toEqual([
    'LICENSE',
    'README.md',
    ...SOURCE_THEMES.map(({ islandCssFile }) => `island/${islandCssFile}`),
    'assets/icon.png',
    'out/extension.js',
    'out/islandCli.js',
    ...SOURCE_THEMES.map(({ slug }) => `themes/${slug}.json`),
  ]);
  expect(fs.existsSync('assets/preview.png')).toBe(false);
  expect(fs.readFileSync('apps/vscode/README.md', 'utf8')).not.toContain('assets/preview.png');
  expect(fs.existsSync('apps/vscode/.vscodeignore')).toBe(false);
});

test('VS Code package license and icon are exact projections of repository assets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-vscode-package-assets-'));

  try {
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'LICENSE'), 'license source\n');
    fs.writeFileSync(path.join(root, 'assets/icon.png'), Buffer.from([0, 1, 2, 3]));

    expect(syncVscodePackageAssets(root, { check: true })).toEqual([
      'apps/vscode/LICENSE',
      'apps/vscode/assets/icon.png',
    ]);
    syncVscodePackageAssets(root);
    expect(syncVscodePackageAssets(root, { check: true })).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'apps/vscode/LICENSE'), 'utf8')).toBe(
      'license source\n'
    );
    expect(fs.readFileSync(path.join(root, 'apps/vscode/assets/icon.png'))).toEqual(
      Buffer.from([0, 1, 2, 3])
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('VS Code package assets never follow generated targets through symlinks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-vscode-package-symlink-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-vscode-package-outside-'));

  try {
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(root, 'apps/vscode'), { recursive: true });
    fs.writeFileSync(path.join(root, 'LICENSE'), 'license source\n');
    fs.writeFileSync(path.join(root, 'assets/icon.png'), Buffer.from([0, 1, 2, 3]));
    const outsideLicense = path.join(outside, 'LICENSE');
    fs.writeFileSync(outsideLicense, 'outside license\n');
    fs.symlinkSync(outsideLicense, path.join(root, 'apps/vscode/LICENSE'));

    expect(() => syncVscodePackageAssets(root)).toThrow('Generated path must not contain symlinks');
    expect(fs.readFileSync(outsideLicense, 'utf8')).toBe('outside license\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
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
  for (const theme of TYRIAN_THEME_CATALOG) {
    expect(theme).not.toHaveProperty('islandCssPath');
  }
});

test('VS Code contribution generation resolves the injected catalog root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-contract-root-'));

  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    fs.mkdirSync(path.join(root, 'apps/vscode'), { recursive: true });
    fs.writeFileSync(path.join(root, VSCODE_PACKAGE_PATH), '{"contributes":{}}\n');
    const themePath = path.join(root, 'source/themes/tyrian-night.json');
    const theme = readJson<Record<string, unknown>>(themePath);
    theme.name = 'Injected Tyrian Night';
    fs.writeFileSync(themePath, `${JSON.stringify(theme)}\n`);

    expect(buildVscodeThemeContributions(root)[0]?.label).toBe('Injected Tyrian Night');
    const packageBeforeCheck = fs.readFileSync(path.join(root, VSCODE_PACKAGE_PATH), 'utf8');
    expect(syncGeneratedContracts(root, { check: true })).toEqual([
      'apps/vscode/src/generated/themeCatalog.ts',
      'apps/vscode/package.json contributes.themes',
      'apps/vscode/package.json files',
    ]);
    expect(fs.readFileSync(path.join(root, VSCODE_PACKAGE_PATH), 'utf8')).toBe(packageBeforeCheck);
    expect(fs.existsSync(path.join(root, 'apps/vscode/src/generated/themeCatalog.ts'))).toBe(false);

    syncGeneratedContracts(root);
    expect(
      fs.readFileSync(path.join(root, 'apps/vscode/src/generated/themeCatalog.ts'), 'utf8')
    ).toContain("label: 'Injected Tyrian Night'");
    expect(
      readJson<{ contributes: { themes: Array<{ label: string }> } }>(
        path.join(root, VSCODE_PACKAGE_PATH)
      ).contributes.themes[0]?.label
    ).toBe('Injected Tyrian Night');
    expect(readJson<{ files: string[] }>(path.join(root, VSCODE_PACKAGE_PATH)).files).toContain(
      'themes/tyrian-night.json'
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

test('preview output derives palette and identity entirely from the selected mode', async () => {
  const previewSource = fs.readFileSync('assets/preview.ts', 'utf8');
  const controller = new ThemePreviewController(process.cwd());

  expect(previewSource).toContain("defaultMode: ThemeMode = 'night'");
  expect(previewSource).not.toContain("defaultMode: ThemeMode = 'nocturne'");

  await controller.readThemeManifest('night');
  const nightSummary = controller.summarize('night');
  expect(nightSummary).toContain('mode=night');
  expect(nightSummary).toContain(previewAnsiPrefix('tyrian-night'));
  expect(nightSummary).toContain('"dark": "Tyrian Night"');
  expect(nightSummary).toContain('# Tyrian Night');
  expect(nightSummary).not.toContain('Tyrian Dawn');

  await controller.readThemeManifest('dawn');
  const dawnSummary = controller.summarize('dawn');
  expect(dawnSummary).toContain('mode=dawn');
  expect(dawnSummary).toContain(previewAnsiPrefix('tyrian-dawn'));
  expect(dawnSummary).toContain('"light": "Tyrian Dawn"');
  expect(dawnSummary).toContain('# Tyrian Dawn');
  expect(dawnSummary).not.toContain('Tyrian Night');
});

test('repo does not keep stale packaged VSIX artifacts as proof surfaces', () => {
  expect(fs.readdirSync('.').filter((fileName) => fileName.endsWith('.vsix'))).toEqual([]);
});

test('existing build output exposes only declared runtime entrypoints', () => {
  if (!fs.existsSync('apps/vscode/out')) {
    return;
  }

  expect(
    fs
      .readdirSync('apps/vscode/out')
      .filter((fileName) => fileName.endsWith('.js'))
      .toSorted()
  ).toEqual(['extension.js', 'islandCli.js']);
});

test('workspace and product manifests have non-competing release ownership', () => {
  const workspace = readJson<WorkspacePackage>('package.json');
  const extension = readJson<ExtensionPackage>(VSCODE_PACKAGE_PATH);
  const desktop = readJson<{
    engines: { node: string };
    scripts: Record<string, string | undefined>;
    tyrianNight: { supportedPlatforms: string[] };
    version: string;
  }>('apps/desktop/package.json');
  const ciWorkflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
  const lockfile = fs.readFileSync('bun.lock', 'utf8');
  const tsupConfig = fs.readFileSync('apps/vscode/tsup.config.ts', 'utf8');
  const vscodeTsconfig = readJson<{ include: string[] }>('apps/vscode/tsconfig.json');
  const desktopTsconfig = readJson<{ include: string[] }>('apps/desktop/tsconfig.json');
  const tsconfig = readJson<{
    compilerOptions: { allowJs?: boolean; checkJs?: boolean };
    include?: string[];
  }>('tsconfig.json');

  expect(workspace.private).toBe(true);
  expect(workspace.packageManager).toBe('bun@1.3.11');
  expect(workspace.engines.node).toBe('>=22.19.0');
  expect(workspace.workspaces).toEqual(['apps/desktop', 'apps/vscode']);
  expect(workspace).not.toHaveProperty('version');
  expect(workspace).not.toHaveProperty('publisher');
  expect(workspace).not.toHaveProperty('contributes');
  expect(workspace.scripts.verify).toStartWith(
    'bun run check:tracked-generated && bun run build:generated'
  );
  expect(workspace.scripts['check:tracked-generated']).toBe(
    'bun run check:contracts && bun run check:vscode-themes && bun run check:zed-theme'
  );
  expect(workspace.scripts['precommit:tracked-generated']).toContain(
    'git ls-files --error-unmatch source/themeRoleContract.json scripts/themeDefinition.mjs scripts/projections/vscodeColors.json scripts/vscodeThemes.mjs'
  );
  expect(workspace.scripts['precommit:tracked-generated']).toContain(
    'git diff --quiet -- source/themeCatalog.json source/themeRoleContract.json source/themes scripts/themeDefinition.mjs scripts/projections/vscodeColors.json scripts/vscodeThemes.mjs apps/vscode/package.json'
  );
  expect(workspace).not.toHaveProperty('simple-git-hooks');
  expect(workspace.devDependencies).not.toHaveProperty('simple-git-hooks');
  expect(workspace.devDependencies).not.toHaveProperty('@vscode/vsce');
  expect(workspace.devDependencies).not.toHaveProperty('@types/vscode');
  expect(workspace.devDependencies).not.toHaveProperty('tsup');
  expect(workspace.scripts.verify).toContain('bun run check:generated');
  expect(workspace.scripts.verify).toContain('bun run check:rice');
  expect(workspace.scripts['build:generated']).toContain('bun run build:vscode-package-assets');
  expect(workspace.scripts['check:generated']).toContain('bun run check:vscode-package-assets');
  expect(workspace.scripts.build).toBe('bun run build:generated && bun run build:vscode');
  expect(workspace.scripts.package).toBe('bun run package:vscode');
  expect(workspace.scripts['package:vscode']).toBe(
    'bun run verify:vscode && bun run --cwd apps/vscode package'
  );
  expect(workspace.scripts['verify:vscode']).not.toContain('verify:desktop');
  expect(workspace.scripts['verify:vscode']).not.toContain('liveInstall.test.ts');
  expect(workspace.scripts['verify:desktop']).not.toContain('verify:vscode');
  expect(workspace.scripts['verify:desktop']).not.toContain('islandShell.test.ts');
  for (const scriptName of ['verify:vscode', 'verify:vscode-portable', 'verify:desktop']) {
    const declaredTests = [
      ...(workspace.scripts[scriptName]?.matchAll(/\.\/(tests\/[^ ]+\.test\.ts)/gu) ?? []),
    ].map((match) => match[1]!);

    expect(declaredTests.length).toBeGreaterThan(0);
    for (const testPath of declaredTests) {
      expect(fs.existsSync(testPath)).toBe(true);
    }
  }
  expect(workspace.scripts['desktop:recover']).toBe('bun run --cwd apps/desktop recover');
  expect(workspace.scripts['desktop:plasma:preview']).toBe(
    'bun run --cwd apps/desktop plasma:preview'
  );
  expect(workspace.scripts['desktop:caelestia:preview']).toBe(
    'bun run --cwd apps/desktop caelestia:preview'
  );
  expect(workspace.scripts['desktop:preview']).toBeUndefined();
  expect(workspace.scripts['desktop:apply']).toBeUndefined();
  expect(workspace.scripts['rice:recover']).toBe('bun run --cwd apps/desktop rice:recover');
  expect(workspace).toHaveProperty('overrides.picomatch', '^4.0.4');

  expect(extension.scripts['vscode:prepublish']).toBeUndefined();
  expect(extension.scripts.check).toBe('tsc --noEmit --project tsconfig.json');
  expect(extension.scripts.lint).toBe('oxlint src/ tsup.config.ts');
  expect(extension.scripts.build).toContain('tsup');
  expect(extension.scripts.package).toContain('bun run check');
  expect(extension.scripts.package).toContain("mkdirSync('../../dist', { recursive: true })");
  expect(extension.scripts.package).toContain('vsce package --no-dependencies');
  expect(extension.scripts.package).toContain('--out ../../dist/tyrian-night.vsix');
  expect(extension.devDependencies['@vscode/vsce']).toBe('^3.9.1');
  expect(extension.devDependencies.tsup).toBe('^8.5.1');
  expect(extension).not.toHaveProperty('dependencies');
  expect(extension).not.toHaveProperty('simple-git-hooks');
  expect(lockfile).toMatch(/"":\s*\{\s*"name":\s*"tyrian-night-workspace"/u);
  expect(lockfile).toMatch(/"apps\/vscode":\s*\{\s*"name":\s*"tyrian-night"/u);
  expect(lockfile).not.toContain('simple-git-hooks');

  expect(desktop.tyrianNight.supportedPlatforms).toEqual(['linux']);
  expect(desktop.version).toBe('3.0.0');
  expect(desktop.engines.node).toBe('>=22.19.0');
  expect(desktop.scripts['plasma:preview']).toContain('--target=plasma');
  expect(desktop.scripts['plasma:apply']).toContain('--target=plasma --apply');
  expect(desktop.scripts['caelestia:preview']).toContain('--target=caelestia');
  expect(desktop.scripts['caelestia:apply']).toContain('--target=caelestia --apply');
  expect(desktop.scripts.preview).toBeUndefined();
  expect(desktop.scripts.apply).toBeUndefined();
  expect(desktop.scripts.recover).toContain('--recover');
  expect(desktop.scripts['rice:recover']).toContain('--recover');
  expect(desktop.scripts.check).toStartWith('tsc --noEmit --project tsconfig.json');
  expect(vscodeTsconfig.include).toContain('src');
  expect(vscodeTsconfig.include).not.toContain('../../scripts/rice.mjs');
  expect(desktopTsconfig.include).toContain('../../scripts/rice.mjs');
  expect(desktopTsconfig.include).not.toContain('../vscode/src');
  expect(tsconfig.compilerOptions.allowJs).toBe(true);
  expect(tsconfig.compilerOptions.checkJs).toBe(true);
  expect(tsconfig.include).toContain('apps/vscode/src');
  expect(tsconfig.include).toContain('scripts');
  expect(tsupConfig).toContain("VSCODE_EXTENSION_HOST_NODE_TARGET = 'node22'");
  expect(tsupConfig).toContain("entry: ['src/extension.ts', 'src/islandCli.ts']");
  expect(tsupConfig).not.toContain("target: 'esnext'");
  expect(ciWorkflow).toContain('bun-version: 1.3.11');
  expect(ciWorkflow).toContain('node-version: 22.19.0');
  expect(ciWorkflow).toContain('run: bun install --frozen-lockfile');
  expect(ciWorkflow).toContain('run: bun run package:vscode');
  expect(ciWorkflow).toContain('run: bun run verify:desktop');
  expect(ciWorkflow).toContain('windows-latest');
  expect(ciWorkflow).toContain('macos-latest');
});

test('clean clones retain generated projections required by VS Code and Zed development', () => {
  const gitignore = fs.readFileSync('.gitignore', 'utf8');

  expect(gitignore).not.toContain('apps/vscode/src/generated/');
  expect(gitignore).not.toContain('apps/vscode/themes/');
  expect(gitignore).not.toContain('apps/zed/themes/tyrian-night.json');
  expect(fs.existsSync('apps/vscode/src/generated/themeCatalog.ts')).toBe(true);
  expect(fs.existsSync('apps/vscode/themes/tyrian-night.json')).toBe(true);
  expect(fs.existsSync('apps/zed/themes/tyrian-night.json')).toBe(true);
});

function previewAnsiPrefix(slug: string): string {
  const source = SOURCE_THEMES.find((candidate) => candidate.slug === slug);
  expect(source).toBeDefined();
  const theme = readSourceTheme(source!);
  return ['ansi.black', 'ansi.red', 'ansi.green', 'ansi.yellow']
    .map((role) => terminalColor(theme, role))
    .join(' ');
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function resolveVscodePackagePath(filePath: string): string {
  return path.join(VSCODE_ROOT, filePath.replace(/^\.\//, ''));
}

function pathBasename(filePath: string, extension: string): string {
  return filePath.replace(/^\.\//, '').split('/').at(-1)!.slice(0, -extension.length);
}
