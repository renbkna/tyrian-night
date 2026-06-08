// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @typedef {'dark' | 'light'} ThemeAppearance
 * @typedef {{
 *   appearance: ThemeAppearance;
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
export const SOURCE_THEMES = readJson(path.join(repoRoot, 'source/themeCatalog.json'));

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
