import { readSourceData, writeSourceData } from '../support/sourceData.js';
import { SOURCE_THEMES } from '../support/themes.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { TYRIAN_THEME_CATALOG } from '../../apps/vscode/src/generated/themeCatalog.js';
import { syncGeneratedContracts } from '../../scripts/generatedContracts.mjs';
import { getDefaultThemeSource } from '../../scripts/themeSources.mjs';
import { syncVscodePackageAssets } from '../../scripts/vscodePackageAssets.mjs';

type ExtensionPackage = {
  contributes: { themes: Array<{ label: string; path: string; uiTheme: string }> };
};

const VSCODE_ROOT = 'apps/vscode';
const VSCODE_PACKAGE_PATH = path.join(VSCODE_ROOT, 'package.json');

test('manifest declares the VS Code host and contribution contracts this extension depends on', () => {
  const manifest = readJson<ExtensionPackage>(VSCODE_PACKAGE_PATH);

  expect(manifest.contributes.themes).toEqual(
    SOURCE_THEMES.map((source) => ({
      label: source.label,
      uiTheme: source.vscodeUiTheme,
      path: source.vscodeContributionPath,
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

test('VS Code contribution generation resolves the injected catalog root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-contract-root-'));

  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    fs.mkdirSync(path.join(root, 'apps/vscode'), { recursive: true });
    fs.writeFileSync(path.join(root, VSCODE_PACKAGE_PATH), '{"contributes":{}}\n');
    const themePath = path.join(root, 'source/themes/tyrian-night.cjs');
    const theme = readSourceData<Record<string, unknown>>(themePath);
    theme.name = 'Injected Tyrian Night';
    writeSourceData(themePath, theme);

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

  expect(settings['workbench.colorTheme']).toBe(getDefaultThemeSource(SOURCE_THEMES).label);
});

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function resolveVscodePackagePath(filePath: string): string {
  return path.join(VSCODE_ROOT, filePath);
}

function pathBasename(filePath: string, extension: string): string {
  return path.basename(filePath, extension);
}
