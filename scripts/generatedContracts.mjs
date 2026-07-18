// @ts-check

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readOwnedGeneratedFile, syncGeneratedAssets } from './generatedAssets.mjs';
import { getDefaultThemeSource, readThemeSources } from './themeSources.mjs';

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const themeCatalogOutputPath = 'apps/vscode/src/generated/themeCatalog.ts';
const vscodePackagePath = 'apps/vscode/package.json';
const GENERATED_CONTRACT_OWNERSHIP = [{ directory: 'apps/vscode/src/generated' }];
const PACKAGE_RUNTIME_PREFIX_FILES = ['LICENSE', 'README.md'];
const PACKAGE_RUNTIME_SUFFIX_FILES = ['assets/icon.png', 'out/extension.js', 'out/islandCli.js'];

/**
 * @typedef {{ label: string; path: string; uiTheme: string }} VscodeThemeContribution
 */

/**
 * @param {string} [root]
 * @returns {VscodeThemeContribution[]}
 */
export function buildVscodeThemeContributions(root = defaultRepoRoot) {
  return vscodeThemeContributions(readThemeSources(root));
}

/**
 * @param {ReadonlyArray<import('./themeSources.mjs').ThemeSource>} sourceThemes
 * @returns {VscodeThemeContribution[]}
 */
function vscodeThemeContributions(sourceThemes) {
  return sourceThemes.map((theme) => ({
    label: theme.label,
    uiTheme: theme.vscodeUiTheme,
    path: theme.vscodeContributionPath,
  }));
}

/**
 * @param {ReadonlyArray<import('./themeSources.mjs').ThemeSource>} sourceThemes
 * @returns {string}
 */
function buildThemeCatalogTs(sourceThemes) {
  const defaultSourceTheme = getDefaultThemeSource(sourceThemes);

  return `export const TYRIAN_THEME_CATALOG = [
${sourceThemes.map((theme) => `${formatThemeEntry(theme)},`).join('\n')}
] as const;

export type TyrianThemeCatalogEntry = (typeof TYRIAN_THEME_CATALOG)[number];
export type TyrianThemeLabel = TyrianThemeCatalogEntry['label'];

export const DEFAULT_TYRIAN_THEME_LABEL = ${formatTsString(defaultSourceTheme.label)};

export const TYRIAN_THEME_CSS: Record<string, string> = Object.fromEntries(
  TYRIAN_THEME_CATALOG.map((theme) => [theme.label, theme.islandCssFile])
);

export function isTyrianThemeLabel(theme: string | undefined): theme is TyrianThemeLabel {
  return theme !== undefined && Object.hasOwn(TYRIAN_THEME_CSS, theme);
}

export function getIslandCssFileForTheme(theme: string): string | undefined {
  return TYRIAN_THEME_CSS[theme];
}
`;
}

/**
 * @param {import('./themeSources.mjs').ThemeSource} theme
 * @returns {string}
 */
function formatThemeEntry(theme) {
  return `  {
    label: ${formatTsString(theme.label)},
    slug: ${formatTsString(theme.slug)},
    isDefault: ${theme.isDefault},
    vscodeUiTheme: ${formatTsString(theme.vscodeUiTheme)},
    islandCssFile: ${formatTsString(theme.islandCssFile)},
    paletteName: ${formatTsString(theme.paletteName)},
    appearance: ${formatTsString(theme.appearance)},
  }`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function formatTsString(value) {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

/**
 * @param {ReadonlyArray<import('./themeSources.mjs').ThemeSource>} sourceThemes
 * @param {string} root
 * @returns {{ content: string; path: string }}
 */
function buildPackageThemeContractAsset(sourceThemes, root) {
  const packageJson =
    /** @type {{ contributes?: { themes?: VscodeThemeContribution[] }; files?: string[] }} */ (
      JSON.parse(readOwnedGeneratedFile(root, vscodePackagePath).toString('utf8'))
    );
  const expectedContributions = vscodeThemeContributions(sourceThemes);
  const expectedFiles = [
    ...PACKAGE_RUNTIME_PREFIX_FILES,
    ...sourceThemes.map(({ islandCssFile }) => `island/${islandCssFile}`),
    ...PACKAGE_RUNTIME_SUFFIX_FILES,
    ...sourceThemes.map(({ slug }) => `themes/${slug}.json`),
  ];

  packageJson.contributes ??= {};
  packageJson.contributes.themes = expectedContributions;
  packageJson.files = expectedFiles;
  return {
    path: vscodePackagePath,
    content: `${JSON.stringify(packageJson, null, 2)}\n`,
  };
}

/**
 * @param {string} [root]
 * @param {{ check?: boolean }} [options]
 * @returns {string[]}
 */
export function syncGeneratedContracts(root = defaultRepoRoot, options = {}) {
  const check = options.check ?? false;
  const sourceThemes = readThemeSources(root);
  const generatedContracts = [
    { path: themeCatalogOutputPath, content: buildThemeCatalogTs(sourceThemes) },
    buildPackageThemeContractAsset(sourceThemes, root),
  ];

  return syncGeneratedAssets(generatedContracts, root, {
    check,
    ownership: GENERATED_CONTRACT_OWNERSHIP,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const staleSurfaces = syncGeneratedContracts(defaultRepoRoot, {
    check: process.argv.includes('--check'),
  });

  if (staleSurfaces.length > 0) {
    console.error(`Generated contract surfaces are stale: ${staleSurfaces.join(', ')}`);
    process.exit(1);
  }
}
