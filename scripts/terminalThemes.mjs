// @ts-check

import fs from 'node:fs';
import path from 'node:path';

import { opaqueHex, parseHexColor } from './colorUtils.mjs';
import { FASTFETCH_IMAGE_CONFIG_PATH } from './portableAssets.mjs';
import { SOURCE_THEMES, readSourceTheme } from './themeSources.mjs';

/**
 * @typedef {{ foreground?: string; fontStyle?: string; italic?: boolean; bold?: boolean }} HighlightSettings
 * @typedef {{
 *   name: string;
 *   colors: Record<string, string>;
 *   semanticTokenColors: Record<string, HighlightSettings>;
 *   tokenColors: Array<{ scope: string | string[]; settings: HighlightSettings }>;
 * }} VscodeTheme
 * @typedef {{ path: string; content: string }} GeneratedAsset
 */

const GHOSTTY_ANSI_KEYS = [
  'terminal.ansiBlack',
  'terminal.ansiRed',
  'terminal.ansiGreen',
  'terminal.ansiYellow',
  'terminal.ansiBlue',
  'terminal.ansiMagenta',
  'terminal.ansiCyan',
  'terminal.ansiWhite',
  'terminal.ansiBrightBlack',
  'terminal.ansiBrightRed',
  'terminal.ansiBrightGreen',
  'terminal.ansiBrightYellow',
  'terminal.ansiBrightBlue',
  'terminal.ansiBrightMagenta',
  'terminal.ansiBrightCyan',
  'terminal.ansiBrightWhite',
];

/**
 * @param {string} [repoRoot]
 * @returns {GeneratedAsset[]}
 */
export function buildTerminalThemeAssets(repoRoot = process.cwd()) {
  const sourceThemes = SOURCE_THEMES.map((source) => ({
    source,
    theme: /** @type {VscodeTheme} */ (readSourceTheme(source, repoRoot)),
  }));

  return [
    ...sourceThemes.flatMap(({ source, theme }) => [
      {
        path: `terminal/ghostty/themes/${source.slug}`,
        content: buildGhosttyTheme(theme),
      },
      {
        path: `terminal/fish/themes/${source.slug}.fish`,
        content: buildFishTheme(theme),
      },
    ]),
    {
      path: 'terminal/ghostty/config.example',
      content: buildGhosttyConfig({ theme: sourceThemes[0].theme }),
    },
    {
      path: 'terminal/ghostty/ghostty.css',
      content: buildGhosttyGtkCss(sourceThemes[0].theme),
    },
    {
      path: 'terminal/fish/config.example.fish',
      content: buildFishConfig(),
    },
    {
      path: 'terminal/fish/functions/fish_greeting.fish',
      content: buildFishGreetingFunction(),
    },
    {
      path: 'terminal/fastfetch/tyrian-night.jsonc',
      content: buildFastfetchConfig(sourceThemes[0].theme),
    },
    {
      path: 'terminal/starship/tyrian-night.toml',
      content: buildStarshipConfig(sourceThemes),
    },
  ];
}

/**
 * @param {string} [repoRoot]
 * @param {{ check?: boolean }} [options]
 * @returns {void}
 */
export function writeTerminalThemeAssets(repoRoot = process.cwd(), options = {}) {
  const staleAssets = [];

  for (const asset of buildTerminalThemeAssets(repoRoot)) {
    const outputPath = path.join(repoRoot, asset.path);

    if (options.check) {
      const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : undefined;

      if (current !== asset.content) {
        staleAssets.push(asset.path);
      }

      continue;
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, asset.content, 'utf8');
  }

  if (staleAssets.length > 0) {
    throw new Error(
      `Terminal theme assets are stale:\n${staleAssets
        .map((assetPath) => `  - ${assetPath}`)
        .join('\n')}\nRun: node scripts/terminalThemes.mjs`
    );
  }
}

/**
 * @param {VscodeTheme} theme
 * @returns {string}
 */
function buildGhosttyTheme(theme) {
  const colors = theme.colors;
  const background = themeColor(theme, 'terminal.background', 'editor.background');
  const foreground = themeColor(theme, 'terminal.foreground', 'editor.foreground');
  const selectionBackground = themeColor(
    theme,
    'terminal.selectionBackground',
    'editor.selectionBackground'
  );

  return [
    ...GHOSTTY_ANSI_KEYS.map(
      (colorKey, index) => `palette = ${index}=${opaqueThemeColor(colors[colorKey], background)}`
    ),
    `background = ${background}`,
    `foreground = ${foreground}`,
    `cursor-color = ${themeColor(theme, 'editorCursor.foreground', 'terminal.foreground')}`,
    `cursor-text = ${themeColor(theme, 'editorCursor.background', 'terminal.background')}`,
    `selection-background = ${selectionBackground}`,
    `selection-foreground = ${foreground}`,
    '',
  ].join('\n');
}

/**
 * @param {VscodeTheme} theme
 * @returns {string}
 */
function buildFishTheme(theme) {
  const semantic = theme.semanticTokenColors;
  const background = themeColor(theme, 'terminal.background', 'editor.background');
  const foreground = fishThemeColor(theme, 'terminal.foreground', 'editor.foreground');
  const selectionBackground = fishThemeColor(
    theme,
    'list.activeSelectionBackground',
    'terminal.selectionBackground'
  );

  const fishColors = [
    ['fish_color_normal', foreground],
    ['fish_color_command', fishColor(semantic.function.foreground, background)],
    ['fish_color_keyword', fishColor(tokenColor(theme, 'keyword'), background)],
    ['fish_color_quote', fishColor(tokenColor(theme, 'string'), background)],
    ['fish_color_redirection', fishThemeColor(theme, 'terminal.ansiBlue')],
    ['fish_color_end', fishThemeColor(theme, 'terminal.ansiMagenta')],
    ['fish_color_error', `${fishThemeColor(theme, 'editorError.foreground')} --bold`],
    ['fish_color_param', fishColor(semantic.parameter.foreground, background)],
    ['fish_color_valid_path', `${fishThemeColor(theme, 'terminal.ansiGreen')} --underline`],
    ['fish_color_option', fishThemeColor(theme, 'terminal.ansiYellow')],
    ['fish_color_comment', fishColor(tokenColor(theme, 'comment'), background)],
    ['fish_color_selection', `${foreground} --background=${selectionBackground}`],
    ['fish_color_operator', fishThemeColor(theme, 'terminal.ansiMagenta')],
    ['fish_color_escape', fishThemeColor(theme, 'terminal.ansiYellow')],
    ['fish_color_autosuggestion', fishThemeColor(theme, 'breadcrumb.foreground')],
    ['fish_color_cwd', fishThemeColor(theme, 'terminal.ansiCyan')],
    ['fish_color_cwd_root', fishThemeColor(theme, 'editorError.foreground')],
    ['fish_color_user', fishThemeColor(theme, 'terminal.ansiMagenta')],
    ['fish_color_host', fishThemeColor(theme, 'terminal.ansiBlue')],
    ['fish_color_host_remote', fishThemeColor(theme, 'terminal.ansiYellow')],
    ['fish_color_status', fishThemeColor(theme, 'editorError.foreground')],
    ['fish_color_cancel', `${fishThemeColor(theme, 'editorError.foreground')} --reverse`],
    ['fish_color_search_match', `${foreground} --background=${selectionBackground}`],
    ['fish_color_history_current', `${fishThemeColor(theme, 'terminal.ansiCyan')} --bold`],
    ['fish_pager_color_progress', fishThemeColor(theme, 'breadcrumb.foreground')],
    ['fish_pager_color_prefix', `${fishThemeColor(theme, 'terminal.ansiCyan')} --bold`],
    ['fish_pager_color_completion', foreground],
    ['fish_pager_color_description', fishThemeColor(theme, 'breadcrumb.foreground')],
    ['fish_pager_color_selected_background', `--background=${selectionBackground}`],
    [
      'fish_pager_color_selected_prefix',
      `${fishThemeColor(theme, 'terminal.ansiCyan')} --bold --background=${selectionBackground}`,
    ],
    ['fish_pager_color_selected_completion', `${foreground} --background=${selectionBackground}`],
    [
      'fish_pager_color_selected_description',
      `${fishThemeColor(theme, 'breadcrumb.foreground')} --background=${selectionBackground}`,
    ],
  ];

  return `${fishColors.map(([name, value]) => `set -g ${name} ${value}`).join('\n')}\n`;
}

/**
 * @param {{ gtkCustomCss?: string; theme?: VscodeTheme }} [options]
 * @returns {string}
 */
export function buildGhosttyConfig(options = {}) {
  const theme = options.theme ?? /** @type {VscodeTheme} */ (readSourceTheme(SOURCE_THEMES[0]));
  const lines = [
    'theme = dark:tyrian-night,light:tyrian-dawn',
    'background-opacity = 0.82',
    'background-blur = true',
    'font-family = Monaspace Neon',
    'font-family-bold = Monaspace Neon',
    'font-family-italic = Monaspace Radon',
    'font-family-bold-italic = Monaspace Radon',
    'font-size = 13',
    'font-thicken = false',
    'cursor-style = bar',
    'cursor-style-blink = true',
    'window-decoration = client',
    'window-theme = ghostty',
    'window-vsync = true',
    `window-titlebar-background = ${themeColor(theme, 'terminal.background', 'editor.background')}`,
    `window-titlebar-foreground = ${themeColor(theme, 'terminal.foreground', 'editor.foreground')}`,
    'gtk-titlebar = true',
    'gtk-titlebar-style = tabs',
    'window-show-tab-bar = auto',
    'gtk-tabs-location = top',
    'gtk-wide-tabs = false',
    'gtk-toolbar-style = flat',
    'window-padding-x = 10',
    'window-padding-y = 8',
    'minimum-contrast = 1',
    'mouse-scroll-multiplier = discrete:1,precision:1',
  ];

  if (options.gtkCustomCss) {
    lines.push(`gtk-custom-css = ${options.gtkCustomCss}`);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * @param {{ tyrianRoot?: string }} [options]
 * @returns {string}
 */
export function buildFishConfig(options = {}) {
  const tyrianRoot = options.tyrianRoot ?? '/path/to/tyrian-night';

  return [
    'if status is-interactive',
    `    set -gx TYRIAN_NIGHT_ROOT "${fishEscape(tyrianRoot)}"`,
    '    source $TYRIAN_NIGHT_ROOT/terminal/fish/themes/tyrian-night.fish',
    '    set -gx STARSHIP_CONFIG $TYRIAN_NIGHT_ROOT/terminal/starship/tyrian-night.toml',
    '',
    '    starship init fish | source',
    'end',
    '',
  ].join('\n');
}

/**
 * @returns {string}
 */
function buildFishGreetingFunction() {
  return [
    'function fish_greeting',
    '    set -l tyrian_night_root $TYRIAN_NIGHT_ROOT',
    '',
    '    if test -z "$tyrian_night_root"',
    '        set -l greeting_path (status current-filename)',
    '        if test -n "$greeting_path"',
    '            set tyrian_night_root (realpath (dirname $greeting_path)/../../..)',
    '        end',
    '    end',
    '',
    '    if test -n "$tyrian_night_root"',
    '        fastfetch --config $tyrian_night_root/terminal/fastfetch/tyrian-night.jsonc',
    '    end',
    'end',
    '',
  ].join('\n');
}

/**
 * @param {VscodeTheme} theme
 * @returns {string}
 */
function buildFastfetchConfig(theme) {
  const config = {
    $schema: 'https://github.com/fastfetch-cli/fastfetch/raw/master/doc/json_schema.json',
    logo: {
      type: 'chafa',
      source: FASTFETCH_IMAGE_CONFIG_PATH,
      width: 50,
      height: 26,
      preserveAspectRatio: true,
      padding: {
        top: 1,
        left: 0,
        right: 4,
      },
      printRemaining: true,
      recache: false,
      position: 'left',
      chafa: {
        fgOnly: false,
        symbols: 'braille',
        canvasMode: 'truecolor',
      },
    },
    display: {
      separator: '  ',
      color: {
        keys: themeColor(theme, 'terminal.ansiMagenta'),
        title: themeColor(theme, 'terminal.foreground'),
        output: themeColor(theme, 'terminal.foreground'),
        separator: themeColor(theme, 'breadcrumb.foreground'),
      },
      brightColor: true,
      key: {
        type: 'icon',
        width: 12,
      },
      bar: {
        char: {
          elapsed: '━',
          total: '─',
        },
        border: {
          left: '',
          right: '',
        },
        color: {
          elapsed: themeColor(theme, 'terminal.ansiMagenta'),
          total: themeColor(theme, 'tab.border'),
        },
        width: 12,
      },
      percent: {
        type: ['bar', 'num'],
        color: {
          green: themeColor(theme, 'terminal.ansiGreen'),
          yellow: themeColor(theme, 'terminal.ansiYellow'),
          red: themeColor(theme, 'terminal.ansiRed'),
        },
      },
    },
    modules: [
      {
        type: 'title',
        key: ' ',
      },
      {
        type: 'separator',
        string: '─',
        outputColor: themeColor(theme, 'terminal.ansiMagenta'),
      },
      {
        type: 'os',
        keyIcon: '󰣇',
      },
      {
        type: 'kernel',
        keyIcon: '',
      },
      {
        type: 'uptime',
        keyIcon: '',
      },
      {
        type: 'packages',
        keyIcon: '󰏖',
      },
      {
        type: 'shell',
        keyIcon: '',
      },
      {
        type: 'de',
        keyIcon: '',
      },
      {
        type: 'wm',
        keyIcon: '',
      },
      {
        type: 'terminal',
        keyIcon: '',
      },
      {
        type: 'cpu',
        keyIcon: '',
      },
      {
        type: 'gpu',
        keyIcon: '󰢮',
      },
      {
        type: 'memory',
        keyIcon: '',
      },
      {
        type: 'disk',
        keyIcon: '',
        folders: '/',
        showReadOnly: true,
      },
      {
        type: 'colors',
        key: ' ',
        symbol: 'block',
        block: {
          width: 3,
          range: [0, 15],
        },
      },
    ],
  };

  return `${formatJson(config)}\n`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatJson(value) {
  return JSON.stringify(value, null, 2)
    .replace(/\[\n\s+"bar",\n\s+"num"\n\s+\]/u, '["bar", "num"]')
    .replace(/\[\n\s+0,\n\s+15\n\s+\]/u, '[0, 15]');
}

/**
 * @param {Array<{ source: import('./themeSources.mjs').ThemeSource; theme: VscodeTheme }>} sourceThemes
 * @returns {string}
 */
function buildStarshipConfig(sourceThemes) {
  return [
    '"$schema" = "https://starship.rs/config-schema.json"',
    '',
    `palette = "${SOURCE_THEMES[0].paletteName}"`,
    '',
    'format = """',
    '[](fg:surface)\\',
    '$os\\',
    '$username\\',
    '$directory\\',
    '$git_branch\\',
    '$git_status\\',
    '$c\\',
    '$rust\\',
    '$golang\\',
    '$nodejs\\',
    '$bun\\',
    '$python\\',
    '$java\\',
    '$docker_context\\',
    '$cmd_duration\\',
    '$time\\',
    '[](fg:surface)\\',
    '$line_break$character"""',
    '',
    '[os]',
    'disabled = false',
    'style = "bg:surface fg:accent"',
    'format = "[$symbol]($style)"',
    '',
    '[os.symbols]',
    'Arch = "󰣇"',
    'CachyOS = "󰣇"',
    'Linux = "󰌽"',
    '',
    '[username]',
    'show_always = true',
    'style_user = "bg:surface fg:muted"',
    'style_root = "bg:surface fg:danger"',
    'format = "[ $user]($style)"',
    '',
    '[directory]',
    'style = "bg:surface fg:text"',
    'format = "[  $path]($style)"',
    'truncation_length = 3',
    'truncation_symbol = "…/"',
    '',
    '[directory.substitutions]',
    'Documents = "󰈙 "',
    'Downloads = " "',
    'Music = "󰝚 "',
    'Pictures = " "',
    '',
    ...['c', 'rust', 'golang', 'nodejs', 'bun', 'python', 'java'].flatMap((module) =>
      buildLanguageModule(module)
    ),
    '[docker_context]',
    'symbol = ""',
    'style = "bg:surface fg:container"',
    'format = "[  $symbol $context]($style)"',
    '',
    '[git_branch]',
    'symbol = ""',
    'style = "bg:surface fg:command"',
    'format = "[  $symbol $branch]($style)"',
    '',
    '[git_status]',
    'style = "bg:surface fg:warning"',
    'format = "[ $all_status$ahead_behind]($style)"',
    '',
    '[time]',
    'disabled = false',
    'time_format = "%R"',
    'style = "bg:surface fg:muted"',
    'format = "[   $time ]($style)"',
    '',
    '[character]',
    'success_symbol = "[❯](fg:success)"',
    'error_symbol = "[❯](fg:danger)"',
    '',
    '[line_break]',
    'disabled = false',
    '',
    '[cmd_duration]',
    'min_time = 2000',
    'style = "bg:surface fg:warning"',
    'format = "[  took $duration]($style)"',
    '',
    ...sourceThemes.flatMap(({ source, theme }) => buildStarshipPalette(source.paletteName, theme)),
  ].join('\n');
}

/**
 * @param {VscodeTheme} theme
 * @returns {string}
 */
function buildGhosttyGtkCss(theme) {
  const background = themeColor(theme, 'terminal.background', 'editor.background').toLowerCase();
  const foreground = themeColor(theme, 'terminal.foreground', 'editor.foreground').toLowerCase();
  const accent = themeColor(theme, 'terminal.ansiMagenta', 'activityBar.activeBorder');

  return [
    'headerbar {',
    '  min-height: 30px;',
    '  padding: 2px 6px;',
    `  background: ${background};`,
    '  border: none;',
    '  box-shadow: none;',
    '}',
    '',
    'tabbar {',
    '  padding: 0;',
    '  background: transparent;',
    '  border: none;',
    '  box-shadow: none;',
    '}',
    '',
    'tabbar tabbox tab {',
    '  min-height: 20px;',
    '  padding: 0 8px;',
    '  margin: 2px 1px;',
    '  border-radius: 6px;',
    '  background: transparent;',
    '  border: none;',
    '}',
    '',
    'tabbar tabbox tab:hover {',
    `  background: ${rgba(accent, 0.18)};`,
    '}',
    '',
    'tabbar tabbox tab:selected {',
    `  background: ${rgba(accent, 0.32)};`,
    '}',
    '',
    'tabbar tabbox tab label {',
    `  color: ${foreground};`,
    '  font-size: 10pt;',
    '  font-weight: 500;',
    '}',
    '',
    'windowcontrols > button {',
    '  min-width: 22px;',
    '  min-height: 22px;',
    '  margin: 0 1px;',
    '  padding: 0;',
    '  border-radius: 999px;',
    '  background: transparent;',
    '  border: none;',
    '  box-shadow: none;',
    '}',
    '',
    'windowcontrols > button:hover {',
    `  background: ${rgba(accent, 0.22)};`,
    '}',
    '',
  ].join('\n');
}

/**
 * @param {string} module
 * @returns {string[]}
 */
function buildLanguageModule(module) {
  /** @type {Record<string, string>} */
  const symbols = {
    bun: '',
    c: '',
    golang: '',
    java: '',
    nodejs: '',
    python: '',
    rust: '',
  };

  return [
    `[${module}]`,
    `symbol = "${symbols[module] ?? ''}"`,
    'style = "bg:surface fg:language"',
    'format = "[  $symbol $version]($style)"',
    '',
  ];
}

/**
 * @param {string} paletteName
 * @param {VscodeTheme} theme
 * @returns {string[]}
 */
function buildStarshipPalette(paletteName, theme) {
  const palette = {
    surface: themeColor(theme, 'list.hoverBackground', 'sideBar.background'),
    text: themeColor(theme, 'terminal.foreground', 'editor.foreground'),
    muted: themeColor(theme, 'breadcrumb.foreground', 'editorLineNumber.foreground'),
    accent: themeColor(theme, 'terminal.ansiMagenta', 'activityBar.activeBorder'),
    command: themeColor(theme, 'terminal.ansiCyan', 'editorHint.foreground'),
    language: themeColor(theme, 'terminal.ansiBlue', 'editorInfo.foreground'),
    container: opaqueThemeColor(
      theme.semanticTokenColors.parameter.foreground,
      theme.colors['editor.background']
    ),
    success: themeColor(theme, 'terminal.ansiGreen', 'editorHint.foreground'),
    danger: themeColor(theme, 'terminal.ansiRed', 'editorError.foreground'),
    warning: themeColor(theme, 'terminal.ansiYellow', 'editorWarning.foreground'),
  };

  return [
    `[palettes.${paletteName}]`,
    ...Object.entries(palette).map(([name, value]) => `${name} = "${value}"`),
    '',
  ];
}

/**
 * @param {VscodeTheme} theme
 * @param {string} key
 * @param {string} [fallbackKey]
 * @returns {string}
 */
function themeColor(theme, key, fallbackKey) {
  const background = theme.colors['terminal.background'] ?? theme.colors['editor.background'];
  const color = theme.colors[key] ?? (fallbackKey ? theme.colors[fallbackKey] : undefined);

  if (!color) {
    throw new Error(`Missing color '${key}' in ${theme.name}`);
  }

  return opaqueThemeColor(color, background);
}

/**
 * @param {VscodeTheme} theme
 * @param {string} key
 * @param {string} [fallbackKey]
 * @returns {string}
 */
function fishThemeColor(theme, key, fallbackKey) {
  return themeColor(theme, key, fallbackKey).slice(1);
}

/**
 * @param {string | undefined} color
 * @param {string} background
 * @returns {string}
 */
function fishColor(color, background) {
  if (!color) {
    throw new Error('Missing fish theme color');
  }

  return opaqueThemeColor(color, background).slice(1);
}

/**
 * @param {string | undefined} color
 * @param {string} background
 * @returns {string}
 */
function opaqueThemeColor(color, background) {
  if (!color) {
    throw new Error('Missing theme color');
  }

  return opaqueHex(color, background);
}

/**
 * @param {string} color
 * @param {number} alpha
 * @returns {string}
 */
function rgba(color, alpha) {
  const { red, green, blue } = parseHexColor(color);

  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function fishEscape(value) {
  return value.replace(/(["\\])/gu, '\\$1');
}

/**
 * @param {VscodeTheme} theme
 * @param {string} scope
 * @returns {string}
 */
function tokenColor(theme, scope) {
  return tokenSettings(theme, scope).foreground ?? '';
}

/**
 * @param {VscodeTheme} theme
 * @param {string} scope
 * @returns {HighlightSettings}
 */
function tokenSettings(theme, scope) {
  for (const token of theme.tokenColors) {
    const scopes = Array.isArray(token.scope) ? token.scope : [token.scope];

    if (scopes.includes(scope)) {
      return token.settings;
    }
  }

  throw new Error(`Missing token scope '${scope}' in ${theme.name}`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  writeTerminalThemeAssets(process.cwd(), { check: process.argv.includes('--check') });
}
