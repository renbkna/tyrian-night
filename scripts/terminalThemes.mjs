// @ts-check

import path from 'node:path';

import { opaqueHex } from './colorUtils.mjs';
import { syncGeneratedAssets } from './generatedAssets.mjs';
import { FASTFETCH_IMAGE_CONFIG_PATH } from './portableAssets.mjs';
import { themeColor as requireThemeColor, TERMINAL_ANSI_ROLES } from './themeDefinition.mjs';
import {
  getTerminalDefaultThemeSource,
  loadThemeRepository,
  readSourceTheme,
  requireProductionThemeRepository,
} from './themeSources.mjs';

const defaultRepoRoot = path.resolve(import.meta.dirname, '..');

/**
 * @typedef {import('./themeDefinition.mjs').ThemeDefinition} ThemeDefinition
 * @typedef {{ path: string; content: string }} GeneratedAsset
 */

const TERMINAL_GENERATED_OWNERSHIP = [
  { directory: 'terminal/ghostty/themes' },
  { directory: 'terminal/fish/themes' },
  { directory: 'terminal/fish/functions', match: /^fish_greeting\.fish$/u },
  { directory: 'terminal/fish/conf.d', match: /^tyrian-night\.fish$/u },
  { directory: 'terminal/foot/themes' },
  { directory: 'terminal/fastfetch', match: /^tyrian-night\.jsonc$/u },
  { directory: 'terminal/ghostty', match: /^(?:config\.example|ghostty\.css)$/u },
  { directory: 'terminal/fish', match: /^config\.example\.fish$/u },
  { directory: 'terminal/foot', match: /^foot\.ini$/u },
  { directory: 'terminal/starship', match: /^tyrian-night\.toml$/u },
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
  const defaultDarkTheme = terminalSourceTheme(sourceThemes, 'dark').theme;

  return [
    ...sourceThemes.flatMap(({ source, theme }) => [
      {
        path: `terminal/ghostty/themes/${source.slug}`,
        content: buildGhosttyTheme(theme),
      },
      {
        path: `terminal/foot/themes/${source.slug}.ini`,
        content: buildFootTheme(theme),
      },
      {
        path: `terminal/fish/themes/${source.slug}.fish`,
        content: buildFishTheme(theme),
      },
    ]),
    {
      path: 'terminal/ghostty/config.example',
      content: buildGhosttyConfig({ repoRoot, repository }),
    },
    {
      path: 'terminal/foot/foot.ini',
      content: buildFootConfig({ repoRoot, repository }),
    },
    {
      path: 'terminal/fish/config.example.fish',
      content: buildFishConfig({ repoRoot, repository }),
    },
    {
      path: 'terminal/fish/conf.d/tyrian-night.fish',
      content: buildFishStartupConfig({ repoRoot, repository }),
    },
    {
      path: 'terminal/fish/functions/fish_greeting.fish',
      content: buildFishGreetingFunction(),
    },
    {
      path: 'terminal/fastfetch/tyrian-night.jsonc',
      content: buildFastfetchConfig(defaultDarkTheme),
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
export function writeTerminalThemeAssets(repoRoot = defaultRepoRoot, options = {}) {
  const staleAssets = syncGeneratedAssets(buildTerminalThemeAssets(repoRoot), repoRoot, {
    check: options.check,
    ownership: TERMINAL_GENERATED_OWNERSHIP,
  });

  if (staleAssets.length > 0) {
    throw new Error(
      `Terminal theme assets are stale:\n${staleAssets
        .map((assetPath) => `  - ${assetPath}`)
        .join('\n')}\nRun: node scripts/terminalThemes.mjs`
    );
  }
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
    ['fish_color_keyword', fishRoleColor(theme, 'syntax:keyword')],
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
 * @param {{ repoRoot?: string; repository?: import('./themeSources.mjs').ThemeRepository }} [options]
 * @returns {string}
 */
export function buildGhosttyConfig(options = {}) {
  const root = options.repoRoot ?? defaultRepoRoot;
  const repository = resolveThemeRepository(root, options.repository);
  const darkSource = getTerminalDefaultThemeSource('dark', repository.sources);
  const lightSource = getTerminalDefaultThemeSource('light', repository.sources);
  const lines = [
    `theme = dark:${darkSource.slug},light:${lightSource.slug}`,
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
    'copy-on-select = clipboard',
  ];

  return `${lines.join('\n')}\n`;
}

/**
 * @param {{ repoRoot?: string; repository?: import('./themeSources.mjs').ThemeRepository; themeDirectory?: string }} [options]
 * @returns {string}
 */
export function buildFootConfig(options = {}) {
  const root = options.repoRoot ?? defaultRepoRoot;
  const repository = resolveThemeRepository(root, options.repository);
  const defaultDarkSource = getTerminalDefaultThemeSource('dark', repository.sources);
  const defaultLightSource = getTerminalDefaultThemeSource('light', repository.sources);
  const themeDirectory = options.themeDirectory ?? '/path/to/tyrian-night/terminal/foot/themes';

  return [
    `include=${themeDirectory}/${defaultDarkSource.slug}.ini`,
    `include=${themeDirectory}/${defaultLightSource.slug}.ini`,
    '',
    '[main]',
    'initial-color-theme=dark',
    'font=Monaspace Neon:size=13',
    'font-bold=Monaspace Neon:size=13',
    'font-italic=Monaspace Radon:size=13',
    'font-bold-italic=Monaspace Radon:size=13',
    'pad=10x8',
    'selection-target=clipboard',
    '',
    '[csd]',
    'preferred=client',
    'font=Monaspace Neon',
    'hide-when-maximized=yes',
    '',
    '[cursor]',
    'style=beam',
    'blink=yes',
    '',
  ].join('\n');
}

/**
 * @param {{ repoRoot?: string; repository?: import('./themeSources.mjs').ThemeRepository; tyrianRoot?: string }} [options]
 * @returns {string}
 */
export function buildFishConfig(options = {}) {
  const tyrianRoot = options.tyrianRoot ?? '/path/to/tyrian-night';

  return [
    'if status is-interactive',
    ...buildFishStartupConfig({
      repoRoot: options.repoRoot,
      repository: options.repository,
      tyrianRoot,
    })
      .trimEnd()
      .split('\n')
      .map((line) => `    ${line}`),
    '',
    '    starship init fish | source',
    'end',
    '',
  ].join('\n');
}

/**
 * @param {{ repoRoot?: string; repository?: import('./themeSources.mjs').ThemeRepository; tyrianRoot?: string }} [options]
 * @returns {string}
 */
export function buildFishStartupConfig(options = {}) {
  const root = options.repoRoot ?? defaultRepoRoot;
  const defaultDarkSource = getTerminalDefaultThemeSource(
    'dark',
    resolveThemeRepository(root, options.repository).sources
  );
  const tyrianRoot = options.tyrianRoot ?? '/path/to/tyrian-night';

  return [
    `set -gx TYRIAN_NIGHT_ROOT "${fishEscape(tyrianRoot)}"`,
    `source $TYRIAN_NIGHT_ROOT/terminal/fish/themes/${defaultDarkSource.slug}.fish`,
    'set -gx STARSHIP_CONFIG $TYRIAN_NIGHT_ROOT/terminal/starship/tyrian-night.toml',
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
 * @param {ThemeDefinition} theme
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
          total: opaqueRoleColor(theme, 'ui:border.tab'),
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
 * @param {Array<{ source: import('./themeSources.mjs').ThemeSource; theme: ThemeDefinition }>} sourceThemes
 * @returns {string}
 */
function buildStarshipConfig(sourceThemes) {
  return [
    '"$schema" = "https://starship.rs/config-schema.json"',
    '',
    `palette = "${terminalSourceTheme(sourceThemes, 'dark').source.paletteName}"`,
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
 * @param {Array<{ source: import('./themeSources.mjs').ThemeSource; theme: ThemeDefinition }>} sourceThemes
 * @param {'dark' | 'light'} appearance
 * @returns {{ source: import('./themeSources.mjs').ThemeSource; theme: ThemeDefinition }}
 */
function terminalSourceTheme(sourceThemes, appearance) {
  const defaultSource = getTerminalDefaultThemeSource(
    appearance,
    sourceThemes.map(({ source }) => source)
  );
  const sourceTheme = sourceThemes.find(({ source }) => source.slug === defaultSource.slug);

  if (!sourceTheme) {
    throw new Error(`Missing resolved ${appearance} terminal source theme.`);
  }

  return sourceTheme;
}

/**
 * @param {string} root
 * @param {import('./themeSources.mjs').ThemeRepository | undefined} repository
 */
function resolveThemeRepository(root, repository) {
  const resolvedRepository = requireProductionThemeRepository(
    repository ?? loadThemeRepository(root)
  );
  if (resolvedRepository.root !== path.resolve(root)) {
    throw new Error('Terminal generator theme context does not belong to the requested root.');
  }
  return resolvedRepository;
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

/**
 * @param {string} value
 * @returns {string}
 */
function fishEscape(value) {
  return value.replace(/([$"\\])/gu, '\\$1');
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  writeTerminalThemeAssets(defaultRepoRoot, { check: process.argv.includes('--check') });
}
