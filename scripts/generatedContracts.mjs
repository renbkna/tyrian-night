// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { syncGeneratedAssets } from './generatedAssets.mjs';
import { getDefaultThemeSource, readThemeSources } from './themeSources.mjs';

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const themeCatalogOutputPath = 'apps/vscode/src/generated/themeCatalog.ts';
const GENERATED_CONTRACT_OWNERSHIP = [{ directory: 'apps/vscode/src/generated' }];
const PACKAGE_RUNTIME_PREFIX_FILES = ['LICENSE', 'README.md'];
const PACKAGE_RUNTIME_SUFFIX_FILES = [
  'assets/icon.png',
  'assets/preview.png',
  'out/extension.js',
  'out/islandCli.js',
];

/**
 * @typedef {{ label: string; path: string; uiTheme: string }} VscodeThemeContribution
 */

/**
 * @param {string} root
 * @param {string} filePath
 * @returns {unknown}
 */
function readJson(root, filePath) {
  return JSON.parse(fs.readFileSync(path.join(root, filePath), 'utf8'));
}

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
 * @param {string} root
 * @param {boolean} check
 * @param {ReadonlyArray<import('./themeSources.mjs').ThemeSource>} sourceThemes
 * @returns {string[]}
 */
function syncPackageThemeContracts(root, check, sourceThemes) {
  const packagePath = path.join(root, 'package.json');
  const packageJson =
    /** @type {{ contributes?: { themes?: VscodeThemeContribution[] }; files?: string[] }} */ (
      readJson(root, 'package.json')
    );
  const expectedContributions = vscodeThemeContributions(sourceThemes);
  const expectedFiles = [
    ...PACKAGE_RUNTIME_PREFIX_FILES,
    ...sourceThemes.map(({ islandCssPath }) => islandCssPath),
    ...PACKAGE_RUNTIME_SUFFIX_FILES,
    ...sourceThemes.map(({ sourcePath }) => sourcePath),
  ];

  if (check) {
    return [
      ...(JSON.stringify(packageJson.contributes?.themes) === JSON.stringify(expectedContributions)
        ? []
        : ['package.json contributes.themes']),
      ...(JSON.stringify(packageJson.files) === JSON.stringify(expectedFiles)
        ? []
        : ['package.json files']),
    ];
  }

  packageJson.contributes ??= {};
  packageJson.contributes.themes = expectedContributions;
  packageJson.files = expectedFiles;
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
  return [];
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
  ];

  return [
    ...syncGeneratedAssets(generatedContracts, root, {
      check,
      ownership: GENERATED_CONTRACT_OWNERSHIP,
    }),
    ...syncPackageThemeContracts(root, check, sourceThemes),
  ];
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
