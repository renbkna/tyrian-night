import { readSourceData, writeSourceData } from '../support/sourceData.js';
import { SOURCE_THEMES, sourceTheme } from '../support/themes.js';
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { contrastRatio } from '../../scripts/colorScience.mjs';
import { opaqueHex, opaqueHexDigits, parseHexColor } from '../../scripts/colorUtils.mjs';
import {
  buildDesktopThemeAssets,
  caelestiaFlavour,
  kdeThemeId,
} from '../../scripts/desktopThemes.mjs';
import { themeColor } from '../../scripts/themeDefinition.mjs';
import { flattenCssFile, UNION_SOURCE_ENTRY } from '../../scripts/union/flattenCss.mjs';
import { GENERATED_FORBIDDEN_TEXT } from '../../scripts/union/lintUnionCss.mjs';

type ThemeDefinition = import('../../scripts/themeDefinition.mjs').ThemeDefinition;

const assets = new Map(buildDesktopThemeAssets().map((asset) => [asset.path, asset.content]));
const UNION_STATIC_TEMPLATE = flattenCssFile(UNION_SOURCE_ENTRY).replace(
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
  '--tyrian-radius-small: 4px;',
  '--tyrian-radius-medium: 5px;',
  '--tyrian-radius-large: 10px;',
  '--tyrian-scrollbar-size:',
];
const UNION_FORBIDDEN_CONTRACT = [
  ...GENERATED_FORBIDDEN_TEXT,
  // Tokens removed from the generator must not come back.
  '--tyrian-corner-radius:',
  '--tyrian-hover:',
  '--tyrian-surface-highest:',
  '--tyrian-accent-hover:',
  '--tyrian-icon-large:',
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
    const themePath = path.join(root, 'source/themes/tyrian-night.cjs');
    const theme = readSourceData(themePath) as Record<string, unknown>;
    theme.name = 'Injected Desktop Night';
    writeSourceData(themePath, theme);

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

test('KDE color schemes consume neutral surface, accent, and text roles', () => {
  for (const source of SOURCE_THEMES) {
    const theme = sourceTheme(source);
    const schemeId = kdeThemeId(source.slug);
    const colorScheme = requiredAsset(`desktop/kde/color-schemes/${schemeId}.colors`);

    expect(kdeSection(colorScheme, 'General')).toMatchObject({
      ColorScheme: schemeId,
      Name: theme.name,
    });
    for (const name of ['Colors:View', 'Colors:Window']) {
      expect(kdeSection(colorScheme, name)).toMatchObject({
        BackgroundNormal: kdeRgb(sourceColor(theme, 'ui:surface.canvas')),
        DecorationFocus: kdeRgb(sourceColor(theme, 'ui:accent.primary')),
        ForegroundNormal: kdeRgb(sourceColor(theme, 'ui:text.primary')),
      });
    }
  }
});

test('Plasma desktop-theme colors consume the KDE palette without owning ColorEffects', () => {
  for (const source of SOURCE_THEMES) {
    const theme = sourceTheme(source);
    const schemeId = kdeThemeId(source.slug);
    const plasmaColors = requiredAsset(`desktop/kde/plasma/desktoptheme/${schemeId}/colors`);

    expect(kdeSection(plasmaColors, 'General').ColorScheme).toBe(schemeId);
    expect(kdeSection(plasmaColors, 'Colors:Window')).toMatchObject({
      BackgroundNormal: kdeRgb(sourceColor(theme, 'ui:surface.canvas')),
      DecorationFocus: kdeRgb(sourceColor(theme, 'ui:accent.primary')),
    });
    expect(plasmaColors).not.toContain('[ColorEffects:');
  }
});

test('KDE ids and Caelestia flavours derive from the theme slug', () => {
  expect(kdeThemeId('tyrian-night')).toBe('TyrianNight');
  expect(caelestiaFlavour('tyrian-night')).toBe('night');
});

test('Plasma packages carry their own id, name and service type', () => {
  for (const source of SOURCE_THEMES) {
    const schemeId = kdeThemeId(source.slug);
    const theme = sourceTheme(source);
    const desktopMetadata = JSON.parse(
      requiredAsset(`desktop/kde/plasma/desktoptheme/${schemeId}/metadata.json`)
    );
    const desktopMetadataDesktop = requiredAsset(
      `desktop/kde/plasma/desktoptheme/${schemeId}/metadata.desktop`
    );

    expect(desktopMetadata.KPlugin.Id).toBe(schemeId);
    expect(desktopMetadata.KPlugin.Name).toBe(theme.name);
    expect(desktopMetadata.KPlugin.ServiceTypes).toEqual(['Plasma/Theme']);
    expect(desktopMetadataDesktop).toContain(`X-KDE-PluginInfo-Name=${schemeId}`);
  }
});

test('Union CSS styles combine generated Tyrian tokens with the editable rice template', () => {
  for (const source of SOURCE_THEMES) {
    const theme = sourceTheme(source);
    const schemeId = kdeThemeId(source.slug);
    const unionStyle = requiredAsset(`desktop/kde/union/css/styles/${schemeId}/style.css`);

    expect(unionStyle).toStartWith(`/*\n * ${theme.name} Union CSS style.\n`);
    expect(unionStyle).toContain(
      `
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
    for (const [token, role] of [
      ['positive', 'ui:status.successBackground'],
      ['neutral', 'ui:status.warningBackground'],
      ['negative', 'ui:status.errorBackground'],
    ]) {
      expect(unionStyle).toContain(
        `--tyrian-${token}-bg: ${themeColor(theme, role).toLowerCase()};`
      );
    }

    for (const forbidden of UNION_FORBIDDEN_CONTRACT) {
      expect(unionStyle).not.toContain(forbidden);
    }

    expect(unionStyle.endsWith(UNION_STATIC_TEMPLATE)).toBe(true);
  }
});

test('Plasma widget skin derives popup, search, task, and row surfaces from Tyrian colors', () => {
  for (const source of SOURCE_THEMES) {
    const theme = sourceTheme(source);
    const schemeId = kdeThemeId(source.slug);
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
    expect(svgFill(lineEdit, 'base-center')).toBe(surfaceLow);
    expect(svgFill(lineEdit, 'focus-center')).toBe(surface);
    expect(svgFill(lineEdit, 'focus-top')).toBe(accent);
    expect(viewItem).toContain(`id="selected-center"`);
    expect(viewItem).toContain(`fill="${selection}"`);
    expect(viewItem).toContain(`fill="${surface}"`);
    expect(listItem).toContain(`id="section-center"`);
    expect(listItem).toContain(`fill="${selection}"`);
    expect(glowbar).toContain(`id="top"`);
    expect(glowbar).toContain(`stop-color="${accent}"`);
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
  }
});

test('DMS themes project the Caelestia Material roles for the source appearance', () => {
  for (const source of SOURCE_THEMES) {
    const mode = source.appearance === 'light' ? 'light' : 'dark';
    const dms = JSON.parse(requiredAsset(`desktop/dms/themes/${source.slug}.json`));
    const { colours } = JSON.parse(
      requiredAsset(`desktop/caelestia/state/${source.slug}.scheme.json`)
    );

    expect(Object.keys(dms)).toEqual([mode]);
    const theme = dms[mode];
    for (const [dmsRole, materialRole] of [
      ['primary', 'primary'],
      ['primaryText', 'onPrimary'],
      ['surface', 'surface'],
      ['surfaceText', 'onSurface'],
      ['background', 'background'],
      ['backgroundText', 'onBackground'],
      ['surfaceContainerHighest', 'surfaceContainerHighest'],
      ['error', 'error'],
    ]) {
      expect(theme[dmsRole]).toBe(`#${colours[materialRole]}`);
    }
    for (const [role, value] of Object.entries(theme)) {
      if (role !== 'name' && role !== 'matugen_type') expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(theme.matugen_type).toBe('scheme-fidelity');
  }
});

test('Caelestia schemes consume neutral Material and terminal roles', () => {
  for (const source of SOURCE_THEMES) {
    const theme = sourceTheme(source);
    const flavour = caelestiaFlavour(source.slug);
    const mode = source.appearance === 'light' ? 'light' : 'dark';
    const scheme = requiredAsset(`desktop/caelestia/schemes/tyrian/${flavour}/${mode}.txt`);
    const hypr = requiredAsset(`desktop/caelestia/hypr/${source.slug}.conf`);
    const hyprLua = requiredAsset(`desktop/caelestia/hypr/${source.slug}.lua`);
    const state = JSON.parse(requiredAsset(`desktop/caelestia/state/${source.slug}.scheme.json`));
    const background = opaqueHexDigits(sourceColor(theme, 'ui:surface.canvas')).toLowerCase();
    const primary = opaqueHexDigits(sourceColor(theme, 'ui:accent.primary')).toLowerCase();
    const foreground = opaqueHexDigits(sourceColor(theme, 'ui:text.primary')).toLowerCase();

    expect(scheme).toContain(`background ${background}`);
    expect(scheme).toContain(`onBackground ${foreground}`);
    expect(scheme).toContain(`primary ${primary}`);
    expect(scheme).toContain(
      `term5 ${opaqueHexDigits(sourceColor(theme, 'terminal:ansi.magenta')).toLowerCase()}`
    );
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

function requiredAsset(assetPath: string): string {
  const content = assets.get(assetPath);

  if (content === undefined) {
    throw new Error(`Missing generated asset '${assetPath}'`);
  }

  return content;
}

function kdeSection(scheme: string, name: string): Record<string, string> {
  const body = scheme.split(/\n\n(?=\[)/u).find((block) => block.startsWith(`[${name}]\n`));
  if (body === undefined) throw new Error(`Missing KDE section '[${name}]'`);

  return Object.fromEntries(
    body
      .split('\n')
      .slice(1)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
  );
}

function svgFill(svg: string, id: string): string | undefined {
  return svg.match(new RegExp(`<rect id="${id}"[^>]* fill="([^"]+)"`, 'u'))?.[1];
}

function kdeRgb(color: string): string {
  const { red, green, blue } = parseHexColor(opaqueHex(color));

  return `${red},${green},${blue}`;
}

function sourceColor(theme: ThemeDefinition, qualifiedRole: string): string {
  return opaqueHex(themeColor(theme, qualifiedRole), themeColor(theme, 'ui:surface.canvas'));
}
