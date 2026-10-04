import { readSourceData, writeSourceData } from '../support/sourceData.js';
import { SOURCE_THEMES, sourceTheme } from '../support/themes.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { oklchToHex } from '../../scripts/colorScience.mjs';
import { buildAllIslandCss, readIslandEffectProfiles } from '../../scripts/islandCss.mjs';
import { parseHexColor } from '../../scripts/colorUtils.mjs';
import { loadThemeDefinitionContext, themeColor } from '../../scripts/themeDefinition.mjs';

const ISLAND_CSS_FILES = SOURCE_THEMES.map(({ islandCssPath }) => islandCssPath);

test('Island CSS is generated for exactly the catalog themes', () => {
  expect(buildAllIslandCss().map(({ outputPath }) => outputPath)).toEqual(ISLAND_CSS_FILES);
});

test('Island UI CSS assets match the generated template and theme tokens', () => {
  for (const { outputPath, css } of buildAllIslandCss()) {
    expect(fs.readFileSync(outputPath, 'utf8')).toBe(css);
  }
});

test('Island CSS generation resolves catalog identity from the injected repository root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-island-root-'));

  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    fs.mkdirSync(path.join(root, 'apps/vscode/island'), { recursive: true });
    fs.copyFileSync('apps/vscode/island/base.css', path.join(root, 'apps/vscode/island/base.css'));
    const themePath = path.join(root, 'source/themes/tyrian-night.cjs');
    const theme = readSourceData(themePath) as {
      name: string;
      oklch: Record<string, [number, number]>;
    };
    theme.name = 'Injected Island Night';
    theme.oklch['ui:accent.glow'] = [0.55, 0.08];
    writeSourceData(themePath, theme);
    const definition = loadThemeDefinitionContext(root);
    const injected = oklchToHex({
      C: 0.08,
      L: 0.55,
      h: definition.familyContract.pigmentHues['ui:accent.glow']!.core!,
    });

    expect(buildAllIslandCss(root)[0]?.css).toContain('Injected Island Night - Custom UI Styles');
    expect(buildAllIslandCss(root)[0]?.css).toContain(
      `--islands-accent-glow-rgb: ${rgbChannels(injected)};`
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Island UI palette tokens derive from neutral theme roles', () => {
  for (const source of SOURCE_THEMES) {
    const theme = sourceTheme(source);
    const css = fs.readFileSync(`apps/vscode/island/${source.slug}.css`, 'utf8');

    expect(css).toContain(
      `--islands-bg-backdrop: ${themeColor(theme, 'ui:surface.navigation').toLowerCase()};`
    );
    expect(css).toContain(
      `--islands-bg-surface: ${themeColor(theme, 'ui:surface.sidebar').toLowerCase()};`
    );
    expect(css).toContain(
      `--islands-accent-glow-rgb: ${rgbChannels(themeColor(theme, 'ui:accent.glow'))};`
    );
    expect(css).toContain(
      `--islands-accent-effect-rgb: ${rgbChannels(themeColor(theme, 'ui:accent.effect'))};`
    );
    for (const role of ['activeSurface', 'checkedSurface', 'focusSurface', 'hoverSurface']) {
      expect(css).toContain(
        `--islands-effect-${kebabCase(role)}-rgb: ${rgbChannels(
          themeColor(theme, `ui:effect.${role}`)
        )};`
      );
    }
    expect(css).toContain(
      `--islands-effect-strong-accent-rgb: ${rgbChannels(
        themeColor(theme, 'ui:effect.strongAccent')
      )};`
    );
    expect(css).toContain(
      `--islands-effect-status-hover: ${themeColor(theme, 'ui:effect.statusHover').toLowerCase()};`
    );
  }
});

test('Island effect profiles own geometry and opacity but no independent palette literals', () => {
  const profiles = fs.readFileSync('source/islandEffects.cjs', 'utf8');
  const paletteLiterals = [];

  for (const match of profiles.matchAll(/#(?<rgb>[0-9a-f]{6})(?:[0-9a-f]{2})?/giu)) {
    const channels = [0, 2, 4].map((offset) =>
      Number.parseInt(match.groups!.rgb!.slice(offset, offset + 2), 16)
    );
    if (!channels.every((channel) => channel === channels[0])) paletteLiterals.push(match[0]);
  }
  for (const match of profiles.matchAll(
    /rgba?\(\s*(?<red>\d+)\s*,\s*(?<green>\d+)\s*,\s*(?<blue>\d+)/gu
  )) {
    const channels = [match.groups!.red, match.groups!.green, match.groups!.blue];
    if (!channels.every((channel) => channel === channels[0])) paletteLiterals.push(match[0]);
  }

  expect(paletteLiterals).toEqual([]);
});

test('Island effect profiles are complete, referenced, and used', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-island-effects-'));
  const profilesPath = path.join(root, 'source/islandEffects.cjs');
  const valid = readSourceData('source/islandEffects.cjs') as Record<
    string,
    Record<string, string>
  >;
  const writeProfiles = (profiles: unknown) => writeSourceData(profilesPath, profiles);

  try {
    fs.mkdirSync(path.dirname(profilesPath), { recursive: true });
    writeProfiles(valid);
    expect(Object.keys(readIslandEffectProfiles(root, SOURCE_THEMES))).toEqual(Object.keys(valid));

    const incomplete = structuredClone(valid);
    delete incomplete.abyss!['--islands-aurora-tail'];
    writeProfiles(incomplete);
    expect(() => readIslandEffectProfiles(root, SOURCE_THEMES)).toThrow(
      "Island effect profile 'abyss' must define the same tokens"
    );

    const { dawn: _dawn, ...missing } = valid;
    writeProfiles(missing);
    expect(() => readIslandEffectProfiles(root, SOURCE_THEMES)).toThrow(
      "names unknown Island effect profile 'dawn'"
    );

    writeProfiles({ ...valid, spare: valid['neutral-dark'] });
    expect(() => readIslandEffectProfiles(root, SOURCE_THEMES)).toThrow(
      'Island effect profiles are unused: spare'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an effect profile cannot redefine a palette or layout token', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-island-token-owner-'));
  const profilesPath = path.join(root, 'source/islandEffects.cjs');
  const valid = readSourceData('source/islandEffects.cjs') as Record<
    string,
    Record<string, string>
  >;

  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    fs.mkdirSync(path.join(root, 'apps/vscode/island'), { recursive: true });
    fs.copyFileSync('apps/vscode/island/base.css', path.join(root, 'apps/vscode/island/base.css'));
    expect(buildAllIslandCss(root)).toHaveLength(SOURCE_THEMES.length);

    for (const token of ['--islands-border', '--islands-panel-radius']) {
      const overlapping = Object.fromEntries(
        Object.entries(valid).map(([name, tokens]) => [name, { ...tokens, [token]: '0' }])
      );
      writeSourceData(profilesPath, overlapping);
      expect(() => buildAllIslandCss(root)).toThrow(
        `Island CSS token '${token}' is defined by both`
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Island UI keeps the editor island offset outside VS Code tab internals', () => {
  for (const cssFile of ISLAND_CSS_FILES) {
    const css = fs.readFileSync(cssFile, 'utf8');
    const editorPartBlock = readCssBlock(css, '.part.editor');
    const tabBlock = readCssBlock(css, '.tab');

    expect(css).not.toMatch(/\.part\.editor\s*>\s*\.content\s*\{[^}]*padding-top/s);
    expect(editorPartBlock).toContain(
      'margin: var(--islands-panel-top) var(--islands-panel-gap) 0 var(--islands-panel-gap);'
    );
    expect(editorPartBlock).toContain(
      'max-height: calc(100% - var(--islands-panel-top) - 2px) !important;'
    );
    expect(editorPartBlock).not.toMatch(/^\s*(?:padding|top|height|transform)\s*:/m);
    expect(tabBlock).not.toMatch(
      /^\s*(?:margin|display|align-items|height|line-height|transform)\s*:/m
    );
  }
});

function readCssBlock(css: string, selector: string): string {
  const escapedSelector = selector.replaceAll('.', '\\.');
  const match = new RegExp(`^${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`, 'm').exec(css);

  expect(match?.groups?.body).toBeDefined();

  return match?.groups?.body ?? '';
}

function rgbChannels(color: string): string {
  const { red, green, blue } = parseHexColor(color);
  return `${red}, ${green}, ${blue}`;
}

function kebabCase(value: string): string {
  return value.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
