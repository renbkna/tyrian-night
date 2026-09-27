import {
  SOURCE_THEMES,
  sourceTheme,
  THEME_REPOSITORY,
  VSCODE_PROJECTION,
} from '../support/themes.js';

import { expect, test } from 'bun:test';

import { parseHexColor } from '../../scripts/colorUtils.mjs';
import { themeColor } from '../../scripts/themeDefinition.mjs';
import { buildVscodeTheme } from '../../scripts/vscodeThemes.mjs';

test('theme definitions expose one strict consumer-neutral role contract', () => {
  for (const source of SOURCE_THEMES) {
    const theme = sourceTheme(source);

    expect(Object.keys(theme).toSorted()).toEqual([
      'appearance',
      'brackets',
      'name',
      'syntax',
      'terminal',
      'ui',
      'vscode',
    ]);
    expect(Object.keys(theme.brackets).toSorted()).toEqual([
      ...THEME_REPOSITORY.definition.requiredThemeRoles.brackets,
    ]);
    expect(Object.keys(theme.ui).toSorted()).toEqual([
      ...THEME_REPOSITORY.definition.requiredThemeRoles.ui,
    ]);
    expect(Object.keys(theme.syntax).toSorted()).toEqual([
      ...THEME_REPOSITORY.definition.requiredThemeRoles.syntax,
    ]);
    expect(Object.keys(theme.terminal).toSorted()).toEqual([
      ...THEME_REPOSITORY.definition.requiredThemeRoles.terminal,
    ]);
    expect(Object.keys(theme.vscode).toSorted()).toEqual([
      ...THEME_REPOSITORY.definition.requiredThemeRoles.vscode,
    ]);
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
    const theme = sourceTheme(source);
    const projected = buildVscodeTheme(theme, VSCODE_PROJECTION);

    for (const key of requiredKeys) expect(projected.colors[key]).toBeDefined();
    expect(projected.semanticHighlighting).toBe(false);
    expect(projected).not.toHaveProperty('semanticTokenColors');
    for (const [index, role] of THEME_REPOSITORY.definition.requiredThemeRoles.brackets.entries()) {
      expect(projected.colors[`editorBracketHighlight.foreground${index + 1}`]).toBe(
        themeColor(theme, `brackets:${role}`)
      );
    }
    expect(projected.colors['symbolIcon.constructorForeground']).toBe(
      themeColor(theme, 'syntax:type')
    );
    expect(projected.colors['terminal.ansiMagenta']).toBe(
      themeColor(theme, 'terminal:ansi.magenta')
    );
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
});

test('shared color parser rejects malformed source hex colors', () => {
  for (const malformedColor of ['#GGGGGG', '#12zz34', '#badhex', '#12', '#12345']) {
    expect(() => parseHexColor(malformedColor)).toThrow('Unsupported hex color');
  }
});
