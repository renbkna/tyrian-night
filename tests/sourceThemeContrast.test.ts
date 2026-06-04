import { expect, test } from 'bun:test';

import { opaqueHex, parseHexColor } from '../scripts/colorUtils.mjs';
import { SOURCE_THEMES, readSourceTheme } from '../scripts/themeSources.mjs';

type HighlightSettings = {
  foreground?: string;
};

type VscodeTheme = {
  colors: Record<string, string>;
  name: string;
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

test('shared color parser rejects malformed source hex colors', () => {
  for (const malformedColor of ['#GGGGGG', '#12zz34', '#badhex', '#12', '#12345']) {
    expect(() => parseHexColor(malformedColor)).toThrow('Unsupported hex color');
  }
});

function tokenColor(theme: VscodeTheme, scope: string): string {
  for (const token of theme.tokenColors) {
    const scopes = Array.isArray(token.scope) ? token.scope : [token.scope];

    if (scopes.includes(scope) && token.settings.foreground) {
      return token.settings.foreground;
    }
  }

  throw new Error(`Missing token scope '${scope}' in ${theme.name}`);
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
