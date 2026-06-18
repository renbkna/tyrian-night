// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SOURCE_THEMES } from './themeSources.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const themeCatalogOutputPath = 'apps/vscode/src/generated/themeCatalog.ts';
const brokerContractOutputPath = 'apps/vscode/src/generated/islandBrokerInstallContract.ts';

/**
 * @typedef {{ label: string; path: string; uiTheme: string }} VscodeThemeContribution
 * @typedef {{
 *   brokerScriptName: string;
 *   assetRoots: string[];
 *   brokerLibRoots: string[];
 *   chmodPath: string;
 *   chownPath: string;
 *   nodePath: string;
 *   pkexecPath: string;
 * }} IslandBrokerRuntimeContract
 */

const ISLAND_BROKER_RUNTIME_CONTRACT = /** @type {IslandBrokerRuntimeContract} */ (
  readJson('source/islandBrokerInstallContract.json')
);
const DEFAULT_SOURCE_THEME = defaultSourceTheme();

/**
 * @param {string} filePath
 * @returns {unknown}
 */
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, filePath), 'utf8'));
}

/**
 * @returns {import('./themeSources.mjs').ThemeSource}
 */
function defaultSourceTheme() {
  const theme = SOURCE_THEMES.find((sourceTheme) => sourceTheme.isDefault);

  if (!theme) {
    throw new Error('Missing default source theme.');
  }

  return theme;
}

/**
 * @param {string} filePath
 * @param {string} content
 * @param {boolean} check
 * @returns {string[]}
 */
function writeOrCheck(filePath, content, check) {
  const absolutePath = path.join(repoRoot, filePath);

  if (check) {
    const current = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : '';
    return current === content ? [] : [filePath];
  }

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf8');
  return [];
}

/**
 * @returns {VscodeThemeContribution[]}
 */
export function buildVscodeThemeContributions() {
  return SOURCE_THEMES.map((theme) => ({
    label: theme.label,
    uiTheme: theme.vscodeUiTheme,
    path: theme.vscodeContributionPath,
  }));
}

/**
 * @returns {string}
 */
function buildThemeCatalogTs() {
  return `export const TYRIAN_THEME_CATALOG = [
${SOURCE_THEMES.map((theme) => `${formatThemeEntry(theme)},`).join('\n')}
] as const;

export type TyrianThemeCatalogEntry = (typeof TYRIAN_THEME_CATALOG)[number];
export type TyrianThemeLabel = TyrianThemeCatalogEntry['label'];

export const DEFAULT_TYRIAN_THEME_LABEL = ${formatTsString(DEFAULT_SOURCE_THEME.label)};

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
 * @returns {string}
 */
function buildBrokerContractTs() {
  const brokerPaths = ISLAND_BROKER_RUNTIME_CONTRACT.brokerLibRoots.map((root) =>
    path.posix.join(root, ISLAND_BROKER_RUNTIME_CONTRACT.brokerScriptName)
  );

  return `export const DEFAULT_ISLAND_BROKER_PATHS = [
${brokerPaths.map((brokerPath) => `  ${formatTsString(brokerPath)},`).join('\n')}
] as const;
export const DEFAULT_ISLAND_BROKER_ASSET_ROOTS = [
${ISLAND_BROKER_RUNTIME_CONTRACT.assetRoots.map((root) => `  ${formatTsString(root)},`).join('\n')}
] as const;
export const ISLAND_BROKER_CHMOD_PATH = ${formatTsString(ISLAND_BROKER_RUNTIME_CONTRACT.chmodPath)};
export const ISLAND_BROKER_CHOWN_PATH = ${formatTsString(ISLAND_BROKER_RUNTIME_CONTRACT.chownPath)};
export const ISLAND_BROKER_NODE_PATH = ${formatTsString(ISLAND_BROKER_RUNTIME_CONTRACT.nodePath)};
export const ISLAND_BROKER_PKEXEC_PATH = ${formatTsString(ISLAND_BROKER_RUNTIME_CONTRACT.pkexecPath)};
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
    sourcePath: ${formatTsString(theme.sourcePath)},
    vscodeContributionPath: ${formatTsString(theme.vscodeContributionPath)},
    vscodeUiTheme: ${formatTsString(theme.vscodeUiTheme)},
    islandCssFile: ${formatTsString(theme.islandCssFile)},
    islandCssPath: ${formatTsString(theme.islandCssPath)},
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
 * @param {boolean} check
 * @returns {string[]}
 */
function syncPackageThemeContributions(check) {
  const packagePath = path.join(repoRoot, 'package.json');
  const packageJson = /** @type {{ contributes?: { themes?: VscodeThemeContribution[] } }} */ (
    readJson('package.json')
  );
  const expected = buildVscodeThemeContributions();

  if (check) {
    return JSON.stringify(packageJson.contributes?.themes) === JSON.stringify(expected)
      ? []
      : ['package.json contributes.themes'];
  }

  packageJson.contributes ??= {};
  packageJson.contributes.themes = expected;
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
  return [];
}

/**
 * @param {{ check?: boolean }} [options]
 * @returns {string[]}
 */
export function syncGeneratedContracts(options = {}) {
  const check = options.check ?? false;

  return [
    ...writeOrCheck(themeCatalogOutputPath, buildThemeCatalogTs(), check),
    ...writeOrCheck(brokerContractOutputPath, buildBrokerContractTs(), check),
    ...syncPackageThemeContributions(check),
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const staleSurfaces = syncGeneratedContracts({ check: process.argv.includes('--check') });

  if (staleSurfaces.length > 0) {
    console.error(`Generated contract surfaces are stale: ${staleSurfaces.join(', ')}`);
    process.exit(1);
  }
}
