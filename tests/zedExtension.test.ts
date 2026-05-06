import fs from 'node:fs';

import { expect, test } from 'bun:test';

import {
  buildZedThemeFamily,
  ZED_SYNTAX_CAPTURE_KEYS,
  ZED_THEME_STYLE_KEYS,
} from '../scripts/zedTheme.mjs';

type ZedThemeFamily = {
  $schema: string;
  author: string;
  name: string;
  themes: Array<{
    appearance: 'dark' | 'light';
    name: string;
    style: {
      'editor.background': string;
      'editor.document_highlight.bracket_background': string;
      'editor.active_line.background': string;
      'editor.foreground': string;
      'editor.highlighted_line.background': string;
      players: Array<{ cursor: string }>;
      'search.active_match_background': string;
      'search.match_background': string;
      'terminal.ansi.red': string;
      'version_control.deleted': string;
      'version_control.word_deleted': string;
      syntax: Record<string, { color?: string; font_style?: string; font_weight?: number }>;
    };
  }>;
};

type HighlightSettings = {
  foreground?: string;
  fontStyle?: string;
};

test('Zed extension manifest is theme-only and installable from the zed directory', () => {
  const manifest = fs.readFileSync('zed/extension.toml', 'utf8');
  const packageJson = readJson<{ version: string }>('package.json');

  expect(manifest).toContain('id = "tyrian-night-theme"');
  expect(manifest).toContain('name = "Tyrian Night"');
  expect(manifest).toContain(`version = "${packageJson.version}"`);
  expect(manifest).toContain('schema_version = 1');
  expect(fs.existsSync('zed/themes/tyrian-night.json')).toBe(true);
  expect(fs.existsSync('zed/Cargo.toml')).toBe(false);
});

test('Zed theme asset matches the generated Zed schema port of the VS Code themes', () => {
  const zedTheme = readJson<ZedThemeFamily>('zed/themes/tyrian-night.json');
  const generated = buildZedThemeFamily() as ZedThemeFamily;

  expect(zedTheme).toEqual(generated);
  expect(zedTheme.$schema).toBe('https://zed.dev/schema/themes/v0.2.0.json');
  expect(zedTheme.name).toBe('Tyrian Night');
  expect(zedTheme.author).toBe('renbkna');
  expect(zedTheme.themes.map((theme) => [theme.name, theme.appearance])).toEqual([
    ['Tyrian Night', 'dark'],
    ['Tyrian Dusk', 'dark'],
    ['Tyrian Dawn', 'light'],
  ]);
});

test('Zed theme covers the current schema and built-in style and syntax surfaces', () => {
  const zedTheme = readJson<ZedThemeFamily>('zed/themes/tyrian-night.json');

  for (const theme of zedTheme.themes) {
    expect(Object.keys(theme.style).sort()).toEqual([...ZED_THEME_STYLE_KEYS].sort());
    expect(Object.keys(theme.style.syntax).sort()).toEqual([...ZED_SYNTAX_CAPTURE_KEYS].sort());
  }
});

test('Zed theme keeps the core palette and syntax colors tied to the VS Code sources', () => {
  const zedTheme = readJson<ZedThemeFamily>('zed/themes/tyrian-night.json');

  for (const theme of zedTheme.themes) {
    const vscodeTheme = readJson<{
      colors: Record<string, string>;
      semanticTokenColors: Record<string, { foreground?: string }>;
      tokenColors: Array<{ scope: string | string[]; settings: HighlightSettings }>;
    }>(sourceThemePath(theme.name));

    expect(theme.style['editor.background']).toBe(vscodeTheme.colors['editor.background']);
    expect(theme.style['editor.foreground']).toBe(vscodeTheme.colors['editor.foreground']);
    expect(theme.style['editor.active_line.background']).toBe(
      vscodeTheme.colors['editor.lineHighlightBackground']
    );
    expect(theme.style['editor.highlighted_line.background']).toBe(
      vscodeTheme.colors['editor.rangeHighlightBackground'] ??
        vscodeTheme.colors['editor.lineHighlightBackground']
    );
    expect(theme.style['search.active_match_background']).toBe(
      vscodeTheme.colors['editor.findMatchBackground']
    );
    expect(theme.style['search.match_background']).toBe(
      vscodeTheme.colors['editor.findMatchHighlightBackground'] ??
        vscodeTheme.colors['editor.findMatchBackground']
    );
    expect(theme.style.players[0]?.cursor).toBe(vscodeTheme.colors['editorCursor.foreground']);
    expect(theme.style['editor.document_highlight.bracket_background']).not.toBe(
      vscodeTheme.colors['editorBracketHighlight.foreground1']
    );
    expect(theme.style['terminal.ansi.red']).toBe(vscodeTheme.colors['terminal.ansiRed']);
    expect(theme.style['version_control.deleted']).toBe(
      vscodeTheme.colors['editorGutter.deletedBackground']
    );
    expect(theme.style['version_control.word_deleted']).toMatch(
      new RegExp(`^${vscodeTheme.colors['editorGutter.deletedBackground'].slice(0, 7)}`, 'u')
    );
    expect(theme.style.syntax.function.color).toBe(
      vscodeTheme.semanticTokenColors.function.foreground
    );
    expect(theme.style.syntax['function.builtin']?.color).toBe(
      vscodeTheme.semanticTokenColors['function.defaultLibrary'].foreground
    );
    expect(theme.style.syntax['markup.quote']?.color).toBe(
      tokenSettings(vscodeTheme, 'markup.quote').foreground
    );
    expect(theme.style.syntax['markup.quote']?.font_style).toBe('italic');
    expect(theme.style.syntax['invalid.deprecated']?.color).toBe(
      tokenSettings(vscodeTheme, 'invalid.deprecated').foreground
    );
    expect(theme.style.syntax.parameter.color).toBe(
      vscodeTheme.semanticTokenColors.parameter.foreground
    );
    expect(theme.style.syntax['property.readonly']?.color).toBe(
      vscodeTheme.semanticTokenColors['property.readonly'].foreground
    );
    expect(theme.style.syntax.type.color).toBe(vscodeTheme.semanticTokenColors.type.foreground);
  }
});

test('Zed example settings close non-theme parity gaps without becoming extension code', () => {
  const settings = readJson<{
    buffer_font_features: Record<string, boolean>;
    buffer_font_family: string;
    buffer_line_height: { custom: number };
    buffer_font_size: number;
    buffer_font_weight: number;
    colorize_brackets: boolean;
    indent_guides: {
      active_line_width: number;
      background_coloring: string;
      coloring: string;
      enabled: boolean;
      line_width: number;
    };
    semantic_tokens: string;
    soft_wrap: string;
    tab_size: number;
    terminal: {
      blinking: string;
      cursor_shape: string;
      font_family: string;
      font_size: number;
      line_height: { custom: number };
      minimum_contrast: number;
    };
    theme: { dark: string; light: string; mode: string };
    ui_font_family: string;
    ui_font_size: number;
    ui_font_weight: number;
  }>('zed/settings.example.json');

  expect(settings.theme).toEqual({
    mode: 'dark',
    dark: 'Tyrian Night',
    light: 'Tyrian Dawn',
  });
  expect(settings.buffer_font_family).toBe('Monaspace Neon');
  expect(settings.buffer_font_size).toBe(15);
  expect(settings.buffer_font_weight).toBe(450);
  expect(settings.buffer_line_height).toEqual({ custom: 1.45 });
  expect(settings.buffer_font_features).toEqual({
    calt: true,
    liga: true,
    dlig: true,
    ss01: true,
    ss02: true,
    ss03: true,
    ss04: true,
    ss05: true,
    ss06: true,
    ss07: true,
    ss08: true,
    ss09: true,
    ss10: true,
  });
  expect(settings.ui_font_family).toBe('.ZedSans');
  expect(settings.ui_font_size).toBe(16);
  expect(settings.ui_font_weight).toBe(400);
  expect(settings.semantic_tokens).toBe('off');
  expect(settings.colorize_brackets).toBe(true);
  expect(settings.soft_wrap).toBe('bounded');
  expect(settings.tab_size).toBe(4);
  expect(settings.indent_guides).toEqual({
    enabled: true,
    line_width: 1,
    active_line_width: 1,
    coloring: 'indent_aware',
    background_coloring: 'disabled',
  });
  expect(settings.terminal.font_family).toBe('Monaspace Neon');
  expect(settings.terminal.font_size).toBe(14);
  expect(settings.terminal.line_height).toEqual({ custom: 1.4 });
  expect(settings.terminal.cursor_shape).toBe('bar');
  expect(settings.terminal.blinking).toBe('terminal_controlled');
  expect(settings.terminal.minimum_contrast).toBe(0);

  for (const personalSetting of [
    'agent',
    'autosave',
    'collaboration_panel',
    'edit_predictions',
    'file_types',
    'git_panel',
    'languages',
    'node',
    'outline_panel',
    'project_panel',
  ]) {
    expect(settings).not.toHaveProperty(personalSetting);
  }
});

test('Zed theme files do not expose VS Code-only theme fields', () => {
  const zedTheme = readJson<Record<string, unknown>>('zed/themes/tyrian-night.json');

  for (const forbiddenField of ['type', 'colors', 'semanticHighlighting', 'semanticTokenColors']) {
    expect(zedTheme).not.toHaveProperty(forbiddenField);
  }

  for (const theme of (zedTheme as ZedThemeFamily).themes) {
    expect(theme).not.toHaveProperty('type');
    expect(theme).not.toHaveProperty('colors');
    expect(theme).not.toHaveProperty('tokenColors');
    expect(theme).not.toHaveProperty('semanticTokenColors');
  }
});

function sourceThemePath(themeName: string): string {
  switch (themeName) {
    case 'Tyrian Night':
      return 'themes/tyrian-night.json';
    case 'Tyrian Dusk':
      return 'themes/tyrian-dusk.json';
    case 'Tyrian Dawn':
      return 'themes/tyrian-dawn.json';
    default:
      throw new Error(`Unexpected theme '${themeName}'`);
  }
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function tokenSettings(
  vscodeTheme: {
    name?: string;
    tokenColors: Array<{ scope: string | string[]; settings: HighlightSettings }>;
  },
  scope: string
): HighlightSettings {
  for (const token of vscodeTheme.tokenColors) {
    const scopes = Array.isArray(token.scope) ? token.scope : [token.scope];

    if (scopes.includes(scope)) {
      return token.settings;
    }
  }

  throw new Error(`Missing token scope '${scope}' in ${vscodeTheme.name ?? 'theme'}`);
}
