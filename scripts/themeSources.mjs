// @ts-check

import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {'dark' | 'light'} ThemeAppearance
 * @typedef {{
 *   appearance: ThemeAppearance;
 *   paletteName: string;
 *   slug: string;
 *   sourcePath: string;
 * }} ThemeSource
 */

/** @type {ThemeSource[]} */
export const SOURCE_THEMES = [
  {
    sourcePath: 'source/themes/tyrian-night.json',
    slug: 'tyrian-night',
    paletteName: 'tyrian_night',
    appearance: 'dark',
  },
  {
    sourcePath: 'source/themes/tyrian-night-old.json',
    slug: 'tyrian-night-old',
    paletteName: 'tyrian_night_old',
    appearance: 'dark',
  },
  {
    sourcePath: 'source/themes/tyrian-abyss.json',
    slug: 'tyrian-abyss',
    paletteName: 'tyrian_abyss',
    appearance: 'dark',
  },
  {
    sourcePath: 'source/themes/tyrian-dawn.json',
    slug: 'tyrian-dawn',
    paletteName: 'tyrian_dawn',
    appearance: 'light',
  },
];

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
