import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import {
  RICE_LAYOUT_FILES,
  RICE_LAYOUT_REQUIRED_COMMANDS,
  RICE_MANIFEST_PATH,
  RICE_REQUIREMENTS_PATH,
  RICE_WALLPAPER_PATH,
  RICE_WALLPAPER_PLACEHOLDER,
  buildPlasmaWallpaperScript,
  buildRiceInstallPlan,
  captureRiceLayout,
  checkRiceSnapshot,
  hydratePlasmaDesktopActivityIds,
  installPlasmaLayout,
  installRice,
} from '../scripts/rice.mjs';

const FIXTURE_HOME = '/home/example';

test('rice install is a full layout restore by default', () => {
  const fullPlan = buildRiceInstallPlan({ repoRoot: '/repo', home: FIXTURE_HOME });
  const nextFullPlan = buildRiceInstallPlan({ repoRoot: '/repo', home: FIXTURE_HOME });

  expect(fullPlan.styleInstaller).toBe('/repo/scripts/installLiveTyrian.mjs');
  expect(fullPlan.layoutFiles.map((file) => file.homePath)).toEqual([
    '.config/plasma-org.kde.plasma.desktop-appletsrc',
    '.config/plasmashellrc',
  ]);
  expect(fullPlan.wallpaperPath).toBe(
    `${FIXTURE_HOME}/.local/share/tyrian-night/assets/wallpaper-tyrian.png`
  );
  expect(fullPlan.repoWallpaperPath).toBe('/repo/assets/wallpaper-tyrian.png');
  expect(fullPlan.runtimeRoot).toBe(`${FIXTURE_HOME}/.local/share/tyrian-night`);
  expect(fullPlan.backupRoot).toContain(
    `${FIXTURE_HOME}/.local/state/tyrian-night/backups/rice-layout-apply-`
  );
  expect(fullPlan.backupRoot).not.toContain('/repo');
  expect(nextFullPlan.backupRoot).not.toBe(fullPlan.backupRoot);

  const styleOnlyPlan = buildRiceInstallPlan({
    repoRoot: '/repo',
    home: FIXTURE_HOME,
    withPlasmaLayout: false,
  });

  expect(styleOnlyPlan.layoutFiles).toEqual([]);

  const linkedLayoutPlan = buildRiceInstallPlan({
    repoRoot: '/repo',
    home: FIXTURE_HOME,
    link: true,
    withPlasmaLayout: true,
  });

  expect(linkedLayoutPlan.wallpaperPath).toBe('/repo/assets/wallpaper-tyrian.png');
  expect(linkedLayoutPlan.runtimeRoot).toBe('/repo');
});

test('rice snapshot is complete and portable', () => {
  const root = process.cwd();

  checkRiceSnapshot({ repoRoot: root });

  const desktopLayout = fs.readFileSync(path.join(root, RICE_LAYOUT_FILES[0].snapshotPath), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, RICE_MANIFEST_PATH), 'utf8')) as {
    layoutFiles: typeof RICE_LAYOUT_FILES;
    requirements: string;
    wallpaperAsset: string;
  };
  const requirements = fs.readFileSync(path.join(root, manifest.requirements), 'utf8');

  expect(desktopLayout).toContain(RICE_WALLPAPER_PLACEHOLDER);
  expect(desktopLayout).not.toMatch(/^Image=\//mu);
  expect(desktopLayout).not.toMatch(/^PreviewImage=\//mu);
  expect(desktopLayout).not.toMatch(/^(?:Image|PreviewImage)=file:\/\//mu);
  expect(desktopLayout).not.toMatch(/^activityId=.+$/mu);
  expect(desktopLayout).not.toMatch(/^ItemGeometries[^=]*=.+$/mu);
  expect(desktopLayout).not.toMatch(/^lastResolution=.+$/mu);
  expect(desktopLayout).not.toMatch(/^lastScreen=.+$/mu);
  expect(desktopLayout).not.toMatch(/^positions=.+desktop:\//mu);
  expect(desktopLayout).not.toMatch(/^itemsOnDisabledScreens=.+desktop:\//mu);
  expect(desktopLayout).not.toMatch(/^screenMapping=.+desktop:\//mu);
  expect(desktopLayout).not.toMatch(/^lastPreset=\/.+$/mu);
  expect(desktopLayout).not.toMatch(/\/home\/[^/\s]+/u);
  expect(desktopLayout).not.toContain('desktop:/');
  expect(fs.readFileSync(path.join(root, RICE_LAYOUT_FILES[1].snapshotPath), 'utf8')).not.toMatch(
    /^performed=\/.+$/mu
  );
  expect(fs.existsSync(path.join(root, RICE_WALLPAPER_PATH))).toBe(true);
  expect(manifest.requirements).toBe(RICE_REQUIREMENTS_PATH);
  expect(requirements).toContain('com.axzoros.yorhahud');
  expect(requirements).toContain('luisbocanegra.panel.colorizer');
  expect(requirements).toContain('org.kde.olib.thermalmonitor');
  expect(manifest.wallpaperAsset).toBe(RICE_WALLPAPER_PATH);
  expect(manifest.layoutFiles).toEqual(RICE_LAYOUT_FILES);
});

test('capturing rice keeps the requirements manifest pointer', () => {
  const root = makeTempRiceRepo();
  const userHome = path.join(root, 'live-home');
  const wallpaperPath = path.join(root, 'live-wallpaper.png');
  const desktopLayoutPath = path.join(userHome, RICE_LAYOUT_FILES[0].homePath);
  const shellLayoutPath = path.join(userHome, RICE_LAYOUT_FILES[1].homePath);

  try {
    fs.mkdirSync(path.dirname(desktopLayoutPath), { recursive: true });
    fs.writeFileSync(wallpaperPath, 'wallpaper');
    fs.writeFileSync(
      desktopLayoutPath,
      [
        '[Containments][1]',
        'activityId=machine-specific',
        'ItemGeometries-2560x1440=Applet-1:128,256,592,336,0;',
        'ItemGeometriesHorizontal=Applet-2:128,256,592,336,0;',
        'lastResolution=2048x1152',
        'lastScreen=0',
        'plugin=org.kde.desktopcontainment',
        '',
        '[Containments][1][Wallpaper][org.kde.image][General]',
        `Image=${wallpaperPath}`,
        `PreviewImage=${wallpaperPath}`,
        '',
        '[ScreenMapping]',
        'positions=desktop:/private.txt',
        'itemsOnDisabledScreens=desktop:/private.txt,1,machine-specific',
        'screenMapping=desktop:/private.txt,1,machine-specific',
        'lastPreset=/home/example/.config/panel-colorizer/presets/Main Setup',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      shellLayoutPath,
      '[General]\n\n[Updates]\nperformed=/usr/share/plasma/update.js\n'
    );

    captureRiceLayout({ repoRoot: root, home: userHome });

    const manifest = JSON.parse(fs.readFileSync(path.join(root, RICE_MANIFEST_PATH), 'utf8')) as {
      requirements: string;
    };
    const capturedDesktop = fs.readFileSync(
      path.join(root, RICE_LAYOUT_FILES[0].snapshotPath),
      'utf8'
    );

    expect(manifest.requirements).toBe(RICE_REQUIREMENTS_PATH);
    expect(capturedDesktop).toContain(RICE_WALLPAPER_PLACEHOLDER);
    expect(capturedDesktop).not.toContain('desktop:/private.txt');
    expect(capturedDesktop).not.toContain('/home/example');
    expect(capturedDesktop).not.toContain('ItemGeometries');
    expect(capturedDesktop).not.toContain('lastResolution');
    expect(capturedDesktop).not.toContain('lastScreen');
    expect(capturedDesktop).toContain(`PreviewImage=${RICE_WALLPAPER_PLACEHOLDER}`);
    expect(
      fs.readFileSync(path.join(root, RICE_LAYOUT_FILES[1].snapshotPath), 'utf8')
    ).not.toContain('[Updates]');
    expect(manifest).not.toHaveProperty('wallpaperSourceName');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rice check validates the requirements file contract', () => {
  const root = makeTempRiceRepo();

  try {
    fs.rmSync(path.join(root, RICE_REQUIREMENTS_PATH));

    expect(() => checkRiceSnapshot({ repoRoot: root })).toThrow(
      `Missing rice layout requirements: ${RICE_REQUIREMENTS_PATH}`
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rice check rejects non-portable wallpaper preview fields', () => {
  const root = makeTempRiceRepo();
  const desktopSnapshotPath = path.join(root, RICE_LAYOUT_FILES[0].snapshotPath);

  try {
    fs.appendFileSync(desktopSnapshotPath, '\nPreviewImage=file:///mnt/wallpaper.png\n');

    expect(() => checkRiceSnapshot({ repoRoot: root })).toThrow('file URI wallpaper path');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('capturing rice validates portability before overwriting tracked snapshots', () => {
  const root = makeTempRiceRepo();
  const userHome = path.join(root, 'live-home');
  const wallpaperPath = path.join(root, 'live-wallpaper.png');
  const desktopLayoutPath = path.join(userHome, RICE_LAYOUT_FILES[0].homePath);
  const shellLayoutPath = path.join(userHome, RICE_LAYOUT_FILES[1].homePath);
  const existingWallpaper = fs.readFileSync(path.join(root, RICE_WALLPAPER_PATH), 'utf8');
  const existingShellSnapshot = fs.readFileSync(
    path.join(root, RICE_LAYOUT_FILES[1].snapshotPath),
    'utf8'
  );

  try {
    fs.mkdirSync(path.dirname(desktopLayoutPath), { recursive: true });
    fs.writeFileSync(wallpaperPath, 'new-wallpaper');
    fs.writeFileSync(
      desktopLayoutPath,
      [
        '[Containments][1]',
        'activityId=machine-specific',
        'plugin=org.kde.desktopcontainment',
        '',
        '[Containments][1][Wallpaper][org.kde.image][General]',
        `Image=${wallpaperPath}`,
        '',
      ].join('\n')
    );
    fs.writeFileSync(shellLayoutPath, '[General]\nlastPreset=/home/example/private\n');

    expect(() => captureRiceLayout({ repoRoot: root, home: userHome })).toThrow(
      `${RICE_LAYOUT_FILES[1].snapshotPath} contains a user home path`
    );
    expect(fs.readFileSync(path.join(root, RICE_WALLPAPER_PATH), 'utf8')).toBe(existingWallpaper);
    expect(fs.readFileSync(path.join(root, RICE_LAYOUT_FILES[1].snapshotPath), 'utf8')).toBe(
      existingShellSnapshot
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('layout-only rice install does not require terminal style commands', () => {
  const root = makeTempRiceRepo();
  const commandCalls: Array<{ command: string; args: string[] }> = [];

  try {
    expect(() =>
      installRice({
        repoRoot: root,
        home: path.join(root, 'home'),
        apply: true,
        layoutOnly: true,
        hasCommand: (command) => command === 'qdbus6',
        runCommand: (command, args) => {
          commandCalls.push({ command, args });

          if (args.includes('org.kde.ActivityManager.Activities.CurrentActivity')) {
            return 'current-activity';
          }

          return '';
        },
      })
    ).not.toThrow();
    expect(commandCalls.map(({ command }) => command)).toEqual(['qdbus6', 'systemctl', 'qdbus6']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('style-only rice install does not require layout snapshots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-rice-style-test-'));
  const commandCalls: Array<{ command: string; args: string[] }> = [];

  try {
    fs.cpSync('assets', path.join(root, 'assets'), { recursive: true });
    fs.cpSync('terminal', path.join(root, 'terminal'), { recursive: true });
    fs.cpSync('desktop', path.join(root, 'desktop'), { recursive: true });

    expect(() =>
      installRice({
        repoRoot: root,
        home: path.join(root, 'home'),
        apply: true,
        withPlasmaLayout: false,
        hasCommand: () => true,
        runCommand: (command, args) => {
          commandCalls.push({ command, args });
          return '';
        },
      })
    ).not.toThrow();
    expect(commandCalls.map(({ command }) => command)).toEqual([
      'kwriteconfig6',
      'kwriteconfig6',
      'kwriteconfig6',
      'plasma-apply-colorscheme',
      'plasma-apply-desktoptheme',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('full rice install honors injected home and command runner for style and layout', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-rice-full-test-'));
  const commandCalls: Array<{ command: string; args: string[] }> = [];

  try {
    expect(() =>
      installRice({
        repoRoot: process.cwd(),
        home,
        apply: true,
        hasCommand: () => true,
        runCommand: (command, args) => {
          commandCalls.push({ command, args });

          if (args.includes('org.kde.ActivityManager.Activities.CurrentActivity')) {
            return 'current-activity';
          }

          return '';
        },
      })
    ).not.toThrow();
    const kdeglobals = path.join(home, '.config/kdeglobals');
    const plasmarc = path.join(home, '.config/plasmarc');

    expect(fs.existsSync(path.join(home, '.config/ghostty/config'))).toBe(true);
    expect(commandCalls.map(({ command }) => command)).toEqual([
      'kwriteconfig6',
      'kwriteconfig6',
      'kwriteconfig6',
      'plasma-apply-colorscheme',
      'plasma-apply-desktoptheme',
      'qdbus6',
      'systemctl',
      'qdbus6',
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
        args: ['--file', plasmarc, '--group', 'Theme', '--key', 'name', 'TyrianNight'],
      },
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Plasma layout restore has its own runtime command contract', () => {
  expect(RICE_LAYOUT_REQUIRED_COMMANDS).toEqual(['qdbus6']);
});

test('Plasma layout restore validates all source snapshots before overwriting live files', () => {
  const root = makeTempRiceRepo();
  const home = path.join(root, 'home');
  const targetDesktop = path.join(home, RICE_LAYOUT_FILES[0].homePath);

  try {
    fs.mkdirSync(path.dirname(targetDesktop), { recursive: true });
    fs.writeFileSync(targetDesktop, '[Existing]\nkeep=true\n');
    fs.rmSync(path.join(root, RICE_LAYOUT_FILES[1].snapshotPath));

    expect(() =>
      installPlasmaLayout({
        repoRoot: root,
        home,
        apply: true,
        runCommand: (command, args) => {
          if (
            command === 'qdbus6' &&
            args.includes('org.kde.ActivityManager.Activities.CurrentActivity')
          ) {
            return 'current-activity';
          }

          return '';
        },
      })
    ).toThrow(RICE_LAYOUT_FILES[1].snapshotPath);
    expect(fs.readFileSync(targetDesktop, 'utf8')).toBe('[Existing]\nkeep=true\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Plasma layout restore validates snapshot portability before overwriting live files', () => {
  const root = makeTempRiceRepo();
  const home = path.join(root, 'home');
  const targetDesktop = path.join(home, RICE_LAYOUT_FILES[0].homePath);
  const desktopSnapshotPath = path.join(root, RICE_LAYOUT_FILES[0].snapshotPath);

  try {
    fs.mkdirSync(path.dirname(targetDesktop), { recursive: true });
    fs.writeFileSync(targetDesktop, '[Existing]\nkeep=true\n');
    fs.appendFileSync(desktopSnapshotPath, '\nPreviewImage=file:///mnt/wallpaper.png\n');

    expect(() =>
      installPlasmaLayout({
        repoRoot: root,
        home,
        apply: true,
        runCommand: (command, args) => {
          if (
            command === 'qdbus6' &&
            args.includes('org.kde.ActivityManager.Activities.CurrentActivity')
          ) {
            return 'current-activity';
          }

          return '';
        },
      })
    ).toThrow('file URI wallpaper path');
    expect(fs.readFileSync(targetDesktop, 'utf8')).toBe('[Existing]\nkeep=true\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Plasma wallpaper script targets current desktops with a portable file URI', () => {
  const script = buildPlasmaWallpaperScript(
    `${FIXTURE_HOME}/.local/share/tyrian-night/assets/wallpaper-tyrian.png`
  );

  expect(script).toContain(
    `var wallpaperImage = "file://${FIXTURE_HOME}/.local/share/tyrian-night/assets/wallpaper-tyrian.png";`
  );
  expect(script).toContain('var allDesktops = desktops();');
  expect(script).toContain('desktop.wallpaperPlugin = "org.kde.image";');
  expect(script).toContain(
    'desktop.currentConfigGroup = ["Wallpaper", "org.kde.image", "General"];'
  );
  expect(script).toContain('desktop.writeConfig("Image", wallpaperImage);');
});

test('Plasma layout restore injects current activity IDs only into desktop containments', () => {
  const hydrated = hydratePlasmaDesktopActivityIds(
    [
      '[Containments][1]',
      'activityId=',
      'formfactor=0',
      'location=0',
      'plugin=org.kde.plasma.folder',
      '',
      '[Containments][2]',
      'activityId=',
      'formfactor=2',
      'location=4',
      'plugin=org.kde.panel',
      '',
      '[Containments][3]',
      'activityId=',
      'formfactor=0',
      'location=0',
      'plugin=org.kde.desktopcontainment',
      '',
    ].join('\n'),
    'current-activity'
  );

  expect(hydrated).toContain('[Containments][1]\nactivityId=current-activity');
  expect(hydrated).toContain('[Containments][2]\nactivityId=\nformfactor=2');
  expect(hydrated).toContain('[Containments][3]\nactivityId=current-activity');
});

test('capturing rice accepts live Plasma file URI wallpaper paths', () => {
  const root = makeTempRiceRepo();
  const userHome = path.join(root, 'live-home');
  const wallpaperPath = path.join(root, 'live-wallpaper.png');
  const desktopLayoutPath = path.join(userHome, RICE_LAYOUT_FILES[0].homePath);
  const shellLayoutPath = path.join(userHome, RICE_LAYOUT_FILES[1].homePath);

  try {
    fs.mkdirSync(path.dirname(desktopLayoutPath), { recursive: true });
    fs.writeFileSync(wallpaperPath, 'wallpaper');
    fs.writeFileSync(
      desktopLayoutPath,
      [
        '[Containments][1]',
        'activityId=machine-specific',
        'plugin=org.kde.plasma.folder',
        '',
        '[Containments][1][Wallpaper][org.kde.image][General]',
        `Image=${new URL(`file://${wallpaperPath}`).href}`,
        '',
      ].join('\n')
    );
    fs.writeFileSync(shellLayoutPath, '[General]\n');

    captureRiceLayout({ repoRoot: root, home: userHome });

    const capturedDesktop = fs.readFileSync(
      path.join(root, RICE_LAYOUT_FILES[0].snapshotPath),
      'utf8'
    );

    expect(fs.readFileSync(path.join(root, RICE_WALLPAPER_PATH), 'utf8')).toBe('wallpaper');
    expect(capturedDesktop).toContain(RICE_WALLPAPER_PLACEHOLDER);
    expect(capturedDesktop).not.toContain(`file://${wallpaperPath}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRiceRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-rice-test-'));

  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'rice/plasma-layout/config'), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(root, RICE_REQUIREMENTS_PATH)), { recursive: true });
  fs.writeFileSync(path.join(root, RICE_WALLPAPER_PATH), 'wallpaper');
  fs.writeFileSync(path.join(root, RICE_REQUIREMENTS_PATH), '# Requirements\n');
  fs.writeFileSync(
    path.join(root, RICE_LAYOUT_FILES[0].snapshotPath),
    [
      '[Containments][1]',
      'activityId=',
      'plugin=org.kde.desktopcontainment',
      '',
      '[Containments][1][Wallpaper][org.kde.image][General]',
      `Image=${RICE_WALLPAPER_PLACEHOLDER}`,
      '',
    ].join('\n')
  );
  fs.writeFileSync(path.join(root, RICE_LAYOUT_FILES[1].snapshotPath), '[General]\n');
  fs.writeFileSync(
    path.join(root, RICE_MANIFEST_PATH),
    `${JSON.stringify(
      {
        version: 1,
        owner: 'Tyrian Night rice',
        requirements: RICE_REQUIREMENTS_PATH,
        wallpaperAsset: RICE_WALLPAPER_PATH,
        layoutFiles: RICE_LAYOUT_FILES,
      },
      null,
      2
    )}\n`
  );

  return root;
}
