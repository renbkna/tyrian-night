import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import {
  buildLiveInstallPlan,
  installLiveTyrian,
  patchIniSection,
} from '../scripts/installLiveTyrian.mjs';
import {
  FASTFETCH_IMAGE_HOME_PATH,
  TYRIAN_BACKUP_HOME,
  TYRIAN_INSTALL_HOME,
  WALLPAPER_ASSET_PATH,
} from '../scripts/portableAssets.mjs';
import { buildFishConfig, buildGhosttyConfig } from '../scripts/terminalThemes.mjs';

const FIXTURE_HOME = '/home/example';

test('live installer defaults to a repo-independent materialized install root', () => {
  const plan = buildLiveInstallPlan({
    repoRoot: '/repo/tyrian-night',
    home: FIXTURE_HOME,
  });
  const nextPlan = buildLiveInstallPlan({
    repoRoot: '/repo/tyrian-night',
    home: FIXTURE_HOME,
  });
  const installRoot = `${FIXTURE_HOME}/${TYRIAN_INSTALL_HOME}`;

  expect(plan.mode).toBe('copy');
  expect(plan.installRoot).toBe(installRoot);
  expect(plan.sourceRoot).toBe(installRoot);
  expect(plan.backupRoot).toContain(`${FIXTURE_HOME}/${TYRIAN_BACKUP_HOME}/live-tyrian-apply-`);
  expect(plan.materializedRoots).toEqual([
    { source: '/repo/tyrian-night/assets', target: `${installRoot}/assets` },
    { source: '/repo/tyrian-night/terminal', target: `${installRoot}/terminal` },
    { source: '/repo/tyrian-night/desktop', target: `${installRoot}/desktop` },
  ]);
  expect(plan.sourcePaths.fastfetchConfig).toBe(
    `${installRoot}/terminal/fastfetch/tyrian-night.jsonc`
  );
  expect(plan.sourcePaths.starshipConfig).toBe(
    `${installRoot}/terminal/starship/tyrian-night.toml`
  );
  expect(plan.sourcePaths.wallpaper).toBe(`${installRoot}/${WALLPAPER_ASSET_PATH}`);
  expect(plan.livePaths.screenLockerConfig).toBe(`${FIXTURE_HOME}/.config/kscreenlockerrc`);
  expect(plan.livePaths.unionEnvironment).toBe(
    `${FIXTURE_HOME}/.config/environment.d/tyrian-union.conf`
  );
  expect(plan.livePaths.unionTyrianStyle).toBe(
    `${FIXTURE_HOME}/.local/share/union/css/styles/TyrianNight`
  );
  expect(plan.livePaths.unionDefaults).toBe(`${FIXTURE_HOME}/.local/share/union/css/defaults`);
  expect(plan.sourcePaths.unionDefaultsRoot).toBe('/usr/share/union/css/defaults');
  expect(plan.touchedPaths).toContain(`${FIXTURE_HOME}/.config/kscreenlockerrc`);
  expect(plan.touchedPaths).toContain(`${FIXTURE_HOME}/.config/environment.d/tyrian-union.conf`);
  expect(plan.touchedPaths).toContain(`${FIXTURE_HOME}/.local/share/union/css/defaults`);
  expect(plan.touchedPaths).toContain(`${FIXTURE_HOME}/.local/share/union/css/styles/TyrianNight`);
  expect(plan.legacyPaths).toEqual([
    `${FIXTURE_HOME}/.local/share/caelestia/fastfetch/sewerslvt.gif`,
    `${FIXTURE_HOME}/.local/share/caelestia/fastfetch/tyrian-logo.png`,
    `${FIXTURE_HOME}/.local/share/caelestia/fastfetch/tyrian-fetch.webp`,
  ]);
  expect(JSON.stringify(plan.sourcePaths)).not.toContain('/repo/tyrian-night');
  expect(plan.backupRoot).not.toContain('/repo/tyrian-night');
  expect(nextPlan.backupRoot).not.toBe(plan.backupRoot);
});

test('live installer materializes full Tyrian rice targets without a Monochrome base', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-install-test-'));
  const commandCalls: Array<{ command: string; args: string[] }> = [];

  try {
    const fishConfig = path.join(home, '.local/share/caelestia/fish/config.fish');
    const ghosttyConfig = path.join(home, '.config/ghostty/config');
    fs.mkdirSync(path.dirname(fishConfig), { recursive: true });
    fs.mkdirSync(path.dirname(ghosttyConfig), { recursive: true });
    fs.writeFileSync(
      fishConfig,
      [
        'if status is-interactive',
        '    echo stale',
        'end',
        '',
        'function fish_greeting',
        '    echo custom-greeting',
        'end',
        '',
      ].join('\n')
    );
    fs.writeFileSync(ghosttyConfig, 'font-size = 99\n');

    installLiveTyrian({
      repoRoot: process.cwd(),
      home,
      apply: true,
      hasCommand: () => true,
      runCommand: (command, args) => {
        commandCalls.push({ command, args });
        return '';
      },
    });

    const installRoot = path.join(home, TYRIAN_INSTALL_HOME);
    const ghosttyCss = path.join(home, '.config/ghostty/ghostty.css');
    const kdeglobals = path.join(home, '.config/kdeglobals');
    const plasmarc = path.join(home, '.config/plasmarc');
    const unionEnvironment = path.join(home, '.config/environment.d/tyrian-union.conf');
    const tyrianDesktopTheme = path.join(home, '.local/share/plasma/desktoptheme/TyrianNight');
    const tyrianLookAndFeel = path.join(home, '.local/share/plasma/look-and-feel/TyrianNight');
    const unionDefaults = path.join(home, '.local/share/union/css/defaults');
    const tyrianUnionStyle = path.join(home, '.local/share/union/css/styles/TyrianNight');

    expect(fs.existsSync(path.join(home, '.local/share/plasma/desktoptheme/Monochrome'))).toBe(
      false
    );
    expect(fs.existsSync(path.join(tyrianDesktopTheme, 'metadata.json'))).toBe(true);
    expect(fs.existsSync(path.join(tyrianDesktopTheme, 'dialogs/background.svg'))).toBe(true);
    expect(fs.existsSync(path.join(tyrianLookAndFeel, 'contents/defaults'))).toBe(true);
    expect(fs.existsSync(path.join(unionDefaults, 'default.css'))).toBe(true);
    expect(fs.existsSync(path.join(unionDefaults, 'extra-properties.css'))).toBe(true);
    expect(fs.existsSync(path.join(unionDefaults, 'generated-properties.css'))).toBe(true);
    expect(fs.existsSync(path.join(tyrianUnionStyle, 'style.css'))).toBe(true);
    expect(fs.readFileSync(unionEnvironment, 'utf8')).toBe(
      ['UNION_STYLE_NAME=TyrianNight', 'QT_QUICK_CONTROLS_STYLE=org.kde.union', ''].join('\n')
    );
    expect(fs.readFileSync(fishConfig, 'utf8')).toBe(buildFishConfig({ tyrianRoot: installRoot }));
    expect(fs.readFileSync(ghosttyConfig, 'utf8')).toBe(
      buildGhosttyConfig({ gtkCustomCss: ghosttyCss })
    );
    expect(fs.readFileSync(fishConfig, 'utf8')).not.toContain('custom-greeting');
    expect(fs.readFileSync(ghosttyConfig, 'utf8')).not.toContain('font-size = 99');
    expect(commandCalls.map(({ command }) => command)).toEqual([
      'kwriteconfig6',
      'kwriteconfig6',
      'kwriteconfig6',
      'kwriteconfig6',
      'plasma-apply-colorscheme',
      'plasma-apply-desktoptheme',
    ]);
    expect(commandCalls.filter(({ command }) => command === 'kwriteconfig6')).toEqual([
      {
        command: 'kwriteconfig6',
        args: [
          '--file',
          kdeglobals,
          '--group',
          'KDE',
          '--key',
          'LookAndFeelPackage',
          'TyrianNight',
        ],
      },
      {
        command: 'kwriteconfig6',
        args: ['--file', kdeglobals, '--group', 'General', '--key', 'ColorScheme', 'TyrianNight'],
      },
      {
        command: 'kwriteconfig6',
        args: ['--file', kdeglobals, '--group', 'KDE', '--key', 'widgetStyle', 'Union'],
      },
      {
        command: 'kwriteconfig6',
        args: ['--file', plasmarc, '--group', 'Theme', '--key', 'name', 'TyrianNight'],
      },
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('live installer link mode is explicit and repo-dependent', () => {
  const plan = buildLiveInstallPlan({
    repoRoot: '/repo/tyrian-night',
    home: FIXTURE_HOME,
    link: true,
  });

  expect(plan.mode).toBe('link');
  expect(plan.installRoot).toBe(`${FIXTURE_HOME}/${TYRIAN_INSTALL_HOME}`);
  expect(plan.sourceRoot).toBe('/repo/tyrian-night');
  expect(plan.sourcePaths.fastfetchConfig).toBe(
    '/repo/tyrian-night/terminal/fastfetch/tyrian-night.jsonc'
  );
  expect(plan.sourcePaths.unionTyrianStyleRoot).toBe(
    '/repo/tyrian-night/desktop/kde/union/css/styles/TyrianNight'
  );
  expect(plan.materializedRoots).toContainEqual({
    source: '/repo/tyrian-night/assets/tyrian-fetch.webp',
    target: `${FIXTURE_HOME}/${FASTFETCH_IMAGE_HOME_PATH}`,
  });
  expect(plan.sourcePaths.wallpaper).toBe('/repo/tyrian-night/assets/wallpaper-tyrian.png');
});

test('live installer validates repo sources before touching live config', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-preflight-home-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-preflight-repo-'));
  const ghosttyConfig = path.join(home, '.config/ghostty/config');

  try {
    fs.mkdirSync(path.dirname(ghosttyConfig), { recursive: true });
    fs.writeFileSync(ghosttyConfig, 'font-size = 99\n');

    expect(() =>
      installLiveTyrian({
        repoRoot,
        home,
        apply: true,
        hasCommand: () => true,
        runCommand: () => '',
      })
    ).toThrow('Missing Tyrian install source: terminal/ghostty/themes/tyrian-night');
    expect(fs.readFileSync(ghosttyConfig, 'utf8')).toBe('font-size = 99\n');
    expect(fs.existsSync(path.join(home, TYRIAN_BACKUP_HOME))).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('live installer uses a fresh backup root for repeated apply operations', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-live-repeat-test-'));
  const targetConfig = path.join(home, 'fish-target.fish');
  const fishConfig = path.join(home, '.local/share/caelestia/fish/config.fish');

  try {
    fs.mkdirSync(path.dirname(fishConfig), { recursive: true });
    fs.writeFileSync(targetConfig, 'original\n');
    fs.symlinkSync(targetConfig, fishConfig);

    const options = {
      repoRoot: process.cwd(),
      home,
      apply: true,
      hasCommand: () => true,
      runCommand: () => '',
    };

    expect(() => installLiveTyrian(options)).not.toThrow();
    fs.writeFileSync(targetConfig, 'customized again\n');
    expect(() => installLiveTyrian(options)).not.toThrow();

    const backupRoot = path.join(home, TYRIAN_BACKUP_HOME);
    const backupDirs = fs
      .readdirSync(backupRoot)
      .filter((entry) => entry.startsWith('live-tyrian-apply-'));

    expect(backupDirs.length).toBeGreaterThanOrEqual(2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('lock screen wallpaper patch preserves existing screen locker settings', () => {
  const patched = patchIniSection(
    [
      '[Daemon]',
      'Timeout=15',
      '',
      '[Greeter][Wallpaper][org.kde.image][General]',
      'Image=/old/wallpaper.png',
      'PreviewImage=/old/wallpaper.png',
      '',
    ].join('\n'),
    'Greeter][Wallpaper][org.kde.image][General',
    {
      Image: `${FIXTURE_HOME}/.local/share/tyrian-night/assets/wallpaper-tyrian.png`,
      PreviewImage: `${FIXTURE_HOME}/.local/share/tyrian-night/assets/wallpaper-tyrian.png`,
    }
  );

  expect(patched).toContain('[Daemon]\nTimeout=15');
  expect(patched).toContain(
    `[Greeter][Wallpaper][org.kde.image][General]\nImage=${FIXTURE_HOME}/.local/share/tyrian-night/assets/wallpaper-tyrian.png\nPreviewImage=${FIXTURE_HOME}/.local/share/tyrian-night/assets/wallpaper-tyrian.png`
  );
  expect(patched).not.toContain('/old/wallpaper.png');
});
