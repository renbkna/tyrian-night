import fs from 'node:fs';

import { expect, test } from 'bun:test';

import { compareColors, contrastRatio } from '../scripts/colorScience.mjs';
import { isTransparentHex, parseHexColor } from '../scripts/colorUtils.mjs';
import {
  REQUIRED_THEME_ROLES,
  VSCODE_PROJECTION,
  syntaxColor,
  terminalColor,
  uiColor,
} from '../scripts/themeDefinition.mjs';
import { SOURCE_THEMES, readSourceTheme } from '../scripts/themeSources.mjs';
import { buildVscodeTheme } from '../scripts/vscodeThemes.mjs';

const AAA_TEXT_CONTRAST = 7;
const AA_TEXT_CONTRAST = 4.5;

test('theme definitions expose one strict consumer-neutral role contract', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme(source);

    expect(Object.keys(theme).toSorted()).toEqual([
      'appearance',
      'name',
      'schemaVersion',
      'syntax',
      'terminal',
      'ui',
      'vscode',
    ]);
    expect(Object.keys(theme.ui).toSorted()).toEqual(REQUIRED_THEME_ROLES.ui);
    expect(Object.keys(theme.syntax).toSorted()).toEqual(REQUIRED_THEME_ROLES.syntax);
    expect(Object.keys(theme.terminal).toSorted()).toEqual(REQUIRED_THEME_ROLES.terminal);
    expect(Object.keys(theme.vscode).toSorted()).toEqual(REQUIRED_THEME_ROLES.vscode);
    expect(theme).not.toHaveProperty('colors');
    expect(theme).not.toHaveProperty('semanticTokenColors');
    expect(theme).not.toHaveProperty('tokenColors');
  }
});

test('consumer-specific VS Code policy is isolated from every other projection', () => {
  for (const filePath of [
    'scripts/zedTheme.mjs',
    'scripts/terminalThemes.mjs',
    'scripts/desktopThemes.mjs',
    'scripts/islandCss.mjs',
    'scripts/colorScience.mjs',
  ]) {
    const source = fs.readFileSync(filePath, 'utf8');
    expect(source).not.toContain('vscodeColor');
    expect(source).not.toContain('.vscode');
    expect(source).not.toContain('vscode:');
  }
});

test('neutral theme roles keep load-bearing text within the contrast contract', () => {
  const foregroundRoles = [
    ['ui', 'status.error'],
    ['ui', 'status.warning'],
    ['ui', 'status.info'],
    ['ui', 'status.success'],
    ['syntax', 'comment'],
    ['terminal', 'ansi.magenta'],
    ['terminal', 'ansi.blue'],
    ['terminal', 'ansi.cyan'],
    ['terminal', 'ansi.green'],
    ['terminal', 'ansi.yellow'],
    ['terminal', 'ansi.red'],
  ] as const;

  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme(source);
    const background = uiColor(theme, 'surface.canvas');

    expect(contrastRatio(uiColor(theme, 'text.primary'), background)).toBeGreaterThanOrEqual(
      AAA_TEXT_CONTRAST
    );
    for (const [namespace, role] of foregroundRoles) {
      const color =
        namespace === 'ui'
          ? uiColor(theme, role)
          : namespace === 'syntax'
            ? syntaxColor(theme, role)
            : terminalColor(theme, role);
      expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);
    }
  }
});

test('neutral UI roles keep interactive labels legible', () => {
  const pairs = [
    ['buttons.foreground', 'buttons.background'],
    ['buttons.foreground', 'buttons.hover.background'],
    ['badges.foreground', 'badges.background'],
  ] as const;

  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme(source);
    for (const [foreground, background] of pairs) {
      expect(
        contrastRatio(uiColor(theme, foreground), uiColor(theme, background))
      ).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);
    }
  }
});

test('neutral editor roles expose a visible active-line boundary', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme(source);
    const activeLineBorder = uiColor(theme, 'editor.activeLineBorder');

    expect(isTransparentHex(activeLineBorder)).toBe(false);
    expect(activeLineBorder).not.toBe(uiColor(theme, 'border.default'));
  }
});

test('syntax roles encode distinctions once, before consumer projection', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme(source);
    const data = syntaxColor(theme, 'data');
    const sentinel = syntaxColor(theme, 'constantLanguage');
    const keyword = syntaxColor(theme, 'keyword');
    const type = syntaxColor(theme, 'type');

    expect(data).not.toBe(syntaxColor(theme, 'function'));
    expect(sentinel).not.toBe(data);
    expect(sentinel).not.toBe(keyword);
    expect(sentinel).not.toBe(type);
    expect(oklabDelta(sentinel, data)).toBeGreaterThanOrEqual(3.5);
  }
});

test('muted editor hints remain outside syntax authority', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme(source);
    const hint = uiColor(theme, 'text.hint');

    expect(hint).not.toBe(syntaxColor(theme, 'keyword'));
    expect(hint).not.toBe(syntaxColor(theme, 'type'));
    expect(hint).not.toBe(syntaxColor(theme, 'function'));
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

    expect(Object.keys(projected.colors)).toHaveLength(302);
    for (const key of requiredKeys) expect(projected.colors[key]).toBeDefined();
    expect(projected.semanticTokenColors.parameter.foreground).toBe(syntaxColor(theme, 'data'));
    expect(projected.semanticTokenColors.type.foreground).toBe(syntaxColor(theme, 'type'));
    expect(projected.colors['symbolIcon.constructorForeground']).toBe(syntaxColor(theme, 'type'));
    expect(projected.colors['terminal.ansiMagenta']).toBe(terminalColor(theme, 'ansi.magenta'));
  }

  expect(VSCODE_PROJECTION.tokenColors).toHaveLength(28);
  expect(Object.keys(VSCODE_PROJECTION.semanticTokenColors)).toHaveLength(31);
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

test('README advertises the default Night palette from neutral roles', () => {
  const readme = fs.readFileSync('README.md', 'utf8');
  const nightSource = SOURCE_THEMES.find((source) => source.slug === 'tyrian-night');
  expect(nightSource).toBeDefined();

  const theme = readSourceTheme(nightSource!);
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
  expect(readme).toContain('OKLab distance');
  expect(readme).not.toContain('CIEDE2000');
  for (const color of advertisedPalette) expect(readme).toContain(`\`${color}\``);
});

function oklabDelta(leftColor: string, rightColor: string): number {
  return compareColors({ left: leftColor, right: rightColor }).oklabDelta;
}
