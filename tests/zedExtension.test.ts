import fs from 'node:fs';

import { expect, test } from 'bun:test';

import { buildZedThemeFamily } from '../scripts/zedTheme.mjs';
import { SOURCE_THEMES, readSourceTheme } from '../scripts/themeSources.mjs';

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

const EXPECTED_ZED_THEME_STYLE_KEYS = [
  'accents',
  'background',
  'background.appearance',
  'border',
  'border.disabled',
  'border.focused',
  'border.selected',
  'border.transparent',
  'border.variant',
  'conflict',
  'conflict.background',
  'conflict.border',
  'created',
  'created.background',
  'created.border',
  'deleted',
  'deleted.background',
  'deleted.border',
  'drop_target.background',
  'editor.active_line.background',
  'editor.active_line_number',
  'editor.active_wrap_guide',
  'editor.background',
  'editor.document_highlight.bracket_background',
  'editor.document_highlight.read_background',
  'editor.document_highlight.write_background',
  'editor.foreground',
  'editor.gutter.background',
  'editor.highlighted_line.background',
  'editor.indent_guide',
  'editor.indent_guide_active',
  'editor.invisible',
  'editor.line_number',
  'editor.subheader.background',
  'editor.wrap_guide',
  'element.active',
  'element.background',
  'element.disabled',
  'element.hover',
  'element.selected',
  'elevated_surface.background',
  'error',
  'error.background',
  'error.border',
  'ghost_element.active',
  'ghost_element.background',
  'ghost_element.disabled',
  'ghost_element.hover',
  'ghost_element.selected',
  'hidden',
  'hidden.background',
  'hidden.border',
  'hint',
  'hint.background',
  'hint.border',
  'icon',
  'icon.accent',
  'icon.disabled',
  'icon.muted',
  'icon.placeholder',
  'ignored',
  'ignored.background',
  'ignored.border',
  'info',
  'info.background',
  'info.border',
  'link_text.hover',
  'modified',
  'modified.background',
  'modified.border',
  'pane.focused_border',
  'pane_group.border',
  'panel.background',
  'panel.focused_border',
  'panel.indent_guide',
  'panel.indent_guide_active',
  'panel.indent_guide_hover',
  'players',
  'predictive',
  'predictive.background',
  'predictive.border',
  'renamed',
  'renamed.background',
  'renamed.border',
  'scrollbar.thumb.background',
  'scrollbar.thumb.border',
  'scrollbar.thumb.hover_background',
  'scrollbar.track.background',
  'scrollbar.track.border',
  'search.active_match_background',
  'search.match_background',
  'status_bar.background',
  'success',
  'success.background',
  'success.border',
  'surface.background',
  'syntax',
  'tab.active_background',
  'tab.inactive_background',
  'tab_bar.background',
  'terminal.ansi.background',
  'terminal.ansi.black',
  'terminal.ansi.blue',
  'terminal.ansi.bright_black',
  'terminal.ansi.bright_blue',
  'terminal.ansi.bright_cyan',
  'terminal.ansi.bright_green',
  'terminal.ansi.bright_magenta',
  'terminal.ansi.bright_red',
  'terminal.ansi.bright_white',
  'terminal.ansi.bright_yellow',
  'terminal.ansi.cyan',
  'terminal.ansi.dim_black',
  'terminal.ansi.dim_blue',
  'terminal.ansi.dim_cyan',
  'terminal.ansi.dim_green',
  'terminal.ansi.dim_magenta',
  'terminal.ansi.dim_red',
  'terminal.ansi.dim_white',
  'terminal.ansi.dim_yellow',
  'terminal.ansi.green',
  'terminal.ansi.magenta',
  'terminal.ansi.red',
  'terminal.ansi.white',
  'terminal.ansi.yellow',
  'terminal.background',
  'terminal.bright_foreground',
  'terminal.dim_foreground',
  'terminal.foreground',
  'text',
  'text.accent',
  'text.disabled',
  'text.muted',
  'text.placeholder',
  'title_bar.background',
  'title_bar.inactive_background',
  'toolbar.background',
  'unreachable',
  'unreachable.background',
  'unreachable.border',
  'warning',
  'warning.background',
  'warning.border',
  'version_control.added',
  'version_control.conflict_marker.ours',
  'version_control.conflict_marker.theirs',
  'version_control.deleted',
  'version_control.modified',
  'version_control.word_added',
  'version_control.word_deleted',
];

const EXPECTED_ZED_SYNTAX_CAPTURE_KEYS = [
  'attribute',
  'boolean',
  'class',
  'comment',
  'comment.doc',
  'comment.documentation',
  'constant',
  'constant.builtin',
  'constructor',
  'decorator',
  'diff.minus',
  'diff.plus',
  'embedded',
  'emphasis',
  'emphasis.strong',
  'enum',
  'enum.member',
  'enumMember',
  'error',
  'function',
  'function.builtin',
  'function.method',
  'hint',
  'invalid.deprecated',
  'keyword',
  'label',
  'link_text',
  'link_uri',
  'macro',
  'markup.quote',
  'method',
  'method.builtin',
  'module',
  'namespace',
  'number',
  'operator',
  'parameter',
  'preproc',
  'predictive',
  'primary',
  'property',
  'property.css',
  'property.json_key',
  'property.readonly',
  'punctuation',
  'punctuation.bracket',
  'punctuation.delimiter',
  'punctuation.list_marker',
  'punctuation.markup',
  'punctuation.special',
  'regexp',
  'selector',
  'selector.pseudo',
  'string',
  'string.escape',
  'string.regex',
  'string.special',
  'string.special.symbol',
  'strong',
  'tag',
  'tag.doctype',
  'text.literal',
  'title',
  'type',
  'type.builtin',
  'type.class',
  'type.enum',
  'type.interface',
  'type.parameter',
  'typeParameter',
  'variable',
  'variable.builtin',
  'variable.parameter',
  'variable.readonly',
  'variable.special',
  'variant',
];

test('Zed extension manifest is theme-only and installable from the apps/zed directory', () => {
  const manifest = fs.readFileSync('apps/zed/extension.toml', 'utf8');
  const packageJson = readJson<{ version: string }>('package.json');

  expect(manifest).toContain('id = "tyrian-night-theme"');
  expect(manifest).toContain('name = "Tyrian Night"');
  expect(manifest).toContain(`version = "${packageJson.version}"`);
  expect(manifest).toContain('schema_version = 1');
  expect(fs.existsSync('apps/zed/themes/tyrian-night.json')).toBe(true);
  expect(fs.existsSync('apps/zed/Cargo.toml')).toBe(false);
});

test('Zed theme asset matches the generated Zed schema port of the VS Code themes', () => {
  const zedTheme = readJson<ZedThemeFamily>('apps/zed/themes/tyrian-night.json');
  const generated = buildZedThemeFamily() as ZedThemeFamily;

  expect(zedTheme).toEqual(generated);
  expect(zedTheme.$schema).toBe('https://zed.dev/schema/themes/v0.2.0.json');
  expect(zedTheme.name).toBe('Tyrian Night');
  expect(zedTheme.author).toBe('renbkna');
  expect(zedTheme.themes.map((theme) => [theme.name, theme.appearance])).toEqual([
    ['Tyrian Night', 'dark'],
    ['Tyrian Nocturne', 'dark'],
    ['Tyrian Night Old', 'dark'],
    ['Tyrian Abyss', 'dark'],
    ['Tyrian Dawn', 'light'],
  ]);
});

test('Zed theme covers the current schema and built-in style and syntax surfaces', () => {
  const zedTheme = readJson<ZedThemeFamily>('apps/zed/themes/tyrian-night.json');

  for (const theme of zedTheme.themes) {
    expect(Object.keys(theme.style).sort()).toEqual([...EXPECTED_ZED_THEME_STYLE_KEYS].sort());
    expect(Object.keys(theme.style.syntax).sort()).toEqual(
      [...EXPECTED_ZED_SYNTAX_CAPTURE_KEYS].sort()
    );
  }
});

test('Zed theme keeps the core palette and syntax colors tied to the VS Code sources', () => {
  const zedTheme = readJson<ZedThemeFamily>('apps/zed/themes/tyrian-night.json');

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
    expect(theme.style.accents[0]).toBe(vscodeTheme.colors.focusBorder);
    expect(theme.style['pane.focused_border']).toBe(vscodeTheme.colors.focusBorder);
    expect(theme.style['panel.focused_border']).toBe(vscodeTheme.colors.focusBorder);
    expect(theme.style.predictive).toBe(vscodeTheme.colors['editorGhostText.foreground']);
    expect(theme.style['predictive.background']).toBe(
      vscodeTheme.colors['editorGhostText.background']
    );
    expect(theme.style['predictive.border']).toBe(vscodeTheme.colors['editorGhostText.border']);
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
    expect(theme.style.syntax.constructor.color).toBe(
      vscodeTheme.semanticTokenColors.constructor.foreground
    );
    expect(theme.style.syntax['function.builtin']?.color).toBe(
      vscodeTheme.semanticTokenColors['function.defaultLibrary'].foreground
    );
    expect(theme.style.syntax.hint?.color).toBe(vscodeTheme.colors['editorInlayHint.foreground']);
    expect(theme.style.syntax.hint?.font_style).toBe('italic');
    expect(theme.style.syntax['markup.quote']?.color).toBe(
      tokenSettings(vscodeTheme, 'markup.quote').foreground
    );
    expect(theme.style.syntax['markup.quote']?.font_style).toBe('italic');
    expect(theme.style.syntax.predictive?.color).toBe(
      vscodeTheme.colors['editorGhostText.foreground']
    );
    expect(theme.style.syntax.predictive?.font_style).toBeUndefined();
    expect(theme.style.syntax['invalid.deprecated']?.color).toBe(
      tokenSettings(vscodeTheme, 'invalid.deprecated').foreground
    );
    expect(theme.style.syntax.parameter.color).toBe(
      vscodeTheme.semanticTokenColors.parameter.foreground
    );
    expect(theme.style.syntax.boolean.color).toBe(
      tokenSettings(vscodeTheme, 'constant.language').foreground
    );
    expect(theme.style.syntax['constant.builtin']?.color).toBe(
      tokenSettings(vscodeTheme, 'constant.language').foreground
    );
    expect(theme.style.syntax.constant.color).toBe(
      vscodeTheme.semanticTokenColors['variable.readonly'].foreground
    );
    expect(theme.style.syntax.number.color).toBe(
      tokenSettings(vscodeTheme, 'constant.numeric').foreground
    );
    expect(theme.style.syntax['variable.special']?.color).toBe(
      tokenSettings(vscodeTheme, 'variable.language').foreground
    );
    expect(theme.style.syntax.operator.color).toBe(
      vscodeTheme.semanticTokenColors.operator.foreground
    );
    expect(theme.style.syntax['selector.pseudo']?.color).toBe(
      tokenSettings(vscodeTheme, 'keyword').foreground
    );
    expect(theme.style.syntax['property.readonly']?.color).toBe(
      vscodeTheme.semanticTokenColors['property.readonly'].foreground
    );
    expect(theme.style.syntax.type.color).toBe(vscodeTheme.semanticTokenColors.type.foreground);
  }
});

test('Zed example settings match the repo companion settings contract', () => {
  const settings = readJson<Record<string, any>>('apps/zed/settings.example.json');
  const readme = fs.readFileSync('apps/zed/README.md', 'utf8');

  expect(settings.theme).toEqual({
    mode: 'dark',
    dark: 'Tyrian Night',
    light: 'Tyrian Dawn',
  });
  expect(settings.icon_theme).toEqual({
    mode: 'dark',
    light: 'Colored Zed Icons Theme Dark',
    dark: 'Colored Zed Icons Theme Dark',
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
  expect(settings.semantic_tokens).toBe('combined');
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
  expect(settings.terminal.font_size).toBe(8);
  expect(settings.terminal.line_height).toEqual({ custom: 1.2 });
  expect(settings.terminal.cursor_shape).toBe('bar');
  expect(settings.terminal.blinking).toBe('terminal_controlled');
  expect(settings.terminal.minimum_contrast).toBe(0);
  expect(settings.cli_default_open_behavior).toBe('existing_window');
  expect(settings.diff_view_style).toBe('unified');
  expect(settings.helix_mode).toBe(false);
  expect(settings.inlay_hints).toEqual({
    enabled: true,
    show_type_hints: true,
    show_parameter_hints: true,
    show_other_hints: true,
    show_background: false,
  });
  expect(settings.use_on_type_format).toBe(true);
  expect(settings.show_edit_predictions).toBe(false);
  expect(settings.edit_predictions.provider).toBe('copilot');
  expect(settings.autosave.after_delay.milliseconds).toBe(2000);
  expect(settings.hover_popover_delay).toBe(300);
  expect(settings.vertical_scroll_margin).toBe(6);
  expect(settings.mouse_wheel_zoom).toBe(true);
  expect(settings.max_tabs).toBe(10);
  expect(settings.project_panel).toMatchObject({
    dock: 'left',
    auto_fold_dirs: false,
    show_diagnostics: 'all',
    indent_size: 18,
  });
  expect(settings.outline_panel.dock).toBe('left');
  expect(settings.collaboration_panel.dock).toBe('left');
  expect(settings.git_panel.dock).toBe('left');
  expect(settings.languages.Python.language_servers).toEqual(['ty', 'ruff']);
  expect(settings.languages.TypeScript.language_servers).toEqual(['tsgo', 'biome']);
  expect(settings.languages.TSX.formatter.language_server.name).toBe('biome');
  expect(settings.languages.JavaScript.code_actions_on_format).toMatchObject({
    'source.fixAll.biome': true,
    'source.organizeImports.biome': true,
  });
  expect(settings.file_types.tailwindcss).toEqual(['*.css']);
  expect(settings.node.ignore_system_version).toBe(true);
  expect(settings).not.toHaveProperty('agent');

  for (const ownedSettingArea of [
    'font family',
    'inlay hints',
    'panels',
    'edit-prediction posture',
    'language servers',
    'formatters',
    'file type mapping',
    'terminal contrast',
    'semantic-token mode',
  ]) {
    expect(readme).toContain(ownedSettingArea);
  }
});

test('Zed theme files do not expose VS Code-only theme fields', () => {
  const zedTheme = readJson<Record<string, unknown>>('apps/zed/themes/tyrian-night.json');

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
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme<{ name: string }>(source);

    if (theme.name === themeName) {
      return source.sourcePath;
    }
  }

  throw new Error(`Unexpected theme '${themeName}'`);
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
