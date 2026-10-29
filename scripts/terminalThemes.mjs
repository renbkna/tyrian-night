// @ts-check

import path from 'node:path';

import { opaqueHex } from './colorUtils.mjs';
import { syncGeneratedAssets } from './generatedAssets.mjs';
import { themeColor as requireThemeColor, TERMINAL_ANSI_ROLES } from './themeDefinition.mjs';
import { loadThemeRepository, readSourceTheme } from './themeSources.mjs';

const defaultRepoRoot = path.resolve(import.meta.dirname, '..');
// The fish greeting passes this checkout-relative logo to fastfetch, so the image is read in place.
export const FASTFETCH_LOGO_ASSET_PATH = 'assets/tyrian-fetch.webp';
const GHOSTTY_THEMES_DIRECTORY = 'terminal/ghostty/themes';
const FOOT_THEMES_DIRECTORY = 'terminal/foot/themes';
const FISH_THEMES_DIRECTORY = 'terminal/fish/themes';
// Each variant's startup snippet derives the checkout root from this directory's depth.
const FISH_STARTUP_DIRECTORY = 'terminal/fish/conf.d';
// Users link the chosen variant under this one name, so switching replaces the link.
const FISH_STARTUP_LINK_NAME = 'tyrian-night.fish';
const FISH_GREETING_ASSET_PATH = 'terminal/fish/functions/fish_greeting.fish';
const FASTFETCH_CONFIG_DIRECTORY = 'terminal/fastfetch';
const STARSHIP_CONFIG_DIRECTORY = 'terminal/starship';

/**
 * @typedef {import('./themeDefinition.mjs').ThemeDefinition} ThemeDefinition
 * @typedef {import('./themeSources.mjs').ThemeSource} ThemeSource
 * @typedef {{ path: string; content: string }} GeneratedAsset
 */

// The variant files share their directories with user files. Every slug starts with `tyrian-`,
// so the generator reserves `tyrian-*.<ext>` there and leaves other names alone.
const TERMINAL_GENERATED_OWNERSHIP = [
  { directory: GHOSTTY_THEMES_DIRECTORY },
  { directory: FOOT_THEMES_DIRECTORY },
  { directory: FISH_THEMES_DIRECTORY },
  { directory: FISH_STARTUP_DIRECTORY, match: /^tyrian-[^/]+\.fish$/u },
  { directory: FASTFETCH_CONFIG_DIRECTORY, match: /^tyrian-[^/]+\.jsonc$/u },
  { directory: STARSHIP_CONFIG_DIRECTORY, match: /^tyrian-[^/]+\.toml$/u },
  {
    directory: path.posix.dirname(FISH_GREETING_ASSET_PATH),
    match: new RegExp(`^${RegExp.escape(path.posix.basename(FISH_GREETING_ASSET_PATH))}$`, 'u'),
  },
];

/**
 * @param {string} [repoRoot]
 * @returns {GeneratedAsset[]}
 */
export function buildTerminalThemeAssets(repoRoot = defaultRepoRoot) {
  const repository = loadThemeRepository(repoRoot);
  const sourceThemes = repository.sources.map((source) => ({
    source,
    theme: /** @type {ThemeDefinition} */ (readSourceTheme(source, repository)),
  }));

  return [
    ...sourceThemes.flatMap(({ source, theme }) => [
      {
        path: `${GHOSTTY_THEMES_DIRECTORY}/${source.slug}`,
        content: buildGhosttyTheme(theme),
      },
      {
        path: `${FOOT_THEMES_DIRECTORY}/${source.slug}.ini`,
        content: buildFootTheme(theme),
      },
      {
        path: `${FISH_THEMES_DIRECTORY}/${source.slug}.fish`,
        content: buildFishTheme(theme),
      },
      {
        path: `${FISH_STARTUP_DIRECTORY}/${source.slug}.fish`,
        content: buildFishStartupConfig(source),
      },
      {
        path: `${FASTFETCH_CONFIG_DIRECTORY}/${source.slug}.jsonc`,
        content: buildFastfetchConfig(theme),
      },
      {
        path: `${STARSHIP_CONFIG_DIRECTORY}/${source.slug}.toml`,
        content: buildStarshipConfig(source, theme),
      },
    ]),
    {
      path: FISH_GREETING_ASSET_PATH,
      content: buildFishGreetingFunction(),
    },
  ];
}

/**
 * @param {string} [repoRoot]
 * @param {{ check?: boolean }} [options]
 * @returns {string[]}
 */
export function syncTerminalThemeAssets(repoRoot = defaultRepoRoot, options = {}) {
  return syncGeneratedAssets(buildTerminalThemeAssets(repoRoot), repoRoot, {
    check: options.check,
    ownership: TERMINAL_GENERATED_OWNERSHIP,
  });
}

/**
 * @param {ThemeDefinition} theme
 * @returns {string}
 */
function buildGhosttyTheme(theme) {
  const background = opaqueRoleColor(theme, 'terminal:background');
  const foreground = opaqueRoleColor(theme, 'terminal:foreground');
  const selectionBackground = opaqueRoleColor(theme, 'terminal:selection');

  return [
    ...TERMINAL_ANSI_ROLES.map(
      (role, index) => `palette = ${index}=${opaqueRoleColor(theme, role)}`
    ),
    `background = ${background}`,
    `foreground = ${foreground}`,
    `cursor-color = ${opaqueRoleColor(theme, 'terminal:cursor')}`,
    `cursor-text = ${background}`,
    `selection-background = ${selectionBackground}`,
    `selection-foreground = ${foreground}`,
    `window-titlebar-background = ${background}`,
    `window-titlebar-foreground = ${foreground}`,
    '',
  ].join('\n');
}

/**
 * @param {ThemeDefinition} theme
 * @returns {string}
 */
function buildFootTheme(theme) {
  const background = opaqueRoleColor(theme, 'terminal:background');
  const foreground = opaqueRoleColor(theme, 'terminal:foreground');

  const ansiColors = TERMINAL_ANSI_ROLES.map((role) => footColor(opaqueRoleColor(theme, role)));

  return [
    theme.appearance === 'light' ? '[colors-light]' : '[colors-dark]',
    `foreground=${footColor(foreground)}`,
    `background=${footColor(background)}`,
    'alpha=0.82',
    'blur=yes',
    `regular0=${ansiColors[0]}`,
    `regular1=${ansiColors[1]}`,
    `regular2=${ansiColors[2]}`,
    `regular3=${ansiColors[3]}`,
    `regular4=${ansiColors[4]}`,
    `regular5=${ansiColors[5]}`,
    `regular6=${ansiColors[6]}`,
    `regular7=${ansiColors[7]}`,
    `bright0=${ansiColors[8]}`,
    `bright1=${ansiColors[9]}`,
    `bright2=${ansiColors[10]}`,
    `bright3=${ansiColors[11]}`,
    `bright4=${ansiColors[12]}`,
    `bright5=${ansiColors[13]}`,
    `bright6=${ansiColors[14]}`,
    `bright7=${ansiColors[15]}`,
    `cursor=${footColor(background)} ${footColor(opaqueRoleColor(theme, 'terminal:cursor'))}`,
    `selection-foreground=${footColor(foreground)}`,
    `selection-background=${footColor(opaqueRoleColor(theme, 'terminal:selection'))}`,
    '',
    '[csd]',
    `color=ff${footColor(background)}`,
    `button-color=ff${footColor(foreground)}`,
    '',
  ].join('\n');
}

/**
 * @param {ThemeDefinition} theme
 * @returns {string}
 */
function buildFishTheme(theme) {
  const foreground = fishRoleColor(theme, 'terminal:foreground');
  const selectionBackground = fishRoleColor(theme, 'ui:selection.active');

  const fishColors = [
    ['fish_color_normal', foreground],
    ['fish_color_command', fishRoleColor(theme, 'syntax:function')],
    ['fish_color_keyword', fishRoleColor(theme, 'syntax:control')],
    ['fish_color_quote', fishRoleColor(theme, 'syntax:string')],
    ['fish_color_redirection', fishRoleColor(theme, 'terminal:ansi.blue')],
    ['fish_color_end', fishRoleColor(theme, 'terminal:ansi.magenta')],
    ['fish_color_error', `${fishRoleColor(theme, 'ui:status.error')} --bold`],
    ['fish_color_param', fishRoleColor(theme, 'syntax:data')],
    ['fish_color_valid_path', `${fishRoleColor(theme, 'terminal:ansi.green')} --underline`],
    ['fish_color_option', fishRoleColor(theme, 'terminal:ansi.yellow')],
    ['fish_color_comment', fishRoleColor(theme, 'syntax:comment')],
    ['fish_color_selection', `${foreground} --background=${selectionBackground}`],
    ['fish_color_operator', fishRoleColor(theme, 'terminal:ansi.magenta')],
    ['fish_color_escape', fishRoleColor(theme, 'terminal:ansi.yellow')],
    ['fish_color_autosuggestion', fishRoleColor(theme, 'ui:text.muted')],
    ['fish_color_cwd', fishRoleColor(theme, 'terminal:ansi.cyan')],
    ['fish_color_cwd_root', fishRoleColor(theme, 'ui:status.error')],
    ['fish_color_user', fishRoleColor(theme, 'terminal:ansi.magenta')],
    ['fish_color_host', fishRoleColor(theme, 'terminal:ansi.blue')],
    ['fish_color_host_remote', fishRoleColor(theme, 'terminal:ansi.yellow')],
    ['fish_color_status', fishRoleColor(theme, 'ui:status.error')],
    ['fish_color_cancel', `${fishRoleColor(theme, 'ui:status.error')} --reverse`],
    ['fish_color_search_match', `${foreground} --background=${selectionBackground}`],
    ['fish_color_history_current', `${fishRoleColor(theme, 'terminal:ansi.cyan')} --bold`],
    ['fish_pager_color_progress', fishRoleColor(theme, 'ui:text.muted')],
    ['fish_pager_color_prefix', `${fishRoleColor(theme, 'terminal:ansi.cyan')} --bold`],
    ['fish_pager_color_completion', foreground],
    ['fish_pager_color_description', fishRoleColor(theme, 'ui:text.muted')],
    ['fish_pager_color_selected_background', `--background=${selectionBackground}`],
    [
      'fish_pager_color_selected_prefix',
      `${fishRoleColor(theme, 'terminal:ansi.cyan')} --bold --background=${selectionBackground}`,
    ],
    ['fish_pager_color_selected_completion', `${foreground} --background=${selectionBackground}`],
    [
      'fish_pager_color_selected_description',
      `${fishRoleColor(theme, 'ui:text.muted')} --background=${selectionBackground}`,
    ],
  ];

  return `${fishColors.map(([name, value]) => `set -g ${name} ${value}`).join('\n')}\n`;
}

/**
 * A variant's startup snippet owns TYRIAN_NIGHT_ROOT and TYRIAN_NIGHT_THEME: it resolves its
 * own path, so a copy-free symlink from fish's conf.d into the checkout finds the checkout
 * wherever it lives, and the snippet that FISH_STARTUP_LINK_NAME points at selects the
 * variant. Only fish reads those two, so they stay unexported; Starship reads STARSHIP_CONFIG.
 *
 * @param {ThemeSource} source
 * @returns {string}
 */
function buildFishStartupConfig(source) {
  const toRoot = `${FISH_STARTUP_DIRECTORY}/${source.slug}.fish`
    .split('/')
    .map(() => ' | path dirname')
    .join('');

  return [
    `# Resolves symlinks, then climbs from <root>/${FISH_STARTUP_DIRECTORY}/${source.slug}.fish to <root>.`,
    `set -g TYRIAN_NIGHT_ROOT (path resolve (status current-filename)${toRoot})`,
    `set -g TYRIAN_NIGHT_THEME ${source.slug}`,
    `source $TYRIAN_NIGHT_ROOT/${FISH_THEMES_DIRECTORY}/$TYRIAN_NIGHT_THEME.fish`,
    `set -gx STARSHIP_CONFIG $TYRIAN_NIGHT_ROOT/${STARSHIP_CONFIG_DIRECTORY}/$TYRIAN_NIGHT_THEME.toml`,
    '',
  ].join('\n');
}

/**
 * @returns {string}
 */
function buildFishGreetingFunction() {
  return [
    'function fish_greeting',
    '    if not set -q TYRIAN_NIGHT_ROOT TYRIAN_NIGHT_THEME',
    `        echo "fish_greeting: link a ${FISH_STARTUP_DIRECTORY}/tyrian-*.fish as ~/.config/fish/conf.d/${FISH_STARTUP_LINK_NAME}" >&2`,
    '        return 1',
    '    end',
    `    fastfetch --config $TYRIAN_NIGHT_ROOT/${FASTFETCH_CONFIG_DIRECTORY}/$TYRIAN_NIGHT_THEME.jsonc --logo $TYRIAN_NIGHT_ROOT/${FASTFETCH_LOGO_ASSET_PATH}`,
    'end',
    '',
  ].join('\n');
}

/**
 * @param {ThemeDefinition} theme
 * @returns {string}
 */
function buildFastfetchConfig(theme) {
  const config = {
    $schema: 'https://github.com/fastfetch-cli/fastfetch/raw/master/doc/json_schema.json',
    logo: {
      type: 'chafa',
      width: 50,
      height: 26,
      preserveAspectRatio: true,
      padding: {
        top: 1,
        left: 0,
        right: 4,
      },
      printRemaining: true,
      cache: true,
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
        keys: opaqueRoleColor(theme, 'terminal:ansi.magenta'),
        title: opaqueRoleColor(theme, 'terminal:foreground'),
        output: opaqueRoleColor(theme, 'terminal:foreground'),
        separator: opaqueRoleColor(theme, 'ui:text.muted'),
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
          elapsed: opaqueRoleColor(theme, 'terminal:ansi.magenta'),
          total: opaqueRoleColor(theme, 'ui:border.default'),
        },
        width: 12,
      },
      percent: {
        type: ['bar', 'num'],
        color: {
          green: opaqueRoleColor(theme, 'terminal:ansi.green'),
          yellow: opaqueRoleColor(theme, 'terminal:ansi.yellow'),
          red: opaqueRoleColor(theme, 'terminal:ansi.red'),
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
        outputColor: opaqueRoleColor(theme, 'terminal:ansi.magenta'),
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

  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * @param {ThemeSource} source
 * @param {ThemeDefinition} theme
 * @returns {string}
 */
function buildStarshipConfig(source, theme) {
  return [
    '"$schema" = "https://starship.rs/config-schema.json"',
    '',
    `palette = "${source.paletteName}"`,
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
    ...buildStarshipPalette(source.paletteName, theme),
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
 * @param {ThemeDefinition} theme
 * @returns {string[]}
 */
function buildStarshipPalette(paletteName, theme) {
  const palette = {
    surface: opaqueRoleColor(theme, 'ui:surface.hover'),
    text: opaqueRoleColor(theme, 'terminal:foreground'),
    muted: opaqueRoleColor(theme, 'ui:text.muted'),
    accent: opaqueRoleColor(theme, 'terminal:ansi.magenta'),
    command: opaqueRoleColor(theme, 'terminal:ansi.cyan'),
    language: opaqueRoleColor(theme, 'terminal:ansi.blue'),
    container: opaqueRoleColor(theme, 'syntax:data'),
    success: opaqueRoleColor(theme, 'terminal:ansi.green'),
    danger: opaqueRoleColor(theme, 'terminal:ansi.red'),
    warning: opaqueRoleColor(theme, 'terminal:ansi.yellow'),
  };

  return [
    `[palettes.${paletteName}]`,
    ...Object.entries(palette).map(([name, value]) => `${name} = "${value}"`),
    '',
  ];
}

/**
 * @param {ThemeDefinition} theme
 * @param {string} qualifiedRole
 * @returns {string}
 */
function opaqueRoleColor(theme, qualifiedRole) {
  return opaqueHex(
    requireThemeColor(theme, qualifiedRole),
    requireThemeColor(theme, 'terminal:background')
  );
}

/**
 * @param {ThemeDefinition} theme
 * @param {string} qualifiedRole
 * @returns {string}
 */
function fishRoleColor(theme, qualifiedRole) {
  return opaqueRoleColor(theme, qualifiedRole).slice(1);
}

/**
 * @param {string} color
 * @returns {string}
 */
function footColor(color) {
  return opaqueHex(color).slice(1);
}
