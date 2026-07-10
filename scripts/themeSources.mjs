// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @typedef {'dark' | 'light'} ThemeAppearance
 * @typedef {{
 *   default?: boolean;
 *   slug: string;
 *   terminalDefault?: boolean;
 * }} ThemeCatalogEntry
 * @typedef {{ name: string; type: ThemeAppearance }} ThemeIdentity
 * @typedef {{
 *   appearance: ThemeAppearance;
 *   isDefault: boolean;
 *   isTerminalDefault: boolean;
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

/** @type {ReadonlyArray<ThemeSource>} */
export const SOURCE_THEMES = Object.freeze(
  readThemeSources(repoRoot).map((theme) => Object.freeze(theme))
);

/**
 * @param {string} [root]
 * @returns {ThemeSource[]}
 */
export function readThemeSources(root = repoRoot) {
  const themesDirectory = path.join(root, 'source/themes');
  const themes = normalizeThemeCatalog(
    readJson(path.join(root, 'source/themeCatalog.json')),
    (slug) => {
      const sourcePath = path.join(themesDirectory, `${slug}.json`);
      const stats = fs.lstatSync(sourcePath);

      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error(`Theme source '${slug}' must be a regular file.`);
      }

      return readJson(sourcePath);
    }
  );
  const expectedFiles = new Set(themes.map(({ slug }) => `${slug}.json`));
  const orphanFiles = fs
    .readdirSync(themesDirectory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith('.json') && !expectedFiles.has(entry.name))
    .map(({ name }) => name)
    .toSorted();

  if (orphanFiles.length > 0) {
    throw new Error(`Source theme files are absent from the catalog: ${orphanFiles.join(', ')}.`);
  }

  return themes;
}

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
 * @param {string} [root]
 * @returns {T}
 */
export function readSourceTheme(source, root = repoRoot) {
  return readJson(path.join(root, source.sourcePath));
}

/**
 * @param {unknown} catalog
 * @param {(slug: string) => unknown} readThemeIdentity
 * @returns {ThemeSource[]}
 */
export function normalizeThemeCatalog(catalog, readThemeIdentity) {
  if (!Array.isArray(catalog) || catalog.length === 0) {
    throw new Error('Theme catalog must be a non-empty array.');
  }

  const labels = new Set();
  const slugs = new Set();
  const themes = catalog.map((value, index) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`Theme catalog entry ${index} must be an object.`);
    }

    const entry = /** @type {Partial<ThemeCatalogEntry>} */ (value);
    const slug = requireCatalogString(entry.slug, index, 'slug');
    const unsupportedFields = Object.keys(entry).filter(
      (field) => field !== 'slug' && field !== 'default' && field !== 'terminalDefault'
    );

    if (unsupportedFields.length > 0) {
      throw new Error(
        `Theme catalog entry '${slug}' has unsupported fields: ${unsupportedFields.join(', ')}.`
      );
    }

    if (!/^tyrian-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
      throw new Error(`Theme catalog entry ${index} has an invalid slug '${slug}'.`);
    }

    if (slugs.has(slug)) {
      throw new Error(`Theme catalog slug '${slug}' is duplicated.`);
    }

    if (entry.default !== undefined && typeof entry.default !== 'boolean') {
      throw new Error(`Theme catalog entry '${slug}' has a non-boolean default flag.`);
    }

    if (entry.terminalDefault !== undefined && typeof entry.terminalDefault !== 'boolean') {
      throw new Error(`Theme catalog entry '${slug}' has a non-boolean terminal default flag.`);
    }

    const identityValue = readThemeIdentity(slug);
    if (
      typeof identityValue !== 'object' ||
      identityValue === null ||
      Array.isArray(identityValue)
    ) {
      throw new Error(`Theme source '${slug}' must be an object.`);
    }

    const identity = /** @type {Partial<ThemeIdentity>} */ (identityValue);
    const label = requireThemeName(identity.name, slug);
    if (identity.type !== 'dark' && identity.type !== 'light') {
      throw new Error(`Theme source '${slug}' has an invalid type.`);
    }

    const appearance = identity.type;
    const vscodeUiTheme = /** @type {'vs' | 'vs-dark'} */ (
      appearance === 'light' ? 'vs' : 'vs-dark'
    );

    if (labels.has(label)) {
      throw new Error(`Theme source name '${label}' is duplicated.`);
    }

    labels.add(label);
    slugs.add(slug);

    return {
      appearance,
      isDefault: entry.default === true,
      isTerminalDefault: entry.terminalDefault === true,
      islandCssFile: `${slug}.css`,
      islandCssPath: `apps/vscode/island/${slug}.css`,
      label,
      paletteName: slug.replaceAll('-', '_'),
      slug,
      sourcePath: `source/themes/${slug}.json`,
      vscodeContributionPath: `./source/themes/${slug}.json`,
      vscodeUiTheme,
    };
  });
  const defaultThemes = themes.filter((theme) => theme.isDefault);

  if (defaultThemes.length !== 1) {
    throw new Error(`Expected exactly one default source theme, found ${defaultThemes.length}.`);
  }

  for (const appearance of /** @type {const} */ (['dark', 'light'])) {
    const terminalDefaults = themes.filter(
      (theme) => theme.appearance === appearance && theme.isTerminalDefault
    );

    if (terminalDefaults.length !== 1) {
      throw new Error(
        `Expected exactly one ${appearance} terminal default source theme, found ${terminalDefaults.length}.`
      );
    }
  }

  return themes;
}

/**
 * @param {ReadonlyArray<ThemeSource>} sourceThemes
 * @returns {ThemeSource}
 */
export function getDefaultThemeSource(sourceThemes = SOURCE_THEMES) {
  return requireSingleThemeRole(
    sourceThemes.filter((theme) => theme.isDefault),
    'default source theme'
  );
}

/**
 * @param {ThemeAppearance} appearance
 * @param {ReadonlyArray<ThemeSource>} sourceThemes
 * @returns {ThemeSource}
 */
export function getTerminalDefaultThemeSource(appearance, sourceThemes = SOURCE_THEMES) {
  return requireSingleThemeRole(
    sourceThemes.filter((theme) => theme.appearance === appearance && theme.isTerminalDefault),
    `${appearance} terminal default source theme`
  );
}

/**
 * @param {unknown} value
 * @param {number} index
 * @param {'slug'} field
 * @returns {string}
 */
function requireCatalogString(value, index, field) {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`Theme catalog entry ${index} must have a non-empty ${field}.`);
  }

  return value;
}

/**
 * @param {unknown} value
 * @param {string} slug
 * @returns {string}
 */
function requireThemeName(value, slug) {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`Theme source '${slug}' must have a non-empty name.`);
  }

  return value;
}

/**
 * @param {ThemeSource[]} themes
 * @param {string} role
 * @returns {ThemeSource}
 */
function requireSingleThemeRole(themes, role) {
  if (themes.length !== 1) {
    throw new Error(`Expected exactly one ${role}, found ${themes.length}.`);
  }

  return /** @type {ThemeSource} */ (themes[0]);
}
