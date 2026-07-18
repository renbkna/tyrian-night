import fs from 'node:fs';

import { expect, test } from 'bun:test';

import { parseHexColor } from '../scripts/colorUtils.mjs';
import {
  REQUIRED_THEME_ROLES,
  VSCODE_PROJECTION,
  bracketColor,
  syntaxColor,
  terminalColor,
  uiColor,
} from '../scripts/themeDefinition.mjs';
import { SOURCE_THEMES, getDefaultThemeSource, readSourceTheme } from '../scripts/themeSources.mjs';
import { buildVscodeTheme } from '../scripts/vscodeThemes.mjs';

test('theme definitions expose one strict consumer-neutral role contract', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme(source);

    expect(Object.keys(theme).toSorted()).toEqual([
      'appearance',
      'brackets',
      'name',
      'schemaVersion',
      'syntax',
      'terminal',
      'ui',
      'vscode',
    ]);
    expect(Object.keys(theme.brackets).toSorted()).toEqual(REQUIRED_THEME_ROLES.brackets);
    expect(Object.keys(theme.ui).toSorted()).toEqual(REQUIRED_THEME_ROLES.ui);
    expect(Object.keys(theme.syntax).toSorted()).toEqual(REQUIRED_THEME_ROLES.syntax);
    expect(Object.keys(theme.terminal).toSorted()).toEqual(REQUIRED_THEME_ROLES.terminal);
    expect(Object.keys(theme.vscode).toSorted()).toEqual(REQUIRED_THEME_ROLES.vscode);
    expect(theme).not.toHaveProperty('colors');
    expect(theme).not.toHaveProperty('semanticTokenColors');
    expect(theme).not.toHaveProperty('tokenColors');
  }
});

test('VS Code projection owns selectors, scopes, and consumer keys', () => {
  const requiredKeys = [
    'editor.background',
    'editor.foreground',
    'editorInlayHint.foreground',
    'symbolIcon.constructorForeground',
    'terminal.ansiMagenta',
    'diffEditor.insertedTextBackground',
  ];

  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme(source);
    const projected = buildVscodeTheme(theme, VSCODE_PROJECTION);

    for (const key of requiredKeys) expect(projected.colors[key]).toBeDefined();
    for (const [index, role] of REQUIRED_THEME_ROLES.brackets.entries()) {
      expect(projected.colors[`editorBracketHighlight.foreground${index + 1}`]).toBe(
        bracketColor(theme, role)
      );
    }
    expect(projected.semanticTokenColors.parameter.foreground).toBe(syntaxColor(theme, 'data'));
    expect(projected.semanticTokenColors.type.foreground).toBe(syntaxColor(theme, 'type'));
    expect(projected.colors['symbolIcon.constructorForeground']).toBe(syntaxColor(theme, 'type'));
    expect(projected.colors['terminal.ansiMagenta']).toBe(terminalColor(theme, 'ansi.magenta'));
  }
});

test('VS Code projection reserves italics for intended grammar surfaces', () => {
  const italicScopes = VSCODE_PROJECTION.tokenColors
    .filter((token: { fontStyle?: string }) => token.fontStyle?.includes('italic'))
    .flatMap((token: { scope: string[] }) => token.scope);

  expect(italicScopes).toContain('comment');
  expect(italicScopes).toContain('variable.language');
  expect(italicScopes).toContain('markup.italic');
  expect(italicScopes.some((scope: string) => scope.includes('deprecated'))).toBe(false);
  expect(VSCODE_PROJECTION.semanticTokenColors['*.deprecated'].fontStyle).toBe('strikethrough');
});

test('shared color parser rejects malformed source hex colors', () => {
  for (const malformedColor of ['#GGGGGG', '#12zz34', '#badhex', '#12', '#12345']) {
    expect(() => parseHexColor(malformedColor)).toThrow('Unsupported hex color');
  }
});

test('README points to the catalog default authority without duplicating its palette', () => {
  const readme = fs.readFileSync('README.md', 'utf8');
  const theme = readSourceTheme(getDefaultThemeSource());
  const advertisedPalette = [
    uiColor(theme, 'surface.canvas'),
    uiColor(theme, 'surface.hover'),
    uiColor(theme, 'text.primary'),
    syntaxColor(theme, 'keyword'),
    syntaxColor(theme, 'type'),
    syntaxColor(theme, 'function'),
    syntaxColor(theme, 'string'),
    syntaxColor(theme, 'data'),
  ];

  expect(readme).toContain('## Palette');
  expect(readme).toContain('gamut-relative pigment richness');
  expect(readme).toContain('source/themes/tyrian-nocturne.json');
  expect(readme).toContain('examples/theme-preview');
  expect(readme).not.toContain('Umbra');
  expect(readme).not.toContain('CIEDE2000');
  for (const color of advertisedPalette) expect(readme).not.toContain(`\`${color}\``);
});
