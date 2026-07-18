import { createHash } from 'node:crypto';

import { expect, test } from 'bun:test';

import { SOURCE_THEMES, readSourceTheme, readSourceThemeRecipe } from '../scripts/themeSources.mjs';
import { VSCODE_PROJECTION, syntaxColor, uiColor } from '../scripts/themeDefinition.mjs';
import { buildVscodeTheme } from '../scripts/vscodeThemes.mjs';
import { buildZedThemeFamily } from '../scripts/zedTheme.mjs';

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
  delete historicalPalette.vscode['input.validation.errorForeground'];
  delete historicalPalette.vscode['input.validation.infoForeground'];
  delete historicalPalette.vscode['input.validation.warningForeground'];

  const canonical = JSON.stringify(sortJson(historicalPalette));
  expect(createHash('sha256').update(canonical).digest('hex')).toBe(FROZEN_LEGACY_V2_SHA256);
  expect(legacy.vscode['chrome.statusBar.offlineForeground']).toBe('#C09040');
  const vscode = buildVscodeTheme(legacy, VSCODE_PROJECTION).colors;
  expect(vscode['statusBarItem.offlineForeground']).toBe('#C09040');
  expect(vscode['inputValidation.errorForeground']).toBe(legacy.ui['status.error']);
  expect(vscode['inputValidation.infoForeground']).toBe(legacy.ui['status.info']);
  expect(vscode['inputValidation.warningForeground']).toBe(legacy.ui['status.warning']);
});

test('current editor projections share semantic bindings while legacy keeps its compatibility mapping', () => {
  const family = buildZedThemeFamily() as {
    themes: Array<{ name: string; style: { syntax: Record<string, { color: string }> } }>;
  };
  const current = family.themes.find(({ name }) => name === 'Tyrian Nocturne')!;
  const legacy = family.themes.find(({ name }) => name === 'Tyrian Night Old')!;
  const currentSource = SOURCE_THEMES.find(({ slug }) => slug === 'tyrian-nocturne')!;
  const currentTheme = readSourceTheme(currentSource);
  const legacySource = SOURCE_THEMES.find(({ slug }) => slug === 'tyrian-night-old')!;
  const legacyTheme = readSourceTheme(legacySource);
  const currentVscode = buildVscodeTheme(currentTheme, VSCODE_PROJECTION, 'current');
  const legacyVscode = buildVscodeTheme(legacyTheme, VSCODE_PROJECTION, 'legacy');
  const grammarColor = (theme: typeof currentVscode, scope: string) =>
    theme.tokenColors.find((token) => token.scope.includes(scope))!.settings.foreground;

  expect(current.style.syntax.link_uri.color).toBe(syntaxColor(currentTheme, 'file'));
  expect(current.style.syntax.link_uri.color).not.toBe(current.style.syntax.type.color);
  expect(current.style.syntax['constant.builtin'].color).toBe(syntaxColor(currentTheme, 'null'));
  expect(current.style.syntax.boolean.color).toBe(syntaxColor(currentTheme, 'constantLanguage'));
  expect(legacy.style.syntax.link_uri.color).toBe(legacy.style.syntax.type.color);
  expect(legacy.style.syntax['constant.builtin'].color).toBe(legacy.style.syntax.boolean.color);
  expect(grammarColor(currentVscode, 'constant.language.null')).toBe(
    syntaxColor(currentTheme, 'null')
  );
  expect(grammarColor(legacyVscode, 'constant.language.null')).toBe(
    syntaxColor(legacyTheme, 'constantLanguage')
  );
  expect(grammarColor(currentVscode, 'markup.underline.link')).toBe(
    syntaxColor(currentTheme, 'file')
  );
  expect(grammarColor(legacyVscode, 'markup.underline.link')).toBe(
    syntaxColor(legacyTheme, 'type')
  );
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
