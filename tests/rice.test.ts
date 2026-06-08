import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import {
  RICE_LAYOUT_FILES,
  RICE_LAYOUT_REQUIRED_COMMANDS,
  RICE_REQUIRED_COMMANDS,
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
import { TYRIAN_REQUIRED_COMMANDS } from '../scripts/commandChecks.mjs';

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
  const shellLayout = fs.readFileSync(path.join(root, RICE_LAYOUT_FILES[1].snapshotPath), 'utf8');
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
  expect(desktopLayout).not.toMatch(/^lastScreen=.+$/mu);
  expect(desktopLayout).not.toMatch(/^positions=.+desktop:\//mu);
  expect(desktopLayout).not.toMatch(/^itemsOnDisabledScreens=.+desktop:\//mu);
  expect(desktopLayout).not.toMatch(/^screenMapping=.+desktop:\//mu);
  expect(desktopLayout).not.toMatch(/^lastPreset=\/.+$/mu);
  expect(desktopLayout).not.toMatch(/\/home\/[^/\s]+/u);
  expect(desktopLayout).not.toContain('desktop:/');
  expect(desktopLayout).toContain('org.kde.plasma.icontasks');
  expect(desktopLayout).toContain('org.kde.plasma.minimizeall');
  expect(shellLayout).not.toMatch(/^performed=\/.+$/mu);
  expect(shellLayout).not.toMatch(/^\[PlasmaViews\]\[Panel \d+\]\[Horizontal\d+\]$/mu);
  expect(shellLayout).not.toMatch(
    /^\[PlasmaViews\]\[Panel \d+\]\[Defaults\]\n(?:[^[\n].*\n?)*^(?:length|maxLength|minLength)=/mu
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
        'ItemGeometries-3840x2160=Applet-1:192,384,888,504,0;',
        'ItemGeometriesHorizontal=Applet-2:128,256,592,336,0;',
        'lastResolution=3840x2160',
        'lastScreen=0',
        'plugin=org.kde.desktopcontainment',
        '',
        '[Containments][149]',
        'formfactor=2',
        'location=4',
        'plugin=org.kde.panel',
        '',
        '[Containments][149][Applets][152]',
        'plugin=org.kde.plasma.icontasks',
        '',
        '[Containments][149][Applets][235]',
        'plugin=org.kde.plasma.minimizeall',
        '',
        '[Containments][149][Applets][206][Configuration][General]',
        'panelWidgets=[{"id":152,"name":"org.kde.plasma.icontasks"},{"id":235,"name":"org.kde.plasma.minimizeall"}]',
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

    captureRiceLayout({
      repoRoot: root,
      home: userHome,
      runCommand: (command, args) => {
        if (command === 'qdbus6' && args.includes('org.kde.PlasmaShell.evaluateScript')) {
          return '[{"id":"149","hiding":"dodgewindows","alignment":"center","lengthRatio":1,"height":42}]';
        }

        return '';
      },
    });

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
    expect(capturedDesktop).toContain('ItemGeometries-3840x2160');
    expect(capturedDesktop).toContain('lastResolution=3840x2160');
    expect(capturedDesktop).not.toContain('lastScreen');
    expect(capturedDesktop).toMatch(/\[Containments\]\[149\][\s\S]*?hiding=dodgewindows/mu);
    expect(capturedDesktop).toMatch(/\[Containments\]\[149\][\s\S]*?tyrianPanelLengthRatio=1/mu);
    expect(capturedDesktop).toContain('plugin=org.kde.plasma.icontasks');
    expect(capturedDesktop).toContain('plugin=org.kde.plasma.minimizeall');
    expect(capturedDesktop).toContain('"name":"org.kde.plasma.icontasks"');
    expect(capturedDesktop).toContain('"name":"org.kde.plasma.minimizeall"');
    expect(capturedDesktop).toContain(`PreviewImage=${RICE_WALLPAPER_PLACEHOLDER}`);
    expect(
      fs.readFileSync(path.join(root, RICE_LAYOUT_FILES[1].snapshotPath), 'utf8')
    ).not.toContain('[Updates]');
    expect(fs.readFileSync(path.join(root, RICE_LAYOUT_FILES[1].snapshotPath), 'utf8')).not.toMatch(
      /^\[PlasmaViews\]\[Panel \d+\]\[Horizontal\d+\]$/mu
    );
    expect(fs.readFileSync(path.join(root, RICE_LAYOUT_FILES[1].snapshotPath), 'utf8')).not.toMatch(
      /^\[PlasmaViews\]\[Panel \d+\]\[Defaults\]\n(?:[^[\n].*\n?)*^(?:length|maxLength|minLength)=/mu
    );
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

    expect(() =>
      captureRiceLayout({ repoRoot: root, home: userHome, runCommand: mockRiceRuntimeCommand })
    ).toThrow(`${RICE_LAYOUT_FILES[1].snapshotPath} contains a user home path`);
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
        hasCommand: (command) => command === 'qdbus6' || command === 'kscreen-doctor',
        runCommand: (command, args) => {
          commandCalls.push({ command, args });

          return mockRiceRuntimeCommand(command, args);
        },
      })
    ).not.toThrow();
    expect(commandCalls.map(({ command }) => command)).toEqual([
      'qdbus6',
      'kscreen-doctor',
      'qdbus6',
      'systemctl',
      'systemctl',
      'qdbus6',
    ]);
    expect(
      commandCalls.filter(({ command }) => command === 'systemctl').map(({ args }) => args)
    ).toEqual([
      ['--user', 'stop', 'plasma-plasmashell.service'],
      ['--user', 'start', 'plasma-plasmashell.service'],
    ]);
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

          return mockRiceRuntimeCommand(command, args);
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
      'kscreen-doctor',
      'qdbus6',
      'systemctl',
      'systemctl',
      'qdbus6',
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
  expect(RICE_LAYOUT_REQUIRED_COMMANDS).toEqual(['qdbus6', 'kscreen-doctor']);
});

test('Plasma layout restore maps captured panels to the current primary screen', () => {
  const root = makeTempRiceRepo();
  const home = path.join(root, 'home');
  const desktopSnapshotPath = path.join(root, RICE_LAYOUT_FILES[0].snapshotPath);
  const commandCalls: Array<{ command: string; args: string[] }> = [];

  try {
    fs.writeFileSync(
      desktopSnapshotPath,
      fs
        .readFileSync(desktopSnapshotPath, 'utf8')
        .replace(
          'plugin=org.kde.desktopcontainment',
          [
            'plugin=org.kde.desktopcontainment',
            'ItemGeometries-1920x1080=Applet-1:960,540,300,150,0;',
            'ItemGeometriesHorizontal=Applet-2:192,108,384,216,0;',
            'lastResolution=1920x1080',
          ].join('\n')
        )
    );
    fs.appendFileSync(
      desktopSnapshotPath,
      [
        '',
        '[Containments][148]',
        'formfactor=0',
        'location=0',
        '',
        'plugin=org.kde.plasma.folder',
        '',
        '',
        '[Containments][149]',
        'formfactor=2',
        'hiding=dodgewindows',
        'immutability=1',
        '',
        'location=4',
        'plugin=org.kde.panel',
        'tyrianPanelAlignment=center',
        'tyrianPanelHeight=42',
        'tyrianPanelLengthRatio=1',
        '',
      ].join('\n')
    );

    installPlasmaLayout({
      repoRoot: root,
      home,
      apply: true,
      runCommand: (command, args) => {
        commandCalls.push({ command, args });
        return mockRiceRuntimeCommand(command, args);
      },
    });

    const installedDesktop = fs.readFileSync(
      path.join(home, RICE_LAYOUT_FILES[0].homePath),
      'utf8'
    );
    const panelStateScript = commandCalls
      .filter(
        ({ command, args }) =>
          command === 'qdbus6' && args.includes('org.kde.PlasmaShell.evaluateScript')
      )
      .map(({ args }) => String(args.at(-1)))
      .find((script) => script.includes('panelStateById'));

    expect(installedDesktop).toMatch(/\[Containments\]\[149\][\s\S]*?lastScreen=0/mu);
    expect(installedDesktop).toMatch(/\[Containments\]\[148\][\s\S]*?lastScreen=1/mu);
    expect(installedDesktop).toContain('ItemGeometries-2560x1440=Applet-1:1280,720,400,200,0;');
    expect(installedDesktop).toContain('ItemGeometriesHorizontal=Applet-2:256,144,512,288,0;');
    expect(installedDesktop).toContain('lastResolution=2560x1440');
    expect(panelStateScript).toContain('"149"');
    expect(panelStateScript).toContain('"hiding":"dodgewindows"');
    expect(panelStateScript).toContain('panel.writeConfig("lastScreen", String(primaryScreen))');
    expect(panelStateScript).not.toContain('panel.screen = primaryScreen');

    const installedShell = fs.readFileSync(path.join(home, RICE_LAYOUT_FILES[1].homePath), 'utf8');

    expect(installedShell).toMatch(
      /^\[PlasmaViews\]\[Panel 149\]\[Defaults\]\n[\s\S]*?^length=2560$/mu
    );
    expect(installedShell).toMatch(
      /^\[PlasmaViews\]\[Panel 231\]\[Defaults\]\n[\s\S]*?^length=2560$/mu
    );
    expect(installedShell).not.toContain('[PlasmaViews][Panel 231][Horizontal2048]');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Rice runtime and live installer share the same command-policy root set', () => {
  expect(RICE_REQUIRED_COMMANDS).toEqual(TYRIAN_REQUIRED_COMMANDS);
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

    captureRiceLayout({ repoRoot: root, home: userHome, runCommand: mockRiceRuntimeCommand });

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
  fs.writeFileSync(
    path.join(root, RICE_LAYOUT_FILES[1].snapshotPath),
    [
      '[General]',
      '',
      '[PlasmaViews][Panel 149][Defaults]',
      'thickness=42',
      '',
      '[PlasmaViews][Panel 231][Defaults]',
      'thickness=30',
      '',
    ].join('\n')
  );
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

function mockRiceRuntimeCommand(command: string, args: string[]) {
  if (command === 'kscreen-doctor') {
    return [
      'Output: 1 HDMI-A-1',
      '  enabled',
      '  connected',
      '  priority 1',
      '  Geometry: 0,0 2560x1440',
      '',
    ].join('\n');
  }

  if (args.includes('org.kde.ActivityManager.Activities.CurrentActivity')) {
    return 'current-activity';
  }

  if (command === 'qdbus6' && args.includes('org.kde.PlasmaShell.evaluateScript')) {
    const script = String(args.at(-1));

    if (script.includes('screenGeometry')) {
      return [
        '[',
        '{"screen":0,"x":0,"y":0,"width":2560,"height":1440},',
        '{"screen":1,"x":2560,"y":96,"width":2048,"height":1152}',
        ']',
      ].join('\n');
    }

    return '[{"id":"149","hiding":"dodgewindows","alignment":"center","lengthRatio":1,"height":42}]';
  }

  return '';
}
