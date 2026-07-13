import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { ISLAND_CSS_THEMES, buildAllIslandCss } from '../scripts/islandCss.mjs';
import { parseHexColor } from '../scripts/colorUtils.mjs';
import { themeColor } from '../scripts/themeDefinition.mjs';
import { SOURCE_THEMES, readSourceTheme } from '../scripts/themeSources.mjs';

const ISLAND_CSS_FILES = [
  'apps/vscode/island/tyrian-night.css',
  'apps/vscode/island/tyrian-nocturne.css',
  'apps/vscode/island/tyrian-night-old.css',
  'apps/vscode/island/tyrian-abyss.css',
  'apps/vscode/island/tyrian-dawn.css',
];

test('Island UI theme list stays in lockstep with source themes', () => {
  expect(ISLAND_CSS_FILES).toEqual(
    SOURCE_THEMES.map((source) => `apps/vscode/island/${source.slug}.css`)
  );
  expect(buildAllIslandCss().map(({ outputPath }) => outputPath)).toEqual(ISLAND_CSS_FILES);
  expect(ISLAND_CSS_THEMES.map(({ outputPath }) => outputPath).toSorted()).toEqual(
    ISLAND_CSS_FILES.toSorted()
  );
  expect(ISLAND_CSS_THEMES.map(({ label }) => label).toSorted()).toEqual(
    SOURCE_THEMES.map((source) => readSourceTheme(source).name).toSorted()
  );
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
    const themePath = path.join(root, 'source/themes/tyrian-night.json');
    const theme = JSON.parse(fs.readFileSync(themePath, 'utf8')) as Record<string, unknown>;
    theme.name = 'Injected Island Night';
    (theme.ui as Record<string, string>)['accent.glow'] = '#123456';
    fs.writeFileSync(themePath, `${JSON.stringify(theme)}\n`);

    expect(buildAllIslandCss(root)[0]?.css).toContain('Injected Island Night - Custom UI Styles');
    expect(buildAllIslandCss(root)[0]?.css).toContain('--islands-accent-glow-rgb: 18, 52, 86;');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Island UI palette tokens derive from neutral theme roles', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme(source);
    const css = fs.readFileSync(`apps/vscode/island/${source.slug}.css`, 'utf8');

    expect(css).toContain(
      `--islands-bg-canvas: ${themeColor(theme, 'ui:surface.canvas').toLowerCase()};`
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

test('Island UI owns geometry and opacity but no independent palette literals', () => {
  const source = fs.readFileSync('scripts/islandCss.mjs', 'utf8');
  const paletteLiterals = [];

  for (const match of source.matchAll(/#(?<rgb>[0-9a-f]{6})(?:[0-9a-f]{2})?/giu)) {
    const channels = [0, 2, 4].map((offset) =>
      Number.parseInt(match.groups!.rgb.slice(offset, offset + 2), 16)
    );
    if (!channels.every((channel) => channel === channels[0])) paletteLiterals.push(match[0]);
  }
  for (const match of source.matchAll(
    /rgba?\(\s*(?<red>\d+)\s*,\s*(?<green>\d+)\s*,\s*(?<blue>\d+)/gu
  )) {
    const channels = [match.groups!.red, match.groups!.green, match.groups!.blue];
    if (!channels.every((channel) => channel === channels[0])) paletteLiterals.push(match[0]);
  }

  expect(paletteLiterals).toEqual([]);
});

test('Island UI custom token blocks are explicit for every source theme', () => {
  for (const source of SOURCE_THEMES) {
    const islandTheme = ISLAND_CSS_THEMES.find(({ outputPath }) =>
      outputPath.endsWith(`${source.slug}.css`)
    );

    expect(islandTheme).toBeDefined();
    expect(Object.keys(islandTheme?.tokens ?? {}).length).toBeGreaterThan(40);
    expect(islandTheme?.tokens).not.toHaveProperty('--islands-bg-canvas');
    expect(islandTheme?.tokens).not.toHaveProperty('--islands-bg-surface');
  }

  expect(fs.readFileSync('apps/vscode/island/tyrian-night.css', 'utf8')).toContain(
    'rgba(var(--islands-accent-glow-rgb), 0.35)'
  );
  expect(fs.readFileSync('apps/vscode/island/tyrian-night-old.css', 'utf8')).toContain(
    'rgba(var(--islands-accent-glow-rgb), 0.35)'
  );
  expect(fs.readFileSync('scripts/islandCss.mjs', 'utf8')).not.toContain('141, 105, 193');
  expect(fs.readFileSync('scripts/islandCss.mjs', 'utf8')).not.toContain('139, 106, 189');
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
