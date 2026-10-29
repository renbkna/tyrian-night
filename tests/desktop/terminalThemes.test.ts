import { readSourceData, writeSourceData } from '../support/sourceData.js';
import { SOURCE_THEMES, THEME_REPOSITORY, sourceTheme } from '../support/themes.js';
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { opaqueHex } from '../../scripts/colorUtils.mjs';
import {
  FASTFETCH_IMAGE_ASSET_PATH,
  FASTFETCH_IMAGE_CONFIG_PATH,
} from '../../apps/desktop/src/installPaths.mjs';
import {
  buildFishStartupConfig,
  buildTerminalThemeAssets,
  syncTerminalThemeAssets,
} from '../../scripts/terminalThemes.mjs';
import { themeColor } from '../../scripts/themeDefinition.mjs';
import {
  getTerminalDefaultThemeSource,
  loadThemeInspectionRepository,
  loadThemeRepository,
} from '../../scripts/themeSources.mjs';

const assets = new Map(buildTerminalThemeAssets().map((asset) => [asset.path, asset.content]));

test('terminal theme assets match the generated neutral-role projections', () => {
  for (const [assetPath, content] of assets) {
    expect(fs.readFileSync(assetPath, 'utf8')).toBe(content);
  }
});

test('terminal generation resolves validated default roles from the injected catalog root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-terminal-root-'));

  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const catalogPath = path.join(root, 'source/themeCatalog.cjs');
    const catalog = readSourceData(catalogPath) as Array<{
      slug: string;
      terminalDefault?: boolean;
    }>;
    for (const entry of catalog) {
      if (entry.slug === 'tyrian-abyss') delete entry.terminalDefault;
      if (entry.slug === 'tyrian-night') entry.terminalDefault = true;
    }
    writeSourceData(catalogPath, catalog);

    const injectedAssets = new Map(
      buildTerminalThemeAssets(root).map((asset) => [asset.path, asset.content])
    );
    expect(injectedAssets.get('terminal/fish/config.example.fish')).toContain(
      'terminal/fish/themes/tyrian-night.fish'
    );
    expect(injectedAssets.get('terminal/starship/tyrian-night.toml')).toContain(
      'palette = "tyrian_night"'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Fish startup generation preserves arbitrary checkout roots as literal paths', () => {
  const tyrianRoot = String.raw`/tmp/$PROJECT/it's\a literal root`;
  const startup = buildFishStartupConfig({ repository: THEME_REPOSITORY, tyrianRoot });

  expect(startup.split('\n')[0]).toBe(
    String.raw`set -gx TYRIAN_NIGHT_ROOT "/tmp/\$PROJECT/it's\\a literal root"`
  );
});

test('terminal config generators require an admitted repository snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-terminal-admission-'));

  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const admitted = loadThemeRepository(root);
    const themePath = path.join(root, 'source/themes/tyrian-abyss.cjs');
    const recipe = readSourceData(themePath) as { syntax: { contrast: Record<string, number> } };
    recipe.syntax.contrast.plain = 50;
    writeSourceData(themePath, recipe);
    const inspection = loadThemeInspectionRepository(root);

    expect(buildFishStartupConfig({ repository: admitted })).toContain('terminal/fish/themes/');
    expect(() => loadThemeRepository(root)).toThrow('violates theme safety policy');

    // Admission is a type-level contract, proved by `bun run check`: generators
    // accept only admitted repositories. The call is never made.
    const rejectsInspection = () =>
      // @ts-expect-error an inspection repository is not an admitted ThemeRepository
      buildFishStartupConfig({ repository: inspection });
    void rejectsInspection;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('terminal generation preserves unrelated files in mixed output directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-terminal-ownership-'));

  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const manualFiles = [
      'terminal/fish/functions/manual.fish',
      'terminal/fish/conf.d/manual.fish',
      'terminal/fastfetch/manual.jsonc',
      'terminal/ghostty/README.md',
    ];
    for (const filePath of manualFiles) {
      fs.mkdirSync(path.dirname(path.join(root, filePath)), { recursive: true });
      fs.writeFileSync(path.join(root, filePath), 'manual\n');
    }

    syncTerminalThemeAssets(root);

    for (const filePath of manualFiles) {
      expect(fs.readFileSync(path.join(root, filePath), 'utf8')).toBe('manual\n');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Ghostty themes derive their palette from neutral terminal roles', () => {
  for (const source of SOURCE_THEMES) {
    const theme = sourceTheme(source);
    const ghosttyTheme = requiredAsset(`terminal/ghostty/themes/${source.slug}`);
    const background = themeColor(theme, 'terminal:background');

    expect(ghosttyTheme).toContain(`background = ${themeColor(theme, 'terminal:background')}`);
    expect(ghosttyTheme).toContain(`foreground = ${themeColor(theme, 'terminal:foreground')}`);
    expect(ghosttyTheme).toContain(`palette = 0=${themeColor(theme, 'terminal:ansi.black')}`);
    expect(ghosttyTheme).toContain(`palette = 5=${themeColor(theme, 'terminal:ansi.magenta')}`);
    expect(ghosttyTheme).toContain(
      `palette = 15=${themeColor(theme, 'terminal:ansi.brightWhite')}`
    );
    expect(ghosttyTheme).toContain(
      `selection-background = ${opaqueHex(themeColor(theme, 'terminal:selection'), background)}`
    );
    expect(ghosttyTheme).toContain(
      `window-titlebar-background = ${themeColor(theme, 'terminal:background')}`
    );
    expect(ghosttyTheme).toContain(
      `window-titlebar-foreground = ${themeColor(theme, 'terminal:foreground')}`
    );
  }
});

test('Foot themes derive their palette from neutral terminal roles', () => {
  for (const source of SOURCE_THEMES) {
    const theme = sourceTheme(source);
    const footTheme = requiredAsset(`terminal/foot/themes/${source.slug}.ini`);

    expect(footTheme).toContain(theme.appearance === 'light' ? '[colors-light]' : '[colors-dark]');
    expect(footTheme).not.toContain(
      theme.appearance === 'light' ? '[colors-dark]' : '[colors-light]'
    );
    expect(footTheme).not.toContain(`[colors]`);
    expect(footTheme).toContain(`background=${footHex(themeColor(theme, 'terminal:background'))}`);
    expect(footTheme).toContain(`foreground=${footHex(themeColor(theme, 'terminal:foreground'))}`);
    expect(footTheme).toContain('alpha=0.82');
    expect(footTheme).toContain('blur=yes');
    expect(footTheme).toContain(`regular0=${footHex(themeColor(theme, 'terminal:ansi.black'))}`);
    expect(footTheme).toContain(`regular5=${footHex(themeColor(theme, 'terminal:ansi.magenta'))}`);
    expect(footTheme).toContain(
      `bright7=${footHex(themeColor(theme, 'terminal:ansi.brightWhite'))}`
    );
    expect(footTheme).toContain(
      `selection-background=${footHex(
        opaqueHex(themeColor(theme, 'terminal:selection'), themeColor(theme, 'terminal:background'))
      )}`
    );
    expect(footTheme).toContain(
      `cursor=${footHex(themeColor(theme, 'terminal:background'))} ${footHex(
        themeColor(theme, 'terminal:cursor')
      )}`
    );
    expect(footTheme).toContain(`[csd]`);
    expect(footTheme).toContain(`color=ff${footHex(themeColor(theme, 'terminal:background'))}`);
    expect(footTheme).toContain(
      `button-color=ff${footHex(themeColor(theme, 'terminal:foreground'))}`
    );
    expect(footTheme).not.toContain('#');
  }
});

test('Ghostty and Foot outputs are theme files only, never user configs', () => {
  const terminalConfigOutputs = [...assets.keys()].filter(
    (assetPath) =>
      /^terminal\/(?:ghostty|foot)\//u.test(assetPath) &&
      !/^terminal\/(?:ghostty|foot)\/themes\//u.test(assetPath)
  );
  expect(terminalConfigOutputs).toEqual([]);
});

test('terminal READMEs name the catalog terminal defaults', () => {
  const dark = getTerminalDefaultThemeSource('dark', THEME_REPOSITORY.sources).slug;
  const light = getTerminalDefaultThemeSource('light', THEME_REPOSITORY.sources).slug;

  expect(fs.readFileSync('terminal/ghostty/README.md', 'utf8')).toContain(
    `theme = dark:${dark},light:${light}`
  );
  const footReadme = fs.readFileSync('terminal/foot/README.md', 'utf8');
  expect(footReadme).toContain(`include=~/.config/foot/themes/${dark}.ini`);
  expect(footReadme).toContain(`include=~/.config/foot/themes/${light}.ini`);
  expect(fs.readFileSync('terminal/fish/README.md', 'utf8')).toContain(
    `terminal/fish/themes/${dark}.fish`
  );
});

test('fish themes derive shell syntax colors without owning terminal window colors', () => {
  for (const source of SOURCE_THEMES) {
    const theme = sourceTheme(source);
    const fishTheme = requiredAsset(`terminal/fish/themes/${source.slug}.fish`);

    expect(fishTheme).toContain(
      `set -g fish_color_command ${fishHex(themeColor(theme, 'syntax:function'))}`
    );
    expect(fishTheme).toContain(
      `set -g fish_color_param ${fishHex(themeColor(theme, 'syntax:data'))}`
    );
    expect(fishTheme).toContain(
      `set -g fish_color_error ${fishHex(themeColor(theme, 'ui:status.error'))} --bold`
    );
    expect(fishTheme).not.toContain('set -U ');
    expect(fishTheme).not.toMatch(/#[0-9A-Fa-f]{6}/u);
    expect(fishTheme).not.toContain('background =');
  }
});

test('Starship prompt uses named Tyrian palettes backed by neutral roles', () => {
  const starshipConfig = requiredAsset('terminal/starship/tyrian-night.toml');

  expect(starshipConfig).toContain('palette = "tyrian_abyss"');
  expect(starshipConfig).toContain('CachyOS = "󰣇"');
  expect(starshipConfig).toContain('style = "bg:surface fg:command"');
  expect(starshipConfig).toContain('style = "bg:surface fg:language"');
  expect(starshipConfig).toContain('success_symbol = "[❯](fg:success)"');
  expect(starshipConfig).not.toContain('success_symbol = "[]');
  expect(starshipConfig).not.toContain('🎗');
  expect(starshipConfig).not.toContain('fg:container bg:accent');

  for (const source of SOURCE_THEMES) {
    const theme = sourceTheme(source);

    expect(starshipConfig).toContain(`[palettes.${source.paletteName}]`);
    expect(starshipConfig).toContain(`surface = "${themeColor(theme, 'ui:surface.hover')}"`);
    expect(starshipConfig).toContain(`text = "${themeColor(theme, 'terminal:foreground')}"`);
    expect(starshipConfig).toContain(`accent = "${themeColor(theme, 'terminal:ansi.magenta')}"`);
    expect(starshipConfig).toContain(`command = "${themeColor(theme, 'terminal:ansi.cyan')}"`);
    expect(starshipConfig).toContain(`language = "${themeColor(theme, 'terminal:ansi.blue')}"`);
    expect(starshipConfig).toContain(`container = "${themeColor(theme, 'syntax:data')}"`);
  }
});

test('Fastfetch startup config uses the default Tyrian terminal palette with the Chafa logo asset', () => {
  const theme = sourceTheme(requiredThemeSource('tyrian-abyss'));
  const fastfetchConfig = JSON.parse(requiredAsset('terminal/fastfetch/tyrian-night.jsonc'));

  expect(fs.existsSync(FASTFETCH_IMAGE_ASSET_PATH)).toBe(true);
  expect(fastfetchConfig.logo).toMatchObject({
    type: 'chafa',
    source: FASTFETCH_IMAGE_CONFIG_PATH,
    width: 50,
    height: 26,
    preserveAspectRatio: true,
  });
  expect(fastfetchConfig.logo.cache).toBe(true);
  expect(fastfetchConfig.logo.printRemaining).toBe(true);
  expect(fastfetchConfig.logo.chafa.symbols).toBe('braille');
  expect(fastfetchConfig.display.color.keys).toBe(themeColor(theme, 'terminal:ansi.magenta'));
  expect(fastfetchConfig.display.color.title).toBe(themeColor(theme, 'terminal:foreground'));
  expect(fastfetchConfig.display.color.separator).toBe(themeColor(theme, 'ui:text.muted'));
  expect(
    fastfetchConfig.modules.map((module: string | { type: string }) =>
      typeof module === 'string' ? module : module.type
    )
  ).toEqual([
    'title',
    'separator',
    'os',
    'kernel',
    'uptime',
    'packages',
    'shell',
    'de',
    'wm',
    'terminal',
    'cpu',
    'gpu',
    'memory',
    'disk',
    'colors',
  ]);
});

test('Fish example, startup snippet and greeting point each layer at the Tyrian root', () => {
  expect(requiredAsset('terminal/fish/config.example.fish')).not.toContain(
    'function fish_greeting'
  );
  expect(requiredAsset('terminal/fish/conf.d/tyrian-night.fish')).toContain(
    'set -gx TYRIAN_NIGHT_ROOT "/path/to/tyrian-night"'
  );
  expect(requiredAsset('terminal/fish/conf.d/tyrian-night.fish')).toContain(
    'source $TYRIAN_NIGHT_ROOT/terminal/fish/themes/tyrian-abyss.fish'
  );
  expect(requiredAsset('terminal/fish/conf.d/tyrian-night.fish')).toContain(
    'set -gx STARSHIP_CONFIG $TYRIAN_NIGHT_ROOT/terminal/starship/tyrian-night.toml'
  );
  expect(requiredAsset('terminal/fish/conf.d/tyrian-night.fish')).not.toContain('starship init');
  const fishGreeting = requiredAsset('terminal/fish/functions/fish_greeting.fish');
  expect(fishGreeting).toContain('status current-filename');
  expect(fishGreeting).toContain(
    'fastfetch --config $tyrian_night_root/terminal/fastfetch/tyrian-night.jsonc'
  );
  expect(fishGreeting).not.toMatch(/\/home\/[^/\s]+/u);
  expect(requiredAsset('terminal/fish/config.example.fish')).toContain(
    'starship init fish | source'
  );
});

function requiredAsset(assetPath: string): string {
  const content = assets.get(assetPath);

  if (content === undefined) {
    throw new Error(`Missing generated asset '${assetPath}'`);
  }

  return content;
}

function requiredThemeSource(slug: string) {
  const source = SOURCE_THEMES.find((candidate) => candidate.slug === slug);

  if (!source) {
    throw new Error(`Missing theme source '${slug}'`);
  }

  return source;
}

function fishHex(color: string | undefined): string {
  if (!color) {
    throw new Error('Missing fish color');
  }

  return opaqueHex(color).slice(1);
}

function footHex(color: string | undefined): string {
  if (!color) {
    throw new Error('Missing Foot color');
  }

  return opaqueHex(color).slice(1);
}
