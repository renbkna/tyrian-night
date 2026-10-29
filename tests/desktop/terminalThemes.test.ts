import { readSourceData, writeSourceData } from '../support/sourceData.js';
import { SOURCE_THEMES, THEME_REPOSITORY, sourceTheme } from '../support/themes.js';
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { opaqueHex, opaqueHexDigits } from '../../scripts/colorUtils.mjs';
import {
  FASTFETCH_LOGO_ASSET_PATH,
  buildTerminalThemeAssets,
  syncTerminalThemeAssets,
} from '../../scripts/terminalThemes.mjs';
import { TERMINAL_ANSI_ROLES, themeColor } from '../../scripts/themeDefinition.mjs';
import { getTerminalDefaultThemeSource } from '../../scripts/themeSources.mjs';

const assets = new Map(buildTerminalThemeAssets().map((asset) => [asset.path, asset.content]));

test('terminal theme assets match the generated neutral-role projections', () => {
  for (const [assetPath, content] of assets) {
    expect(fs.readFileSync(assetPath, 'utf8')).toBe(content);
  }
});

test('each linked fish startup file finds its checkout and wires its own variant', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tyrian-fish-root-it's $x-`));

  try {
    const checkout = path.join(root, 'checkout');
    for (const [assetPath, content] of assets) {
      fs.mkdirSync(path.dirname(path.join(checkout, assetPath)), { recursive: true });
      fs.writeFileSync(path.join(checkout, assetPath), content);
    }
    fs.mkdirSync(path.dirname(path.join(checkout, FASTFETCH_LOGO_ASSET_PATH)), { recursive: true });
    fs.copyFileSync(FASTFETCH_LOGO_ASSET_PATH, path.join(checkout, FASTFETCH_LOGO_ASSET_PATH));
    const resolvedCheckout = fs.realpathSync(checkout);

    const functionsDir = path.join(root, 'home/functions');
    fs.mkdirSync(functionsDir, { recursive: true });
    fs.symlinkSync(
      path.join(checkout, 'terminal/fish/functions/fish_greeting.fish'),
      path.join(functionsDir, 'fish_greeting.fish')
    );
    // A stand-in fastfetch that prints the arguments the greeting passes.
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'fastfetch'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', {
      mode: 0o755,
    });

    // Switching variants replaces the one documented link, as `ln -sfn` does.
    const confDir = path.join(root, 'home/conf.d');
    const startupLink = path.join(confDir, 'tyrian-night.fish');
    fs.mkdirSync(confDir, { recursive: true });

    for (const source of SOURCE_THEMES) {
      const { slug } = source;
      fs.rmSync(startupLink, { force: true });
      fs.symlinkSync(path.join(checkout, `terminal/fish/conf.d/${slug}.fish`), startupLink);

      const fish = Bun.spawnSync(
        [
          'fish',
          '--no-config',
          '--command',
          [
            'source $argv[1]',
            'set -p fish_function_path $argv[2]',
            "echo (count (set --names --export | string match -r '^TYRIAN_NIGHT_'))",
            'printf "%s\\n" $fish_color_command $STARSHIP_CONFIG',
            'fish_greeting',
          ].join('; and '),
          startupLink,
          functionsDir,
        ],
        { env: { ...fishEnv(), PATH: `${binDir}:${process.env.PATH}` } }
      );

      const [exportedCount, commandColor, starshipConfig, ...fastfetchArgs] = fish.stdout
        .toString()
        .trimEnd()
        .split('\n');
      expect(fish.stderr.toString()).toBe('');
      expect(fish.exitCode).toBe(0);
      // Only fish reads these, so a child shell without the link must not inherit them.
      expect(exportedCount).toBe('0');
      expect(commandColor).toBe(
        opaqueHexDigits(themeColor(sourceTheme(source), 'syntax:function'))
      );
      expect(starshipConfig).toBe(`${resolvedCheckout}/terminal/starship/${slug}.toml`);
      expect(fastfetchArgs).toEqual([
        '--config',
        `${resolvedCheckout}/terminal/fastfetch/${slug}.jsonc`,
        '--logo',
        `${resolvedCheckout}/${FASTFETCH_LOGO_ASSET_PATH}`,
      ]);
      for (const referenced of [starshipConfig, fastfetchArgs[1], fastfetchArgs[3]]) {
        expect(fs.existsSync(referenced!)).toBe(true);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fish greeting without the startup snippet reports the missing link', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-fish-greeting-'));

  try {
    const greetingPath = path.join(root, 'fish_greeting.fish');
    fs.writeFileSync(greetingPath, requiredAsset('terminal/fish/functions/fish_greeting.fish'));
    const fish = Bun.spawnSync(
      ['fish', '--no-config', '--command', 'source $argv[1]; and fish_greeting', greetingPath],
      { env: fishEnv() }
    );

    expect(fish.exitCode).toBe(1);
    expect(fish.stderr.toString()).toContain(
      'link a terminal/fish/conf.d/tyrian-*.fish as ~/.config/fish/conf.d/tyrian-night.fish'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('terminal config generators require an admitted repository snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-terminal-admission-'));

  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const themePath = path.join(root, 'source/themes/tyrian-abyss.cjs');
    const recipe = readSourceData(themePath) as { syntax: { contrast: Record<string, number> } };
    recipe.syntax.contrast.plain = 50;
    writeSourceData(themePath, recipe);

    expect(() => buildTerminalThemeAssets(root)).toThrow(
      "Theme 'tyrian-abyss' violates theme safety policy"
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

    syncTerminalThemeAssets(root);

    for (const assetPath of assets.keys()) {
      expect(fs.existsSync(path.join(root, assetPath))).toBe(true);
    }
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
    const ghosttyTheme = requiredAsset(`terminal/ghostty/themes/${source.slug}`).split('\n');
    const background = themeColor(theme, 'terminal:background');

    expect(ghosttyTheme).toContain(`background = ${themeColor(theme, 'terminal:background')}`);
    expect(ghosttyTheme).toContain(`foreground = ${themeColor(theme, 'terminal:foreground')}`);
    TERMINAL_ANSI_ROLES.forEach((role, slot) => {
      expect(ghosttyTheme).toContain(`palette = ${slot}=${themeColor(theme, role)}`);
    });
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
    const footText = requiredAsset(`terminal/foot/themes/${source.slug}.ini`);
    const footTheme = footText.split('\n');

    expect(footTheme).toContain(theme.appearance === 'light' ? '[colors-light]' : '[colors-dark]');
    expect(footTheme).not.toContain(
      theme.appearance === 'light' ? '[colors-dark]' : '[colors-light]'
    );
    expect(footTheme).not.toContain(`[colors]`);
    expect(footTheme).toContain(
      `background=${opaqueHexDigits(themeColor(theme, 'terminal:background'))}`
    );
    expect(footTheme).toContain(
      `foreground=${opaqueHexDigits(themeColor(theme, 'terminal:foreground'))}`
    );
    expect(footTheme).toContain('alpha=0.82');
    expect(footTheme).toContain('blur=yes');
    TERMINAL_ANSI_ROLES.forEach((role, slot) => {
      const key = slot < 8 ? `regular${slot}` : `bright${slot - 8}`;
      expect(footTheme).toContain(`${key}=${opaqueHexDigits(themeColor(theme, role))}`);
    });
    expect(footTheme).toContain(
      `selection-background=${opaqueHexDigits(
        opaqueHex(themeColor(theme, 'terminal:selection'), themeColor(theme, 'terminal:background'))
      )}`
    );
    expect(footTheme).toContain(
      `cursor=${opaqueHexDigits(themeColor(theme, 'terminal:background'))} ${opaqueHexDigits(
        themeColor(theme, 'terminal:cursor')
      )}`
    );
    // [csd] is global in foot; in a theme file the last included variant would win.
    expect(footTheme).not.toContain('[csd]');
    expect(footText).not.toContain('#');
    expect(requiredAsset(`terminal/foot/csd/${source.slug}.ini`).split('\n')).toEqual([
      '[csd]',
      `color=ff${opaqueHexDigits(themeColor(theme, 'terminal:background'))}`,
      `button-color=ff${opaqueHexDigits(themeColor(theme, 'terminal:foreground'))}`,
      '',
    ]);
  }
});

test('Ghostty and Foot outputs are include files only, never user configs', () => {
  const terminalConfigOutputs = [...assets.keys()].filter(
    (assetPath) =>
      /^terminal\/(?:ghostty|foot)\//u.test(assetPath) &&
      !/^terminal\/(?:ghostty\/themes|foot\/themes|foot\/csd)\//u.test(assetPath)
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

test('fish themes derive shell syntax colors as session-scoped variables', () => {
  for (const source of SOURCE_THEMES) {
    const theme = sourceTheme(source);
    const fishTheme = requiredAsset(`terminal/fish/themes/${source.slug}.fish`);

    expect(fishTheme).toContain(
      `set -g fish_color_command ${opaqueHexDigits(themeColor(theme, 'syntax:function'))}`
    );
    expect(fishTheme).toContain(
      `set -g fish_color_param ${opaqueHexDigits(themeColor(theme, 'syntax:data'))}`
    );
    expect(fishTheme).toContain(
      `set -g fish_color_error ${opaqueHexDigits(themeColor(theme, 'ui:status.error'))} --bold`
    );
    expect(fishTheme).not.toContain('set -U ');
    expect(fishTheme).not.toMatch(/#[0-9A-Fa-f]{6}/u);
  }
});

test('Starship prompts select their own variant palette backed by neutral roles', () => {
  const starshipConfig = requiredAsset('terminal/starship/tyrian-night.toml');

  expect(starshipConfig).toContain('CachyOS = "󰣇"');
  expect(starshipConfig).toContain('style = "bg:surface fg:command"');
  expect(starshipConfig).toContain('style = "bg:surface fg:language"');
  expect(starshipConfig).toContain('success_symbol = "[❯](fg:success)"');
  expect(starshipConfig).not.toContain('success_symbol = "[]');
  expect(starshipConfig).not.toContain('🎗');
  expect(starshipConfig).not.toContain('fg:container bg:accent');

  for (const source of SOURCE_THEMES) {
    const theme = sourceTheme(source);
    const variantConfig = requiredAsset(`terminal/starship/${source.slug}.toml`).split('\n');

    expect(variantConfig).toContain(`palette = "${source.paletteName}"`);
    expect(variantConfig.filter((line) => line.startsWith('[palettes.'))).toEqual([
      `[palettes.${source.paletteName}]`,
    ]);
    for (const [key, role] of [
      ['surface', 'ui:surface.hover'],
      ['text', 'terminal:foreground'],
      ['muted', 'ui:text.muted'],
      ['accent', 'terminal:ansi.magenta'],
      ['command', 'terminal:ansi.cyan'],
      ['language', 'terminal:ansi.blue'],
      ['container', 'syntax:data'],
      ['success', 'terminal:ansi.green'],
      ['danger', 'terminal:ansi.red'],
      ['warning', 'terminal:ansi.yellow'],
    ] as const) {
      expect(variantConfig).toContain(`${key} = "${themeColor(theme, role)}"`);
    }
  }
});

test('Fastfetch configs render the passed logo with Chafa in their own variant colors', () => {
  for (const source of SOURCE_THEMES) {
    const theme = sourceTheme(source);
    const variantConfig = JSON.parse(requiredAsset(`terminal/fastfetch/${source.slug}.jsonc`));

    expect(variantConfig.display.color.keys).toBe(themeColor(theme, 'terminal:ansi.magenta'));
    expect(variantConfig.display.color.title).toBe(themeColor(theme, 'terminal:foreground'));
    expect(variantConfig.display.color.separator).toBe(themeColor(theme, 'ui:text.muted'));
  }

  const fastfetchConfig = JSON.parse(requiredAsset('terminal/fastfetch/tyrian-night.jsonc'));
  expect(fastfetchConfig.logo.source).toBeUndefined();
  expect(fastfetchConfig.logo).toMatchObject({
    type: 'chafa',
    width: 50,
    height: 26,
    preserveAspectRatio: true,
  });
  expect(fastfetchConfig.logo.cache).toBe(true);
  expect(fastfetchConfig.logo.printRemaining).toBe(true);
  expect(fastfetchConfig.logo.chafa.symbols).toBe('braille');
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

test('fish startup snippets leave prompt init to the user config', () => {
  for (const { slug } of SOURCE_THEMES) {
    expect(requiredAsset(`terminal/fish/conf.d/${slug}.fish`)).not.toContain('starship init');
  }
});

/** The test process's environment without a Tyrian setup inherited from the developer's shell. */
function fishEnv(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('TYRIAN_NIGHT_'))
  );
}

function requiredAsset(assetPath: string): string {
  const content = assets.get(assetPath);

  if (content === undefined) {
    throw new Error(`Missing generated asset '${assetPath}'`);
  }

  return content;
}
