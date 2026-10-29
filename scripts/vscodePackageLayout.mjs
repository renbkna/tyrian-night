// @ts-check

/**
 * Where the VS Code package keeps its files. Paths are relative to the package
 * root, as package.json and the running extension see them; `inVscodePackage`
 * makes one repository-relative.
 */
export const VSCODE_PACKAGE_ROOT = 'apps/vscode';
export const VSCODE_PACKAGE_MANIFEST = 'package.json';
export const VSCODE_GENERATED_SOURCE_DIRECTORY = 'src/generated';
export const VSCODE_THEMES_DIRECTORY = 'themes';
export const VSCODE_ISLAND_DIRECTORY = 'island';
export const VSCODE_ISLAND_BASE_TEMPLATE = `${VSCODE_ISLAND_DIRECTORY}/base.css`;
export const VSCODE_PACKAGE_ICON = 'assets/icon.png';
/**
 * The files the package's `bundle` script writes: `bun build --outdir=out` turns
 * each entry point `src/<name>.ts` into `out/<name>.js`.
 */
export const VSCODE_BUNDLE_FILES = Object.freeze({
  extension: 'out/extension.js',
  islandCli: 'out/islandCli.js',
});

/** @param {string} packagePath */
export function inVscodePackage(packagePath) {
  return `${VSCODE_PACKAGE_ROOT}/${packagePath}`;
}

/** @param {string} slug */
export function vscodeThemeFile(slug) {
  return `${VSCODE_THEMES_DIRECTORY}/${slug}.json`;
}

/** @param {string} cssFile */
export function vscodeIslandCssFile(cssFile) {
  return `${VSCODE_ISLAND_DIRECTORY}/${cssFile}`;
}
