import { expect, setDefaultTimeout, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildPlasmaWallpaperScript,
  captureRiceLayout,
  checkRiceSnapshot,
  hydratePlasmaDesktopActivityIds,
  installPlasmaLayout,
  installRice,
  recoverRice,
  RICE_LAYOUT_FILES,
  RICE_LAYOUT_REQUIRED_COMMANDS,
  RICE_MANIFEST_PATH,
  RICE_REQUIREMENTS_PATH,
  RICE_WALLPAPER_PATH,
  RICE_WALLPAPER_PLACEHOLDER,
} from '../scripts/rice.mjs';

const FIXTURE_HOME = '/home/example';
setDefaultTimeout(30_000);

function resolveMutationPath(value: fs.PathLike): string {
  const requestedPath = String(value);
  return path.join(fs.realpathSync(path.dirname(requestedPath)), path.basename(requestedPath));
}

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
  expect(requirements).toContain('Application widget style: `Breeze`');
  expect(requirements).not.toContain('widgetStyle=Union');
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
        if (
          command === 'qdbus6' &&
          args.includes('org.kde.PlasmaShell.evaluateScript') &&
          String(args.at(-1)).includes('var ids = panelIds')
        ) {
          return '[{"id":"149","hiding":"dodgewindows","alignment":"center","lengthRatio":1,"height":42,"screen":0,"location":"bottom"}]';
        }

        return mockRiceRuntimeCommand(command, args);
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

test('rice capture rejects its injected home path outside standard home roots', () => {
  const root = makeTempRiceRepo();
  const userHome = path.join(root, 'alternate-capture-home');
  const wallpaperPath = path.join(root, 'live-wallpaper.png');
  const desktopPath = path.join(userHome, RICE_LAYOUT_FILES[0].homePath);
  const shellPath = path.join(userHome, RICE_LAYOUT_FILES[1].homePath);
  const originalWallpaper = fs.readFileSync(path.join(root, RICE_WALLPAPER_PATH));

  try {
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    fs.writeFileSync(wallpaperPath, 'new wallpaper');
    fs.writeFileSync(
      desktopPath,
      `[Containments][1][Wallpaper][org.kde.image][General]\nImage=${wallpaperPath}\n`
    );
    fs.writeFileSync(shellPath, `[Cache]\npath=${path.join(userHome, 'private-cache')}\n`);

    expect(() =>
      captureRiceLayout({ repoRoot: root, home: userHome, runCommand: mockRiceRuntimeCommand })
    ).toThrow('contains a user home path');
    expect(fs.readFileSync(path.join(root, RICE_WALLPAPER_PATH))).toEqual(originalWallpaper);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rice snapshot rejects root and var-home path forms', () => {
  for (const privatePath of ['/root/private', '/var/home/example/private']) {
    const root = makeTempRiceRepo();

    try {
      fs.appendFileSync(
        path.join(root, RICE_LAYOUT_FILES[1].snapshotPath),
        `\n[Private]\npath=${privatePath}\n`
      );
      expect(() => checkRiceSnapshot({ repoRoot: root })).toThrow('contains a user home path');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('rice snapshot and capture reject symlinked or wrong-type source artifacts', () => {
  const root = makeTempRiceRepo();
  const wallpaperPath = path.join(root, RICE_WALLPAPER_PATH);
  const realWallpaperPath = path.join(root, 'real-wallpaper.png');

  try {
    fs.writeFileSync(realWallpaperPath, 'wallpaper');
    fs.rmSync(wallpaperPath);
    fs.symlinkSync(realWallpaperPath, wallpaperPath);
    expect(() => checkRiceSnapshot({ repoRoot: root })).toThrow('traverses a symbolic link');

    fs.rmSync(wallpaperPath);
    fs.mkdirSync(wallpaperPath);
    expect(() => checkRiceSnapshot({ repoRoot: root })).toThrow('must be a regular file');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rice snapshot rejects symlinked source ancestors', () => {
  const root = makeTempRiceRepo();
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-rice-external-config-'));
  const configRoot = path.join(root, 'rice/plasma-layout/config');

  try {
    fs.cpSync(configRoot, externalRoot, { recursive: true });
    fs.rmSync(configRoot, { recursive: true });
    fs.symlinkSync(externalRoot, configRoot);

    expect(() => checkRiceSnapshot({ repoRoot: root })).toThrow('traverses a symbolic link');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

test('rice capture rejects a symlinked output ancestor before touching Plasma or its target', () => {
  const root = makeTempRiceRepo();
  const userHome = path.join(root, 'live-home');
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-rice-capture-output-'));
  const configRoot = path.join(root, 'rice/plasma-layout/config');
  let commandCalled = false;

  try {
    fs.rmSync(configRoot, { recursive: true });
    fs.writeFileSync(path.join(externalRoot, 'sentinel'), 'unchanged\n');
    fs.symlinkSync(externalRoot, configRoot);

    expect(() =>
      captureRiceLayout({
        repoRoot: root,
        home: userHome,
        hasCommand: () => true,
        runCommand: () => {
          commandCalled = true;
          throw new Error('must not run');
        },
      })
    ).toThrow('Rice capture destination traverses a symbolic link');
    expect(commandCalled).toBe(false);
    expect(fs.readFileSync(path.join(externalRoot, 'sentinel'), 'utf8')).toBe('unchanged\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

test('rice capture checks required commands before recovery or lifecycle work', () => {
  const root = makeTempRiceRepo();
  const userHome = path.join(root, 'live-home');
  const journalPath = path.join(root, '.tyrian-rice-capture-journal.json');
  let commandCalled = false;

  try {
    fs.writeFileSync(journalPath, '{ corrupt');

    expect(() =>
      captureRiceLayout({
        repoRoot: root,
        home: userHome,
        hasCommand: (command) => command !== 'qdbus6',
        runCommand: () => {
          commandCalled = true;
          throw new Error('must not run');
        },
      })
    ).toThrow('Missing Tyrian rice capture commands: qdbus6');
    expect(commandCalled).toBe(false);
    expect(fs.readFileSync(journalPath, 'utf8')).toBe('{ corrupt');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rice check blocks on a corrupt capture journal', () => {
  const root = makeTempRiceRepo();
  const desktopPath = path.join(root, RICE_LAYOUT_FILES[0].snapshotPath);
  const originalDesktop = fs.readFileSync(desktopPath, 'utf8');

  try {
    fs.writeFileSync(path.join(root, '.tyrian-rice-capture-journal.json'), '{ corrupt');

    expect(() => checkRiceSnapshot({ repoRoot: root })).toThrow('capture journal is corrupt');
    expect(fs.readFileSync(desktopPath, 'utf8')).toBe(originalDesktop);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rice capture recovery removes its bounded unpublished journal candidate', () => {
  const root = makeTempRiceRepo();
  const candidatePath = path.join(root, '.tyrian-rice-capture-journal.json.next');

  try {
    fs.writeFileSync(candidatePath, '{ incomplete');
    checkRiceSnapshot({ repoRoot: root });
    expect(fs.existsSync(candidatePath)).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Plasma preview preserves recovery evidence until explicit recovery', () => {
  const root = makeTempRiceRepo();
  const home = path.join(root, 'home');
  const candidatePath = path.join(home, '.local/state/tyrian-night/plasma-lifecycle.json.next');

  try {
    fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
    fs.writeFileSync(candidatePath, '{ incomplete');
    installPlasmaLayout({
      repoRoot: root,
      home,
      apply: false,
      hasCommand: () => true,
      runCommand: mockRiceRuntimeCommand,
    });
    expect(fs.existsSync(candidatePath)).toBe(true);

    recoverRice({ home, runCommand: mockRiceRuntimeCommand });
    expect(fs.existsSync(candidatePath)).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('full rice preview leaves repository and home state byte-for-byte unchanged', () => {
  const root = makeTempRiceRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-rice-preview-home-'));
  const captureCandidate = path.join(root, '.tyrian-rice-capture-journal.json.next');
  const lifecycleCandidate = path.join(
    home,
    '.local/state/tyrian-night/plasma-lifecycle.json.next'
  );

  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    fs.cpSync('terminal', path.join(root, 'terminal'), { recursive: true });
    fs.cpSync('desktop', path.join(root, 'desktop'), { recursive: true });
    fs.cpSync('assets', path.join(root, 'assets'), { recursive: true });
    fs.copyFileSync('package.json', path.join(root, 'package.json'));
    fs.mkdirSync(path.join(root, 'apps/desktop'), { recursive: true });
    fs.copyFileSync('apps/desktop/package.json', path.join(root, 'apps/desktop/package.json'));
    fs.writeFileSync(captureCandidate, '{ incomplete');
    fs.mkdirSync(path.dirname(lifecycleCandidate), { recursive: true });
    fs.writeFileSync(lifecycleCandidate, '{ incomplete');
    const repositoryBefore = snapshotTree(root);
    const homeBefore = snapshotTree(home);

    installRice({
      repoRoot: root,
      home,
      apply: false,
      link: true,
      hasCommand: () => true,
      runCommand: mockRiceRuntimeCommand,
    });

    expect(snapshotTree(root)).toEqual(repositoryBefore);
    expect(snapshotTree(home)).toEqual(homeBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('rice capture publishes allocating ownership before transaction artifacts', () => {
  const root = makeTempRiceRepo();
  const userHome = path.join(root, 'capture-home');
  const wallpaperPath = path.join(root, 'live-wallpaper.png');
  const desktopPath = path.join(userHome, RICE_LAYOUT_FILES[0].homePath);
  const shellPath = path.join(userHome, RICE_LAYOUT_FILES[1].homePath);
  const journalPath = path.join(root, '.tyrian-rice-capture-journal.json');
  const originalMkdir = fs.mkdirSync;
  let ownershipObserved = false;

  try {
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    fs.writeFileSync(wallpaperPath, 'wallpaper\n');
    fs.writeFileSync(
      desktopPath,
      `[Containments][1][Wallpaper][org.kde.image][General]\nImage=${wallpaperPath}\n`
    );
    fs.writeFileSync(shellPath, '[General]\n');
    fs.mkdirSync = ((directoryPath: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      const physicalPath = resolveMutationPath(directoryPath);

      if (
        !ownershipObserved &&
        path.dirname(physicalPath) === root &&
        path.basename(physicalPath).startsWith('.tyrian-rice-capture-transaction-')
      ) {
        ownershipObserved = true;
        expect(JSON.parse(fs.readFileSync(journalPath, 'utf8'))).toMatchObject({
          version: 3,
          phase: 'allocating',
        });
        throw new Error('injected capture allocation failure');
      }

      return originalMkdir(directoryPath, options as fs.MakeDirectoryOptions);
    }) as typeof fs.mkdirSync;

    expect(() =>
      captureRiceLayout({
        repoRoot: root,
        home: userHome,
        hasCommand: () => true,
        runCommand: mockRiceRuntimeCommand,
      })
    ).toThrow('injected capture allocation failure');
    expect(ownershipObserved).toBe(true);
    expect(fs.existsSync(journalPath)).toBe(false);
  } finally {
    fs.mkdirSync = originalMkdir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rice capture recovers an interrupted publication from its fixed journal', () => {
  const root = makeTempRiceRepo();
  const userHome = path.join(root, 'capture-home');
  const liveWallpaper = path.join(root, 'live-wallpaper.png');
  const desktopPath = path.join(userHome, RICE_LAYOUT_FILES[0].homePath);
  const shellPath = path.join(userHome, RICE_LAYOUT_FILES[1].homePath);
  const originalWallpaper = fs.readFileSync(path.join(root, RICE_WALLPAPER_PATH), 'utf8');
  const originalDesktop = fs.readFileSync(
    path.join(root, RICE_LAYOUT_FILES[0].snapshotPath),
    'utf8'
  );

  try {
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    fs.writeFileSync(liveWallpaper, 'new wallpaper');
    fs.writeFileSync(
      desktopPath,
      `[Containments][1][Wallpaper][org.kde.image][General]\nImage=${liveWallpaper}\n`
    );
    fs.writeFileSync(shellPath, '[General]\n');
    expect(() =>
      captureRiceLayout({
        repoRoot: root,
        home: userHome,
        runCommand: mockRiceRuntimeCommand,
        testInterruptPublicationAfter: 2,
      })
    ).toThrow('Simulated interruption');
    const journalPath = path.join(root, '.tyrian-rice-capture-journal.json');
    expect(fs.existsSync(journalPath)).toBe(true);
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    const alreadyRestored = journal.entries[0];
    fs.copyFileSync(
      path.join(root, alreadyRestored.backupPath),
      path.join(root, alreadyRestored.targetPath)
    );

    checkRiceSnapshot({ repoRoot: root });

    expect(fs.readFileSync(path.join(root, RICE_WALLPAPER_PATH), 'utf8')).toBe(originalWallpaper);
    expect(fs.readFileSync(path.join(root, RICE_LAYOUT_FILES[0].snapshotPath), 'utf8')).toBe(
      originalDesktop
    );
    expect(fs.existsSync(path.join(root, '.tyrian-rice-capture-journal.json'))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rice capture recovery refuses a newly symlinked output ancestor', () => {
  const root = makeTempRiceRepo();
  const userHome = path.join(root, 'capture-home');
  const liveWallpaper = path.join(root, 'live-wallpaper.png');
  const desktopPath = path.join(userHome, RICE_LAYOUT_FILES[0].homePath);
  const shellPath = path.join(userHome, RICE_LAYOUT_FILES[1].homePath);
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-rice-recovery-output-'));
  const configRoot = path.join(root, 'rice/plasma-layout/config');

  try {
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    fs.writeFileSync(liveWallpaper, 'new wallpaper');
    fs.writeFileSync(
      desktopPath,
      `[Containments][1][Wallpaper][org.kde.image][General]\nImage=${liveWallpaper}\n`
    );
    fs.writeFileSync(shellPath, '[General]\n');

    expect(() =>
      captureRiceLayout({
        repoRoot: root,
        home: userHome,
        hasCommand: () => true,
        runCommand: mockRiceRuntimeCommand,
        testInterruptPublicationAfter: 1,
      })
    ).toThrow('Simulated interruption during rice capture publication');

    fs.rmSync(configRoot, { recursive: true });
    fs.writeFileSync(path.join(externalRoot, 'sentinel'), 'unchanged\n');
    fs.symlinkSync(externalRoot, configRoot);

    expect(() => checkRiceSnapshot({ repoRoot: root })).toThrow(
      'Rice capture recovery traverses a symbolic link'
    );
    expect(fs.readFileSync(path.join(externalRoot, 'sentinel'), 'utf8')).toBe('unchanged\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

test('rice capture recovery preserves a post-interruption external generation', () => {
  const root = makeTempRiceRepo();
  const userHome = path.join(root, 'capture-home');
  const liveWallpaper = path.join(root, 'live-wallpaper.png');
  const desktopPath = path.join(userHome, RICE_LAYOUT_FILES[0].homePath);
  const shellPath = path.join(userHome, RICE_LAYOUT_FILES[1].homePath);
  const publishedWallpaper = path.join(root, RICE_WALLPAPER_PATH);
  const journalPath = path.join(root, '.tyrian-rice-capture-journal.json');

  try {
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    fs.writeFileSync(liveWallpaper, 'captured wallpaper');
    fs.writeFileSync(
      desktopPath,
      `[Containments][1][Wallpaper][org.kde.image][General]\nImage=${liveWallpaper}\n`
    );
    fs.writeFileSync(shellPath, '[General]\n');

    expect(() =>
      captureRiceLayout({
        repoRoot: root,
        home: userHome,
        hasCommand: () => true,
        runCommand: mockRiceRuntimeCommand,
        testInterruptPublicationAfter: 1,
      })
    ).toThrow('Simulated interruption during rice capture publication');

    fs.writeFileSync(publishedWallpaper, 'external generation');
    expect(() => checkRiceSnapshot({ repoRoot: root })).toThrow(
      'Rice capture recovery could not safely restore every target'
    );
    expect(fs.readFileSync(publishedWallpaper, 'utf8')).toBe('external generation');
    expect(fs.existsSync(journalPath)).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent rice captures wait for the live token owner', async () => {
  const root = makeTempRiceRepo();
  const userHome = path.join(root, 'capture-home');
  const liveWallpaper = path.join(root, 'live-wallpaper.png');
  const desktopPath = path.join(userHome, RICE_LAYOUT_FILES[0].homePath);
  const shellPath = path.join(userHome, RICE_LAYOUT_FILES[1].homePath);
  const ownerPath = path.join(root, '.tyrian-rice-capture.lock');
  let holder: ReturnType<typeof Bun.spawn> | undefined;

  try {
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    fs.writeFileSync(liveWallpaper, 'new wallpaper');
    fs.writeFileSync(
      desktopPath,
      `[Containments][1][Wallpaper][org.kde.image][General]\nImage=${liveWallpaper}\n`
    );
    fs.writeFileSync(shellPath, '[General]\n');

    holder = Bun.spawn({
      cmd: [
        process.execPath,
        '-e',
        [
          "const module = await import('./scripts/installOps.mjs');",
          'module.withTokenFileLock(process.env.CAPTURE_LOCK, () => {',
          'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);',
          '}, { ownerRoot: process.env.OWNER_ROOT });',
        ].join(' '),
      ],
      env: { ...process.env, CAPTURE_LOCK: ownerPath, OWNER_ROOT: root },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    const readyDeadline = Date.now() + 1_000;

    while (!fs.existsSync(ownerPath) && Date.now() < readyDeadline) {
      await Bun.sleep(5);
    }

    expect(fs.existsSync(ownerPath)).toBe(true);
    const startedAt = Date.now();
    captureRiceLayout({ repoRoot: root, home: userHome, runCommand: mockRiceRuntimeCommand });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    await holder.exited;
  } finally {
    holder?.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('layout-only rice rejects repository runtime aliases before mutation', () => {
  const root = makeTempRiceRepo();
  const alias = path.join(os.tmpdir(), `tyrian-rice-layout-alias-${process.pid}`);

  try {
    fs.rmSync(alias, { force: true });
    fs.symlinkSync(root, alias);

    expect(() =>
      installRice({
        repoRoot: alias,
        home: root,
        apply: false,
        layoutOnly: true,
        link: true,
      })
    ).toThrow('layout runtime root must not overlap');
    expect(fs.existsSync(path.join(root, '.tyrian-rice-capture.lock'))).toBe(false);
  } finally {
    fs.rmSync(alias, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('layout-only rice install does not require terminal style commands', () => {
  const root = makeTempRiceRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-rice-layout-home-'));
  const commandCalls: Array<{ command: string; args: string[] }> = [];

  try {
    expect(() =>
      installRice({
        repoRoot: root,
        home,
        apply: true,
        layoutOnly: true,
        hasCommand: (command) =>
          command === 'qdbus6' || command === 'kscreen-doctor' || command === 'systemctl',
        runCommand: (command, args) => {
          commandCalls.push({ command, args });

          return mockRiceRuntimeCommand(command, args);
        },
      })
    ).not.toThrow();
    expect(commandCalls.map(({ command }) => command)).toEqual([
      'systemctl',
      'qdbus6',
      'kscreen-doctor',
      'qdbus6',
      'qdbus6',
      'qdbus6',
      'systemctl',
      'systemctl',
      'systemctl',
      'systemctl',
      'qdbus6',
      'qdbus6',
      'qdbus6',
      'qdbus6',
    ]);
    expect(
      commandCalls.filter(({ command }) => command === 'systemctl').map(({ args }) => args)
    ).toEqual([
      ['--user', 'is-active', '--quiet', 'plasma-plasmashell.service'],
      ['--user', 'stop', 'plasma-plasmashell.service'],
      ['--user', 'is-active', '--quiet', 'plasma-plasmashell.service'],
      ['--user', 'start', 'plasma-plasmashell.service'],
      ['--user', 'is-active', '--quiet', 'plasma-plasmashell.service'],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('layout-only rice interruption has one reported outer transaction and no inner backup', () => {
  const root = makeTempRiceRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-rice-layout-only-owner-'));
  const transactionPath = path.join(
    home,
    '.local/state/tyrian-night/live-install-transaction.json'
  );
  const backupRoot = path.join(home, '.local/state/tyrian-night/backups');

  try {
    mockPlasmaShellActive = true;
    expect(() =>
      installRice({
        repoRoot: root,
        home,
        apply: true,
        layoutOnly: true,
        hasCommand: () => true,
        runCommand: mockRiceRuntimeCommand,
        testInterruptAfterStop: true,
      })
    ).toThrow('Simulated interruption while the Plasma shell is stopped');

    expect(JSON.parse(fs.readFileSync(transactionPath, 'utf8'))).toMatchObject({
      owner: 'rice',
      phase: 'prepared',
    });
    expect(fs.readdirSync(backupRoot)).toHaveLength(1);
    expect(fs.readdirSync(backupRoot)[0]).toStartWith('rice-full-apply-');

    installRice({
      repoRoot: root,
      home,
      apply: false,
      layoutOnly: true,
      withPlasmaLayout: false,
      runCommand: mockRiceRuntimeCommand,
    });
    expect(fs.existsSync(transactionPath)).toBe(true);

    recoverRice({ home, runCommand: mockRiceRuntimeCommand });
    expect(fs.existsSync(transactionPath)).toBe(false);
  } finally {
    mockPlasmaShellActive = true;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('style-only rice install does not require layout snapshots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-rice-style-test-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-rice-style-home-'));
  const commandCalls: Array<{ command: string; args: string[] }> = [];

  try {
    fs.cpSync('assets', path.join(root, 'assets'), { recursive: true });
    fs.cpSync('terminal', path.join(root, 'terminal'), { recursive: true });
    fs.cpSync('desktop', path.join(root, 'desktop'), { recursive: true });
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });

    expect(() =>
      installRice({
        repoRoot: root,
        home,
        apply: true,
        withPlasmaLayout: false,
        hasCommand: () => true,
        runCommand: (command, args) => {
          commandCalls.push({ command, args });
          return '';
        },
      })
    ).not.toThrow();
    expect(commandCalls).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('style-only rice applies the Plasma profile without touching Hyprland or Caelestia', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-rice-xdg-home-'));
  const environment = {
    XDG_CONFIG_HOME: path.join(home, 'xdg/config'),
    XDG_DATA_HOME: path.join(home, 'xdg/data'),
    XDG_STATE_HOME: path.join(home, 'xdg/state'),
  };
  const hyprlandConfig = path.join(environment.XDG_CONFIG_HOME, 'hypr/hyprland.lua');

  try {
    fs.mkdirSync(path.dirname(hyprlandConfig), { recursive: true });
    fs.writeFileSync(hyprlandConfig, 'user Hyprland config\n');

    installRice({
      repoRoot: process.cwd(),
      home,
      apply: true,
      withPlasmaLayout: false,
      environment,
    });

    expect(fs.readFileSync(hyprlandConfig, 'utf8')).toBe('user Hyprland config\n');
    expect(fs.existsSync(path.join(environment.XDG_CONFIG_HOME, 'kdeglobals'))).toBe(true);
    expect(fs.existsSync(path.join(environment.XDG_CONFIG_HOME, 'hypr/scheme/current.lua'))).toBe(
      false
    );
    expect(fs.existsSync(path.join(environment.XDG_STATE_HOME, 'caelestia/scheme.json'))).toBe(
      false
    );
    expect(
      fs.existsSync(path.join(environment.XDG_DATA_HOME, 'caelestia/fastfetch/config.jsonc'))
    ).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
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
    expect(fs.existsSync(path.join(home, '.config/foot/foot.ini'))).toBe(true);
    expect(commandCalls.map(({ command }) => command)).toEqual([
      'systemctl',
      'qdbus6',
      'kscreen-doctor',
      'qdbus6',
      'qdbus6',
      'qdbus6',
      'systemctl',
      'systemctl',
      'systemctl',
      'systemctl',
      'qdbus6',
      'qdbus6',
      'qdbus6',
      'qdbus6',
    ]);
    expect(fs.readFileSync(kdeglobals, 'utf8')).toContain('widgetStyle=Breeze');
    expect(fs.readFileSync(plasmarc, 'utf8')).toContain('name=TyrianNight');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('full rice validates layout runtime before mutating style files', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-rice-preflight-'));
  const ghosttyConfig = path.join(home, '.config/ghostty/config');

  try {
    fs.mkdirSync(path.dirname(ghosttyConfig), { recursive: true });
    fs.writeFileSync(ghosttyConfig, 'keep=true\n');

    expect(() =>
      installRice({
        repoRoot: process.cwd(),
        home,
        apply: true,
        hasCommand: () => true,
        runCommand: (command, args) => {
          if (args.includes('org.kde.ActivityManager.Activities.CurrentActivity')) {
            throw new Error('Plasma activity unavailable');
          }

          return mockRiceRuntimeCommand(command, args);
        },
      })
    ).toThrow('Plasma activity unavailable');
    expect(fs.readFileSync(ghosttyConfig, 'utf8')).toBe('keep=true\n');
    expect(fs.existsSync(path.join(home, '.local/share/tyrian-night'))).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Plasma layout restore has its own runtime command contract', () => {
  expect(RICE_LAYOUT_REQUIRED_COMMANDS).toEqual(['qdbus6', 'kscreen-doctor', 'systemctl']);
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
    expect(panelStateScript).toContain('"location":"bottom"');
    expect(panelStateScript).toContain('panel.location = state.location');
    expect(panelStateScript).toContain('panel.writeConfig("lastScreen", String(targetScreen))');
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

test('Plasma qdbus JSON parsing ignores bracketed warning prefixes', () => {
  const root = makeTempRiceRepo();
  const home = path.join(root, 'home');

  try {
    expect(() =>
      installPlasmaLayout({
        repoRoot: root,
        home,
        apply: true,
        runCommand: (command, args) => {
          const output = mockRiceRuntimeCommand(command, args);

          if (command === 'qdbus6' && args.includes('org.kde.PlasmaShell.evaluateScript')) {
            return `[warning] Plasma printed a diagnostic before JSON\n${output}`;
          }

          return output;
        },
      })
    ).not.toThrow();
    expect(fs.existsSync(path.join(home, RICE_LAYOUT_FILES[0].homePath))).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Plasma layout restore rejects an unmapped primary screen before mutation', () => {
  const root = makeTempRiceRepo();
  const home = path.join(root, 'home');
  const targetDesktop = path.join(home, RICE_LAYOUT_FILES[0].homePath);

  try {
    expect(() =>
      installPlasmaLayout({
        repoRoot: root,
        home,
        apply: true,
        runCommand: (command, args) => {
          if (
            command === 'qdbus6' &&
            args.includes('org.kde.PlasmaShell.evaluateScript') &&
            String(args.at(-1)).includes('screenGeometry')
          ) {
            return '[]';
          }

          return mockRiceRuntimeCommand(command, args);
        },
      })
    ).toThrow('Could not read Plasma screen geometries');
    expect(fs.existsSync(targetDesktop)).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test('Plasma layout restore rejects an inactive shell without starting it', () => {
  const root = makeTempRiceRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-rice-inactive-home-'));
  const commandCalls: Array<{ command: string; args: string[] }> = [];

  try {
    expect(() =>
      installPlasmaLayout({
        repoRoot: root,
        home,
        apply: true,
        runCommand: (command, args) => {
          commandCalls.push({ command, args });

          if (command === 'systemctl' && args.includes('is-active')) {
            throw new Error('inactive');
          }

          return mockRiceRuntimeCommand(command, args);
        },
      })
    ).toThrow('requires an active plasma-plasmashell.service');
    expect(commandCalls).toEqual([
      {
        command: 'systemctl',
        args: ['--user', 'is-active', '--quiet', 'plasma-plasmashell.service'],
      },
    ]);
    expect(fs.existsSync(path.join(home, RICE_LAYOUT_FILES[0].homePath))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Plasma session mutation rejects another home without an injected runner', () => {
  const root = makeTempRiceRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-rice-other-home-'));

  try {
    expect(() => installPlasmaLayout({ repoRoot: root, home, apply: true })).toThrow(
      'cannot mutate the current Plasma session for another home'
    );
    expect(fs.existsSync(path.join(root, '.tyrian-rice-capture.lock'))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('standalone layout rejects physical symlink and wrong-type ancestors before mutation', () => {
  for (const ancestorType of ['symlink', 'file'] as const) {
    const root = makeTempRiceRepo();
    const home = path.join(root, `home-${ancestorType}`);
    const external = path.join(root, `external-${ancestorType}`);
    const configPath = path.join(home, '.config');

    try {
      fs.mkdirSync(home, { recursive: true });

      if (ancestorType === 'symlink') {
        fs.mkdirSync(external, { recursive: true });
        fs.symlinkSync(external, configPath);
      } else {
        fs.writeFileSync(configPath, 'not a directory\n');
      }

      expect(() =>
        installPlasmaLayout({
          repoRoot: root,
          home,
          apply: true,
          runCommand: mockRiceRuntimeCommand,
        })
      ).toThrow(
        ancestorType === 'symlink' ? 'traverses a symbolic link' : 'non-directory ancestor'
      );
      expect(fs.existsSync(path.join(external, 'plasma-org.kde.plasma.desktop-appletsrc'))).toBe(
        false
      );
      expect(
        fs.existsSync(path.join(home, '.local/state/tyrian-night/live-install-transaction.json'))
      ).toBe(false);
      expect(
        fs.existsSync(path.join(home, '.local/state/tyrian-night/plasma-lifecycle.json'))
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('standalone layout interruption is recovered by its reported persisted transaction', () => {
  const root = makeTempRiceRepo();
  const home = path.join(root, 'home');
  const desktopPath = path.join(home, RICE_LAYOUT_FILES[0].homePath);
  const shellPath = path.join(home, RICE_LAYOUT_FILES[1].homePath);
  const transactionPath = path.join(
    home,
    '.local/state/tyrian-night/live-install-transaction.json'
  );
  const lifecyclePath = path.join(home, '.local/state/tyrian-night/plasma-lifecycle.json');
  const logs: string[] = [];
  const originalLog = console.log;

  try {
    mockPlasmaShellActive = true;
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    fs.writeFileSync(desktopPath, 'original desktop\n');
    fs.writeFileSync(shellPath, 'original shell\n');

    expect(() =>
      installPlasmaLayout({
        repoRoot: root,
        home,
        apply: true,
        hasCommand: () => true,
        runCommand: mockRiceRuntimeCommand,
        testInterruptAfterStop: true,
      })
    ).toThrow('Simulated interruption while the Plasma shell is stopped');

    const transaction = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
    const lifecycle = JSON.parse(fs.readFileSync(lifecyclePath, 'utf8'));
    expect(transaction).toMatchObject({ owner: 'layout', phase: 'prepared' });
    expect(transaction.backupRoot).toContain('rice-layout-apply-');
    expect(lifecycle).toMatchObject({
      version: 3,
      owner: 'layout',
      phase: 'prepared',
      previousPanels: expect.arrayContaining([expect.objectContaining({ id: '149' })]),
    });

    console.log = (message) => logs.push(String(message));
    expect(() =>
      installPlasmaLayout({
        repoRoot: root,
        home,
        apply: true,
        hasCommand: (command) => command !== 'qdbus6',
        runCommand: mockRiceRuntimeCommand,
      })
    ).toThrow('Missing Plasma layout install commands: qdbus6');

    expect(fs.readFileSync(desktopPath, 'utf8')).toBe('original desktop\n');
    expect(fs.readFileSync(shellPath, 'utf8')).toBe('original shell\n');
    expect(fs.existsSync(transactionPath)).toBe(false);
    expect(fs.existsSync(lifecyclePath)).toBe(false);
    expect(mockPlasmaShellActive).toBe(true);
    expect(logs).toContain('Recovered prior rice transaction: rolledBack');
  } finally {
    console.log = originalLog;
    mockPlasmaShellActive = true;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Plasma layout restore requires a stopped shell before replacing files', () => {
  const root = makeTempRiceRepo();
  const home = path.join(root, 'home');
  const targetDesktop = path.join(home, RICE_LAYOUT_FILES[0].homePath);
  const targetShell = path.join(home, RICE_LAYOUT_FILES[1].homePath);
  let stopCalls = 0;

  try {
    fs.mkdirSync(path.dirname(targetDesktop), { recursive: true });
    fs.writeFileSync(targetDesktop, 'desktop=original\n');
    fs.writeFileSync(targetShell, 'shell=original\n');

    expect(() =>
      installPlasmaLayout({
        repoRoot: root,
        home,
        apply: true,
        runCommand: (command, args) => {
          if (command === 'systemctl' && args.includes('stop') && stopCalls++ === 0) {
            throw new Error('stop failed');
          }

          return mockRiceRuntimeCommand(command, args);
        },
      })
    ).toThrow('stop failed');
    expect(fs.readFileSync(targetDesktop, 'utf8')).toBe('desktop=original\n');
    expect(fs.readFileSync(targetShell, 'utf8')).toBe('shell=original\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Plasma layout restore rolls back committed files and restarts after replacement failure', () => {
  const root = makeTempRiceRepo();
  const home = path.join(root, 'home');
  const targetDesktop = path.join(home, RICE_LAYOUT_FILES[0].homePath);
  const targetShell = path.join(home, RICE_LAYOUT_FILES[1].homePath);
  const commandCalls: Array<{ command: string; args: string[] }> = [];

  try {
    fs.mkdirSync(path.dirname(targetDesktop), { recursive: true });
    fs.writeFileSync(targetDesktop, 'desktop=original\n');
    fs.writeFileSync(targetShell, 'shell=original\n');
    const originalRename = fs.renameSync;
    let replacementFailureInjected = false;
    fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (!replacementFailureInjected && resolveMutationPath(newPath) === targetShell) {
        replacementFailureInjected = true;
        throw new Error('injected layout replacement failure');
      }

      return originalRename(oldPath, newPath);
    }) as typeof fs.renameSync;

    try {
      expect(() =>
        installPlasmaLayout({
          repoRoot: root,
          home,
          apply: true,
          hasCommand: () => true,
          runCommand: (command, args) => {
            commandCalls.push({ command, args });
            return mockRiceRuntimeCommand(command, args);
          },
        })
      ).toThrow('injected layout replacement failure');
    } finally {
      fs.renameSync = originalRename;
    }
    expect(replacementFailureInjected).toBe(true);
    expect(fs.readFileSync(targetDesktop, 'utf8')).toBe('desktop=original\n');
    expect(fs.readFileSync(targetShell, 'utf8')).toBe('shell=original\n');
    expect(commandCalls).toContainEqual({
      command: 'systemctl',
      args: ['--user', 'start', 'plasma-plasmashell.service'],
    });
    expect(
      fs.readdirSync(path.dirname(targetDesktop)).some((name) => name.includes('.tyrian-'))
    ).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Plasma layout restart failure restores files and restarts the previous layout', () => {
  const root = makeTempRiceRepo();
  const home = path.join(root, 'home');
  const targetDesktop = path.join(home, RICE_LAYOUT_FILES[0].homePath);
  const targetShell = path.join(home, RICE_LAYOUT_FILES[1].homePath);
  let startCalls = 0;

  try {
    fs.mkdirSync(path.dirname(targetDesktop), { recursive: true });
    fs.writeFileSync(targetDesktop, 'desktop=original\n');
    fs.writeFileSync(targetShell, 'shell=original\n');

    expect(() =>
      installPlasmaLayout({
        repoRoot: root,
        home,
        apply: true,
        runCommand: (command, args) => {
          if (command === 'systemctl' && args.includes('start') && startCalls++ === 0) {
            throw new Error('initial restart failed');
          }

          return mockRiceRuntimeCommand(command, args);
        },
      })
    ).toThrow('initial restart failed');
    expect(startCalls).toBe(2);
    expect(fs.readFileSync(targetDesktop, 'utf8')).toBe('desktop=original\n');
    expect(fs.readFileSync(targetShell, 'utf8')).toBe('shell=original\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Plasma rollback restores the prior image and non-image wallpaper plugin', () => {
  const root = makeTempRiceRepo();
  const home = path.join(root, 'home');
  const targetDesktop = path.join(home, RICE_LAYOUT_FILES[0].homePath);
  const targetShell = path.join(home, RICE_LAYOUT_FILES[1].homePath);
  const previousWallpaper = path.join(home, 'previous-wallpaper.png');
  const wallpaperScripts: string[] = [];
  const runtime = makeStatefulPlasmaRuntime(previousWallpaper);

  try {
    runtime.state.wallpaperPlugin = 'org.kde.slideshow';
    fs.mkdirSync(path.dirname(targetDesktop), { recursive: true });
    fs.writeFileSync(previousWallpaper, 'previous wallpaper');
    fs.writeFileSync(
      targetDesktop,
      `[Containments][1][Wallpaper][org.kde.image][General]\nImage=${previousWallpaper}\n`
    );
    fs.writeFileSync(targetShell, 'shell=original\n');
    const originalDesktop = fs.readFileSync(targetDesktop, 'utf8');

    expect(() =>
      installPlasmaLayout({
        repoRoot: root,
        home,
        apply: true,
        runCommand: (command, args) => {
          const script = String(args.at(-1));

          if (
            command === 'qdbus6' &&
            (script.includes('var wallpaperImage') || script.includes('var wallpaperState ='))
          ) {
            wallpaperScripts.push(script);

            if (script.includes('var wallpaperImage')) {
              runtime.runCommand(command, args);
              throw new Error('wallpaper qdbus failed');
            }
          }

          return runtime.runCommand(command, args);
        },
      })
    ).toThrow('wallpaper qdbus failed');
    expect(fs.readFileSync(targetDesktop, 'utf8')).toBe(originalDesktop);
    expect(fs.readFileSync(targetShell, 'utf8')).toBe('shell=original\n');
    expect(wallpaperScripts).toHaveLength(2);
    expect(wallpaperScripts[1]).toContain(previousWallpaper);
    expect(wallpaperScripts[1]).toContain('org.kde.slideshow');
    expect(runtime.state.wallpaperPath).toBe(previousWallpaper);
    expect(runtime.state.wallpaperPlugin).toBe('org.kde.slideshow');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Plasma layout rejects a desired image when the wallpaper plugin remains wrong', () => {
  const root = makeTempRiceRepo();
  const home = path.join(root, 'home');
  const targetDesktop = path.join(home, RICE_LAYOUT_FILES[0].homePath);
  const targetShell = path.join(home, RICE_LAYOUT_FILES[1].homePath);
  const previousWallpaper = path.join(home, 'previous-wallpaper.png');
  const lifecyclePath = path.join(home, '.local/state/tyrian-night/plasma-lifecycle.json');
  const runtime = makeStatefulPlasmaRuntime(previousWallpaper);
  let ignoredPluginMutations = 0;

  try {
    runtime.state.wallpaperPlugin = 'org.kde.slideshow';
    fs.mkdirSync(path.dirname(targetDesktop), { recursive: true });
    fs.writeFileSync(previousWallpaper, 'previous wallpaper');
    fs.writeFileSync(
      targetDesktop,
      `[Containments][1][Wallpaper][org.kde.image][General]\nImage=${previousWallpaper}\n`
    );
    fs.writeFileSync(targetShell, 'shell=original\n');

    expect(() =>
      installPlasmaLayout({
        repoRoot: root,
        home,
        apply: true,
        runCommand: (command, args) => {
          const script = String(args.at(-1));

          if (command === 'qdbus6' && script.includes('var wallpaperImage')) {
            ignoredPluginMutations += 1;
            runtime.state.wallpaperPath = JSON.parse(
              script.match(/^var wallpaperImage = (.+);$/mu)?.[1] ?? '""'
            );
            return '';
          }

          return runtime.runCommand(command, args);
        },
      })
    ).toThrow('wallpaper runtime state did not match the requested wallpaper');
    expect(ignoredPluginMutations).toBe(1);
    expect(runtime.state.wallpaperPath).toBe(previousWallpaper);
    expect(runtime.state.wallpaperPlugin).toBe('org.kde.slideshow');
    expect(fs.existsSync(lifecyclePath)).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Plasma layout rejects a successful panel mutation no-op before runtimeApplied', () => {
  const root = makeTempRiceRepo();
  const home = path.join(root, 'home');
  const desktopPath = path.join(home, RICE_LAYOUT_FILES[0].homePath);
  const shellPath = path.join(home, RICE_LAYOUT_FILES[1].homePath);
  let panelMutations = 0;

  try {
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    fs.writeFileSync(desktopPath, 'original desktop\n');
    fs.writeFileSync(shellPath, 'original shell\n');

    expect(() =>
      installPlasmaLayout({
        repoRoot: root,
        home,
        apply: true,
        runCommand: (command, args) => {
          const script = String(args.at(-1));

          if (command === 'qdbus6' && script.includes('var panelStateById')) {
            panelMutations += 1;

            if (panelMutations === 1) {
              return '{"requested":["149"],"updated":[],"missing":[]}';
            }
          }

          return mockRiceRuntimeCommand(command, args);
        },
      })
    ).toThrow('did not update every requested panel');
    expect(panelMutations).toBe(2);
    expect(fs.readFileSync(desktopPath, 'utf8')).toBe('original desktop\n');
    expect(fs.readFileSync(shellPath, 'utf8')).toBe('original shell\n');
    expect(fs.existsSync(path.join(home, '.local/state/tyrian-night/plasma-lifecycle.json'))).toBe(
      false
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Plasma layout removes a stale extra panel and proves the exact owned generation', () => {
  const root = makeTempRiceRepo();
  const home = path.join(root, 'home');

  try {
    mockExtraPanelRuntime = {
      id: '999',
      alignment: 'left',
      height: 24,
      hiding: 'autohide',
      lengthRatio: 0.5,
      location: 'left',
      screen: 1,
    };

    expect(() =>
      installPlasmaLayout({
        repoRoot: root,
        home,
        apply: true,
        runCommand: mockRiceRuntimeCommand,
      })
    ).not.toThrow();
    expect(mockExtraPanelRuntime).toBeUndefined();
  } finally {
    mockExtraPanelRuntime = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Plasma layout owns an empty panel generation and removes every stale panel', () => {
  const root = makeTempRiceRepo();
  const home = path.join(root, 'home');
  const snapshotPath = path.join(root, RICE_LAYOUT_FILES[0].snapshotPath);
  let runtimePanels = [
    {
      id: '999',
      alignment: 'left',
      height: 24,
      hiding: 'autohide',
      lengthRatio: 0.5,
      location: 'left',
      screen: 1,
    },
  ];
  let panelMutations = 0;

  try {
    fs.writeFileSync(
      snapshotPath,
      fs
        .readFileSync(snapshotPath, 'utf8')
        .replace(/\[Containments\]\[(?:149|231)\]\n(?:(?!^\[).*\n?)*/gmu, '')
    );

    expect(() =>
      installPlasmaLayout({
        repoRoot: root,
        home,
        apply: true,
        runCommand: (command, args) => {
          const script = String(args.at(-1));

          if (command === 'qdbus6' && script.includes('var ids = panelIds')) {
            return JSON.stringify(runtimePanels);
          }

          if (command === 'qdbus6' && script.includes('var panelStateById')) {
            const desired = JSON.parse(script.match(/^var panelStateById = (.+);$/mu)?.[1] ?? '{}');
            panelMutations += 1;
            runtimePanels = Object.entries(desired).map(([id, state]) => ({
              id,
              ...(state as (typeof runtimePanels)[number]),
            }));
            const requested = Object.keys(desired);
            return JSON.stringify({ requested, updated: requested, missing: [] });
          }

          return mockRiceRuntimeCommand(command, args);
        },
      })
    ).not.toThrow();
    expect(panelMutations).toBe(1);
    expect(runtimePanels).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('full rice rolls back a successful style install when layout restore fails', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-rice-style-rollback-'));
  const ghosttyConfig = path.join(home, '.config/ghostty/config');
  let layoutStopCalls = 0;

  try {
    fs.mkdirSync(path.dirname(ghosttyConfig), { recursive: true });
    fs.writeFileSync(ghosttyConfig, 'original style\n');

    expect(() =>
      installRice({
        repoRoot: process.cwd(),
        home,
        apply: true,
        hasCommand: () => true,
        runCommand: (command, args) => {
          if (command === 'systemctl' && args.includes('stop') && layoutStopCalls++ === 0) {
            throw new Error('layout stop failed');
          }

          return mockRiceRuntimeCommand(command, args);
        },
      })
    ).toThrow('layout stop failed');
    expect(fs.readFileSync(ghosttyConfig, 'utf8')).toBe('original style\n');
    expect(fs.existsSync(path.join(home, '.local/share/tyrian-night'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.config/foot/foot.ini'))).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('full rice recovery is explicit after interruption between style and layout', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-rice-gap-recovery-'));
  const ghosttyConfig = path.join(home, '.config/ghostty/config');
  const transactionPath = path.join(
    home,
    '.local/state/tyrian-night/live-install-transaction.json'
  );

  try {
    mockPlasmaShellActive = true;
    fs.mkdirSync(path.dirname(ghosttyConfig), { recursive: true });
    fs.writeFileSync(ghosttyConfig, 'original style\n');

    expect(() =>
      installRice({
        repoRoot: process.cwd(),
        home,
        apply: true,
        hasCommand: () => true,
        runCommand: mockRiceRuntimeCommand,
        testInterruptAfterStyle: true,
      })
    ).toThrow('Simulated interruption between rice style and layout');
    expect(fs.existsSync(transactionPath)).toBe(true);
    expect(fs.readFileSync(ghosttyConfig, 'utf8')).not.toBe('original style\n');

    installRice({
      repoRoot: process.cwd(),
      home,
      apply: false,
      withPlasmaLayout: false,
      runCommand: mockRiceRuntimeCommand,
    });

    expect(fs.readFileSync(ghosttyConfig, 'utf8')).not.toBe('original style\n');
    expect(fs.existsSync(transactionPath)).toBe(true);

    recoverRice({ home, runCommand: mockRiceRuntimeCommand });

    expect(fs.readFileSync(ghosttyConfig, 'utf8')).toBe('original style\n');
    expect(fs.existsSync(path.join(home, '.local/share/tyrian-night'))).toBe(false);
    expect(fs.existsSync(transactionPath)).toBe(false);
  } finally {
    mockPlasmaShellActive = true;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('full rice restores files before restarting a shell interrupted during layout', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-rice-layout-recovery-'));
  const ghosttyConfig = path.join(home, '.config/ghostty/config');
  const desktopPath = path.join(home, RICE_LAYOUT_FILES[0].homePath);
  const shellPath = path.join(home, RICE_LAYOUT_FILES[1].homePath);
  const transactionPath = path.join(
    home,
    '.local/state/tyrian-night/live-install-transaction.json'
  );
  const lifecyclePath = path.join(home, '.local/state/tyrian-night/plasma-lifecycle.json');

  try {
    mockPlasmaShellActive = true;
    fs.mkdirSync(path.dirname(ghosttyConfig), { recursive: true });
    fs.writeFileSync(ghosttyConfig, 'original style\n');
    fs.writeFileSync(desktopPath, 'original desktop\n');
    fs.writeFileSync(shellPath, 'original shell\n');

    expect(() =>
      installRice({
        repoRoot: process.cwd(),
        home,
        apply: true,
        hasCommand: () => true,
        runCommand: mockRiceRuntimeCommand,
        testInterruptAfterStop: true,
      })
    ).toThrow('Simulated interruption while the Plasma shell is stopped');
    expect(mockPlasmaShellActive).toBe(false);
    expect(fs.existsSync(transactionPath)).toBe(true);
    expect(fs.existsSync(lifecyclePath)).toBe(true);

    installRice({
      repoRoot: process.cwd(),
      home,
      apply: false,
      withPlasmaLayout: false,
      runCommand: (command, args) => {
        if (command === 'systemctl' && args.includes('start')) {
          expect(fs.readFileSync(ghosttyConfig, 'utf8')).toBe('original style\n');
          expect(fs.readFileSync(desktopPath, 'utf8')).toBe('original desktop\n');
          expect(fs.readFileSync(shellPath, 'utf8')).toBe('original shell\n');
        }

        return mockRiceRuntimeCommand(command, args);
      },
    });

    expect(mockPlasmaShellActive).toBe(false);
    expect(fs.existsSync(transactionPath)).toBe(true);
    expect(fs.existsSync(lifecyclePath)).toBe(true);

    recoverRice({
      home,
      runCommand: (command, args) => {
        if (command === 'systemctl' && args.includes('start')) {
          expect(fs.readFileSync(ghosttyConfig, 'utf8')).toBe('original style\n');
          expect(fs.readFileSync(desktopPath, 'utf8')).toBe('original desktop\n');
          expect(fs.readFileSync(shellPath, 'utf8')).toBe('original shell\n');
        }

        return mockRiceRuntimeCommand(command, args);
      },
    });

    expect(mockPlasmaShellActive).toBe(true);
    expect(fs.existsSync(transactionPath)).toBe(false);
    expect(fs.existsSync(lifecyclePath)).toBe(false);
    expect(fs.existsSync(path.join(home, '.local/share/tyrian-night'))).toBe(false);
  } finally {
    mockPlasmaShellActive = true;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('full rice crash after runtime mutation restores persisted panels and wallpaper', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-rice-runtime-recovery-'));
  const ghosttyConfig = path.join(home, '.config/ghostty/config');
  const desktopPath = path.join(home, RICE_LAYOUT_FILES[0].homePath);
  const shellPath = path.join(home, RICE_LAYOUT_FILES[1].homePath);
  const previousWallpaper = path.join(home, 'previous-wallpaper.png');
  const transactionPath = path.join(
    home,
    '.local/state/tyrian-night/live-install-transaction.json'
  );
  const lifecyclePath = path.join(home, '.local/state/tyrian-night/plasma-lifecycle.json');
  const runtime = makeStatefulPlasmaRuntime(previousWallpaper);

  try {
    fs.mkdirSync(path.dirname(ghosttyConfig), { recursive: true });
    fs.writeFileSync(ghosttyConfig, 'original style\n');
    fs.writeFileSync(previousWallpaper, 'previous wallpaper\n');
    fs.writeFileSync(
      desktopPath,
      `[Containments][1][Wallpaper][org.kde.image][General]\nImage=${previousWallpaper}\n`
    );
    fs.writeFileSync(shellPath, 'original shell\n');

    expect(() =>
      installRice({
        repoRoot: process.cwd(),
        home,
        apply: true,
        hasCommand: () => true,
        runCommand: runtime.runCommand,
        testInterruptAfterRuntime: true,
      })
    ).toThrow('Simulated interruption after applying Plasma runtime state');
    expect(runtime.state.alignment).toBe('center');
    expect(runtime.state.wallpaperPath).toContain('wallpaper-tyrian.png');
    expect(JSON.parse(fs.readFileSync(transactionPath, 'utf8')).phase).toBe('prepared');
    expect(JSON.parse(fs.readFileSync(lifecyclePath, 'utf8'))).toMatchObject({
      phase: 'runtimeApplied',
      previousWallpapers: [
        expect.objectContaining({
          image: previousWallpaper,
          wallpaperPlugin: 'org.kde.image',
        }),
      ],
      previousPanels: expect.arrayContaining([
        expect.objectContaining({ alignment: 'right', id: '149' }),
      ]),
    });

    installRice({
      repoRoot: process.cwd(),
      home,
      apply: false,
      withPlasmaLayout: false,
      runCommand: runtime.runCommand,
    });

    expect(fs.readFileSync(ghosttyConfig, 'utf8')).not.toBe('original style\n');
    expect(fs.existsSync(transactionPath)).toBe(true);
    expect(fs.existsSync(lifecyclePath)).toBe(true);

    recoverRice({ home, runCommand: runtime.runCommand });

    expect(fs.readFileSync(ghosttyConfig, 'utf8')).toBe('original style\n');
    expect(runtime.state.alignment).toBe('right');
    expect(runtime.state.wallpaperPath).toBe(previousWallpaper);
    expect(fs.existsSync(transactionPath)).toBe(false);
    expect(fs.existsSync(lifecyclePath)).toBe(false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('committed cleanup failure warns, preserves rice success, and closes on next recovery', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-rice-commit-recovery-'));
  const desktopPath = path.join(home, RICE_LAYOUT_FILES[0].homePath);
  const shellPath = path.join(home, RICE_LAYOUT_FILES[1].homePath);
  const previousWallpaper = path.join(home, 'previous-wallpaper.png');
  const transactionPath = path.join(
    home,
    '.local/state/tyrian-night/live-install-transaction.json'
  );
  const lifecyclePath = path.join(home, '.local/state/tyrian-night/plasma-lifecycle.json');
  const runtime = makeStatefulPlasmaRuntime(previousWallpaper);
  const warnings: string[] = [];
  const originalWarn = console.warn;

  try {
    console.warn = (message) => warnings.push(String(message));
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    fs.writeFileSync(previousWallpaper, 'previous wallpaper\n');
    fs.writeFileSync(
      desktopPath,
      `[Containments][1][Wallpaper][org.kde.image][General]\nImage=${previousWallpaper}\n`
    );
    fs.writeFileSync(shellPath, 'original shell\n');

    expect(() =>
      installRice({
        repoRoot: process.cwd(),
        home,
        apply: true,
        hasCommand: () => true,
        runCommand: runtime.runCommand,
        testInterruptAfterCommit: true,
      })
    ).not.toThrow();
    expect(warnings).toContainEqual(
      expect.stringContaining('Committed rice finalization was deferred')
    );
    expect(JSON.parse(fs.readFileSync(transactionPath, 'utf8')).phase).toBe('committed');
    expect(JSON.parse(fs.readFileSync(lifecyclePath, 'utf8'))).toMatchObject({
      phase: 'runtimeApplied',
      desiredPanels: expect.arrayContaining([
        expect.objectContaining({ id: '149', location: 'bottom', screen: 0 }),
        expect.objectContaining({ id: '231', location: 'top', screen: 0 }),
      ]),
      desiredWallpapers: [
        expect.objectContaining({
          image: expect.stringContaining('wallpaper-tyrian.png'),
          wallpaperPlugin: 'org.kde.image',
        }),
      ],
    });
    expect(runtime.state.alignment).toBe('center');
    expect(runtime.state.wallpaperPath).toContain('wallpaper-tyrian.png');

    runtime.state.active = false;
    runtime.state.alignment = 'right';
    runtime.state.secondAlignment = 'left';
    runtime.state.wallpaperPath = 'file:///tmp/committed-runtime-drift.png';

    expect(() =>
      recoverRice({
        home,
        runCommand: runtime.runCommand,
        testInterruptAfterFilesystem: true,
      })
    ).toThrow('Simulated interruption during the committed filesystem handoff');
    expect(JSON.parse(fs.readFileSync(transactionPath, 'utf8')).phase).toBe('committed');
    expect(JSON.parse(fs.readFileSync(lifecyclePath, 'utf8')).phase).toBe('runtimeApplied');

    recoverRice({ home, runCommand: runtime.runCommand });

    expect(runtime.state.alignment).toBe('center');
    expect(runtime.state.secondAlignment).toBe('center');
    expect(runtime.state.wallpaperPath).toContain('wallpaper-tyrian.png');
    expect(runtime.state.active).toBe(true);
    expect(fs.existsSync(path.join(home, '.config/ghostty/config'))).toBe(true);
    expect(fs.existsSync(transactionPath)).toBe(false);
    expect(fs.existsSync(lifecyclePath)).toBe(false);
  } finally {
    console.warn = originalWarn;
    fs.rmSync(home, { recursive: true, force: true });
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

test('rice capture maps semantic panel locations only at the KConfig boundary', () => {
  const root = makeTempRiceRepo();
  const userHome = path.join(root, 'live-home');
  const wallpaperPath = path.join(root, 'live-wallpaper.png');
  const desktopLayoutPath = path.join(userHome, RICE_LAYOUT_FILES[0].homePath);
  const shellLayoutPath = path.join(userHome, RICE_LAYOUT_FILES[1].homePath);
  const originalPanelRuntime = mockPanelRuntime;

  try {
    fs.mkdirSync(path.dirname(desktopLayoutPath), { recursive: true });
    fs.writeFileSync(wallpaperPath, 'wallpaper');
    fs.writeFileSync(
      desktopLayoutPath,
      [
        '[Containments][1]',
        'plugin=org.kde.plasma.folder',
        '',
        '[Containments][149]',
        'formfactor=2',
        'location=4',
        'plugin=org.kde.panel',
        '',
        '[Containments][1][Wallpaper][org.kde.image][General]',
        `Image=${wallpaperPath}`,
        '',
      ].join('\n')
    );
    fs.writeFileSync(shellLayoutPath, '[General]\n');
    mockPanelRuntime = { ...mockPanelRuntime, location: 'top' };

    captureRiceLayout({ repoRoot: root, home: userHome, runCommand: mockRiceRuntimeCommand });

    const capturedDesktop = fs.readFileSync(
      path.join(root, RICE_LAYOUT_FILES[0].snapshotPath),
      'utf8'
    );
    expect(capturedDesktop).toMatch(/\[Containments\]\[149\][\s\S]*\nlocation=3\n/u);
  } finally {
    mockPanelRuntime = originalPanelRuntime;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rice capture freezes files under the shell lifecycle and restores active state', () => {
  const root = makeTempRiceRepo();
  const userHome = path.join(root, 'live-home');
  const wallpaperPath = path.join(root, 'live-wallpaper.png');
  const desktopPath = path.join(userHome, RICE_LAYOUT_FILES[0].homePath);
  const shellPath = path.join(userHome, RICE_LAYOUT_FILES[1].homePath);
  const lifecycle: string[] = [];

  try {
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    fs.writeFileSync(wallpaperPath, 'wallpaper');
    fs.writeFileSync(
      desktopPath,
      `[Containments][1][Wallpaper][org.kde.image][General]\nImage=${wallpaperPath}\n`
    );
    fs.writeFileSync(shellPath, '[General]\n');

    captureRiceLayout({
      repoRoot: root,
      home: userHome,
      runCommand: (command, args) => {
        if (command === 'systemctl') {
          lifecycle.push(String(args[1]));
        }

        return mockRiceRuntimeCommand(command, args);
      },
    });

    expect(lifecycle).toEqual([
      'is-active',
      'stop',
      'is-active',
      'is-active',
      'start',
      'is-active',
      'is-active',
    ]);
    expect(fs.existsSync(path.join(root, '.tyrian-rice-capture-journal.json'))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Plasma lifecycle flushes its first-created parent chain before stopping the shell', () => {
  const root = makeTempRiceRepo();
  const userHome = path.join(root, 'live-home');
  const wallpaperPath = path.join(root, 'live-wallpaper.png');
  const desktopPath = path.join(userHome, RICE_LAYOUT_FILES[0].homePath);
  const shellPath = path.join(userHome, RICE_LAYOUT_FILES[1].homePath);
  const syncedDirectories = new Set<string>();
  const originalFsync = fs.fsyncSync;

  try {
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    fs.writeFileSync(wallpaperPath, 'wallpaper');
    fs.writeFileSync(
      desktopPath,
      `[Containments][1][Wallpaper][org.kde.image][General]\nImage=${wallpaperPath}\n`
    );
    fs.writeFileSync(shellPath, '[General]\n');
    fs.fsyncSync = (descriptor) => {
      const descriptorPath = fs.readlinkSync(`/proc/self/fd/${descriptor}`);

      if (fs.statSync(descriptorPath).isDirectory()) {
        syncedDirectories.add(fs.realpathSync(descriptorPath));
      }

      originalFsync(descriptor);
    };

    captureRiceLayout({
      repoRoot: root,
      home: userHome,
      runCommand: (command, args) => {
        if (command === 'systemctl' && args.includes('stop')) {
          for (const relativeDirectory of ['.local', '.local/state', '.local/state/tyrian-night']) {
            expect(syncedDirectories).toContain(
              fs.realpathSync(path.join(userHome, relativeDirectory))
            );
          }
        }

        return mockRiceRuntimeCommand(command, args);
      },
    });
  } finally {
    fs.fsyncSync = originalFsync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('capture interruption persists and recovers exact panel placement and wallpaper', () => {
  const root = makeTempRiceRepo();
  const userHome = path.join(root, 'live-home');
  const wallpaperPath = path.join(root, 'live-wallpaper.png');
  const desktopPath = path.join(userHome, RICE_LAYOUT_FILES[0].homePath);
  const shellPath = path.join(userHome, RICE_LAYOUT_FILES[1].homePath);
  const lifecyclePath = path.join(userHome, '.local/state/tyrian-night/plasma-lifecycle.json');

  try {
    mockPlasmaShellActive = true;
    mockPanelRuntime = { ...mockPanelRuntime, location: 'right', screen: 1 };
    mockWallpaperRuntime = wallpaperPath;
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    fs.writeFileSync(wallpaperPath, 'wallpaper');
    fs.writeFileSync(
      desktopPath,
      `[Containments][1][Wallpaper][org.kde.image][General]\nImage=${wallpaperPath}\n`
    );
    fs.writeFileSync(shellPath, '[General]\n');

    expect(() =>
      captureRiceLayout({
        repoRoot: root,
        home: userHome,
        runCommand: mockRiceRuntimeCommand,
        testInterruptAfterStop: true,
      })
    ).toThrow('Simulated interruption while the Plasma shell is stopped');
    expect(mockPlasmaShellActive).toBe(false);
    expect(JSON.parse(fs.readFileSync(lifecyclePath, 'utf8'))).toMatchObject({
      previousPanels: expect.arrayContaining([
        expect.objectContaining({ id: '149', location: 'right', screen: 1 }),
      ]),
      previousWallpapers: [
        expect.objectContaining({
          image: wallpaperPath,
          screen: 0,
          wallpaperPlugin: 'org.kde.image',
        }),
      ],
    });

    captureRiceLayout({
      repoRoot: root,
      home: userHome,
      runCommand: mockRiceRuntimeCommand,
    });

    expect(mockPlasmaShellActive).toBe(true);
    expect(fs.existsSync(lifecyclePath)).toBe(false);
  } finally {
    mockPlasmaShellActive = true;
    mockPanelRuntime = { ...mockPanelRuntime, location: 'bottom', screen: 0 };
    mockWallpaperRuntime = 'file:///tmp/tyrian-mock-wallpaper.png';
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('capture crash before restart proof reconciles panels from its persisted pre-state', () => {
  const root = makeTempRiceRepo();
  const userHome = path.join(root, 'live-home');
  const wallpaperPath = path.join(root, 'live-wallpaper.png');
  const desktopPath = path.join(userHome, RICE_LAYOUT_FILES[0].homePath);
  const shellPath = path.join(userHome, RICE_LAYOUT_FILES[1].homePath);
  const lifecyclePath = path.join(userHome, '.local/state/tyrian-night/plasma-lifecycle.json');
  const runtime = makeStatefulPlasmaRuntime(wallpaperPath);
  runtime.state.alignment = 'center';

  try {
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    fs.writeFileSync(wallpaperPath, 'wallpaper');
    fs.writeFileSync(
      desktopPath,
      [
        '[Containments][149]',
        'formfactor=2',
        'location=4',
        'plugin=org.kde.panel',
        '',
        '[Containments][1][Wallpaper][org.kde.image][General]',
        `Image=${wallpaperPath}`,
        '',
      ].join('\n')
    );
    fs.writeFileSync(shellPath, '[General]\n');

    expect(() =>
      captureRiceLayout({
        repoRoot: root,
        home: userHome,
        testInterruptAfterRestart: true,
        runCommand: (command, args) => {
          const result = runtime.runCommand(command, args);

          if (command === 'systemctl' && args.includes('start')) {
            runtime.state.alignment = 'right';
          }

          return result;
        },
      })
    ).toThrow('Simulated interruption before proving the restarted Plasma state');
    expect(runtime.state.alignment).toBe('right');
    expect(JSON.parse(fs.readFileSync(lifecyclePath, 'utf8'))).toMatchObject({
      owner: 'capture',
      phase: 'prepared',
      previousPanels: expect.arrayContaining([
        expect.objectContaining({ alignment: 'center', id: '149' }),
      ]),
    });

    captureRiceLayout({
      repoRoot: root,
      home: userHome,
      runCommand: runtime.runCommand,
    });

    expect(runtime.state.alignment).toBe('center');
    expect(fs.existsSync(lifecyclePath)).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rice capture rejects an inactive shell without starting it', () => {
  const root = makeTempRiceRepo();
  const userHome = path.join(root, 'live-home');
  const desktopPath = path.join(userHome, RICE_LAYOUT_FILES[0].homePath);
  const commandCalls: Array<{ command: string; args: string[] }> = [];

  try {
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    fs.writeFileSync(desktopPath, '[General]\n');

    expect(() =>
      captureRiceLayout({
        repoRoot: root,
        home: userHome,
        runCommand: (command, args) => {
          commandCalls.push({ command, args });
          throw new Error('inactive');
        },
      })
    ).toThrow('requires an active plasma-plasmashell.service');
    expect(commandCalls).toHaveLength(1);
    expect(commandCalls[0]?.args).toEqual([
      '--user',
      'is-active',
      '--quiet',
      'plasma-plasmashell.service',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rice capture rejects a panel generation change while freezing files', () => {
  const root = makeTempRiceRepo();
  const userHome = path.join(root, 'live-home');
  const wallpaperPath = path.join(root, 'live-wallpaper.png');
  const desktopPath = path.join(userHome, RICE_LAYOUT_FILES[0].homePath);
  const shellPath = path.join(userHome, RICE_LAYOUT_FILES[1].homePath);
  const lifecycle: string[] = [];

  try {
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    fs.writeFileSync(wallpaperPath, 'wallpaper');
    fs.writeFileSync(
      desktopPath,
      [
        '[Containments][149]',
        'formfactor=2',
        'location=4',
        'plugin=org.kde.panel',
        '',
        '[Containments][1][Wallpaper][org.kde.image][General]',
        `Image=${wallpaperPath}`,
        '',
      ].join('\n')
    );
    fs.writeFileSync(shellPath, '[General]\n');

    expect(() =>
      captureRiceLayout({
        repoRoot: root,
        home: userHome,
        runCommand: (command, args) => {
          if (command === 'systemctl') {
            lifecycle.push(String(args[1]));

            if (args.includes('stop')) {
              fs.writeFileSync(
                desktopPath,
                fs
                  .readFileSync(desktopPath, 'utf8')
                  .replace('[Containments][149]', '[Containments][231]')
              );
            }
          }

          return mockRiceRuntimeCommand(command, args);
        },
      })
    ).toThrow('panel generation changed');
    expect(lifecycle).toEqual([
      'is-active',
      'stop',
      'is-active',
      'is-active',
      'start',
      'is-active',
      'is-active',
    ]);
    expect(fs.readFileSync(path.join(root, RICE_WALLPAPER_PATH), 'utf8')).toBe('wallpaper');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rice capture rejects non-ID runtime state drift after shell restart', () => {
  const root = makeTempRiceRepo();
  const userHome = path.join(root, 'live-home');
  const wallpaperPath = path.join(root, 'live-wallpaper.png');
  const desktopPath = path.join(userHome, RICE_LAYOUT_FILES[0].homePath);
  const shellPath = path.join(userHome, RICE_LAYOUT_FILES[1].homePath);
  const originalSnapshot = fs.readFileSync(
    path.join(root, RICE_LAYOUT_FILES[0].snapshotPath),
    'utf8'
  );
  let panelQueries = 0;
  let reconciliationScripts = 0;
  let panelAlignment = 'center';

  try {
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    fs.writeFileSync(wallpaperPath, 'wallpaper');
    fs.writeFileSync(
      desktopPath,
      [
        '[Containments][149]',
        'formfactor=2',
        'location=4',
        'plugin=org.kde.panel',
        '',
        '[Containments][1][Wallpaper][org.kde.image][General]',
        `Image=${wallpaperPath}`,
        '',
      ].join('\n')
    );
    fs.writeFileSync(shellPath, '[General]\n');

    expect(() =>
      captureRiceLayout({
        repoRoot: root,
        home: userHome,
        runCommand: (command, args) => {
          const script = String(args.at(-1));

          if (command === 'qdbus6' && script.includes('var ids = panelIds')) {
            panelQueries += 1;
            return JSON.stringify([
              {
                id: '149',
                hiding: 'dodgewindows',
                alignment: panelQueries === 2 ? 'right' : panelAlignment,
                lengthRatio: 1,
                height: 42,
                screen: 0,
                location: 'bottom',
              },
            ]);
          }

          if (command === 'qdbus6' && script.includes('var panelStateById')) {
            reconciliationScripts += 1;
            panelAlignment = 'center';
            return '{"requested":["149"],"updated":["149"],"missing":[]}';
          }

          return mockRiceRuntimeCommand(command, args);
        },
      })
    ).toThrow('runtime state changed across the capture shell round-trip');
    expect(panelQueries).toBe(3);
    expect(reconciliationScripts).toBe(1);
    expect(panelAlignment).toBe('center');
    expect(fs.readFileSync(path.join(root, RICE_LAYOUT_FILES[0].snapshotPath), 'utf8')).toBe(
      originalSnapshot
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rice capture reconciles and rereads wallpaper drift before deleting its lifecycle', () => {
  const root = makeTempRiceRepo();
  const userHome = path.join(root, 'live-home');
  const wallpaperPath = path.join(root, 'live-wallpaper.png');
  const desktopPath = path.join(userHome, RICE_LAYOUT_FILES[0].homePath);
  const shellPath = path.join(userHome, RICE_LAYOUT_FILES[1].homePath);
  const lifecyclePath = path.join(userHome, '.local/state/tyrian-night/plasma-lifecycle.json');
  const originalSnapshot = fs.readFileSync(
    path.join(root, RICE_LAYOUT_FILES[0].snapshotPath),
    'utf8'
  );
  const runtime = makeStatefulPlasmaRuntime(wallpaperPath);

  try {
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    fs.writeFileSync(wallpaperPath, 'wallpaper');
    fs.writeFileSync(
      desktopPath,
      `[Containments][1][Wallpaper][org.kde.image][General]\nImage=${wallpaperPath}\n`
    );
    fs.writeFileSync(shellPath, '[General]\n');

    expect(() =>
      captureRiceLayout({
        repoRoot: root,
        home: userHome,
        runCommand: (command, args) => {
          const result = runtime.runCommand(command, args);

          if (command === 'systemctl' && args.includes('start')) {
            runtime.state.wallpaperPath = 'file:///tmp/drifted-wallpaper.png';
          }

          return result;
        },
      })
    ).toThrow('wallpaper runtime state changed across the capture shell round-trip');
    expect(runtime.state.wallpaperPath).toBe(wallpaperPath);
    expect(fs.existsSync(lifecyclePath)).toBe(false);
    expect(fs.readFileSync(path.join(root, RICE_LAYOUT_FILES[0].snapshotPath), 'utf8')).toBe(
      originalSnapshot
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rice capture detects and reconciles wallpaper-plugin-only drift', () => {
  const root = makeTempRiceRepo();
  const userHome = path.join(root, 'live-home');
  const wallpaperPath = path.join(root, 'live-wallpaper.png');
  const desktopPath = path.join(userHome, RICE_LAYOUT_FILES[0].homePath);
  const shellPath = path.join(userHome, RICE_LAYOUT_FILES[1].homePath);
  const lifecyclePath = path.join(userHome, '.local/state/tyrian-night/plasma-lifecycle.json');
  const originalSnapshot = fs.readFileSync(
    path.join(root, RICE_LAYOUT_FILES[0].snapshotPath),
    'utf8'
  );
  const runtime = makeStatefulPlasmaRuntime(wallpaperPath);

  try {
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    fs.writeFileSync(wallpaperPath, 'wallpaper');
    fs.writeFileSync(
      desktopPath,
      `[Containments][1][Wallpaper][org.kde.image][General]\nImage=${wallpaperPath}\n`
    );
    fs.writeFileSync(shellPath, '[General]\n');

    expect(() =>
      captureRiceLayout({
        repoRoot: root,
        home: userHome,
        runCommand: (command, args) => {
          const result = runtime.runCommand(command, args);

          if (command === 'systemctl' && args.includes('start')) {
            runtime.state.wallpaperPlugin = 'org.kde.slideshow';
          }

          return result;
        },
      })
    ).toThrow('wallpaper runtime state changed across the capture shell round-trip');
    expect(runtime.state.wallpaperPath).toBe(wallpaperPath);
    expect(runtime.state.wallpaperPlugin).toBe('org.kde.image');
    expect(fs.existsSync(lifecyclePath)).toBe(false);
    expect(fs.readFileSync(path.join(root, RICE_LAYOUT_FILES[0].snapshotPath), 'utf8')).toBe(
      originalSnapshot
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rice capture refuses to publish a panel layout without runtime state', () => {
  const root = makeTempRiceRepo();
  const userHome = path.join(root, 'live-home');
  const wallpaperPath = path.join(root, 'live-wallpaper.png');
  const desktopPath = path.join(userHome, RICE_LAYOUT_FILES[0].homePath);
  const shellPath = path.join(userHome, RICE_LAYOUT_FILES[1].homePath);
  const originalSnapshot = fs.readFileSync(
    path.join(root, RICE_LAYOUT_FILES[0].snapshotPath),
    'utf8'
  );

  try {
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    fs.writeFileSync(wallpaperPath, 'new wallpaper');
    fs.writeFileSync(
      desktopPath,
      [
        '[Containments][149]',
        'formfactor=2',
        'location=4',
        'plugin=org.kde.panel',
        '',
        '[Containments][1][Wallpaper][org.kde.image][General]',
        `Image=${wallpaperPath}`,
        '',
      ].join('\n')
    );
    fs.writeFileSync(shellPath, '[General]\n');

    expect(() =>
      captureRiceLayout({
        repoRoot: root,
        home: userHome,
        runCommand: (command) => {
          if (command === 'qdbus6') {
            throw new Error('qdbus failed');
          }

          return '';
        },
      })
    ).toThrow('qdbus failed');
    expect(() =>
      captureRiceLayout({
        repoRoot: root,
        home: userHome,
        runCommand: () =>
          '[{"id":"149","hiding":"dodgewindows","alignment":"center","lengthRatio":null,"height":42}]',
      })
    ).toThrow('Could not parse live Plasma panel runtime state');
    expect(() =>
      captureRiceLayout({
        repoRoot: root,
        home: userHome,
        runCommand: () =>
          '[{"id":"149","hiding":"undefined","alignment":"center","lengthRatio":1,"height":42}]',
      })
    ).toThrow('Could not parse live Plasma panel runtime state');
    expect(fs.readFileSync(path.join(root, RICE_LAYOUT_FILES[0].snapshotPath), 'utf8')).toBe(
      originalSnapshot
    );
    expect(fs.readFileSync(path.join(root, RICE_WALLPAPER_PATH), 'utf8')).toBe('wallpaper');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRiceRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-rice-test-'));

  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'home'));
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
      '[Containments][149]',
      'formfactor=2',
      'location=4',
      'plugin=org.kde.panel',
      'hiding=dodgewindows',
      'tyrianPanelAlignment=center',
      'tyrianPanelHeight=42',
      'tyrianPanelLengthRatio=1',
      '',
      '[Containments][231]',
      'formfactor=2',
      'location=3',
      'plugin=org.kde.panel',
      'hiding=dodgewindows',
      'tyrianPanelAlignment=center',
      'tyrianPanelHeight=30',
      'tyrianPanelLengthRatio=1',
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

let mockPlasmaShellActive = true;
let mockPanelRuntime = {
  alignment: 'center',
  height: 42,
  hiding: 'dodgewindows',
  lengthRatio: 1,
  location: 'bottom',
  screen: 0,
};
let mockSecondPanelRuntime = {
  alignment: 'center',
  height: 30,
  hiding: 'dodgewindows',
  lengthRatio: 1,
  location: 'top',
  screen: 0,
};
let mockExtraPanelRuntime: ({ id: string } & typeof mockPanelRuntime) | undefined;
let mockWallpaperRuntime = 'file:///tmp/tyrian-mock-wallpaper.png';
let mockWallpaperPluginRuntime = 'org.kde.image';

function makeStatefulPlasmaRuntime(previousWallpaperPath: string) {
  const state = {
    active: true,
    alignment: 'right',
    location: 'bottom',
    screen: 0,
    secondAlignment: 'left',
    secondLocation: 'top',
    secondScreen: 1,
    wallpaperPath: previousWallpaperPath,
    wallpaperPlugin: 'org.kde.image',
  };

  return {
    state,
    runCommand(command: string, args: string[]) {
      if (command === 'systemctl') {
        if (args.includes('is-active')) {
          if (!state.active) {
            throw new Error('inactive');
          }

          return '';
        }

        if (args.includes('stop')) {
          state.active = false;
          return '';
        }

        if (args.includes('start')) {
          state.active = true;
          return '';
        }
      }

      if (command === 'qdbus6' && args.includes('org.kde.PlasmaShell.evaluateScript')) {
        const script = String(args.at(-1));

        if (script.includes('var ids = panelIds')) {
          return JSON.stringify([
            {
              id: '149',
              hiding: 'dodgewindows',
              alignment: state.alignment,
              lengthRatio: 1,
              height: 42,
              location: state.location,
              screen: state.screen,
            },
            {
              id: '231',
              hiding: 'dodgewindows',
              alignment: state.secondAlignment,
              lengthRatio: 1,
              height: 30,
              location: state.secondLocation,
              screen: state.secondScreen,
            },
          ]);
        }

        if (script.includes('var panelStateById')) {
          const panelState = JSON.parse(
            script.match(/^var panelStateById = (.+);$/mu)?.[1] ?? '{}'
          );
          const requested = Object.keys(panelState);
          const target = panelState['149'];

          if (target) {
            state.alignment = target.alignment;
            state.location = target.location;
            state.screen = target.screen;
          }

          const secondTarget = panelState['231'];

          if (secondTarget) {
            state.secondAlignment = secondTarget.alignment;
            state.secondLocation = secondTarget.location;
            state.secondScreen = secondTarget.screen;
          }

          return JSON.stringify({ requested, updated: requested, missing: [] });
        }

        if (script.includes('var wallpaperState =')) {
          const wallpaperState = JSON.parse(
            script.match(/^var wallpaperState = (.+);$/mu)?.[1] ?? '[]'
          );
          state.wallpaperPath = wallpaperState[0]?.image ?? state.wallpaperPath;
          state.wallpaperPlugin = wallpaperState[0]?.wallpaperPlugin ?? state.wallpaperPlugin;
          return JSON.stringify({
            requested: wallpaperState.length,
            updated: wallpaperState.length,
          });
        }

        if (script.includes('var wallpaperImage')) {
          state.wallpaperPath = JSON.parse(
            script.match(/^var wallpaperImage = (.+);$/mu)?.[1] ?? '""'
          );
          state.wallpaperPlugin = 'org.kde.image';
          return '';
        }

        if (script.includes('var wallpaperStates')) {
          return JSON.stringify([
            {
              activityId: 'current-activity',
              screen: 0,
              image: state.wallpaperPath,
              wallpaperPlugin: state.wallpaperPlugin,
            },
          ]);
        }
      }

      return mockRiceRuntimeCommand(command, args);
    },
  };
}

function snapshotTree(root: string): Array<[string, string]> {
  const snapshot: Array<[string, string]> = [];

  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath);

      if (entry.isDirectory()) {
        snapshot.push([relativePath, 'directory']);
        visit(absolutePath);
      } else if (entry.isSymbolicLink()) {
        snapshot.push([relativePath, `symlink:${fs.readlinkSync(absolutePath)}`]);
      } else {
        snapshot.push([relativePath, `file:${fs.readFileSync(absolutePath).toString('base64')}`]);
      }
    }
  };

  visit(root);
  return snapshot;
}

function mockRiceRuntimeCommand(command: string, args: string[]) {
  if (command === 'systemctl') {
    if (args.includes('is-active')) {
      if (!mockPlasmaShellActive) {
        throw new Error('inactive');
      }

      return '';
    }

    if (args.includes('stop')) {
      mockPlasmaShellActive = false;
      return '';
    }

    if (args.includes('start')) {
      mockPlasmaShellActive = true;
      return '';
    }
  }

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

    if (script.includes('var ids = panelIds')) {
      return JSON.stringify([
        { id: '149', ...mockPanelRuntime },
        { id: '231', ...mockSecondPanelRuntime },
        ...(mockExtraPanelRuntime ? [mockExtraPanelRuntime] : []),
      ]);
    }

    if (script.includes('var panelStateById')) {
      const panelState = JSON.parse(script.match(/^var panelStateById = (.+);$/mu)?.[1] ?? '{}');
      const requested = Object.keys(panelState);

      if (panelState['149']) {
        mockPanelRuntime = { ...mockPanelRuntime, ...panelState['149'] };
      }

      if (panelState['231']) {
        mockSecondPanelRuntime = { ...mockSecondPanelRuntime, ...panelState['231'] };
      }

      const removed =
        mockExtraPanelRuntime && !panelState[mockExtraPanelRuntime.id]
          ? [mockExtraPanelRuntime.id]
          : [];

      if (removed.length > 0) {
        mockExtraPanelRuntime = undefined;
      }

      return JSON.stringify({ requested, updated: requested, missing: [], removed });
    }

    if (script.includes('var wallpaperState =')) {
      const wallpaperState = JSON.parse(
        script.match(/^var wallpaperState = (.+);$/mu)?.[1] ?? '[]'
      );
      mockWallpaperRuntime = wallpaperState[0]?.image ?? mockWallpaperRuntime;
      mockWallpaperPluginRuntime = wallpaperState[0]?.wallpaperPlugin ?? mockWallpaperPluginRuntime;
      return JSON.stringify({ requested: wallpaperState.length, updated: wallpaperState.length });
    }

    if (script.includes('var wallpaperImage')) {
      mockWallpaperRuntime = JSON.parse(
        script.match(/^var wallpaperImage = (.+);$/mu)?.[1] ?? '""'
      );
      mockWallpaperPluginRuntime = 'org.kde.image';
      return '';
    }

    if (script.includes('var wallpaperStates')) {
      return JSON.stringify([
        {
          activityId: 'current-activity',
          screen: 0,
          image: mockWallpaperRuntime,
          wallpaperPlugin: mockWallpaperPluginRuntime,
        },
      ]);
    }

    if (script.includes('screenGeometry')) {
      return [
        '[',
        '{"screen":0,"x":0,"y":0,"width":2560,"height":1440},',
        '{"screen":1,"x":2560,"y":96,"width":2048,"height":1152}',
        ']',
      ].join('\n');
    }

    return JSON.stringify([
      { id: '149', ...mockPanelRuntime },
      { id: '231', ...mockSecondPanelRuntime },
      ...(mockExtraPanelRuntime ? [mockExtraPanelRuntime] : []),
    ]);
  }

  return '';
}
