// @ts-check

import { readOwnedGeneratedFile, syncGeneratedAssets } from './generatedAssets.mjs';
import { getDefaultThemeSource, readThemeSources } from './themeSources.mjs';
import { VSCODE_PACKAGE_COPIED_FILES } from './vscodePackageAssets.mjs';
import {
  inVscodePackage,
  VSCODE_BUNDLE_FILES,
  VSCODE_GENERATED_SOURCE_DIRECTORY,
  VSCODE_ISLAND_DIRECTORY,
  VSCODE_PACKAGE_ICON,
  VSCODE_PACKAGE_MANIFEST,
  vscodeIslandCssFile,
  vscodeThemeFile,
} from './vscodePackageLayout.mjs';

const themeCatalogOutputPath = inVscodePackage(
  `${VSCODE_GENERATED_SOURCE_DIRECTORY}/themeCatalog.ts`
);
const packageLayoutOutputPath = inVscodePackage(
  `${VSCODE_GENERATED_SOURCE_DIRECTORY}/packageLayout.ts`
);
const vscodePackagePath = inVscodePackage(VSCODE_PACKAGE_MANIFEST);
const GENERATED_CONTRACT_OWNERSHIP = [
  { directory: inVscodePackage(VSCODE_GENERATED_SOURCE_DIRECTORY) },
  { file: vscodePackagePath },
];

/**
 * @typedef {{ label: string; path: string; uiTheme: string }} VscodeThemeContribution
 */

/**
 * @param {ReadonlyArray<import('./themeSources.mjs').ThemeSource>} sourceThemes
 * @returns {VscodeThemeContribution[]}
 */
function vscodeThemeContributions(sourceThemes) {
  return sourceThemes.map((theme) => ({
    label: theme.label,
    uiTheme: theme.vscodeUiTheme,
    path: `./${vscodeThemeFile(theme.slug)}`,
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

export function isTyrianThemeLabel(theme: string | undefined): theme is TyrianThemeLabel {
  return theme !== undefined && TYRIAN_THEME_CATALOG.some(({ label }) => label === theme);
}

export function getIslandCssFileForTheme(theme: string): string | undefined {
  return TYRIAN_THEME_CATALOG.find(({ label }) => label === theme)?.islandCssFile;
}

export function isTyrianIslandCssFile(cssFile: string): boolean {
  return TYRIAN_THEME_CATALOG.some(({ islandCssFile }) => islandCssFile === cssFile);
}
`;
}

/** @returns {string} */
function buildPackageLayoutTs() {
  return `/** Package-relative path of the bundled Island CLI the extension runs. */
export const ISLAND_CLI_BUNDLE_PATH = ${formatTsString(VSCODE_BUNDLE_FILES.islandCli)};

/** Package-relative directory of the generated Island stylesheets. */
export const ISLAND_CSS_DIRECTORY = ${formatTsString(VSCODE_ISLAND_DIRECTORY)};
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
    islandCssFile: ${formatTsString(theme.islandCssFile)},
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
    /** @type {{ contributes?: { themes?: VscodeThemeContribution[] }; files?: string[]; icon?: string; main?: string }} */ (
      JSON.parse(readOwnedGeneratedFile(root, vscodePackagePath).toString('utf8'))
    );
  const expectedContributions = vscodeThemeContributions(sourceThemes);
  const expectedFiles = [
    'README.md',
    ...Object.keys(VSCODE_PACKAGE_COPIED_FILES),
    ...Object.values(VSCODE_BUNDLE_FILES),
    ...sourceThemes.map(({ islandCssFile }) => vscodeIslandCssFile(islandCssFile)),
    ...sourceThemes.map(({ slug }) => vscodeThemeFile(slug)),
  ];

  packageJson.main = `./${VSCODE_BUNDLE_FILES.extension}`;
  packageJson.icon = VSCODE_PACKAGE_ICON;
  packageJson.contributes ??= {};
  packageJson.contributes.themes = expectedContributions;
  packageJson.files = expectedFiles;
  return {
    path: vscodePackagePath,
    content: `${JSON.stringify(packageJson, null, 2)}\n`,
  };
}

/**
 * @param {string} root
 * @param {{ check?: boolean }} [options]
 * @returns {string[]}
 */
export function syncGeneratedContracts(root, options = {}) {
  const check = options.check ?? false;
  const sourceThemes = readThemeSources(root);
  const generatedContracts = [
    { path: themeCatalogOutputPath, content: buildThemeCatalogTs(sourceThemes) },
    { path: packageLayoutOutputPath, content: buildPackageLayoutTs() },
    buildPackageThemeContractAsset(sourceThemes, root),
  ];

  return syncGeneratedAssets(generatedContracts, root, {
    check,
    ownership: GENERATED_CONTRACT_OWNERSHIP,
  });
}
