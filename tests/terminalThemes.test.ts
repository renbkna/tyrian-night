import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { opaqueHex } from '../scripts/colorUtils.mjs';
import {
  FASTFETCH_IMAGE_ASSET_PATH,
  FASTFETCH_IMAGE_CONFIG_PATH,
} from '../scripts/portableAssets.mjs';
import { buildTerminalThemeAssets, writeTerminalThemeAssets } from '../scripts/terminalThemes.mjs';
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

test('terminal generation resolves validated default roles from the injected catalog root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-terminal-root-'));

  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const catalogPath = path.join(root, 'source/themeCatalog.json');
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')) as Array<{
      slug: string;
      terminalDefault?: boolean;
    }>;
    for (const entry of catalog) {
      if (entry.slug === 'tyrian-nocturne') delete entry.terminalDefault;
      if (entry.slug === 'tyrian-night') entry.terminalDefault = true;
    }
    fs.writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`);

    const injectedAssets = new Map(
      buildTerminalThemeAssets(root).map((asset) => [asset.path, asset.content])
    );
    expect(injectedAssets.get('terminal/ghostty/config.example')).toContain(
      'theme = dark:tyrian-night,light:tyrian-dawn'
    );
    expect(injectedAssets.get('terminal/foot/foot.ini')).toContain(
      'terminal/foot/themes/tyrian-night.ini'
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

    writeTerminalThemeAssets(root);

    for (const filePath of manualFiles) {
      expect(fs.readFileSync(path.join(root, filePath), 'utf8')).toBe('manual\n');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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

test('Foot themes derive terminal colors from the VS Code theme sources', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme<VscodeTheme>(source);
    const footTheme = requiredAsset(`terminal/foot/themes/${source.slug}.ini`);

    expect(footTheme).toContain(`[colors-dark]`);
    expect(footTheme).not.toContain(`[colors]`);
    expect(footTheme).toContain(`background=${footHex(theme.colors['terminal.background'])}`);
    expect(footTheme).toContain(`foreground=${footHex(theme.colors['terminal.foreground'])}`);
    expect(footTheme).toContain('alpha=0.82');
    expect(footTheme).toContain('blur=yes');
    expect(footTheme).toContain(`regular0=${footHex(theme.colors['terminal.ansiBlack'])}`);
    expect(footTheme).toContain(`regular5=${footHex(theme.colors['terminal.ansiMagenta'])}`);
    expect(footTheme).toContain(`bright7=${footHex(theme.colors['terminal.ansiBrightWhite'])}`);
    expect(footTheme).toContain(
      `selection-background=${footHex(
        opaqueHex(theme.colors['terminal.selectionBackground'], theme.colors['terminal.background'])
      )}`
    );
    expect(footTheme).toContain(`[csd]`);
    expect(footTheme).toContain(`color=ff${footHex(theme.colors['terminal.background'])}`);
    expect(footTheme).toContain(`button-color=ff${footHex(theme.colors['terminal.foreground'])}`);
    expect(footTheme).not.toContain('#');
  }
});

test('Ghostty GTK chrome CSS derives titlebar colors from Tyrian Nocturne', () => {
  const theme = readSourceTheme<VscodeTheme>(requiredThemeSource('tyrian-nocturne'));
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

  expect(starshipConfig).toContain('palette = "tyrian_nocturne"');
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

test('Fastfetch startup config uses the default Tyrian terminal palette with the Chafa logo asset', () => {
  const theme = readSourceTheme<VscodeTheme>(requiredThemeSource('tyrian-nocturne'));
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
  const nocturneTheme = readSourceTheme<VscodeTheme>(requiredThemeSource('tyrian-nocturne'));

  expect(requiredAsset('terminal/ghostty/config.example')).toContain(
    'theme = dark:tyrian-nocturne,light:tyrian-dawn'
  );
  expect(requiredAsset('terminal/ghostty/config.example')).toContain('background-opacity = 0.82');
  expect(requiredAsset('terminal/ghostty/config.example')).toContain(
    'font-family = Monaspace Neon'
  );
  expect(requiredAsset('terminal/ghostty/config.example')).toContain(
    'font-family-italic = Monaspace Radon'
  );
  expect(requiredAsset('terminal/ghostty/config.example')).toContain(
    'font-family-bold-italic = Monaspace Radon'
  );
  expect(requiredAsset('terminal/ghostty/config.example')).toContain('cursor-style = bar');
  expect(requiredAsset('terminal/ghostty/config.example')).toContain('window-decoration = client');
  expect(requiredAsset('terminal/ghostty/config.example')).toContain('window-theme = ghostty');
  expect(requiredAsset('terminal/ghostty/config.example')).toContain('window-vsync = true');
  expect(requiredAsset('terminal/ghostty/config.example')).toContain(
    `window-titlebar-background = ${nocturneTheme.colors['terminal.background']}`
  );
  expect(requiredAsset('terminal/ghostty/config.example')).toContain(
    `window-titlebar-foreground = ${nocturneTheme.colors['terminal.foreground']}`
  );
  expect(requiredAsset('terminal/ghostty/config.example')).toContain('gtk-titlebar = true');
  expect(requiredAsset('terminal/ghostty/config.example')).toContain('gtk-titlebar-style = tabs');
  expect(requiredAsset('terminal/ghostty/config.example')).toContain('window-show-tab-bar = auto');
  expect(requiredAsset('terminal/ghostty/config.example')).toContain('gtk-tabs-location = top');
  expect(requiredAsset('terminal/ghostty/config.example')).toContain('gtk-wide-tabs = false');
  expect(requiredAsset('terminal/ghostty/config.example')).toContain('gtk-toolbar-style = flat');
  expect(requiredAsset('terminal/ghostty/config.example')).toContain(
    'mouse-scroll-multiplier = discrete:1,precision:1'
  );
  expect(requiredAsset('terminal/ghostty/config.example')).toContain('copy-on-select = clipboard');
  expect(requiredAsset('terminal/ghostty/config.example')).not.toContain('gtk-custom-css');
  expect(requiredAsset('terminal/foot/foot.ini')).toContain(
    'include=/path/to/tyrian-night/terminal/foot/themes/tyrian-nocturne.ini'
  );
  expect(requiredAsset('terminal/foot/foot.ini')).toContain('font=Monaspace Neon:size=13');
  expect(requiredAsset('terminal/foot/foot.ini')).toContain('font-italic=Monaspace Radon:size=13');
  expect(requiredAsset('terminal/foot/foot.ini')).toContain('selection-target=clipboard');
  expect(requiredAsset('terminal/foot/foot.ini')).toContain('[csd]');
  expect(requiredAsset('terminal/foot/foot.ini')).toContain('preferred=client');
  expect(requiredAsset('terminal/foot/foot.ini')).toContain('hide-when-maximized=yes');
  expect(requiredAsset('terminal/foot/foot.ini')).toContain('style=beam');
  expect(requiredAsset('terminal/fish/config.example.fish')).toContain(
    'set -gx TYRIAN_NIGHT_ROOT "/path/to/tyrian-night"'
  );
  expect(requiredAsset('terminal/fish/config.example.fish')).toContain(
    'source $TYRIAN_NIGHT_ROOT/terminal/fish/themes/tyrian-nocturne.fish'
  );
  expect(requiredAsset('terminal/fish/config.example.fish')).toContain(
    'set -gx STARSHIP_CONFIG $TYRIAN_NIGHT_ROOT/terminal/starship/tyrian-night.toml'
  );
  expect(requiredAsset('terminal/fish/config.example.fish')).not.toContain(
    'function fish_greeting'
  );
  expect(requiredAsset('terminal/fish/conf.d/tyrian-night.fish')).toContain(
    'set -gx TYRIAN_NIGHT_ROOT "/path/to/tyrian-night"'
  );
  expect(requiredAsset('terminal/fish/conf.d/tyrian-night.fish')).toContain(
    'source $TYRIAN_NIGHT_ROOT/terminal/fish/themes/tyrian-nocturne.fish'
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

test('terminal docs list the generated theme and palette surfaces from source themes', () => {
  const ghosttyReadme = fs.readFileSync('terminal/ghostty/README.md', 'utf8');
  const footReadme = fs.readFileSync('terminal/foot/README.md', 'utf8');
  const starshipReadme = fs.readFileSync('terminal/starship/README.md', 'utf8');

  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme<VscodeTheme>(source);

    expect(ghosttyReadme).toContain(`- \`${source.slug}\``);
    expect(footReadme).toContain(`- \`${source.slug}.ini\``);
    expect(starshipReadme).toContain(theme.name.replace(/^Tyrian /u, ''));
  }
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

function rgba(color: string, alpha: number): string {
  const hex = opaqueHex(color);
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);

  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}
