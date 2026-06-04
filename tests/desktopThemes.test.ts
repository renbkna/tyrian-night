import fs from 'node:fs';

import { expect, test } from 'bun:test';

import { opaqueHex, parseHexColor } from '../scripts/colorUtils.mjs';
import { buildDesktopThemeAssets } from '../scripts/desktopThemes.mjs';
import { SOURCE_THEMES, readSourceTheme } from '../scripts/themeSources.mjs';

type HighlightSettings = {
  foreground?: string;
};

type VscodeTheme = {
  name: string;
  colors: Record<string, string>;
  semanticTokenColors: Record<string, HighlightSettings>;
};

const assets = new Map(buildDesktopThemeAssets().map((asset) => [asset.path, asset.content]));

test('desktop theme assets match the generated VS Code-derived outputs', () => {
  for (const [assetPath, content] of assets) {
    expect(fs.readFileSync(assetPath, 'utf8')).toBe(content);
  }
});

test('KDE color schemes derive backgrounds and accents from Tyrian sources', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme<VscodeTheme>(source);
    const schemeId = pascalSlug(source.slug);
    const colorScheme = requiredAsset(`desktop/kde/color-schemes/${schemeId}.colors`);

    expect(colorScheme).toContain(`ColorScheme=${schemeId}`);
    expect(colorScheme).toContain(`Name=${theme.name}`);
    expect(colorScheme).toContain(`BackgroundNormal=${kdeRgb(theme.colors['editor.background'])}`);
    expect(colorScheme).toContain(
      `DecorationFocus=${kdeRgb(theme.colors['activityBar.activeBorder'])}`
    );
    expect(colorScheme).toContain(`ForegroundNormal=${kdeRgb(theme.colors['editor.foreground'])}`);
    expect(colorScheme).not.toContain('Monochrome');
  }
});

test('Plasma desktop-theme colors consume the KDE palette without owning ColorEffects', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme<VscodeTheme>(source);
    const schemeId = pascalSlug(source.slug);
    const plasmaColors = requiredAsset(`desktop/kde/plasma/desktoptheme/${schemeId}/colors`);

    expect(plasmaColors).toContain(`ColorScheme=${schemeId}`);
    expect(plasmaColors).toContain(`BackgroundNormal=${kdeRgb(theme.colors['editor.background'])}`);
    expect(plasmaColors).toContain(
      `DecorationFocus=${kdeRgb(theme.colors['activityBar.activeBorder'])}`
    );
    expect(plasmaColors).not.toContain('[ColorEffects:');
  }
});

test('Plasma packages are full Tyrian-owned packages without a Monochrome base', () => {
  const packageJson = readJson<{ version: string }>('package.json');

  for (const source of SOURCE_THEMES) {
    const schemeId = pascalSlug(source.slug);
    const theme = readSourceTheme<VscodeTheme>(source);
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
    expect(lookAndFeelDefaults).toContain(`name=${schemeId}`);
    expect(
      `${JSON.stringify(desktopMetadata)}\n${desktopMetadataDesktop}\n${JSON.stringify(
        lookAndFeelMetadata
      )}\n${lookAndFeelDefaults}`
    ).not.toContain('Monochrome');
  }
});

test('Plasma widget skin derives popup, search, task, and row surfaces from Tyrian colors', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme<VscodeTheme>(source);
    const schemeId = pascalSlug(source.slug);
    const background = opaqueHex(theme.colors['editor.background']);
    const surface = opaqueHex(theme.colors['list.hoverBackground']);
    const surfaceLow = opaqueHex(theme.colors['sideBar.background']);
    const selection = opaqueHex(theme.colors['list.activeSelectionBackground']);
    const accent = opaqueHex(theme.colors['activityBar.activeBorder']);
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

test('Caelestia schemes derive Material and terminal tokens from Tyrian sources', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme<VscodeTheme>(source);
    const flavour = source.slug.replace(/^tyrian-/, '');
    const mode = source.appearance === 'light' ? 'light' : 'dark';
    const scheme = requiredAsset(`desktop/caelestia/schemes/tyrian/${flavour}/${mode}.txt`);
    const hypr = requiredAsset(`desktop/caelestia/hypr/${source.slug}.conf`);
    const state = JSON.parse(requiredAsset(`desktop/caelestia/state/${source.slug}.scheme.json`));
    const background = hexNoHash(theme.colors['editor.background']);
    const primary = hexNoHash(theme.colors['activityBar.activeBorder']);
    const foreground = hexNoHash(theme.colors['editor.foreground']);

    expect(scheme).toContain(`background ${background}`);
    expect(scheme).toContain(`onBackground ${foreground}`);
    expect(scheme).toContain(`primary ${primary}`);
    expect(scheme).toContain(`term5 ${hexNoHash(theme.colors['terminal.ansiMagenta'])}`);
    expect(scheme).not.toContain('#');
    expect(hypr).toContain(`$background = ${background}`);
    expect(hypr).toContain(`$primary = ${primary}`);
    expect(state.name).toBe('tyrian');
    expect(state.flavour).toBe(flavour);
    expect(state.mode).toBe(mode);
    expect(state.colours.background).toBe(background);
    expect(state.colours.primary).toBe(primary);
  }
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

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function pascalSlug(slug: string): string {
  return slug
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join('');
}
