import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';
import { contrastRatio, oklchToHex } from '../scripts/colorScience.mjs';
import { opaqueHex, parseHexColor, withHexAlpha } from '../scripts/colorUtils.mjs';
import { buildZedThemeFamily, writeZedThemeFamily } from '../scripts/zedTheme.mjs';
import {
  REQUIRED_THEME_ROLES,
  bracketColor,
  loadThemeDefinitionContext,
  themePigmentHue,
} from '../scripts/themeDefinition.mjs';
import {
  SOURCE_THEMES,
  getDefaultThemeSource,
  getTerminalDefaultThemeSource,
  readSourceTheme,
} from '../scripts/themeSources.mjs';

type ThemeDefinition = {
  appearance: 'dark' | 'light';
  brackets: Record<string, string>;
  name: string;
  syntax: Record<string, string>;
  terminal: Record<string, string>;
  ui: Record<string, string>;
};

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
  const version = manifest.match(/^version = "([^"]+)"$/mu)?.[1];

  expect(manifest).toContain('id = "tyrian-night-theme"');
  expect(manifest).toContain('name = "Tyrian Night"');
  expect(version).toMatch(/^\d+\.\d+\.\d+$/u);
  expect(manifest).toContain('schema_version = 1');
  expect(fs.existsSync('apps/zed/themes/tyrian-night.json')).toBe(true);
  expect(fs.existsSync('apps/zed/Cargo.toml')).toBe(false);
});

test('Zed theme asset matches the generated projection of the neutral themes', () => {
  const zedTheme = readJson<ZedThemeFamily>('apps/zed/themes/tyrian-night.json');
  const generated = buildZedThemeFamily() as ZedThemeFamily;

  expect(zedTheme).toEqual(generated);
  expect(zedTheme.$schema).toBe('https://zed.dev/schema/themes/v0.2.0.json');
  expect(zedTheme.name).toBe('Tyrian Night');
  expect(zedTheme.author).toBe('renbkna');
  expect(zedTheme.themes.map((theme) => [theme.name, theme.appearance])).toEqual([
    ['Tyrian Night', 'dark'],
    ['Tyrian Nocturne', 'dark'],
    ['Tyrian Pastel', 'dark'],
    ['Tyrian Abyss', 'dark'],
    ['Tyrian Dawn', 'light'],
    ['Tyrian Night Old', 'dark'],
  ]);
});

test('every generated Zed color uses a supported hex representation', () => {
  const generated = buildZedThemeFamily() as ZedThemeFamily;

  for (const theme of generated.themes) {
    const colors = collectHexStrings(theme.style);
    expect(colors.length).toBeGreaterThan(0);
    for (const color of colors) expect(() => parseHexColor(color)).not.toThrow();
  }

  const dawn = generated.themes.find((theme) => theme.name === 'Tyrian Dawn');
  expect(dawn?.style['border.transparent']).toBe(
    withHexAlpha(sourceTheme('Tyrian Dawn').ui['border.tab'], '00')
  );
});

test('Zed generation resolves theme membership and identity from the injected root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-zed-root-'));

  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const themePath = path.join(root, 'source/themes/tyrian-night.json');
    const theme = readJson<{
      name: string;
      oklch: Record<string, [number, number]>;
    }>(themePath);
    theme.name = 'Injected Zed Night';
    const injected = {
      'ui:surface.canvas': [0.13, 0.02],
      'syntax:function': [0.65, 0.085],
      'brackets:depth1': [0.61, 0.05],
      'ui:status.error': [0.63, 0.11],
    } satisfies Record<string, [number, number]>;
    Object.assign(theme.oklch, injected);
    fs.writeFileSync(themePath, `${JSON.stringify(theme)}\n`);
    const definition = loadThemeDefinitionContext(root);
    const color = (pigment: keyof typeof injected) => {
      const [L, C] = injected[pigment];
      return oklchToHex({
        C,
        L,
        h: themePigmentHue(definition, 'core', pigment)!,
      });
    };

    const generated = buildZedThemeFamily(root) as ZedThemeFamily;
    expect(generated.themes[0]?.name).toBe('Injected Zed Night');
    expect(generated.themes[0]?.style['editor.background']).toBe(color('ui:surface.canvas'));
    expect(generated.themes[0]?.style.syntax.function?.color).toBe(color('syntax:function'));
    expect(generated.themes[0]?.style.accents[0]).toBe(color('brackets:depth1'));
    expect(generated.themes[0]?.style['terminal.ansi.red']).toBe(color('ui:status.error'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Zed generation owns the complete themes directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-zed-ownership-'));

  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    fs.mkdirSync(path.join(root, 'apps/zed/themes/nested'), { recursive: true });
    fs.writeFileSync(path.join(root, 'apps/zed/themes/stale.json'), '{}\n');
    fs.writeFileSync(path.join(root, 'apps/zed/themes/nested/stale.txt'), 'stale\n');

    writeZedThemeFamily(root);

    expect(fs.readdirSync(path.join(root, 'apps/zed/themes'))).toEqual(['tyrian-night.json']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test('Zed theme maps UI, syntax, and terminal colors from their neutral owners', () => {
  const zedTheme = readJson<ZedThemeFamily>('apps/zed/themes/tyrian-night.json');

  for (const theme of zedTheme.themes) {
    const source = sourceTheme(theme.name);

    expect(theme.style['editor.background']).toBe(source.ui['surface.canvas']);
    expect(theme.style['editor.foreground']).toBe(source.ui['text.primary']);
    expect(theme.style['editor.active_line.background']).toBe(source.ui['surface.hover']);
    expect(theme.style['editor.highlighted_line.background']).toBe(source.ui['editor.highlight']);
    expect(theme.style['search.active_match_background']).toBe(source.ui['search.match.active']);
    expect(theme.style['search.match_background']).toBe(source.ui['search.match.passive']);
    expect(theme.style.players[0]?.cursor).toBe(source.ui['accent.cursor']);
    expect(theme.style.accents[0]).toBe(bracketColor(source, 'depth1'));
    expect(theme.style['pane.focused_border']).toBe(source.ui['accent.primary']);
    expect(theme.style['panel.focused_border']).toBe(source.ui['accent.primary']);
    expect(theme.style.predictive).toBe(source.ui['text.hint']);
    expect(theme.style['predictive.background']).toBe(source.ui['editor.predictive.background']);
    expect(theme.style['predictive.border']).toBe(source.ui['editor.predictive.border']);
    expect(theme.style['terminal.ansi.red']).toBe(source.terminal['ansi.red']);
    expect(theme.style['version_control.deleted']).toBe(source.ui['status.removed']);
    expect(theme.style['version_control.word_deleted']).toMatch(
      new RegExp(`^${source.ui['status.removed'].slice(0, 7)}`, 'u')
    );
    expect(theme.style.syntax.function.color).toBe(source.syntax.function);
    expect(theme.style.syntax.function.font_weight).toBe(500);
    expect(theme.style.syntax.constructor.color).toBe(source.syntax.type);
    expect(theme.style.syntax['function.builtin']?.color).toBe(source.syntax.function);
    expect(theme.style.syntax['function.builtin']?.font_weight).toBe(500);
    expect(theme.style.syntax.hint?.color).toBe(source.ui['text.hint']);
    expect(theme.style.syntax.hint?.font_style).toBe('italic');
    expect(theme.style.syntax['markup.quote']?.color).toBe(source.syntax.string);
    expect(theme.style.syntax['markup.quote']?.font_style).toBe('italic');
    expect(theme.style.syntax.predictive?.color).toBe(source.ui['text.hint']);
    expect(theme.style.syntax.predictive?.font_style).toBeUndefined();
    expect(theme.style.syntax['invalid.deprecated']?.color).toBe(source.syntax.data);
    expect(theme.style.syntax.parameter.color).toBe(source.syntax.data);
    expect(theme.style.syntax.boolean.color).toBe(source.syntax.constantLanguage);
    expect(theme.style.syntax['constant.builtin']?.color).toBe(source.syntax.null);
    expect(theme.style.syntax.constant.color).toBe(source.syntax.data);
    expect(theme.style.syntax.number.color).toBe(source.syntax.data);
    expect(theme.style.syntax['variable.special']?.color).toBe(source.syntax.data);
    expect(theme.style.syntax['variable.special']?.font_style).toBe('italic');
    expect(theme.style.syntax.operator.color).toBe(source.syntax.keyword);
    expect(theme.style.syntax['selector.pseudo']?.color).toBe(source.syntax.keyword);
    expect(theme.style.syntax['property.readonly']?.color).toBe(source.syntax.data);
    expect(theme.style.syntax.type.color).toBe(source.syntax.type);
  }
});

test('Zed bracket accents are exact source projections and dim ANSI colors use the muted contrast envelope', () => {
  const generated = buildZedThemeFamily() as ZedThemeFamily;
  const ansiNames = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

  for (const theme of generated.themes) {
    const source = sourceTheme(theme.name);
    const style = theme.style as unknown as Record<string, any>;
    const background = source.terminal.background!;
    const mutedContrast = contrastRatio(source.ui['text.muted']!, background);
    const sourceAccents = REQUIRED_THEME_ROLES.brackets.map((role) => bracketColor(source, role));
    const accents = style.accents as string[];

    expect(accents).toEqual(sourceAccents);
    expect(style['terminal.dim_foreground']).toBe(style['terminal.ansi.dim_white']);

    for (const name of ansiNames) {
      const normal = style[`terminal.ansi.${name}`] as string;
      const dim = style[`terminal.ansi.dim_${name}`] as string;
      const normalContrast = contrastRatio(normal, background);
      const dimContrast = contrastRatio(dim, background);

      expect(dimContrast).toBeLessThanOrEqual(normalContrast);
      if (normalContrast <= mutedContrast) {
        expect(dim).toBe(normal);
      } else {
        expect(dim).not.toBe(normal);
        const closestRepresentableDistance = Math.min(
          ...Array.from({ length: 254 }, (_, index) => {
            const alpha = (index + 1).toString(16).padStart(2, '0');
            const candidate = opaqueHex(withHexAlpha(normal, alpha), background);
            return candidate === normal
              ? Number.POSITIVE_INFINITY
              : Math.abs(contrastRatio(candidate, background) - mutedContrast);
          })
        );
        expect(Math.abs(dimContrast - mutedContrast)).toBeCloseTo(closestRepresentableDistance, 12);
      }
    }
  }
});

test('Zed example settings match the repo companion settings contract', () => {
  const settings = readJson<Record<string, any>>('apps/zed/settings.example.json');
  const readme = fs.readFileSync('apps/zed/README.md', 'utf8');

  expect(settings.theme).toEqual({
    mode: 'dark',
    dark: getDefaultThemeSource().label,
    light: getTerminalDefaultThemeSource('light').label,
  });
  expect(settings.icon_theme).toEqual({
    mode: 'light',
    light: 'Colored Zed Icons Theme Dark',
    dark: 'Colored Zed Icons Theme Dark',
  });
  expect(settings.buffer_font_family).toBe('Monaspace Neon');
  expect(settings.buffer_font_size).toBe(18);
  expect(settings.buffer_font_weight).toBe(300);
  expect(settings.buffer_line_height).toEqual({ custom: 1.45 });
  expect(settings.disable_ai).toBe(true);
  expect(settings.text_rendering_mode).toBe('platform_default');
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
  expect(settings.ui_font_family).toBe('Inter Variable');
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
  });
  expect(settings.terminal.font_family).toBe('Monaspace Neon');
  expect(settings.terminal.font_size).toBe(12);
  expect(settings.terminal.line_height).toEqual({ custom: 1.2 });
  expect(settings.terminal.cursor_shape).toBe('bar');
  expect(settings.terminal.blinking).toBe('terminal_controlled');
  expect(settings.terminal.minimum_contrast).toBe(0);
  expect(settings.cli_default_open_behavior).toBe('existing_window');
  expect(settings.diff_view_style).toBe('split');
  expect(settings).not.toHaveProperty('helix_mode');
  expect(settings.inlay_hints).toEqual({
    enabled: true,
    show_type_hints: true,
    show_parameter_hints: true,
    show_other_hints: true,
    show_background: false,
  });
  expect(settings.use_on_type_format).toBe(true);
  expect(settings.show_edit_predictions).toBe(false);
  expect(settings).not.toHaveProperty('edit_predictions');
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
  expect(settings.languages.Python.indent_guides.background_coloring).toBe('indent_aware');
  expect(settings.languages.Python.language_servers).toEqual(['ty', 'ruff']);
  expect(settings.languages.TypeScript.language_servers).toEqual(['tsgo', 'biome']);
  expect(settings.languages.TSX.formatter.language_server.name).toBe('biome');
  expect(settings.languages.JavaScript.code_actions_on_format).toMatchObject({
    'source.fixAll.biome': true,
    'source.organizeImports.biome': true,
  });
  expect(settings.languages.Java.language_servers).toEqual(['jdtls']);
  expect(settings.file_types.tailwindcss).toEqual(['*.css']);
  expect(settings.node.ignore_system_version).toBe(true);
  expect(settings).not.toHaveProperty('agent');

  for (const ownedSettingArea of [
    'font family',
    'text rendering',
    'inlay hints',
    'panels',
    'AI posture',
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

function sourceTheme(themeName: string): ThemeDefinition {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme(source);

    if (theme.name === themeName) {
      return theme;
    }
  }

  throw new Error(`Unexpected theme '${themeName}'`);
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function collectHexStrings(value: unknown): string[] {
  if (typeof value === 'string') return value.startsWith('#') ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(collectHexStrings);
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(collectHexStrings);
  }
  return [];
}
