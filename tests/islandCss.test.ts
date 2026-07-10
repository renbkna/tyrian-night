import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { ISLAND_CSS_THEMES, buildAllIslandCss } from '../scripts/islandCss.mjs';
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
    SOURCE_THEMES.map((source) => readSourceTheme<{ name: string }>(source).name).toSorted()
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
    fs.writeFileSync(themePath, `${JSON.stringify(theme)}\n`);

    expect(buildAllIslandCss(root)[0]?.css).toContain('Injected Island Night - Custom UI Styles');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Island UI canvas and surface palette tokens derive from source themes', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme<{ colors: Record<string, string> }>(source);
    const css = fs.readFileSync(`apps/vscode/island/${source.slug}.css`, 'utf8');

    expect(css).toContain(
      `--islands-bg-canvas: ${theme.colors['editor.background'].toLowerCase()};`
    );
    expect(css).toContain(
      `--islands-bg-surface: ${theme.colors['sideBar.background'].toLowerCase()};`
    );
  }
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
    'rgba(141, 105, 193, 0.35)'
  );
  expect(fs.readFileSync('apps/vscode/island/tyrian-night-old.css', 'utf8')).toContain(
    'rgba(139, 106, 189, 0.35)'
  );
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
