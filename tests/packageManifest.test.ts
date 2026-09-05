import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { TYRIAN_THEME_CATALOG } from '../apps/vscode/src/generated/themeCatalog';
import { THEME_MODES, ThemePreviewController, buildThemePreviewContract } from '../assets/preview';
import {
  buildVscodeThemeContributions,
  syncGeneratedContracts,
} from '../scripts/generatedContracts.mjs';
import { terminalColor } from '../scripts/themeDefinition.mjs';
import {
  SOURCE_THEMES,
  getDefaultThemeSource,
  loadThemeRepository,
  readSourceTheme,
} from '../scripts/themeSources.mjs';
import { syncVscodePackageAssets } from '../scripts/vscodePackageAssets.mjs';

type ExtensionPackage = {
  activationEvents?: string[];
  contributes: {
    commands: Array<{ command: string }>;
    themes: Array<{ label: string; path: string; uiTheme: string }>;
  };
  description: string;
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
const VSCODE_PACKAGE_PATH = path.join(VSCODE_ROOT, 'package.json');

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

test('source theme catalog owns ordered membership and terminal defaults; family owns canonical default', () => {
  const catalog = readJson<Array<Record<string, unknown>>>('source/themeCatalog.json');
  const family = loadThemeRepository().definition.familyContract;
  const terminalDefaultEntries = catalog.filter((entry) => entry.terminalDefault === true);

  expect(family.canonical).toBe('tyrian-nocturne');
  expect(catalog.some((entry) => Object.hasOwn(entry, 'default'))).toBe(false);
  expect(terminalDefaultEntries.map(({ slug }) => slug)).toEqual([
    'tyrian-nocturne',
    'tyrian-dawn',
  ]);

  for (const entry of catalog) {
    expect(Object.keys(entry).toSorted()).toEqual(
      Object.keys(entry)
        .filter((key) => ['slug', 'terminalDefault'].includes(key))
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
  expect(TYRIAN_THEME_CATALOG.find((theme) => theme.isDefault)?.label).toBe('Tyrian Nocturne');
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
      'apps/vscode/package.json',
      'apps/vscode/src/generated/themeCatalog.ts',
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

test('generated contracts cannot redirect the mixed-authority package manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-contract-symlink-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-contract-outside-'));

  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    fs.mkdirSync(path.join(root, 'apps/vscode'), { recursive: true });
    const outsidePackage = path.join(outside, 'package.json');
    const outsideContent = '{"name":"outside","contributes":{},"files":[]}\n';
    fs.writeFileSync(outsidePackage, outsideContent);
    fs.symlinkSync(outsidePackage, path.join(root, VSCODE_PACKAGE_PATH));

    expect(() => syncGeneratedContracts(root)).toThrow('Generated path must not contain symlinks');
    expect(fs.readFileSync(outsidePackage, 'utf8')).toBe(outsideContent);
    expect(fs.existsSync(path.join(root, 'apps/vscode/src/generated/themeCatalog.ts'))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('VS Code companion settings example is parseable and aligned with Tyrian defaults', () => {
  const settings = readJson<Record<string, unknown>>('apps/vscode/settings.example.json');

  expect(settings['workbench.colorTheme']).toBe(getDefaultThemeSource().label);
  expect(settings['editor.fontFamily']).toBe(
    "'Monaspace Neon var', 'JetBrains Mono', 'IBM Plex Mono', monospace"
  );
  expect(settings['editor.fontLigatures']).toContain('ss10');
  expect(settings['editor.inlayHints.fontFamily']).toBe(
    "'Monaspace Radon var', 'Monaspace Neon var', 'IBM Plex Mono', 'SF Mono', monospace"
  );
  expect(settings['editor.lineHeight']).toBe(1.5);
  expect(settings['editor.semanticHighlighting.enabled']).toBe('configuredByTheme');
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
  const controller = new ThemePreviewController(process.cwd());

  expect(THEME_MODES).toEqual(SOURCE_THEMES.map(({ slug }) => slug.replace(/^tyrian-/u, '')));
  expect(ThemePreviewController.defaultMode).toBe(
    getDefaultThemeSource().slug.replace(/^tyrian-/u, '')
  );

  for (const [index, mode] of THEME_MODES.entries()) {
    const source = SOURCE_THEMES[index]!;
    await controller.readThemeManifest(mode);
    const summary = controller.summarize(mode);

    expect(summary).toContain(`mode=${mode}`);
    expect(summary).toContain(previewAnsiPrefix(source.slug));
    expect(summary).toContain(`"${source.appearance}": "${source.label}"`);
    expect(summary).toContain(`# ${source.label}`);
  }
});

test('preview membership, order, and default project the supplied source catalog', () => {
  const sourceThemes = SOURCE_THEMES.toReversed().map((source) => ({
    ...source,
    isDefault: source.slug === 'tyrian-dawn',
  }));

  expect(buildThemePreviewContract(sourceThemes)).toEqual({
    modes: sourceThemes.map(({ slug }) => slug.replace(/^tyrian-/u, '')),
    defaultMode: 'dawn',
  });
});

test('public family copy projects every catalog member', () => {
  const rootReadme = fs.readFileSync('README.md', 'utf8');
  const vscodeReadme = fs.readFileSync('apps/vscode/README.md', 'utf8');
  const vscodeDescription = readJson<ExtensionPackage>(VSCODE_PACKAGE_PATH).description;
  const zedManifest = fs.readFileSync('apps/zed/extension.toml', 'utf8');
  const countWord = numberWord(SOURCE_THEMES.length);

  expect(rootReadme).toContain(`The ${countWord} variants`);
  expect(vscodeReadme).toContain(`provides ${countWord} generated VS Code color themes`);

  for (const { label } of SOURCE_THEMES) {
    const shortLabel = label.replace(/^Tyrian /u, '');
    expect(rootReadme).toContain(`**${label}**`);
    expect(vscodeReadme).toContain(`**${shortLabel}**`);
    expect(vscodeDescription).toContain(shortLabel);
    expect(zedManifest).toContain(shortLabel);
  }
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
  const trackedGeneratedChecks = workspace.scripts['check:tracked-generated'].split(' && ');
  expect(trackedGeneratedChecks).toEqual(
    expect.arrayContaining([
      'bun run check:contracts',
      'bun run check:vscode-themes',
      'bun run check:zed-theme',
      'bun run check:theme-preview',
    ])
  );
  expect(workspace.scripts['test:isolated']).toBe('bun test --isolate');
  for (const scriptName of [
    'test',
    'verify',
    'verify:vscode',
    'verify:vscode-portable',
    'verify:desktop',
  ]) {
    expect(workspace.scripts[scriptName]).toContain('bun run test:isolated');
    expect(workspace.scripts[scriptName]).not.toContain('bun test ');
  }
  const trackedGeneratedGate = workspace.scripts['precommit:tracked-generated'];
  expect(trackedGeneratedGate).toStartWith('bun run check:tracked-generated && ');
  for (const pathspec of [
    '.oxlintrc.json',
    'source/themeCatalog.json',
    'source/themeFamilyContract.json',
    'source/themeOpacityContract.json',
    'source/themePigmentPolicy.json',
    'source/themeSafetyContract.json',
    'source/themes/*.json',
    'scripts/colorScience.mjs',
    'scripts/colorVision.mjs',
    'scripts/vscodeProjection.mjs',
    'scripts/themePreview.mjs',
    'scripts/themeSources.mjs',
    'scripts/zedTheme.mjs',
    'apps/vscode/src/generated/*.ts',
    'apps/vscode/themes/*.json',
    'apps/zed/themes/*.json',
    'examples/theme-preview/*',
    'examples/theme-preview/generated/*.js',
  ]) {
    expect(trackedGeneratedGate).toContain(pathspec);
  }
  expect(trackedGeneratedGate.match(/scripts\/zedTheme\.mjs/gu)).toHaveLength(2);
  expect(trackedGeneratedGate.match(/scripts\/vscodeProjection\.mjs/gu)).toHaveLength(2);
  for (const { slug } of SOURCE_THEMES) {
    expect(trackedGeneratedGate).not.toContain(`apps/vscode/themes/${slug}.json`);
  }
  expect(trackedGeneratedGate).toContain(
    'git diff --quiet -- source/themeCatalog.json source/themeRoleContract.json'
  );
  expect(workspace).not.toHaveProperty('simple-git-hooks');
  expect(workspace.devDependencies).not.toHaveProperty('simple-git-hooks');
  expect(workspace.devDependencies).not.toHaveProperty('@vscode/vsce');
  expect(workspace.devDependencies).not.toHaveProperty('@types/vscode');
  expect(workspace.devDependencies).not.toHaveProperty('tsup');
  expect(workspace.scripts.verify).toContain('bun run check:generated');
  expect(workspace.scripts.verify).toContain('bun run check:rice');
  const verifySteps = workspace.scripts.verify.split(' && ');
  expect(verifySteps[0]).toBe('bun run check:tracked-generated');
  expect(verifySteps.indexOf('bun run check:tracked-generated')).toBeLessThan(
    verifySteps.indexOf('bun run build:generated')
  );
  expect(verifySteps).toContain('bun run test:isolated ./tests');
  expect(fs.existsSync('tests/zedExtension.test.ts')).toBe(true);
  expect(workspace.scripts['build:generated']).toContain('bun run build:vscode-package-assets');
  expect(workspace.scripts['build:generated']).toContain('bun run build:theme-preview');
  expect(workspace.scripts['check:generated']).toContain('bun run check:vscode-package-assets');
  expect(workspace.scripts['check:generated']).toContain('bun run check:theme-preview');
  expect(workspace.scripts.build).toBe(
    'bun run build:generated && bun run --cwd apps/vscode bundle'
  );
  expect(workspace.scripts.watch).toBe('bun run --cwd apps/vscode watch');
  expect(workspace.scripts.package).toBe('bun run package:vscode');
  expect(workspace.scripts['package:check']).toBeUndefined();
  expect(workspace.scripts['build:vscode']).toBeUndefined();
  expect(workspace.scripts['watch:vscode']).toBeUndefined();
  expect(workspace.scripts['package:vscode']).toBe(
    'bun run verify:vscode && bun run --cwd apps/vscode package:artifact'
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
  expect(extension.scripts.lint).toBe('oxlint -c ../../.oxlintrc.json src/');
  expect(extension.scripts.bundle).toContain('bun build --target=node');
  expect(extension.scripts.bundle).toContain('--format=esm');
  expect(extension.scripts.bundle).toContain('--external=vscode');
  expect(extension.scripts.bundle).toContain('--sourcemap=none');
  expect(extension.scripts.bundle).toContain("rmSync('out', { recursive: true, force: true })");
  expect(extension.scripts.watch).toBe('bun run bundle -- --watch');
  expect(extension.scripts.build).toEndWith('bun run bundle');
  expect(extension.scripts.package).toBe(
    'bun run check && bun run build && bun run package:artifact'
  );
  expect(extension.scripts['package:artifact']).toContain(
    "mkdirSync('../../dist', { recursive: true })"
  );
  expect(extension.scripts['package:artifact']).toContain('vsce package --no-dependencies');
  expect(extension.scripts['package:artifact']).toContain('--out ../../dist/tyrian-night.vsix');
  expect(extension.scripts['package:verified']).toBeUndefined();
  expect(extension.devDependencies['@vscode/vsce']).toBe('^3.9.1');
  expect(extension.devDependencies.tsup).toBeUndefined();
  expect(extension).not.toHaveProperty('dependencies');
  expect(extension).not.toHaveProperty('simple-git-hooks');
  expect(lockfile).toMatch(/"":\s*\{\s*"name":\s*"tyrian-night-workspace"/u);
  expect(lockfile).toMatch(/"apps\/vscode":\s*\{\s*"name":\s*"tyrian-night"/u);
  expect(lockfile).not.toContain('packages/umbra');
  expect(lockfile).not.toContain('@tyrian-night/umbra');
  expect(lockfile).not.toContain('simple-git-hooks');
  expect(lockfile).not.toContain('tsup');

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
  expect(tsconfig.include).not.toContain('packages/umbra/src');
  expect(ciWorkflow).toContain('bun-version: 1.3.11');
  expect(ciWorkflow).toContain('node-version: 22.19.0');
  expect(ciWorkflow).toContain('run: bun install --frozen-lockfile');
  expect(ciWorkflow).toContain('run: bun run package:vscode');
  expect(ciWorkflow).toContain('run: bun run --cwd apps/vscode package:artifact');
  expect(ciWorkflow).toContain('run: bun run verify');
  expect(ciWorkflow).toContain('windows-latest');
  expect(ciWorkflow).toContain('macos-latest');
});

test('lint policy enforces correctness without documentation or preference rules', () => {
  const workspace = readJson<WorkspacePackage>('package.json');
  const extension = readJson<ExtensionPackage>(VSCODE_PACKAGE_PATH);
  const lintConfig = readJson<{
    categories: Record<string, 'allow' | 'warn' | 'deny'>;
    plugins?: string[];
  }>('.oxlintrc.json');

  expect(workspace.scripts.lint).toContain('-c .oxlintrc.json');
  expect(workspace.scripts['lint:fix']).toContain('-c .oxlintrc.json');
  expect(extension.scripts.lint).toContain('-c ../../.oxlintrc.json');
  expect(lintConfig.categories).toEqual({
    correctness: 'deny',
    suspicious: 'allow',
    pedantic: 'allow',
    perf: 'allow',
    style: 'allow',
    restriction: 'allow',
    nursery: 'allow',
  });
  expect(lintConfig.plugins ?? []).not.toContain('jsdoc');
});

test('git tracking assertion rejects an untracked member of an expanded theme path set', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-tracked-themes-'));

  try {
    fs.mkdirSync(path.join(root, 'source/themes'), { recursive: true });
    const tracked = 'source/themes/tyrian-night.json';
    const untracked = 'source/themes/tyrian-new-member.json';
    fs.writeFileSync(path.join(root, tracked), '{}\n');
    fs.writeFileSync(path.join(root, untracked), '{}\n');
    expect(runGit(root, ['init', '--quiet']).status).toBe(0);
    expect(runGit(root, ['add', tracked]).status).toBe(0);

    expect(runGit(root, ['ls-files', '--error-unmatch', tracked, untracked]).status).not.toBe(0);
    expect(runGit(root, ['add', untracked]).status).toBe(0);
    expect(runGit(root, ['ls-files', '--error-unmatch', tracked, untracked]).status).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  return path.join(VSCODE_ROOT, filePath);
}

function pathBasename(filePath: string, extension: string): string {
  return path.basename(filePath, extension);
}

function numberWord(value: number): string {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];
  const word = words[value];
  if (!word) throw new Error(`No number word for family size ${value}.`);
  return word;
}

function runGit(root: string, args: string[]) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}
