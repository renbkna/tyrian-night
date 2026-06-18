import fs from 'node:fs';

import { expect, test } from 'bun:test';

import { compareColors } from '../scripts/colorScience.mjs';
import { isTransparentHex, opaqueHex, parseHexColor } from '../scripts/colorUtils.mjs';
import { SOURCE_THEMES, readSourceTheme } from '../scripts/themeSources.mjs';

type HighlightSettings = {
  foreground?: string;
  fontStyle?: string;
  italic?: boolean;
};

type VscodeTheme = {
  colors: Record<string, string>;
  name: string;
  semanticTokenColors: Record<string, HighlightSettings>;
  tokenColors: Array<{ scope: string | string[]; settings: HighlightSettings }>;
};

const AAA_TEXT_CONTRAST = 7;
const AA_TEXT_CONTRAST = 4.5;

const LOAD_BEARING_EDITOR_COLORS = [
  'terminal.ansiMagenta',
  'terminal.ansiBlue',
  'terminal.ansiCyan',
  'terminal.ansiGreen',
  'terminal.ansiYellow',
  'terminal.ansiRed',
  'editorError.foreground',
  'editorWarning.foreground',
  'editorInfo.foreground',
  'editorHint.foreground',
];

const INTERACTIVE_TEXT_PAIRS = [
  ['button.foreground', 'button.background'],
  ['button.foreground', 'button.hoverBackground'],
  ['badge.foreground', 'badge.background'],
];

const REQUIRED_WORKBENCH_COLOR_KEYS = [
  'foreground',
  'disabledForeground',
  'descriptionForeground',
  'errorForeground',
  'focusBorder',
  'selection.background',
  'icon.foreground',
  'editor.selectionForeground',
  'editor.findMatchForeground',
  'editor.findMatchBorder',
  'editor.findMatchHighlightForeground',
  'editor.hoverHighlightBackground',
  'editor.rangeHighlightBackground',
  'editorGhostText.foreground',
  'editorGhostText.background',
  'editorGhostText.border',
  'editorWhitespace.foreground',
  'editorWidget.foreground',
  'sideBarTitle.foreground',
  'sideBarSectionHeader.foreground',
  'sideBarSectionHeader.border',
  'activityBar.inactiveForeground',
  'activityBarBadge.background',
  'activityBarBadge.foreground',
  'editorGroup.border',
  'panel.foreground',
  'panelTitle.activeForeground',
  'panelTitle.inactiveForeground',
  'panelTitle.activeBorder',
  'statusBar.border',
  'statusBar.debuggingForeground',
  'statusBarItem.remoteBackground',
  'statusBarItem.remoteForeground',
  'titleBar.border',
  'inputOption.activeBorder',
  'button.secondaryBackground',
  'button.secondaryForeground',
  'button.secondaryHoverBackground',
  'list.errorForeground',
  'list.warningForeground',
  'problemsErrorIcon.foreground',
  'problemsWarningIcon.foreground',
  'problemsInfoIcon.foreground',
  'diffEditor.insertedTextBackground',
  'diffEditor.removedTextBackground',
  'diffEditor.insertedLineBackground',
  'diffEditor.removedLineBackground',
  'terminalCursor.foreground',
];

const REQUIRED_SEMANTIC_SELECTORS = [
  'variable',
  'keyword',
  'operator',
  'string',
  'number',
  'comment',
  '*.readonly',
  '*.deprecated',
  '*.documentation',
];

test('source themes expose one shared VS Code color and semantic surface', () => {
  const themes = SOURCE_THEMES.map((source) => readSourceTheme<VscodeTheme>(source));
  const colorKeys = Object.keys(themes[0]!.colors).sort();
  const semanticKeys = Object.keys(themes[0]!.semanticTokenColors).sort();
  const tokenScopeSignature = tokenScopeSurface(themes[0]!);

  for (const theme of themes) {
    expect(Object.keys(theme.colors).sort()).toEqual(colorKeys);
    expect(Object.keys(theme.semanticTokenColors).sort()).toEqual(semanticKeys);
    expect(tokenScopeSurface(theme)).toEqual(tokenScopeSignature);

    for (const colorKey of REQUIRED_WORKBENCH_COLOR_KEYS) {
      expect(theme.colors[colorKey]).toBeDefined();
    }

    for (const selector of REQUIRED_SEMANTIC_SELECTORS) {
      expect(theme.semanticTokenColors[selector]).toBeDefined();
    }
  }
});

test('source themes keep load-bearing editor text within the contrast contract', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme<VscodeTheme>(source);
    const background = theme.colors['editor.background'];

    expect(contrastRatio(theme.colors['editor.foreground'], background)).toBeGreaterThanOrEqual(
      AAA_TEXT_CONTRAST
    );

    for (const colorKey of LOAD_BEARING_EDITOR_COLORS) {
      expect(contrastRatio(theme.colors[colorKey], background)).toBeGreaterThanOrEqual(
        AA_TEXT_CONTRAST
      );
    }

    expect(contrastRatio(tokenColor(theme, 'comment'), background)).toBeGreaterThanOrEqual(
      AA_TEXT_CONTRAST
    );
  }
});

test('source themes keep interactive label text within the contrast contract', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme<VscodeTheme>(source);

    for (const [foregroundKey, backgroundKey] of INTERACTIVE_TEXT_PAIRS) {
      expect(
        contrastRatio(theme.colors[foregroundKey], theme.colors[backgroundKey])
      ).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);
    }
  }
});

test('source themes expose visible active line borders', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme<VscodeTheme>(source);
    const activeLineBorder = theme.colors['editor.lineHighlightBorder'];

    expect(activeLineBorder).toBeDefined();
    expect(isTransparentHex(activeLineBorder)).toBe(false);
    expect(activeLineBorder).not.toBe(theme.colors['editorWidget.border']);
  }
});

test('shared color parser rejects malformed source hex colors', () => {
  for (const malformedColor of ['#GGGGGG', '#12zz34', '#badhex', '#12', '#12345']) {
    expect(() => parseHexColor(malformedColor)).toThrow('Unsupported hex color');
  }
});

test('source themes reserve italics for Radon-intended prose surfaces', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme<VscodeTheme>(source);

    for (const [selector, settings] of Object.entries(theme.semanticTokenColors)) {
      if (isItalic(settings)) {
        expect(isAllowedItalicSemanticSelector(selector)).toBe(true);
      }

      if (selector.includes('deprecated')) {
        expect(settings.italic).toBeUndefined();
        expect(settings.fontStyle ?? '').not.toContain('italic');
      }
    }

    for (const token of theme.tokenColors) {
      if (isItalic(token.settings)) {
        expect(isAllowedItalicScope(token.scope)).toBe(true);
      }

      if (scopeList(token.scope).some((scope) => scope.includes('deprecated'))) {
        expect(token.settings.fontStyle ?? '').not.toContain('italic');
      }
    }
  }
});

test('source themes color JSON property names as attributes instead of callables', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme<VscodeTheme>(source);
    const jsonPropertyColor = tokenColor(theme, 'support.type.property-name.json');
    const parameterColor = theme.semanticTokenColors.parameter.foreground;
    const functionColor = theme.semanticTokenColors.function.foreground;

    expect(jsonPropertyColor).toBe(parameterColor);
    expect(jsonPropertyColor).not.toBe(functionColor);
  }
});

test('source themes color language variables as italic data-shaped receivers', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme<VscodeTheme>(source);
    const languageVariable = tokenSettings(theme, 'variable.language');
    const languageVariableColor = languageVariable.foreground;
    const parameterColor = theme.semanticTokenColors.parameter.foreground;
    const constantColor = theme.semanticTokenColors['variable.readonly'].foreground;
    const keywordColor = theme.semanticTokenColors.keyword.foreground;
    const typeColor = theme.semanticTokenColors.type.foreground;

    expect(languageVariableColor).toBe(parameterColor);
    expect(languageVariableColor).toBe(constantColor);
    expect(languageVariable.fontStyle).toBe('italic');
    expect(languageVariableColor).not.toBe(keywordColor);
    expect(languageVariableColor).not.toBe(typeColor);
    expect(oklabDelta(languageVariableColor, keywordColor)).toBeGreaterThanOrEqual(6);
    expect(oklabDelta(languageVariableColor, typeColor)).toBeGreaterThanOrEqual(6);
  }
});

test('source themes keep inlay hints muted instead of syntax-colored', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme<VscodeTheme>(source);
    const hintColor = theme.colors['editorInlayHint.foreground'];

    expect(theme.colors['editorInlayHint.typeForeground']).toBe(hintColor);
    expect(theme.colors['editorInlayHint.parameterForeground']).toBe(hintColor);
  }
});

test('source themes split language sentinels from runtime data', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme<VscodeTheme>(source);
    const dataColor = theme.semanticTokenColors.parameter.foreground;
    const sentinelColor = tokenColor(theme, 'constant.language');
    const keywordColor = theme.semanticTokenColors.keyword.foreground;
    const typeColor = theme.semanticTokenColors.type.foreground;

    expect(theme.semanticTokenColors['variable.defaultLibrary'].foreground).toBe(dataColor);
    expect(theme.semanticTokenColors['variable.readonly'].foreground).toBe(dataColor);
    expect(theme.semanticTokenColors.number.foreground).toBe(dataColor);
    expect(tokenColor(theme, 'constant.numeric')).toBe(dataColor);
    expect(sentinelColor).not.toBe(dataColor);
    expect(sentinelColor).not.toBe(keywordColor);
    expect(sentinelColor).not.toBe(typeColor);
    expect(oklabDelta(sentinelColor, dataColor)).toBeGreaterThanOrEqual(3.5);
  }
});

test('source themes keep type-shaped symbols and namespaces on the type lane', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme<VscodeTheme>(source);
    const typeColor = theme.semanticTokenColors.type.foreground;

    expect(theme.semanticTokenColors.constructor.foreground).toBe(typeColor);
    expect(theme.semanticTokenColors.namespace.foreground).toBe(typeColor);
    expect(theme.semanticTokenColors.typeParameter.foreground).toBe(typeColor);
    expect(theme.colors['symbolIcon.constructorForeground']).toBe(typeColor);
    expect(theme.colors['symbolIcon.namespaceForeground']).toBe(typeColor);
    expect(theme.colors['symbolIcon.typeParameterForeground']).toBe(typeColor);
    expect(tokenColor(theme, 'meta.type.annotation')).toBe(typeColor);
    expect(tokenColor(theme, 'entity.name.type')).toBe(typeColor);
  }
});

test('README advertises the default Night palette from the Night source theme', () => {
  const readme = fs.readFileSync('README.md', 'utf8');
  const nightSource = SOURCE_THEMES.find((source) => source.slug === 'tyrian-night');

  expect(nightSource).toBeDefined();

  const theme = readSourceTheme<VscodeTheme>(nightSource!);
  const advertisedPalette = [
    theme.colors['editor.background'],
    theme.colors['editor.lineHighlightBackground'],
    theme.colors['editor.foreground'],
    theme.semanticTokenColors.keyword.foreground,
    theme.semanticTokenColors.type.foreground,
    theme.semanticTokenColors.function.foreground,
    theme.semanticTokenColors.string.foreground,
    theme.semanticTokenColors.number.foreground,
    theme.semanticTokenColors.parameter.foreground,
  ];

  expect(readme).toContain('## Palette');

  for (const color of advertisedPalette) {
    expect(readme).toContain(`\`${color}\``);
  }

  expect(readme).not.toContain('| Background (Tyrian v3 Canvas) | `#0A0910` |');
});

function tokenColor(theme: VscodeTheme, scope: string): string {
  return tokenSettings(theme, scope).foreground!;
}

function tokenSettings(theme: VscodeTheme, scope: string): HighlightSettings {
  for (const token of theme.tokenColors) {
    const scopes = Array.isArray(token.scope) ? token.scope : [token.scope];

    if (scopes.includes(scope)) {
      return token.settings;
    }
  }

  throw new Error(`Missing token scope '${scope}' in ${theme.name}`);
}

function tokenScopeSurface(theme: VscodeTheme): Array<{ scope: string[]; fontStyle?: string }> {
  return theme.tokenColors.map((token) => ({
    scope: scopeList(token.scope),
    fontStyle: token.settings.fontStyle,
  }));
}

function oklabDelta(leftColor: string, rightColor: string): number {
  return compareColors({ left: leftColor, right: rightColor }).oklabDelta;
}

function isItalic(settings: HighlightSettings): boolean {
  return settings.italic === true || String(settings.fontStyle ?? '').includes('italic');
}

function isAllowedItalicSemanticSelector(selector: string): boolean {
  return selector === 'comment' || selector.includes('documentation');
}

function isAllowedItalicScope(scope: string | string[]): boolean {
  return scopeList(scope).some(
    (entry) =>
      entry.startsWith('comment') ||
      entry.startsWith('meta.type') ||
      entry.startsWith('meta.annotation') ||
      entry === 'entity.name.type.annotation' ||
      entry === 'variable.language' ||
      entry === 'punctuation.definition.comment' ||
      entry === 'string.quoted.docstring' ||
      entry === 'markup.italic' ||
      entry === 'markup.quote'
  );
}

function scopeList(scope: string | string[]): string[] {
  return Array.isArray(scope) ? scope : [scope];
}

function contrastRatio(foreground: string | undefined, background: string | undefined): number {
  if (!foreground || !background) {
    throw new Error('Missing contrast color');
  }

  const foregroundLuminance = luminance(opaqueHex(foreground));
  const backgroundLuminance = luminance(opaqueHex(background));
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);

  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(color: string): number {
  const { red, green, blue } = parseHex(color);

  return 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue);
}

function linearize(channel: number): number {
  const value = channel / 255;

  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function parseHex(color: string): { blue: number; green: number; red: number } {
  const match = /^#(?<red>[0-9a-f]{2})(?<green>[0-9a-f]{2})(?<blue>[0-9a-f]{2})$/iu.exec(color);

  if (!match?.groups) {
    throw new Error(`Invalid hex color '${color}'`);
  }

  return {
    red: Number.parseInt(match.groups.red, 16),
    green: Number.parseInt(match.groups.green, 16),
    blue: Number.parseInt(match.groups.blue, 16),
  };
}
