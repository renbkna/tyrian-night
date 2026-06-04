import fs from 'node:fs';

import { expect, test } from 'bun:test';

import { opaqueHex } from '../scripts/colorUtils.mjs';
import {
  FASTFETCH_IMAGE_ASSET_PATH,
  FASTFETCH_IMAGE_CONFIG_PATH,
} from '../scripts/portableAssets.mjs';
import { buildTerminalThemeAssets } from '../scripts/terminalThemes.mjs';
import { SOURCE_THEMES, readSourceTheme } from '../scripts/themeSources.mjs';

type HighlightSettings = {
  foreground?: string;
};

type VscodeTheme = {
  name: string;
  colors: Record<string, string>;
  semanticTokenColors: Record<string, HighlightSettings>;
};

const assets = new Map(buildTerminalThemeAssets().map((asset) => [asset.path, asset.content]));

test('terminal theme assets match the generated VS Code-derived outputs', () => {
  for (const [assetPath, content] of assets) {
    expect(fs.readFileSync(assetPath, 'utf8')).toBe(content);
  }
});

test('Ghostty themes derive terminal colors from the VS Code theme sources', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme<VscodeTheme>(source);
    const ghosttyTheme = requiredAsset(`terminal/ghostty/themes/${source.slug}`);
    const background = theme.colors['terminal.background'];

    expect(ghosttyTheme).toContain(`background = ${theme.colors['terminal.background']}`);
    expect(ghosttyTheme).toContain(`foreground = ${theme.colors['terminal.foreground']}`);
    expect(ghosttyTheme).toContain(`palette = 0=${theme.colors['terminal.ansiBlack']}`);
    expect(ghosttyTheme).toContain(`palette = 5=${theme.colors['terminal.ansiMagenta']}`);
    expect(ghosttyTheme).toContain(`palette = 15=${theme.colors['terminal.ansiBrightWhite']}`);
    expect(ghosttyTheme).toContain(
      `selection-background = ${opaqueHex(theme.colors['terminal.selectionBackground'], background)}`
    );
  }
});

test('Ghostty GTK chrome CSS derives titlebar colors from Tyrian Night', () => {
  const theme = readSourceTheme<VscodeTheme>(SOURCE_THEMES[0]);
  const css = requiredAsset('terminal/ghostty/ghostty.css');

  expect(css).toContain(`background: ${theme.colors['terminal.background'].toLowerCase()};`);
  expect(css).toContain(`color: ${theme.colors['terminal.foreground'].toLowerCase()};`);
  expect(css).toContain(`background: ${rgba(theme.colors['terminal.ansiMagenta'], 0.32)};`);
  expect(css).not.toContain('#F2F2F2');
});

test('fish themes derive shell syntax colors without owning terminal window colors', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme<VscodeTheme>(source);
    const fishTheme = requiredAsset(`terminal/fish/themes/${source.slug}.fish`);

    expect(fishTheme).toContain(
      `set -g fish_color_command ${fishHex(theme.semanticTokenColors.function.foreground)}`
    );
    expect(fishTheme).toContain(
      `set -g fish_color_param ${fishHex(theme.semanticTokenColors.parameter.foreground)}`
    );
    expect(fishTheme).toContain(
      `set -g fish_color_error ${fishHex(theme.colors['editorError.foreground'])} --bold`
    );
    expect(fishTheme).not.toContain('set -U ');
    expect(fishTheme).not.toMatch(/#[0-9A-Fa-f]{6}/u);
    expect(fishTheme).not.toContain('background =');
  }
});

test('Starship prompt uses named Tyrian palettes backed by the VS Code theme sources', () => {
  const starshipConfig = requiredAsset('terminal/starship/tyrian-night.toml');

  expect(starshipConfig).toContain('palette = "tyrian_night"');
  expect(starshipConfig).toContain('CachyOS = "󰣇"');
  expect(starshipConfig).toContain('style = "bg:surface fg:command"');
  expect(starshipConfig).toContain('style = "bg:surface fg:language"');
  expect(starshipConfig).toContain('success_symbol = "[❯](fg:success)"');
  expect(starshipConfig).not.toContain('success_symbol = "[]');
  expect(starshipConfig).not.toContain('🎗');
  expect(starshipConfig).not.toContain('fg:container bg:accent');

  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme<VscodeTheme>(source);

    expect(starshipConfig).toContain(`[palettes.${source.paletteName}]`);
    expect(starshipConfig).toContain(`surface = "${theme.colors['list.hoverBackground']}"`);
    expect(starshipConfig).toContain(`text = "${theme.colors['terminal.foreground']}"`);
    expect(starshipConfig).toContain(`accent = "${theme.colors['terminal.ansiMagenta']}"`);
    expect(starshipConfig).toContain(`command = "${theme.colors['terminal.ansiCyan']}"`);
    expect(starshipConfig).toContain(`language = "${theme.colors['terminal.ansiBlue']}"`);
    expect(starshipConfig).toContain(
      `container = "${theme.semanticTokenColors.parameter.foreground}"`
    );
  }
});

test('Fastfetch startup config uses the Tyrian palette with the Chafa logo asset', () => {
  const theme = readSourceTheme<VscodeTheme>(SOURCE_THEMES[0]);
  const fastfetchConfig = JSON.parse(requiredAsset('terminal/fastfetch/tyrian-night.jsonc'));

  expect(fs.existsSync(FASTFETCH_IMAGE_ASSET_PATH)).toBe(true);
  expect(fastfetchConfig.logo).toMatchObject({
    type: 'chafa',
    source: FASTFETCH_IMAGE_CONFIG_PATH,
    width: 50,
    height: 26,
    preserveAspectRatio: true,
  });
  expect(fastfetchConfig.logo.recache).toBe(false);
  expect(fastfetchConfig.logo.printRemaining).toBe(true);
  expect(fastfetchConfig.logo.chafa.symbols).toBe('braille');
  expect(fastfetchConfig.display.color.keys).toBe(theme.colors['terminal.ansiMagenta']);
  expect(fastfetchConfig.display.color.title).toBe(theme.colors['terminal.foreground']);
  expect(fastfetchConfig.display.color.separator).toBe(theme.colors['breadcrumb.foreground']);
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

test('example configs point each terminal layer at the right owner', () => {
  expect(requiredAsset('terminal/ghostty/config.example')).toContain(
    'theme = dark:tyrian-night,light:tyrian-dawn'
  );
  expect(requiredAsset('terminal/ghostty/config.example')).toContain('background-opacity = 0.78');
  expect(requiredAsset('terminal/ghostty/config.example')).toContain('cursor-style = bar');
  expect(requiredAsset('terminal/ghostty/config.example')).toContain(
    'window-titlebar-background = #0C0C0C'
  );
  expect(requiredAsset('terminal/ghostty/config.example')).not.toContain('gtk-custom-css');
  expect(requiredAsset('terminal/fish/config.example.fish')).toContain(
    'set -gx TYRIAN_NIGHT_ROOT "/path/to/tyrian-night"'
  );
  expect(requiredAsset('terminal/fish/config.example.fish')).toContain(
    'source $TYRIAN_NIGHT_ROOT/terminal/fish/themes/tyrian-night.fish'
  );
  expect(requiredAsset('terminal/fish/config.example.fish')).toContain(
    'set -gx STARSHIP_CONFIG $TYRIAN_NIGHT_ROOT/terminal/starship/tyrian-night.toml'
  );
  expect(requiredAsset('terminal/fish/config.example.fish')).not.toContain(
    'function fish_greeting'
  );
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

function fishHex(color: string | undefined): string {
  if (!color) {
    throw new Error('Missing fish color');
  }

  return opaqueHex(color).slice(1);
}

function rgba(color: string, alpha: number): string {
  const hex = opaqueHex(color);
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);

  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}
