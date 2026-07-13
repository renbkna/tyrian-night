import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { contrastRatio } from '../scripts/colorScience.mjs';
import { opaqueHex, parseHexColor } from '../scripts/colorUtils.mjs';
import { buildDesktopThemeAssets } from '../scripts/desktopThemes.mjs';
import { themeColor } from '../scripts/themeDefinition.mjs';
import { readSourceTheme, SOURCE_THEMES } from '../scripts/themeSources.mjs';
import { flattenCssFile } from '../scripts/union/flattenCss.mjs';

type ThemeDefinition = {
  appearance: 'dark' | 'light';
  name: string;
  schemaVersion: 1;
  syntax: Record<string, string>;
  terminal: Record<string, string>;
  ui: Record<string, string>;
};

const assets = new Map(buildDesktopThemeAssets().map((asset) => [asset.path, asset.content]));
const UNION_STATIC_TEMPLATE = flattenCssFile('source/union-css/index.css').replace(
  /\/\*[\s\S]*?\*\/\n\n:root \{\n\s*\/\* TYRIAN_GENERATED_TOKENS \*\/\n\}\n\n/u,
  ''
);
const UNION_TOKEN_CONTRACT = [
  '--tyrian-background:',
  '--tyrian-foreground:',
  '--tyrian-accent:',
  '--tyrian-control-bg: var(--tyrian-surface-low);',
  '--tyrian-row-selected-bg: var(--tyrian-selection);',
  '--tyrian-indicator-checked-bg: var(--tyrian-accent);',
  '--tyrian-focus-ring: var(--tyrian-accent);',
  '--tyrian-corner-radius: 5px;',
  '--tyrian-scrollbar-size:',
];
const UNION_FORBIDDEN_CONTRACT = [
  '@import',
  '../breeze',
  'custom-color("kcolorscheme"',
  'kcolorscheme',
  'Breeze',
];

test('desktop theme assets match the neutral theme definitions', () => {
  for (const [assetPath, content] of assets) {
    expect(fs.readFileSync(assetPath, 'utf8')).toBe(content);
  }
});

test('desktop generation resolves catalog identity from the injected repository root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-desktop-root-'));

  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    fs.mkdirSync(path.join(root, 'apps/desktop'), { recursive: true });
    fs.writeFileSync(path.join(root, 'apps/desktop/package.json'), '{"version":"1.0.0"}\n');
    const themePath = path.join(root, 'source/themes/tyrian-night.json');
    const theme = JSON.parse(fs.readFileSync(themePath, 'utf8')) as Record<string, unknown>;
    theme.name = 'Injected Desktop Night';
    fs.writeFileSync(themePath, `${JSON.stringify(theme)}\n`);

    const generated = new Map(
      buildDesktopThemeAssets(root).map((asset) => [asset.path, asset.content])
    );
    expect(generated.get('desktop/kde/color-schemes/TyrianNight.colors')).toContain(
      'Name=Injected Desktop Night'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('KDE manual Union setup includes packaged base styles', () => {
  const kdeReadme = fs.readFileSync('desktop/kde/README.md', 'utf8');

  for (const path of [
    '/usr/share/union/css/styles/breeze',
    '/usr/share/union/css/styles/breeze-mobile',
    '/usr/share/union/css/styles/breeze-rtl',
    'desktop/kde/union/css/styles/TyrianNight',
  ]) {
    expect(kdeReadme).toContain(path);
  }

  expect(kdeReadme).toContain('bun run build:desktop-themes');
  expect(kdeReadme).toContain('does not mutate the live');
  expect(kdeReadme).not.toContain('clears already-imported');
});

test('KDE color schemes consume neutral surface, accent, and text roles', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme(source);
    const schemeId = pascalSlug(source.slug);
    const colorScheme = requiredAsset(`desktop/kde/color-schemes/${schemeId}.colors`);

    expect(colorScheme).toContain(`ColorScheme=${schemeId}`);
    expect(colorScheme).toContain(`Name=${theme.name}`);
    expect(colorScheme).toContain(
      `BackgroundNormal=${kdeRgb(sourceColor(theme, 'ui:surface.canvas'))}`
    );
    expect(colorScheme).toContain(
      `DecorationFocus=${kdeRgb(sourceColor(theme, 'ui:accent.primary'))}`
    );
    expect(colorScheme).toContain(
      `ForegroundNormal=${kdeRgb(sourceColor(theme, 'ui:text.primary'))}`
    );
    expect(colorScheme).not.toContain('Monochrome');
  }
});

test('Plasma desktop-theme colors consume the KDE palette without owning ColorEffects', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme(source);
    const schemeId = pascalSlug(source.slug);
    const plasmaColors = requiredAsset(`desktop/kde/plasma/desktoptheme/${schemeId}/colors`);

    expect(plasmaColors).toContain(`ColorScheme=${schemeId}`);
    expect(plasmaColors).toContain(
      `BackgroundNormal=${kdeRgb(sourceColor(theme, 'ui:surface.canvas'))}`
    );
    expect(plasmaColors).toContain(
      `DecorationFocus=${kdeRgb(sourceColor(theme, 'ui:accent.primary'))}`
    );
    expect(plasmaColors).not.toContain('[ColorEffects:');
  }
});

test('Plasma packages are full Tyrian-owned packages without a Monochrome base', () => {
  const packageJson = readJson<{ version: string }>('apps/desktop/package.json');

  for (const source of SOURCE_THEMES) {
    const schemeId = pascalSlug(source.slug);
    const theme = readSourceTheme(source);
    const desktopMetadata = JSON.parse(
      requiredAsset(`desktop/kde/plasma/desktoptheme/${schemeId}/metadata.json`)
    );
    const desktopMetadataDesktop = requiredAsset(
      `desktop/kde/plasma/desktoptheme/${schemeId}/metadata.desktop`
    );
    const lookAndFeelMetadata = JSON.parse(
      requiredAsset(`desktop/kde/plasma/look-and-feel/${schemeId}/metadata.json`)
    );
    const lookAndFeelDefaults = requiredAsset(
      `desktop/kde/plasma/look-and-feel/${schemeId}/contents/defaults`
    );

    expect(desktopMetadata.KPlugin.Id).toBe(schemeId);
    expect(desktopMetadata.KPlugin.Name).toBe(theme.name);
    expect(desktopMetadata.KPlugin.Version).toBe(packageJson.version);
    expect(desktopMetadata.KPlugin.ServiceTypes).toEqual(['Plasma/Theme']);
    expect(desktopMetadataDesktop).toContain(`X-KDE-PluginInfo-Name=${schemeId}`);
    expect(lookAndFeelMetadata.KPackageStructure).toBe('Plasma/LookAndFeel');
    expect(lookAndFeelMetadata.KPlugin.Id).toBe(schemeId);
    expect(lookAndFeelDefaults).toContain(`ColorScheme=${schemeId}`);
    expect(lookAndFeelDefaults).toContain('widgetStyle=Breeze');
    expect(lookAndFeelDefaults).toContain(`name=${schemeId}`);
    expect(lookAndFeelDefaults).toContain(
      `Theme=${source.appearance === 'light' ? 'Papirus' : 'Papirus-Dark'}`
    );
    expect(
      `${JSON.stringify(desktopMetadata)}\n${desktopMetadataDesktop}\n${JSON.stringify(
        lookAndFeelMetadata
      )}\n${lookAndFeelDefaults}`
    ).not.toContain('Monochrome');
  }
});

test('Union CSS styles combine generated Tyrian tokens with the editable rice template', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme(source);
    const schemeId = pascalSlug(source.slug);
    const unionStyle = requiredAsset(`desktop/kde/union/css/styles/${schemeId}/style.css`);

    expect(unionStyle).toStartWith(
      `/*
 * ${theme.name} Union CSS style.
 * Static rice controls live in source/union-css/index.css and parts/.
 * Palette and shape tokens are generated from neutral source/themes roles by scripts/desktopThemes.mjs.
 */

:root {
`
    );
    expect(unionStyle).toContain(
      `--tyrian-background: ${sourceColor(theme, 'ui:surface.canvas').toLowerCase()}`
    );
    expect(unionStyle).toContain(
      `--tyrian-accent: ${sourceColor(theme, 'ui:accent.primary').toLowerCase()}`
    );

    for (const token of UNION_TOKEN_CONTRACT) {
      expect(unionStyle).toContain(token);
    }

    for (const forbidden of UNION_FORBIDDEN_CONTRACT) {
      expect(unionStyle).not.toContain(forbidden);
    }

    expect(unionStyle.endsWith(UNION_STATIC_TEMPLATE)).toBe(true);
  }
});

test('Plasma widget skin derives popup, search, task, and row surfaces from Tyrian colors', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme(source);
    const schemeId = pascalSlug(source.slug);
    const background = sourceColor(theme, 'ui:surface.canvas');
    const surface = sourceColor(theme, 'ui:surface.hover');
    const surfaceLow = sourceColor(theme, 'ui:surface.sidebar');
    const selection = sourceColor(theme, 'ui:selection.active');
    const accent = sourceColor(theme, 'ui:accent.primary');
    const launcherBackground = requiredAsset(
      `desktop/kde/plasma/desktoptheme/${schemeId}/dialogs/background.svg`
    );
    const lineEdit = requiredAsset(
      `desktop/kde/plasma/desktoptheme/${schemeId}/widgets/lineedit.svg`
    );
    const viewItem = requiredAsset(
      `desktop/kde/plasma/desktoptheme/${schemeId}/widgets/viewitem.svg`
    );
    const listItem = requiredAsset(
      `desktop/kde/plasma/desktoptheme/${schemeId}/widgets/listitem.svg`
    );
    const glowbar = requiredAsset(
      `desktop/kde/plasma/desktoptheme/${schemeId}/widgets/glowbar.svg`
    );
    const tasks = requiredAsset(`desktop/kde/plasma/desktoptheme/${schemeId}/widgets/tasks.svg`);

    expect(launcherBackground).toContain(`id="center"`);
    expect(launcherBackground).toContain(`fill="${background}"`);
    expect(launcherBackground).toContain(`fill="${accent}"`);
    expect(launcherBackground).not.toContain('#1e1e20');
    expect(lineEdit).toContain(`id="focus-center"`);
    expect(lineEdit).toContain(`fill="${surfaceLow}"`);
    expect(lineEdit).toContain(`fill="${accent}"`);
    expect(viewItem).toContain(`id="selected-center"`);
    expect(viewItem).toContain(`fill="${selection}"`);
    expect(viewItem).toContain(`fill="${surface}"`);
    expect(listItem).toContain(`id="section-center"`);
    expect(listItem).toContain(`fill="${selection}"`);
    expect(glowbar).toContain(`id="top"`);
    expect(glowbar).toContain(`stop-color="${accent}"`);
    expect(glowbar).not.toContain('stop-color="#fff"');
    expect(glowbar).not.toContain('stop-color="#6e6e70"');
    expect(tasks).toContain(`id="normal-center"`);
    expect(tasks).toContain(`id="minimized-center"`);
    expect(tasks).toContain(`id="focus-center"`);
    expect(tasks).toContain(`id="progress-center"`);
    expect(tasks).toContain(`id="attention-center"`);
    expect(tasks).toContain(`id="north-focus-center"`);
    expect(tasks).toContain(`id="west-focus-center"`);
    expect(tasks).toContain(`id="east-focus-center"`);
    expect(tasks).toContain(`fill="${accent}"`);
    expect(tasks).toContain(
      `id="focus-top" x="15" y="68" width="30" height="3" fill="${accent}" opacity=".95"`
    );
    expect(tasks).toContain(
      `id="focus-left" x="12" y="71" width="3" height="14" fill="${accent}" opacity="0"`
    );
    expect(tasks).toContain(
      `id="focus-right" x="45" y="71" width="3" height="14" fill="${accent}" opacity="0"`
    );
    expect(tasks).toContain(
      `id="north-focus-bottom" x="63" y="85" width="30" height="3" fill="${accent}" opacity=".95"`
    );
    expect(tasks).toContain(
      `id="west-focus-right" x="141" y="71" width="3" height="14" fill="${accent}" opacity=".95"`
    );
    expect(tasks).toContain(
      `id="east-focus-left" x="156" y="71" width="3" height="14" fill="${accent}" opacity=".95"`
    );
    expect(tasks).not.toContain('fill="#fff"');
    expect(tasks).not.toContain('fill="#6e6e70"');
    expect(tasks).not.toContain('color="#3daee9"');
  }
});

test('Caelestia schemes consume neutral Material and terminal roles', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme(source);
    const flavour = source.slug.replace(/^tyrian-/, '');
    const mode = source.appearance === 'light' ? 'light' : 'dark';
    const scheme = requiredAsset(`desktop/caelestia/schemes/tyrian/${flavour}/${mode}.txt`);
    const hypr = requiredAsset(`desktop/caelestia/hypr/${source.slug}.conf`);
    const hyprLua = requiredAsset(`desktop/caelestia/hypr/${source.slug}.lua`);
    const state = JSON.parse(requiredAsset(`desktop/caelestia/state/${source.slug}.scheme.json`));
    const background = hexNoHash(sourceColor(theme, 'ui:surface.canvas'));
    const primary = hexNoHash(sourceColor(theme, 'ui:accent.primary'));
    const foreground = hexNoHash(sourceColor(theme, 'ui:text.primary'));

    expect(scheme).toContain(`background ${background}`);
    expect(scheme).toContain(`onBackground ${foreground}`);
    expect(scheme).toContain(`primary ${primary}`);
    expect(scheme).toContain(`term5 ${hexNoHash(sourceColor(theme, 'terminal:ansi.magenta'))}`);
    expect(scheme).not.toContain('#');
    expect(hypr).toContain(`$background = ${background}`);
    expect(hypr).toContain(`$primary = ${primary}`);
    expect(hyprLua).toContain(`background = "${background}"`);
    expect(hyprLua).toContain(`primary = "${primary}"`);
    expect(hyprLua).toStartWith('return {\n');
    expect(state.name).toBe('tyrian');
    expect(state.flavour).toBe(flavour);
    expect(state.mode).toBe(mode);
    expect(state.colours.background).toBe(background);
    expect(state.colours.primary).toBe(primary);

    for (const [backgroundRole, foregroundRole] of [
      ['primary', 'onPrimary'],
      ['primaryContainer', 'onPrimaryContainer'],
      ['primaryFixed', 'onPrimaryFixed'],
      ['primaryFixedDim', 'onPrimaryFixedVariant'],
      ['secondary', 'onSecondary'],
      ['secondaryContainer', 'onSecondaryContainer'],
      ['secondaryFixed', 'onSecondaryFixed'],
      ['secondaryFixedDim', 'onSecondaryFixedVariant'],
      ['tertiary', 'onTertiary'],
      ['tertiaryContainer', 'onTertiaryContainer'],
      ['tertiaryFixed', 'onTertiaryFixed'],
      ['tertiaryFixedDim', 'onTertiaryFixedVariant'],
      ['error', 'onError'],
      ['errorContainer', 'onErrorContainer'],
      ['success', 'onSuccess'],
      ['successContainer', 'onSuccessContainer'],
    ]) {
      expect(
        contrastRatio(`#${state.colours[foregroundRole]}`, `#${state.colours[backgroundRole]}`)
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test('Caelestia manual setup names generation, XDG, and both Hyprland projections', () => {
  const readme = fs.readFileSync('desktop/caelestia/README.md', 'utf8');

  expect(readme).toContain('bun run build:desktop-themes');
  expect(readme).toContain('current.lua');
  expect(readme).toContain('current.conf');
  expect(readme).toContain('XDG_CONFIG_HOME');
  expect(readme).toContain('XDG_DATA_HOME');
  expect(readme).toContain('XDG_STATE_HOME');
});

function requiredAsset(assetPath: string): string {
  const content = assets.get(assetPath);

  if (content === undefined) {
    throw new Error(`Missing generated asset '${assetPath}'`);
  }

  return content;
}

function kdeRgb(color: string): string {
  const { red, green, blue } = parseHexColor(opaqueHex(color));

  return `${red},${green},${blue}`;
}

function hexNoHash(color: string): string {
  return opaqueHex(color).slice(1).toLowerCase();
}

function sourceColor(theme: ThemeDefinition, qualifiedRole: string): string {
  return opaqueHex(themeColor(theme, qualifiedRole), themeColor(theme, 'ui:surface.canvas'));
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function pascalSlug(slug: string): string {
  return slug
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('');
}
