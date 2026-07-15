import { createHash } from 'node:crypto';

import { expect, test } from 'bun:test';

import { SOURCE_THEMES, readSourceTheme, readSourceThemeRecipe } from '../scripts/themeSources.mjs';
import { VSCODE_PROJECTION, uiColor } from '../scripts/themeDefinition.mjs';
import { buildVscodeTheme } from '../scripts/vscodeThemes.mjs';

const FROZEN_LEGACY_V2_SHA256 = 'b906660b139a56decb054037bce3d59f0f4675d8aed90a044630f7fd2845efc8';

test('the family exposes five deliberate visual poles plus one explicit legacy profile', () => {
  expect(SOURCE_THEMES.map(({ slug }) => slug)).toEqual([
    'tyrian-night',
    'tyrian-nocturne',
    'tyrian-pastel',
    'tyrian-abyss',
    'tyrian-dawn',
    'tyrian-night-old',
  ]);

  const current = SOURCE_THEMES.filter(({ slug }) => slug !== 'tyrian-night-old');
  expect(
    current.every((source) => readSourceThemeRecipe(source).bindingProfile === 'current')
  ).toBe(true);
  const legacySource = SOURCE_THEMES.find(({ slug }) => slug === 'tyrian-night-old');
  expect(legacySource).toBeDefined();
  expect(readSourceThemeRecipe(legacySource!).bindingProfile).toBe('legacy');

  const themes = current.map((source) => readSourceTheme(source));
  expect(new Set(themes.map((theme) => uiColor(theme, 'surface.canvas'))).size).toBe(themes.length);
  expect(new Set(themes.map((theme) => uiColor(theme, 'accent.primary'))).size).toBe(themes.length);
});

test('the legacy schema migration preserves the complete resolved v2 palette', () => {
  const source = SOURCE_THEMES.find(({ slug }) => slug === 'tyrian-night-old');
  expect(source).toBeDefined();
  const legacy = readSourceTheme(source!);
  const historicalPalette = structuredClone(legacy);
  delete historicalPalette.vscode['chrome.statusBar.offlineForeground'];

  const canonical = JSON.stringify(sortJson(historicalPalette));
  expect(createHash('sha256').update(canonical).digest('hex')).toBe(FROZEN_LEGACY_V2_SHA256);
  expect(legacy.vscode['chrome.statusBar.offlineForeground']).toBe('#C09040');
  expect(
    buildVscodeTheme(legacy, VSCODE_PROJECTION).colors['statusBarItem.offlineForeground']
  ).toBe('#C09040');
});

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)])
  );
}
