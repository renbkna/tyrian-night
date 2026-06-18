// @ts-check

import fs from 'node:fs';
import path from 'node:path';

import { isLightHex, opaqueHex, parseHexColor } from './colorUtils.mjs';
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
 * @typedef {{
 *   background: string;
 *   foreground: string;
 *   surfaceLow: string;
 *   surface: string;
 *   surfaceHigh: string;
 *   surfaceHighest: string;
 *   border: string;
 *   muted: string;
 *   accent: string;
 *   accentHover: string;
 *   selection: string;
 *   selectionAlt: string;
 *   link: string;
 *   visited: string;
 *   negative: string;
 *   neutral: string;
 *   positive: string;
 *   info: string;
 *   parameter: string;
 *   brightAccent: string;
 *   brightBlue: string;
 *   brightCyan: string;
 *   brightGreen: string;
 *   brightYellow: string;
 *   brightRed: string;
 *   brightWhite: string;
 *   ansi: string[];
 * }} DesktopPalette
 */

const CAELESTIA_COLOUR_ORDER = [
  'background',
  'onBackground',
  'surface',
  'surfaceDim',
  'surfaceBright',
  'surfaceContainerLowest',
  'surfaceContainerLow',
  'surfaceContainer',
  'surfaceContainerHigh',
  'surfaceContainerHighest',
  'onSurface',
  'surfaceVariant',
  'onSurfaceVariant',
  'inverseSurface',
  'inverseOnSurface',
  'outline',
  'outlineVariant',
  'shadow',
  'scrim',
  'surfaceTint',
  'primary',
  'primaryDim',
  'onPrimary',
  'primaryContainer',
  'onPrimaryContainer',
  'inversePrimary',
  'primaryFixed',
  'primaryFixedDim',
  'onPrimaryFixed',
  'onPrimaryFixedVariant',
  'secondary',
  'secondaryDim',
  'onSecondary',
  'secondaryContainer',
  'onSecondaryContainer',
  'secondaryFixed',
  'secondaryFixedDim',
  'onSecondaryFixed',
  'onSecondaryFixedVariant',
  'tertiary',
  'tertiaryDim',
  'onTertiary',
  'tertiaryContainer',
  'onTertiaryContainer',
  'tertiaryFixed',
  'tertiaryFixedDim',
  'onTertiaryFixed',
  'onTertiaryFixedVariant',
  'error',
  'errorDim',
  'onError',
  'errorContainer',
  'onErrorContainer',
  'primaryPaletteKeyColor',
  'secondaryPaletteKeyColor',
  'tertiaryPaletteKeyColor',
  'neutralPaletteKeyColor',
  'neutralVariantPaletteKeyColor',
  'errorPaletteKeyColor',
  'primary_paletteKeyColor',
  'secondary_paletteKeyColor',
  'tertiary_paletteKeyColor',
  'neutral_paletteKeyColor',
  'neutral_variant_paletteKeyColor',
  'term0',
  'term1',
  'term2',
  'term3',
  'term4',
  'term5',
  'term6',
  'term7',
  'term8',
  'term9',
  'term10',
  'term11',
  'term12',
  'term13',
  'term14',
  'term15',
  'rosewater',
  'flamingo',
  'pink',
  'mauve',
  'red',
  'maroon',
  'peach',
  'yellow',
  'green',
  'teal',
  'sky',
  'sapphire',
  'blue',
  'lavender',
  'klink',
  'klinkSelection',
  'kvisited',
  'kvisitedSelection',
  'knegative',
  'knegativeSelection',
  'kneutral',
  'kneutralSelection',
  'kpositive',
  'kpositiveSelection',
  'text',
  'subtext1',
  'subtext0',
  'overlay2',
  'overlay1',
  'overlay0',
  'surface2',
  'surface1',
  'surface0',
  'base',
  'mantle',
  'crust',
  'success',
  'onSuccess',
  'successContainer',
  'onSuccessContainer',
];

const ANSI_KEYS = [
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
export function buildDesktopThemeAssets(repoRoot = process.cwd()) {
  const packageVersion = readPackageVersion(repoRoot);

  return SOURCE_THEMES.flatMap((source) => {
    const theme = /** @type {VscodeTheme} */ (readSourceTheme(source, repoRoot));
    const palette = buildDesktopPalette(theme);
    const kdeFileName = pascalSlug(source.slug);
    const flavour = source.slug.replace(/^tyrian-/, '');
    const mode = source.appearance === 'light' ? 'light' : 'dark';
    const caelestiaColours = buildCaelestiaColours(theme, palette);

    return [
      {
        path: `desktop/kde/color-schemes/${kdeFileName}.colors`,
        content: buildKdeColorScheme(kdeFileName, theme.name, palette, { includeEffects: true }),
      },
      {
        path: `desktop/kde/plasma/desktoptheme/${kdeFileName}/colors`,
        content: buildKdeColorScheme(kdeFileName, theme.name, palette, { includeEffects: false }),
      },
      ...buildPlasmaDesktopThemePackageAssets(kdeFileName, theme.name, packageVersion),
      ...buildPlasmaWidgetSkinAssets(kdeFileName, palette),
      ...buildPlasmaLookAndFeelPackageAssets(kdeFileName, theme.name, packageVersion),
      ...buildUnionCssStylePackageAssets(kdeFileName, theme.name, palette),
      {
        path: `desktop/caelestia/schemes/tyrian/${flavour}/${mode}.txt`,
        content: buildCaelestiaSchemeText(caelestiaColours),
      },
      {
        path: `desktop/caelestia/hypr/${source.slug}.conf`,
        content: buildCaelestiaHyprScheme(caelestiaColours),
      },
      {
        path: `desktop/caelestia/state/${source.slug}.scheme.json`,
        content: `${JSON.stringify(
          {
            name: 'tyrian',
            flavour,
            mode,
            variant: 'fidelity',
            colours: caelestiaColours,
          },
          null,
          2
        )}\n`,
      },
    ];
  });
}

/**
 * @param {string} repoRoot
 * @returns {string}
 */
function readPackageVersion(repoRoot) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

  if (typeof packageJson.version !== 'string') {
    throw new Error('Missing package.json version');
  }

  return packageJson.version;
}

/**
 * @param {string} [repoRoot]
 * @param {{ check?: boolean }} [options]
 * @returns {void}
 */
export function writeDesktopThemeAssets(repoRoot = process.cwd(), options = {}) {
  const staleAssets = [];

  for (const asset of buildDesktopThemeAssets(repoRoot)) {
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
      `Desktop theme assets are stale:\n${staleAssets
        .map((assetPath) => `  - ${assetPath}`)
        .join('\n')}\nRun: node scripts/desktopThemes.mjs`
    );
  }
}

/**
 * @param {VscodeTheme} theme
 * @returns {DesktopPalette}
 */
function buildDesktopPalette(theme) {
  const background = themeColor(theme, 'editor.background', 'terminal.background');

  return {
    background,
    foreground: themeColor(theme, 'editor.foreground', 'terminal.foreground'),
    surfaceLow: themeColor(theme, 'sideBar.background', 'editor.background'),
    surface: themeColor(theme, 'list.hoverBackground', 'sideBar.background'),
    surfaceHigh: themeColor(theme, 'list.inactiveSelectionBackground', 'list.hoverBackground'),
    surfaceHighest: themeColor(theme, 'list.activeSelectionBackground', 'list.hoverBackground'),
    border: themeColor(theme, 'sideBar.border', 'tab.border'),
    muted: themeColor(theme, 'editorLineNumber.foreground', 'breadcrumb.foreground'),
    accent: themeColor(theme, 'activityBar.activeBorder', 'terminal.ansiMagenta'),
    accentHover: themeColor(theme, 'button.hoverBackground', 'terminal.ansiBrightMagenta'),
    selection: themeColor(theme, 'list.activeSelectionBackground', 'editor.selectionBackground'),
    selectionAlt: themeColor(theme, 'editor.selectionBackground', 'list.activeSelectionBackground'),
    link: themeColor(theme, 'notificationLink.foreground', 'terminal.ansiBlue'),
    visited: themeColor(theme, 'terminal.ansiMagenta', 'activityBar.activeBorder'),
    negative: themeColor(theme, 'editorError.foreground', 'terminal.ansiRed'),
    neutral: themeColor(theme, 'editorWarning.foreground', 'terminal.ansiYellow'),
    positive: themeColor(theme, 'editorGutter.addedBackground', 'terminal.ansiGreen'),
    info: themeColor(theme, 'editorInfo.foreground', 'terminal.ansiBlue'),
    parameter: semanticColor(theme, 'parameter', 'terminal.ansiMagenta'),
    brightAccent: themeColor(theme, 'terminal.ansiBrightMagenta', 'activityBar.activeBorder'),
    brightBlue: themeColor(theme, 'terminal.ansiBrightBlue', 'terminal.ansiBlue'),
    brightCyan: themeColor(theme, 'terminal.ansiBrightCyan', 'terminal.ansiCyan'),
    brightGreen: themeColor(theme, 'terminal.ansiBrightGreen', 'terminal.ansiGreen'),
    brightYellow: themeColor(theme, 'terminal.ansiBrightYellow', 'terminal.ansiYellow'),
    brightRed: themeColor(theme, 'terminal.ansiBrightRed', 'terminal.ansiRed'),
    brightWhite: themeColor(theme, 'terminal.ansiBrightWhite', 'terminal.foreground'),
    ansi: ANSI_KEYS.map((key) => themeColor(theme, key, undefined, background)),
  };
}

/**
 * @param {string} schemeId
 * @param {string} schemeName
 * @param {DesktopPalette} palette
 * @param {{ includeEffects: boolean }} options
 * @returns {string}
 */
function buildKdeColorScheme(schemeId, schemeName, palette, options) {
  const foregrounds = {
    DecorationFocus: palette.accent,
    DecorationHover: palette.accentHover,
    ForegroundActive: palette.accent,
    ForegroundInactive: palette.muted,
    ForegroundLink: palette.link,
    ForegroundNegative: palette.negative,
    ForegroundNeutral: palette.neutral,
    ForegroundNormal: palette.foreground,
    ForegroundPositive: palette.positive,
    ForegroundVisited: palette.visited,
  };

  const sections = [
    ...(options.includeEffects
      ? [
          section('ColorEffects:Disabled', {
            Color: palette.muted,
            ColorAmount: '0',
            ColorEffect: '0',
            ContrastAmount: '0.4',
            ContrastEffect: '1',
            IntensityAmount: '0.1',
            IntensityEffect: '2',
          }),
          section('ColorEffects:Inactive', {
            ChangeSelectionColor: 'true',
            Color: palette.muted,
            ColorAmount: '0.025',
            ColorEffect: '2',
            ContrastAmount: '0.1',
            ContrastEffect: '2',
            Enable: 'false',
            IntensityAmount: '0',
            IntensityEffect: '0',
          }),
        ]
      : []),
    section('Colors:Button', {
      BackgroundAlternate: palette.surface,
      BackgroundNormal: palette.surfaceLow,
      ...foregrounds,
    }),
    section('Colors:Complementary', {
      BackgroundAlternate: palette.surfaceHigh,
      BackgroundNormal: palette.surfaceHighest,
      ...foregrounds,
    }),
    section('Colors:Selection', {
      BackgroundAlternate: palette.selectionAlt,
      BackgroundNormal: palette.selection,
      DecorationFocus: palette.accent,
      DecorationHover: palette.accentHover,
      ForegroundActive: palette.foreground,
      ForegroundInactive: palette.foreground,
      ForegroundLink: palette.brightBlue,
      ForegroundNegative: palette.negative,
      ForegroundNeutral: palette.neutral,
      ForegroundNormal: palette.foreground,
      ForegroundPositive: palette.positive,
      ForegroundVisited: palette.brightAccent,
    }),
    section('Colors:Tooltip', {
      BackgroundAlternate: palette.surface,
      BackgroundNormal: palette.surfaceLow,
      ...foregrounds,
    }),
    section('Colors:View', {
      BackgroundAlternate: palette.surfaceLow,
      BackgroundNormal: palette.background,
      ...foregrounds,
    }),
    section('Colors:Window', {
      BackgroundAlternate: palette.surfaceLow,
      BackgroundNormal: palette.background,
      ...foregrounds,
    }),
    section('General', {
      ColorScheme: schemeId,
      Name: schemeName,
      shadeSortColumn: 'true',
    }),
    section('KDE', {
      contrast: '4',
    }),
    section('WM', {
      activeBackground: palette.background,
      activeBlend: palette.accent,
      activeForeground: palette.foreground,
      inactiveBackground: palette.background,
      inactiveBlend: palette.border,
      inactiveForeground: palette.muted,
    }),
  ];

  return `${sections.join('\n\n')}\n`;
}

/**
 * @param {string} schemeId
 * @param {DesktopPalette} palette
 * @returns {GeneratedAsset[]}
 */
function buildPlasmaWidgetSkinAssets(schemeId, palette) {
  const themeRoot = `desktop/kde/plasma/desktoptheme/${schemeId}`;

  return [
    {
      path: `${themeRoot}/dialogs/background.svg`,
      content: buildDialogBackgroundSvg(palette),
    },
    {
      path: `${themeRoot}/widgets/lineedit.svg`,
      content: buildLineEditSvg(palette),
    },
    {
      path: `${themeRoot}/widgets/viewitem.svg`,
      content: buildViewItemSvg(palette),
    },
    {
      path: `${themeRoot}/widgets/listitem.svg`,
      content: buildListItemSvg(palette),
    },
    {
      path: `${themeRoot}/widgets/glowbar.svg`,
      content: buildGlowbarSvg(palette),
    },
    {
      path: `${themeRoot}/widgets/tasks.svg`,
      content: buildTasksSvg(palette),
    },
  ];
}

/**
 * @param {string} schemeId
 * @param {string} schemeName
 * @param {string} packageVersion
 * @returns {GeneratedAsset[]}
 */
function buildPlasmaDesktopThemePackageAssets(schemeId, schemeName, packageVersion) {
  const themeRoot = `desktop/kde/plasma/desktoptheme/${schemeId}`;

  return [
    {
      path: `${themeRoot}/metadata.json`,
      content: `${formatJson({
        KPlugin: {
          Authors: [{ Name: 'renbkna' }],
          Category: '',
          Description: `${schemeName} Plasma desktop theme with generated Tyrian colors, launcher surfaces, taskbar states, and edge glow.`,
          EnabledByDefault: true,
          Id: schemeId,
          License: 'Apache-2.0',
          Name: schemeName,
          ServiceTypes: ['Plasma/Theme'],
          Version: packageVersion,
          Website: 'https://github.com/renbkna/tyrian-night',
        },
        'X-Plasma-API': '5.0',
      })}\n`,
    },
    {
      path: `${themeRoot}/metadata.desktop`,
      content: [
        '[Desktop Entry]',
        `Name=${schemeName}`,
        `Comment=${schemeName} Plasma desktop theme`,
        `X-KDE-PluginInfo-Name=${schemeId}`,
        'X-KDE-PluginInfo-Author=renbkna',
        `X-KDE-PluginInfo-Version=${packageVersion}`,
        'X-KDE-PluginInfo-License=Apache-2.0',
        'X-KDE-ServiceTypes=Plasma/Theme',
        '',
      ].join('\n'),
    },
  ];
}

/**
 * @param {string} schemeId
 * @param {string} schemeName
 * @param {string} packageVersion
 * @returns {GeneratedAsset[]}
 */
function buildPlasmaLookAndFeelPackageAssets(schemeId, schemeName, packageVersion) {
  const packageRoot = `desktop/kde/plasma/look-and-feel/${schemeId}`;

  return [
    {
      path: `${packageRoot}/metadata.json`,
      content: `${formatJson({
        KPackageStructure: 'Plasma/LookAndFeel',
        KPlugin: {
          Authors: [{ Name: 'renbkna' }],
          Category: '',
          Description: `${schemeName} look-and-feel using Tyrian-owned theme defaults.`,
          EnabledByDefault: true,
          Id: schemeId,
          License: 'Apache-2.0',
          Name: schemeName,
          Version: packageVersion,
          Website: 'https://github.com/renbkna/tyrian-night',
        },
      })}\n`,
    },
    {
      path: `${packageRoot}/contents/defaults`,
      content: buildLookAndFeelDefaults(schemeId),
    },
  ];
}

/**
 * @param {string} schemeId
 * @returns {string}
 */
function buildLookAndFeelDefaults(schemeId) {
  return [
    '[kdeglobals][KDE]',
    'widgetStyle=Union',
    '',
    '[kdeglobals][General]',
    `ColorScheme=${schemeId}`,
    '',
    '[kdeglobals][MainToolbarIcons]',
    'Size=16',
    '',
    '[kdeglobals][ToolbarIcons]',
    'Size=16',
    '',
    '[kdeglobals][Toolbar style]',
    'ToolButtonStyle=NoText',
    'ToolButtonStyleOtherToolbars=NoText',
    '',
    '[kdeglobals][Icons]',
    'Theme=Papirus-Dark',
    '',
    '[plasmarc][Theme]',
    `name=${schemeId}`,
    '',
    '[kwinrc][org.kde.kdecoration2]',
    'library=org.kde.breeze',
    'theme=Breeze',
    '',
    '[kcminputrc][Mouse]',
    'cursorTheme=Bibata-Modern-Classic',
    '',
  ].join('\n');
}

/**
 * @param {string} schemeId
 * @param {string} schemeName
 * @param {DesktopPalette} palette
 * @returns {GeneratedAsset[]}
 */
function buildUnionCssStylePackageAssets(schemeId, schemeName, palette) {
  return [
    {
      path: `desktop/kde/union/css/styles/${schemeId}/style.css`,
      content: buildUnionCssStyle(schemeName, palette),
    },
  ];
}

/**
 * @param {string} schemeName
 * @param {DesktopPalette} palette
 * @returns {string}
 */
function buildUnionCssStyle(schemeName, palette) {
  return `/*
 * ${schemeName} Union CSS style.
 * Generated from source/themes by scripts/desktopThemes.mjs.
 */

:root {
  --tyrian-background: ${palette.background.toLowerCase()};
  --tyrian-foreground: ${palette.foreground.toLowerCase()};
  --tyrian-surface-low: ${palette.surfaceLow.toLowerCase()};
  --tyrian-surface: ${palette.surface.toLowerCase()};
  --tyrian-surface-high: ${palette.surfaceHigh.toLowerCase()};
  --tyrian-surface-highest: ${palette.surfaceHighest.toLowerCase()};
  --tyrian-border: ${palette.border.toLowerCase()};
  --tyrian-muted: ${palette.muted.toLowerCase()};
  --tyrian-accent: ${palette.accent.toLowerCase()};
  --tyrian-accent-hover: ${palette.accentHover.toLowerCase()};
  --tyrian-selection: ${palette.selection.toLowerCase()};
  --tyrian-positive: ${palette.positive.toLowerCase()};
  --tyrian-neutral: ${palette.neutral.toLowerCase()};
  --tyrian-negative: ${palette.negative.toLowerCase()};
  --tyrian-corner-radius: 5px;
  --tyrian-small-spacing: 4px;
  --tyrian-medium-spacing: 6px;
  --tyrian-large-spacing: 8px;
}

* {
  color: var(--tyrian-foreground);
  icon-color: var(--tyrian-foreground);
  icon-size: 16px;
}

applicationwindow,
window,
dialog {
  background-color: var(--tyrian-background);
  color: var(--tyrian-foreground);
}

popup,
menu,
tooltip {
  padding: var(--tyrian-large-spacing);
  background-color: var(--tyrian-surface-low);
  border: 1px solid var(--tyrian-border);
  border-radius: var(--tyrian-corner-radius);
  box-shadow: 0px 2px 24px 0px rgba(0, 0, 0, 0.28);
}

button,
toolbutton,
combobox,
roundbutton,
delaybutton {
  width: 32px;
  height: 32px;
  padding: var(--tyrian-large-spacing);
  spacing: var(--tyrian-small-spacing);
  background-color: var(--tyrian-surface-low);
  border: 1px solid var(--tyrian-border);
  border-radius: var(--tyrian-corner-radius);
  color: var(--tyrian-foreground);
}

button:hovered,
toolbutton:hovered,
combobox:hovered,
roundbutton:hovered,
delaybutton:hovered {
  background-color: var(--tyrian-surface);
  border-color: var(--tyrian-accent-hover);
}

button:pressed,
button:checked,
toolbutton:pressed,
toolbutton:checked,
combobox:pressed,
roundbutton:pressed,
roundbutton:checked,
delaybutton:pressed {
  background-color: var(--tyrian-selection);
  border-color: var(--tyrian-accent);
}

button:visual-focus,
toolbutton:visual-focus,
combobox:visual-focus,
textfield:visual-focus,
textarea:visual-focus {
  outline: 2px solid var(--tyrian-accent);
}

toolbar,
applicationheader {
  background-color: var(--tyrian-surface-low);
  border-bottom: 1px solid var(--tyrian-border);
}

textfield,
textarea,
spinbox {
  width: 200px;
  height: 32px;
  padding: var(--tyrian-medium-spacing) var(--tyrian-large-spacing);
  background-color: var(--tyrian-background);
  border: 1px solid var(--tyrian-border);
  border-radius: var(--tyrian-corner-radius);
  color: var(--tyrian-foreground);
}

textfield:hovered,
textarea:hovered,
spinbox:hovered {
  border-color: var(--tyrian-accent-hover);
}

itemdelegate,
checkdelegate,
menuitem {
  height: 32px;
  padding: var(--tyrian-medium-spacing) var(--tyrian-large-spacing);
  spacing: var(--tyrian-small-spacing);
  background: none;
  color: var(--tyrian-foreground);
}

itemdelegate:hovered,
checkdelegate:hovered,
menuitem:hovered {
  background-color: var(--tyrian-surface);
}

itemdelegate:highlight,
itemdelegate:checked,
checkdelegate:highlight,
checkdelegate:checked,
menuitem:highlight,
menuitem:checked {
  background-color: var(--tyrian-selection);
  border: 1px solid var(--tyrian-accent);
}

checkbox > indicator,
radiobutton > indicator,
switch > indicator {
  width: 18px;
  height: 18px;
  background-color: var(--tyrian-surface-high);
  border: 1px solid var(--tyrian-border);
  border-radius: var(--tyrian-corner-radius);
}

checkbox:checked > indicator,
radiobutton:checked > indicator,
switch:checked > indicator {
  background-color: var(--tyrian-accent);
  border-color: var(--tyrian-accent-hover);
}

progressbar,
slider {
  height: 20px;
  background-color: var(--tyrian-surface-low);
  border-radius: var(--tyrian-corner-radius);
}

progressbar > fill,
slider > fill {
  background-color: var(--tyrian-accent);
  border-radius: var(--tyrian-corner-radius);
}

tabbutton {
  height: 32px;
  padding: var(--tyrian-medium-spacing) var(--tyrian-large-spacing);
  background-color: var(--tyrian-surface);
  border: 1px solid var(--tyrian-border);
  color: var(--tyrian-foreground);
}

tabbutton:checked {
  background-color: var(--tyrian-background);
  border-top: 3px solid var(--tyrian-accent);
}

text.positive {
  color: var(--tyrian-positive);
}

text.neutral {
  color: var(--tyrian-neutral);
}

text.negative {
  color: var(--tyrian-negative);
}
`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatJson(value) {
  return JSON.stringify(value, null, 2).replace(
    /\[\n\s+"Plasma\/Theme"\n\s+\]/u,
    '["Plasma/Theme"]'
  );
}

/**
 * @param {DesktopPalette} palette
 * @returns {string}
 */
function buildDialogBackgroundSvg(palette) {
  return `${svgHeader(230, 80)}
 <defs>
  <linearGradient id="shadow">
   <stop stop-color="#000000" stop-opacity=".62" offset="0"/>
   <stop stop-color="#000000" stop-opacity="0" offset="1"/>
  </linearGradient>
 </defs>
 <g fill="${palette.background}">
  <rect id="center" x="18" y="18" width="50" height="50" opacity=".94"/>
  <rect id="top" x="18" y="10" width="50" height="8" opacity=".94"/>
  <rect id="right" x="68" y="18" width="8" height="50" opacity=".94"/>
  <rect id="bottom" x="18" y="68" width="50" height="8" opacity=".94"/>
  <rect id="left" x="10" y="18" width="8" height="50" opacity=".94"/>
  <path id="topleft" d="M18 18h-8c0-4.4 3.6-8 8-8z" opacity=".94"/>
  <path id="topright" d="M68 18v-8c4.4 0 8 3.6 8 8z" opacity=".94"/>
  <path id="bottomright" d="M68 68h8c0 4.4-3.6 8-8 8z" opacity=".94"/>
  <path id="bottomleft" d="M18 68v8c-4.4 0-8-3.6-8-8z" opacity=".94"/>
 </g>
 <g fill="${palette.accent}">
  <rect x="18" y="10" width="50" height="1" opacity=".48"/>
  <rect x="10" y="18" width="1" height="50" opacity=".22"/>
  <rect x="75" y="18" width="1" height="50" opacity=".22"/>
 </g>
 <g fill="#000000">
  <rect id="shadow-center" x="165" y="15" width="50" height="50" opacity=".20"/>
  <rect id="shadow-top" x="165" y="7" width="50" height="8" opacity=".14"/>
  <rect id="shadow-right" x="215" y="15" width="8" height="50" opacity=".24"/>
  <rect id="shadow-bottom" x="165" y="65" width="50" height="8" opacity=".30"/>
  <rect id="shadow-left" x="157" y="15" width="8" height="50" opacity=".14"/>
  <path id="shadow-topleft" d="M165 15h-8c0-4.4 3.6-8 8-8z" opacity=".14"/>
  <path id="shadow-topright" d="M215 15v-8c4.4 0 8 3.6 8 8z" opacity=".20"/>
  <path id="shadow-bottomright" d="M215 65h8c0 4.4-3.6 8-8 8z" opacity=".34"/>
  <path id="shadow-bottomleft" d="M165 65v8c-4.4 0-8-3.6-8-8z" opacity=".24"/>
 </g>
 <g fill="#000000">
  <rect id="mask-center" x="88" y="18" width="50" height="50"/>
  <rect id="mask-top" x="88" y="10" width="50" height="8"/>
  <rect id="mask-right" x="138" y="18" width="8" height="50"/>
  <rect id="mask-bottom" x="88" y="68" width="50" height="8"/>
  <rect id="mask-left" x="80" y="18" width="8" height="50"/>
  <path id="mask-topleft" d="M88 18h-8c0-4.4 3.6-8 8-8z"/>
  <path id="mask-topright" d="M138 18v-8c4.4 0 8 3.6 8 8z"/>
  <path id="mask-bottomright" d="M138 68h8c0 4.4-3.6 8-8 8z"/>
  <path id="mask-bottomleft" d="M88 68v8c-4.4 0-8-3.6-8-8z"/>
 </g>
 <g fill="#ff00ff">
  <rect id="hint-top-margin" x="42" y="10" width="2" height="8"/>
  <rect id="hint-right-margin" x="68" y="42" width="8" height="2"/>
  <rect id="hint-bottom-margin" x="42" y="68" width="2" height="8"/>
  <rect id="hint-left-margin" x="10" y="42" width="8" height="2"/>
  <rect id="shadow-hint-top-margin" x="188" y="7" width="2" height="8"/>
  <rect id="shadow-hint-right-margin" x="215" y="39" width="8" height="2"/>
  <rect id="shadow-hint-bottom-margin" x="188" y="65" width="2" height="8"/>
  <rect id="shadow-hint-left-margin" x="157" y="39" width="8" height="2"/>
 </g>
 <g fill="#00ff00">
  <rect id="hint-stretch-borders" width="5" height="5"/>
  <rect id="hint-top-inset" x="42" y="18" width="2" height="1"/>
  <rect id="hint-bottom-inset" x="42" y="67" width="2" height="1"/>
  <rect id="hint-left-inset" x="18" y="42" width="1" height="2"/>
  <rect id="hint-right-inset" x="67" y="42" width="1" height="2"/>
 </g>
</svg>
`;
}

/**
 * @param {DesktopPalette} palette
 * @returns {string}
 */
function buildLineEditSvg(palette) {
  return `${svgHeader(74, 103)}
 <g>
${frameRects('base', 12, 12, 60, 22, 3, palette.surfaceLow, palette.border, '.96', '.55')}
${frameRects('focus', 12, 47, 60, 22, 3, palette.surface, palette.accent, '.96', '.86')}
${frameRects('hover', 12, 82, 60, 22, 3, palette.surface, palette.accentHover, '.92', '.62')}
 </g>
 <g fill="#ff00ff">
  <rect id="hint-focus-over-base" width="5" height="5"/>
  <rect id="base-hint-top-margin" x="42" y="10" width="2" height="5"/>
  <rect id="base-hint-bottom-margin" x="42" y="34" width="2" height="5"/>
  <rect id="base-hint-right-margin" x="72" y="22" width="5" height="2"/>
  <rect id="base-hint-left-margin" x="7" y="22" width="5" height="2"/>
  <rect id="focus-hint-top-margin" x="42" y="45" width="2" height="5"/>
  <rect id="focus-hint-bottom-margin" x="42" y="69" width="2" height="5"/>
  <rect id="focus-hint-right-margin" x="72" y="57" width="5" height="2"/>
  <rect id="focus-hint-left-margin" x="7" y="57" width="5" height="2"/>
  <rect id="hover-hint-top-margin" x="42" y="80" width="2" height="5"/>
  <rect id="hover-hint-bottom-margin" x="42" y="104" width="2" height="5"/>
  <rect id="hover-hint-right-margin" x="72" y="92" width="5" height="2"/>
  <rect id="hover-hint-left-margin" x="7" y="92" width="5" height="2"/>
 </g>
</svg>
`;
}

/**
 * @param {DesktopPalette} palette
 * @returns {string}
 */
function buildViewItemSvg(palette) {
  return `${svgHeader(200, 200)}
 <g>
${frameRects('normal', 20, 20, 50, 50, 4, '#000000', '#000000', '0', '0')}
${frameRects('hover', 20, 85, 50, 50, 4, palette.surface, palette.border, '.72', '.40')}
${frameRects('selected', 85, 20, 50, 50, 4, palette.selection, palette.accent, '.88', '.72')}
${frameRects('selected+hover', 85, 85, 50, 50, 4, palette.surfaceHighest, palette.accentHover, '.92', '.82')}
 </g>
 <g fill="#ff00ff">
  <rect id="hint-tile-center" width="10" height="10"/>
  <rect id="normal-hint-top-margin" x="44" y="16" width="2" height="4"/>
  <rect id="normal-hint-bottom-margin" x="44" y="70" width="2" height="4"/>
  <rect id="normal-hint-left-margin" x="16" y="44" width="4" height="2"/>
  <rect id="normal-hint-right-margin" x="70" y="44" width="4" height="2"/>
 </g>
</svg>
`;
}

/**
 * @param {DesktopPalette} palette
 * @returns {string}
 */
function buildListItemSvg(palette) {
  return `${svgHeader(48, 55)}
 <g>
  <rect id="separator" x="8" y="54" width="40" height="1" fill="${palette.border}" opacity=".7"/>
${frameRects('normal', 8, 8, 13, 13, 2, '#000000', '#000000', '0', '0')}
${frameRects('hover', 28, 8, 13, 13, 2, palette.surface, palette.border, '.72', '.38')}
${frameRects('pressed', 8, 28, 13, 13, 2, palette.surfaceHigh, palette.accent, '.74', '.50')}
${frameRects('section', 28, 28, 13, 13, 2, palette.selection, palette.accent, '.82', '.62')}
 </g>
 <g fill="#ff00ff">
  <rect id="hint-tile-center" width="5" height="5"/>
  <rect id="normal-hint-right-margin" x="21" y="14" width="4" height="1"/>
  <rect id="normal-hint-left-margin" x="4" y="14" width="4" height="1"/>
  <rect id="normal-hint-top-margin" x="14" y="4" width="1" height="4"/>
  <rect id="normal-hint-bottom-margin" x="14" y="21" width="1" height="4"/>
  <rect id="pressed-hint-right-margin" x="21" y="34" width="4" height="1"/>
  <rect id="pressed-hint-left-margin" x="4" y="34" width="4" height="1"/>
  <rect id="pressed-hint-top-margin" x="14" y="24" width="1" height="4"/>
  <rect id="pressed-hint-bottom-margin" x="14" y="41" width="1" height="4"/>
  <rect id="section-hint-right-margin" x="41" y="34" width="4" height="1"/>
  <rect id="section-hint-left-margin" x="24" y="34" width="4" height="1"/>
  <rect id="section-hint-top-margin" x="34" y="24" width="1" height="4"/>
  <rect id="section-hint-bottom-margin" x="34" y="41" width="1" height="4"/>
 </g>
</svg>
`;
}

/**
 * @param {DesktopPalette} palette
 * @returns {string}
 */
function buildGlowbarSvg(palette) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="36" height="36" version="1.1" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">
 <defs>
  <linearGradient id="glow-fade-vertical" x1="0" x2="0" y1="0" y2="1">
   <stop stop-color="${palette.accent}" stop-opacity=".48" offset="0"/>
   <stop stop-color="${palette.accent}" stop-opacity="0" offset="1"/>
  </linearGradient>
  <linearGradient id="glow-fade-horizontal" x1="0" x2="1" y1="0" y2="0">
   <stop stop-color="${palette.accent}" stop-opacity=".48" offset="0"/>
   <stop stop-color="${palette.accent}" stop-opacity="0" offset="1"/>
  </linearGradient>
  <radialGradient id="glow-corner">
   <stop stop-color="${palette.accent}" stop-opacity=".42" offset="0"/>
   <stop stop-color="${palette.accent}" stop-opacity="0" offset="1"/>
  </radialGradient>
 </defs>
 <g>
  <rect id="topleft" x="0" y="0" width="12" height="12" fill="url(#glow-corner)"/>
  <rect id="top" x="12" y="0" width="12" height="12" fill="url(#glow-fade-vertical)"/>
  <rect id="topright" x="24" y="0" width="12" height="12" fill="url(#glow-corner)"/>
  <rect id="right" x="24" y="12" width="12" height="12" transform="rotate(90 30 18)" fill="url(#glow-fade-horizontal)"/>
  <rect id="bottomright" x="24" y="24" width="12" height="12" fill="url(#glow-corner)"/>
  <rect id="bottom" x="12" y="24" width="12" height="12" transform="rotate(180 18 30)" fill="url(#glow-fade-vertical)"/>
  <rect id="bottomleft" x="0" y="24" width="12" height="12" fill="url(#glow-corner)"/>
  <rect id="left" x="0" y="12" width="12" height="12" fill="url(#glow-fade-horizontal)"/>
 </g>
 <g fill="#ff00ff">
  <rect id="hint-glow-radius" width="5" height="5"/>
  <rect id="hint-stretch-borders" x="7" width="5" height="5"/>
 </g>
</svg>
`;
}

/**
 * @param {DesktopPalette} palette
 * @returns {string}
 */
function buildTasksSvg(palette) {
  const states = [
    {
      name: 'normal',
      fill: palette.surfaceLow,
      indicator: palette.accent,
      fillOpacity: '.10',
      indicatorOpacity: '.48',
    },
    {
      name: 'hover',
      fill: palette.surface,
      indicator: palette.accentHover,
      fillOpacity: '.18',
      indicatorOpacity: '.58',
    },
    {
      name: 'focus',
      fill: palette.selection,
      indicator: palette.accent,
      fillOpacity: '.24',
      indicatorOpacity: '.95',
    },
    {
      name: 'minimized',
      fill: palette.surfaceLow,
      indicator: palette.muted,
      fillOpacity: '.06',
      indicatorOpacity: '.34',
    },
    {
      name: 'progress',
      fill: palette.positive,
      indicator: palette.brightGreen,
      fillOpacity: '.12',
      indicatorOpacity: '.76',
    },
    {
      name: 'attention',
      fill: palette.negative,
      indicator: palette.brightRed,
      fillOpacity: '.14',
      indicatorOpacity: '.86',
    },
  ];
  /** @type {Array<{ prefix: string; activeEdge: 'top' | 'right' | 'bottom' | 'left' }>} */
  const orientations = [
    { prefix: '', activeEdge: 'top' },
    { prefix: 'north-', activeEdge: 'bottom' },
    { prefix: 'west-', activeEdge: 'right' },
    { prefix: 'east-', activeEdge: 'left' },
  ];
  const frameGroups = states
    .flatMap((state, stateIndex) =>
      orientations.map((orientation, orientationIndex) =>
        taskFrame(
          `${orientation.prefix}${state.name}`,
          12 + orientationIndex * 48,
          12 + stateIndex * 28,
          orientation.activeEdge,
          state
        )
      )
    )
    .join('\n');

  return `${svgHeader(220, 196)}
 <g>
${frameGroups}
 </g>
 <g fill="${palette.accent}">
  <circle id="group-expander-bottom" cx="22" cy="186" r="4" opacity=".70"/>
  <circle id="group-expander-left" cx="38" cy="186" r="4" opacity=".58"/>
  <circle id="group-expander-top" cx="54" cy="186" r="4" opacity=".70"/>
  <circle id="group-expander-right" cx="70" cy="186" r="4" opacity=".58"/>
 </g>
 <g fill="#ff00ff">
  <rect id="hint-stretch-borders" width="5" height="5"/>
 </g>
</svg>
`;
}

/**
 * @param {string} prefix
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {number} inset
 * @param {string} fill
 * @param {string} border
 * @param {string} fillOpacity
 * @param {string} borderOpacity
 * @returns {string}
 */
function frameRects(prefix, x, y, width, height, inset, fill, border, fillOpacity, borderOpacity) {
  const right = x + width;
  const bottom = y + height;
  const centerWidth = width - inset * 2;
  const centerHeight = height - inset * 2;

  return `  <rect id="${prefix}-center" x="${x + inset}" y="${y + inset}" width="${centerWidth}" height="${centerHeight}" fill="${fill}" opacity="${fillOpacity}"/>
  <rect id="${prefix}-top" x="${x + inset}" y="${y}" width="${centerWidth}" height="${inset}" fill="${border}" opacity="${borderOpacity}"/>
  <rect id="${prefix}-right" x="${right - inset}" y="${y + inset}" width="${inset}" height="${centerHeight}" fill="${border}" opacity="${borderOpacity}"/>
  <rect id="${prefix}-bottom" x="${x + inset}" y="${bottom - inset}" width="${centerWidth}" height="${inset}" fill="${border}" opacity="${borderOpacity}"/>
  <rect id="${prefix}-left" x="${x}" y="${y + inset}" width="${inset}" height="${centerHeight}" fill="${border}" opacity="${borderOpacity}"/>
  <rect id="${prefix}-topleft" x="${x}" y="${y}" width="${inset}" height="${inset}" fill="${border}" opacity="${borderOpacity}"/>
  <rect id="${prefix}-topright" x="${right - inset}" y="${y}" width="${inset}" height="${inset}" fill="${border}" opacity="${borderOpacity}"/>
  <rect id="${prefix}-bottomright" x="${right - inset}" y="${bottom - inset}" width="${inset}" height="${inset}" fill="${border}" opacity="${borderOpacity}"/>
  <rect id="${prefix}-bottomleft" x="${x}" y="${bottom - inset}" width="${inset}" height="${inset}" fill="${border}" opacity="${borderOpacity}"/>`;
}

/**
 * @param {string} prefix
 * @param {number} x
 * @param {number} y
 * @param {'top' | 'right' | 'bottom' | 'left'} activeEdge
 * @param {{ fill: string; indicator: string; fillOpacity: string; indicatorOpacity: string }} state
 * @returns {string}
 */
function taskFrame(prefix, x, y, activeEdge, state) {
  return directionalFrameRects(
    prefix,
    x,
    y,
    36,
    20,
    3,
    state.fill,
    state.indicator,
    state.fillOpacity,
    state.indicatorOpacity,
    activeEdge
  );
}

/**
 * @param {string} prefix
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @param {number} inset
 * @param {string} fill
 * @param {string} indicator
 * @param {string} fillOpacity
 * @param {string} indicatorOpacity
 * @param {'top' | 'right' | 'bottom' | 'left'} activeEdge
 * @returns {string}
 */
function directionalFrameRects(
  prefix,
  x,
  y,
  width,
  height,
  inset,
  fill,
  indicator,
  fillOpacity,
  indicatorOpacity,
  activeEdge
) {
  const right = x + width;
  const bottom = y + height;
  const centerWidth = width - inset * 2;
  const centerHeight = height - inset * 2;
  const activePieces = new Set(
    {
      top: ['top', 'topleft', 'topright'],
      right: ['right', 'topright', 'bottomright'],
      bottom: ['bottom', 'bottomleft', 'bottomright'],
      left: ['left', 'topleft', 'bottomleft'],
    }[activeEdge]
  );
  /** @param {string} piece */
  const edgeOpacity = (piece) => (activePieces.has(piece) ? indicatorOpacity : '0');

  return `  <rect id="${prefix}-center" x="${x + inset}" y="${y + inset}" width="${centerWidth}" height="${centerHeight}" fill="${fill}" opacity="${fillOpacity}"/>
  <rect id="${prefix}-top" x="${x + inset}" y="${y}" width="${centerWidth}" height="${inset}" fill="${indicator}" opacity="${edgeOpacity('top')}"/>
  <rect id="${prefix}-right" x="${right - inset}" y="${y + inset}" width="${inset}" height="${centerHeight}" fill="${indicator}" opacity="${edgeOpacity('right')}"/>
  <rect id="${prefix}-bottom" x="${x + inset}" y="${bottom - inset}" width="${centerWidth}" height="${inset}" fill="${indicator}" opacity="${edgeOpacity('bottom')}"/>
  <rect id="${prefix}-left" x="${x}" y="${y + inset}" width="${inset}" height="${centerHeight}" fill="${indicator}" opacity="${edgeOpacity('left')}"/>
  <rect id="${prefix}-topleft" x="${x}" y="${y}" width="${inset}" height="${inset}" fill="${indicator}" opacity="${edgeOpacity('topleft')}"/>
  <rect id="${prefix}-topright" x="${right - inset}" y="${y}" width="${inset}" height="${inset}" fill="${indicator}" opacity="${edgeOpacity('topright')}"/>
  <rect id="${prefix}-bottomright" x="${right - inset}" y="${bottom - inset}" width="${inset}" height="${inset}" fill="${indicator}" opacity="${edgeOpacity('bottomright')}"/>
  <rect id="${prefix}-bottomleft" x="${x}" y="${bottom - inset}" width="${inset}" height="${inset}" fill="${indicator}" opacity="${edgeOpacity('bottomleft')}"/>`;
}

/**
 * @param {number} width
 * @param {number} height
 * @returns {string}
 */
function svgHeader(width, height) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" version="1.1" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
}

/**
 * @param {VscodeTheme} theme
 * @param {DesktopPalette} palette
 * @returns {Record<string, string>}
 */
function buildCaelestiaColours(theme, palette) {
  const onAccent = contrastText(palette.accent);
  const onSecondary = contrastText(palette.info);
  const onTertiary = contrastText(palette.parameter);
  const onError = contrastText(palette.negative);
  const onSuccess = contrastText(palette.positive);
  const crust = themeColor(theme, 'editorGutter.background', 'editor.background');
  /** @type {Record<string, string>} */
  const colours = {
    background: palette.background,
    onBackground: palette.foreground,
    surface: palette.background,
    surfaceDim: palette.background,
    surfaceBright: palette.surfaceHighest,
    surfaceContainerLowest: crust,
    surfaceContainerLow: palette.surfaceLow,
    surfaceContainer: palette.surface,
    surfaceContainerHigh: palette.surfaceHigh,
    surfaceContainerHighest: palette.surfaceHighest,
    onSurface: palette.foreground,
    surfaceVariant: palette.border,
    onSurfaceVariant: themeColor(theme, 'sideBar.foreground', 'editor.foreground'),
    inverseSurface: palette.foreground,
    inverseOnSurface: palette.background,
    outline: palette.muted,
    outlineVariant: palette.border,
    shadow: '#000000',
    scrim: '#000000',
    surfaceTint: palette.accent,
    primary: palette.accent,
    primaryDim: themeColor(theme, 'editorCursor.foreground', 'activityBar.activeBorder'),
    onPrimary: onAccent,
    primaryContainer: palette.selection,
    onPrimaryContainer: palette.foreground,
    inversePrimary: palette.accentHover,
    primaryFixed: palette.brightAccent,
    primaryFixedDim: palette.accent,
    onPrimaryFixed: contrastText(palette.brightAccent),
    onPrimaryFixedVariant: palette.background,
    secondary: palette.info,
    secondaryDim: themeColor(theme, 'terminal.ansiBlue', 'editorInfo.foreground'),
    onSecondary,
    secondaryContainer: themeColor(
      theme,
      'merge.currentContentBackground',
      'list.inactiveSelectionBackground'
    ),
    onSecondaryContainer: palette.foreground,
    secondaryFixed: palette.brightBlue,
    secondaryFixedDim: palette.info,
    onSecondaryFixed: contrastText(palette.brightBlue),
    onSecondaryFixedVariant: palette.background,
    tertiary: palette.parameter,
    tertiaryDim: themeColor(theme, 'terminal.ansiMagenta', 'activityBar.activeBorder'),
    onTertiary,
    tertiaryContainer: themeColor(
      theme,
      'editor.wordHighlightBackground',
      'list.inactiveSelectionBackground'
    ),
    onTertiaryContainer: palette.foreground,
    tertiaryFixed: palette.brightAccent,
    tertiaryFixedDim: palette.parameter,
    onTertiaryFixed: contrastText(palette.brightAccent),
    onTertiaryFixedVariant: palette.background,
    error: palette.negative,
    errorDim: themeColor(theme, 'terminal.ansiRed', 'editorError.foreground'),
    onError,
    errorContainer: themeColor(theme, 'inputValidation.errorBackground', 'editorError.foreground'),
    onErrorContainer: palette.foreground,
    primaryPaletteKeyColor: palette.accent,
    secondaryPaletteKeyColor: palette.info,
    tertiaryPaletteKeyColor: palette.parameter,
    neutralPaletteKeyColor: palette.muted,
    neutralVariantPaletteKeyColor: palette.border,
    errorPaletteKeyColor: palette.negative,
    primary_paletteKeyColor: palette.accent,
    secondary_paletteKeyColor: palette.info,
    tertiary_paletteKeyColor: palette.parameter,
    neutral_paletteKeyColor: palette.muted,
    neutral_variant_paletteKeyColor: palette.border,
    term0: palette.ansi[0],
    term1: palette.ansi[1],
    term2: palette.ansi[2],
    term3: palette.ansi[3],
    term4: palette.ansi[4],
    term5: palette.ansi[5],
    term6: palette.ansi[6],
    term7: palette.ansi[7],
    term8: palette.ansi[8],
    term9: palette.ansi[9],
    term10: palette.ansi[10],
    term11: palette.ansi[11],
    term12: palette.ansi[12],
    term13: palette.ansi[13],
    term14: palette.ansi[14],
    term15: palette.ansi[15],
    rosewater: palette.brightWhite,
    flamingo: palette.parameter,
    pink: palette.brightAccent,
    mauve: palette.accent,
    red: palette.negative,
    maroon: palette.brightRed,
    peach: palette.neutral,
    yellow: palette.brightYellow,
    green: palette.positive,
    teal: palette.ansi[6],
    sky: palette.brightCyan,
    sapphire: palette.info,
    blue: palette.brightBlue,
    lavender: palette.brightAccent,
    klink: palette.link,
    klinkSelection: palette.brightBlue,
    kvisited: palette.visited,
    kvisitedSelection: palette.brightAccent,
    knegative: palette.negative,
    knegativeSelection: palette.brightRed,
    kneutral: palette.neutral,
    kneutralSelection: palette.brightYellow,
    kpositive: palette.positive,
    kpositiveSelection: palette.brightGreen,
    text: palette.foreground,
    subtext1: themeColor(theme, 'sideBar.foreground', 'editor.foreground'),
    subtext0: palette.muted,
    overlay2: palette.muted,
    overlay1: themeColor(theme, 'breadcrumb.foreground', 'editorLineNumber.foreground'),
    overlay0: palette.border,
    surface2: palette.surfaceHighest,
    surface1: palette.surfaceHigh,
    surface0: palette.surface,
    base: palette.background,
    mantle: palette.surfaceLow,
    crust,
    success: palette.positive,
    onSuccess,
    successContainer: themeColor(
      theme,
      'merge.incomingContentBackground',
      'editorGutter.addedBackground'
    ),
    onSuccessContainer: palette.foreground,
  };

  return Object.fromEntries(
    CAELESTIA_COLOUR_ORDER.map((name) => [name, stripHash(colours[name]).toLowerCase()])
  );
}

/**
 * @param {Record<string, string>} colours
 * @returns {string}
 */
function buildCaelestiaSchemeText(colours) {
  return `${CAELESTIA_COLOUR_ORDER.map((name) => `${name} ${colours[name]}`).join('\n')}\n`;
}

/**
 * @param {Record<string, string>} colours
 * @returns {string}
 */
function buildCaelestiaHyprScheme(colours) {
  return `${CAELESTIA_COLOUR_ORDER.map((name) => `$${name} = ${colours[name]}`).join('\n')}\n`;
}

/**
 * @param {string} name
 * @param {Record<string, string>} entries
 * @returns {string}
 */
function section(name, entries) {
  return [
    `[${name}]`,
    ...Object.entries(entries).map(([key, value]) => `${key}=${kdeValue(value)}`),
  ].join('\n');
}

/**
 * @param {string} value
 * @returns {string}
 */
function kdeValue(value) {
  return value.startsWith('#') ? rgbTriplet(value) : value;
}

/**
 * @param {string} color
 * @returns {string}
 */
function rgbTriplet(color) {
  const { red, green, blue } = parseHexColor(color);

  return `${red},${green},${blue}`;
}

/**
 * @param {string} color
 * @returns {string}
 */
function stripHash(color) {
  return opaqueHex(color).slice(1);
}

/**
 * @param {string} color
 * @returns {string}
 */
function contrastText(color) {
  return isLightHex(color) ? '#0C0C0C' : '#FFFFFF';
}

/**
 * @param {string} slug
 * @returns {string}
 */
function pascalSlug(slug) {
  return slug
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('');
}

/**
 * @param {VscodeTheme} theme
 * @param {string} key
 * @param {string | undefined} fallbackKey
 * @param {string} [background]
 * @returns {string}
 */
function themeColor(theme, key, fallbackKey, background) {
  const backdrop =
    background ?? theme.colors['terminal.background'] ?? theme.colors['editor.background'];
  const color = theme.colors[key] ?? (fallbackKey ? theme.colors[fallbackKey] : undefined);

  if (!color) {
    throw new Error(`Missing color '${key}' in ${theme.name}`);
  }

  return opaqueHex(color, backdrop);
}

/**
 * @param {VscodeTheme} theme
 * @param {string} key
 * @param {string} fallbackKey
 * @returns {string}
 */
function semanticColor(theme, key, fallbackKey) {
  const color = theme.semanticTokenColors[key]?.foreground;

  return color
    ? opaqueHex(color, theme.colors['editor.background'])
    : themeColor(theme, fallbackKey, undefined);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  writeDesktopThemeAssets(process.cwd(), { check: process.argv.includes('--check') });
}
