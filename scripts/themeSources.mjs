// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @typedef {'dark' | 'light'} ThemeAppearance
 * @typedef {{
 *   appearance: ThemeAppearance;
 *   default?: boolean;
 *   label: string;
 *   slug: string;
 *   vscodeUiTheme: 'vs' | 'vs-dark';
 * }} ThemeCatalogEntry
 * @typedef {{
 *   appearance: ThemeAppearance;
 *   isDefault: boolean;
 *   islandCssFile: string;
 *   islandCssPath: string;
 *   label: string;
 *   paletteName: string;
 *   slug: string;
 *   sourcePath: string;
 *   vscodeContributionPath: string;
 *   vscodeUiTheme: 'vs' | 'vs-dark';
 * }} ThemeSource
 */

/** @type {ThemeSource[]} */
export const SOURCE_THEMES = normalizeThemeCatalog(
  readJson(path.join(repoRoot, 'source/themeCatalog.json'))
);

/**
 * @template T
 * @param {string} filePath
 * @returns {T}
 */
export function readJson(filePath) {
  return /** @type {T} */ (JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

/**
 * @template T
 * @param {ThemeSource} source
 * @param {string} [repoRoot]
 * @returns {T}
 */
export function readSourceTheme(source, repoRoot = process.cwd()) {
  return readJson(path.join(repoRoot, source.sourcePath));
}

/**
 * @param {ThemeCatalogEntry[]} catalog
 * @returns {ThemeSource[]}
 */
export function normalizeThemeCatalog(catalog) {
  const themes = catalog.map((entry) => {
    const slug = entry.slug;

    return {
      appearance: entry.appearance,
      isDefault: entry.default === true,
      islandCssFile: `${slug}.css`,
      islandCssPath: `apps/vscode/island/${slug}.css`,
      label: entry.label,
      paletteName: slug.replaceAll('-', '_'),
      slug,
      sourcePath: `source/themes/${slug}.json`,
      vscodeContributionPath: `./source/themes/${slug}.json`,
      vscodeUiTheme: entry.vscodeUiTheme,
    };
  });
  const defaultThemes = themes.filter((theme) => theme.isDefault);

  if (defaultThemes.length !== 1) {
    throw new Error(`Expected exactly one default source theme, found ${defaultThemes.length}.`);
  }

  return themes;
}
