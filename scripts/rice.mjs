// @ts-check

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  TYRIAN_INSTALL_HOME,
  WALLPAPER_ASSET_PATH,
  buildTyrianBackupRoot,
} from './portableAssets.mjs';
import { TYRIAN_REQUIRED_COMMANDS, checkRequiredCommands, hasCommand } from './commandChecks.mjs';
import {
  backupHomePath,
  exists,
  installManagedPathRaw,
  operation,
  writeBinaryFileRaw,
  writeTextFileRaw,
} from './installOps.mjs';
import { installLiveTyrian } from './installLiveTyrian.mjs';

const repoRoot = process.cwd();
const home = os.homedir();

export const RICE_ROOT = 'rice';
export const RICE_WALLPAPER_PLACEHOLDER = `{{TYRIAN_RICE_ROOT}}/${WALLPAPER_ASSET_PATH}`;
export const RICE_WALLPAPER_PATH = WALLPAPER_ASSET_PATH;
export const RICE_MANIFEST_PATH = `${RICE_ROOT}/plasma-layout/manifest.json`;
export const RICE_REQUIREMENTS_PATH = `${RICE_ROOT}/plasma-layout/requirements.md`;
export const RICE_LAYOUT_FILES = [
  {
    homePath: '.config/plasma-org.kde.plasma.desktop-appletsrc',
    snapshotPath: `${RICE_ROOT}/plasma-layout/config/plasma-org.kde.plasma.desktop-appletsrc`,
    portableWallpaper: true,
  },
  {
    homePath: '.config/plasmashellrc',
    snapshotPath: `${RICE_ROOT}/plasma-layout/config/plasmashellrc`,
    portableWallpaper: false,
  },
];
export const RICE_REQUIRED_COMMANDS = TYRIAN_REQUIRED_COMMANDS;
export const RICE_LAYOUT_REQUIRED_COMMANDS = ['qdbus6', 'kscreen-doctor'];
// Preserve KDE's alias applet IDs: icontasks/minimizeall have X-Plasma-RootPath
// metadata that resolves to compiled taskmanager/showdesktop roots, and replacing
// the IDs changes the exact panel mode/look even though Plasma logs mainscript warnings.

/**
 * @typedef {(command: string, args: string[], options?: import('node:child_process').ExecFileSyncOptions) => Buffer | string} CommandRunner
 */

/**
 * @param {{ repoRoot?: string; home?: string; withPlasmaLayout?: boolean; link?: boolean }} [options]
 * @returns {{ styleInstaller: string; layoutFiles: typeof RICE_LAYOUT_FILES; wallpaperPath: string; repoWallpaperPath: string; runtimeRoot: string; backupRoot: string }}
 */
export function buildRiceInstallPlan(options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const userHome = options.home ?? home;
  const runtimeRoot = options.link ? root : path.join(userHome, TYRIAN_INSTALL_HOME);
  const withPlasmaLayout = options.withPlasmaLayout ?? true;

  return {
    styleInstaller: path.join(root, 'scripts/installLiveTyrian.mjs'),
    layoutFiles: withPlasmaLayout ? RICE_LAYOUT_FILES : [],
    wallpaperPath: path.join(runtimeRoot, RICE_WALLPAPER_PATH),
    repoWallpaperPath: path.join(root, RICE_WALLPAPER_PATH),
    runtimeRoot,
    backupRoot: buildTyrianBackupRoot(userHome, 'rice-layout-apply'),
  };
}

/**
 * @param {{ repoRoot?: string; home?: string }} [options]
 * @returns {void}
 */
export function checkRiceSnapshot(options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const layoutContents = new Map();

  for (const file of RICE_LAYOUT_FILES) {
    const snapshotPath = path.join(root, file.snapshotPath);

    if (!exists(snapshotPath)) {
      throw new Error(`Missing rice layout snapshot: ${file.snapshotPath}`);
    }

    layoutContents.set(file.snapshotPath, fs.readFileSync(snapshotPath, 'utf8'));
  }

  const wallpaperPath = path.join(root, RICE_WALLPAPER_PATH);

  if (!exists(wallpaperPath)) {
    throw new Error(`Missing rice wallpaper asset: ${RICE_WALLPAPER_PATH}`);
  }

  const desktopLayout = layoutContents.get(RICE_LAYOUT_FILES[0].snapshotPath);

  if (desktopLayout === undefined) {
    throw new Error(`Missing rice desktop layout snapshot: ${RICE_LAYOUT_FILES[0].snapshotPath}`);
  }

  if (!desktopLayout.includes(RICE_WALLPAPER_PLACEHOLDER)) {
    throw new Error('Plasma desktop snapshot does not use the portable wallpaper placeholder');
  }

  assertPortablePlasmaLayoutSnapshot(desktopLayout);
  assertNoHomePaths(layoutContents);

  const manifestPath = path.join(root, RICE_MANIFEST_PATH);

  if (!exists(manifestPath)) {
    throw new Error(`Missing rice layout manifest: ${RICE_MANIFEST_PATH}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assertRiceManifest(manifest);

  if (!exists(path.join(root, manifest.requirements))) {
    throw new Error(`Missing rice layout requirements: ${manifest.requirements}`);
  }
}

/**
 * @param {{ repoRoot?: string; home?: string; runCommand?: CommandRunner }} [options]
 * @returns {void}
 */
export function captureRiceLayout(options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const userHome = options.home ?? home;
  const runCommand = options.runCommand ?? execFileSync;
  const desktopLayoutPath = path.join(userHome, RICE_LAYOUT_FILES[0].homePath);
  const desktopLayout = fs.readFileSync(desktopLayoutPath, 'utf8');
  const wallpaperSource = findWallpaperSource(desktopLayout);
  const panelStateById = readLivePanelStateById(runCommand);

  if (!wallpaperSource) {
    throw new Error(`Could not find an existing wallpaper Image= path in ${desktopLayoutPath}`);
  }

  const wallpaperContent = fs.readFileSync(wallpaperSource);
  const capturedLayoutContents = new Map();

  for (const file of RICE_LAYOUT_FILES) {
    const sourcePath = path.join(userHome, file.homePath);
    let content = fs.readFileSync(sourcePath, 'utf8');

    if (file.portableWallpaper) {
      content = sanitizePlasmaDesktopLayout(makeWallpaperPortable(content, wallpaperSource));
      content = applyPanelStateToDesktopLayout(content, panelStateById);
    } else if (file.snapshotPath === RICE_LAYOUT_FILES[1].snapshotPath) {
      content = sanitizePlasmaShellConfig(content);
    }

    capturedLayoutContents.set(file.snapshotPath, content);
  }

  validateCapturedRiceSnapshot(capturedLayoutContents);

  writeBinaryFile(
    path.join(root, RICE_WALLPAPER_PATH),
    wallpaperContent,
    `capture wallpaper ${wallpaperSource}`
  );

  for (const file of RICE_LAYOUT_FILES) {
    const sourcePath = path.join(userHome, file.homePath);
    const snapshotPath = path.join(root, file.snapshotPath);
    const content = capturedLayoutContents.get(file.snapshotPath);

    writeTextFile(snapshotPath, content, `capture ${sourcePath}`);
  }

  writeTextFile(
    path.join(root, RICE_MANIFEST_PATH),
    `${JSON.stringify(buildRiceManifest(), null, 2)}\n`,
    'write rice layout manifest'
  );
}

/**
 * @param {Map<string, string>} layoutContents
 * @returns {void}
 */
function validateCapturedRiceSnapshot(layoutContents) {
  const desktopLayout = layoutContents.get(RICE_LAYOUT_FILES[0].snapshotPath);

  if (desktopLayout === undefined) {
    throw new Error(`Missing captured rice desktop layout: ${RICE_LAYOUT_FILES[0].snapshotPath}`);
  }

  if (!desktopLayout.includes(RICE_WALLPAPER_PLACEHOLDER)) {
    throw new Error(
      'Captured Plasma desktop snapshot does not use the portable wallpaper placeholder'
    );
  }

  assertPortablePlasmaLayoutSnapshot(desktopLayout);
  assertNoHomePaths(layoutContents);
}

/**
 * @param {{ repoRoot?: string; home?: string; apply?: boolean; withPlasmaLayout?: boolean; layoutOnly?: boolean; link?: boolean; runCommand?: CommandRunner; hasCommand?: (command: string) => boolean }} [options]
 * @returns {void}
 */
export function installRice(options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const userHome = options.home ?? home;
  const apply = options.apply ?? false;
  const withPlasmaLayout = options.withPlasmaLayout ?? true;
  const layoutOnly = options.layoutOnly ?? false;
  const link = options.link ?? false;
  const runCommand = options.runCommand ?? execFileSync;
  const commandExists = options.hasCommand ?? hasCommand;
  const plan = buildRiceInstallPlan({
    repoRoot: root,
    home: userHome,
    withPlasmaLayout,
    link,
  });

  if (!layoutOnly) {
    checkRequiredCommands(RICE_REQUIRED_COMMANDS, apply, commandExists, 'Tyrian rice');
  }

  if (withPlasmaLayout) {
    checkRequiredCommands(RICE_LAYOUT_REQUIRED_COMMANDS, apply, commandExists, 'Tyrian rice');
  }

  if (withPlasmaLayout) {
    checkRiceSnapshot({ repoRoot: root });
  }

  if (!layoutOnly) {
    installLiveTyrian({
      repoRoot: root,
      home: userHome,
      apply,
      link,
      runCommand,
      hasCommand: commandExists,
    });
  } else if (withPlasmaLayout && !link) {
    materializeRiceLayoutAssets(root, plan.runtimeRoot, apply);
  }

  if (withPlasmaLayout) {
    installPlasmaLayout({
      repoRoot: root,
      home: userHome,
      runtimeRoot: plan.runtimeRoot,
      apply,
      runCommand,
    });
  } else {
    console.log(
      `${apply ? 'apply' : 'dry-run'}: Plasma layout restore skipped by explicit partial install mode`
    );
  }
}

/**
 * @param {{ repoRoot?: string; home?: string; runtimeRoot?: string; apply?: boolean; runCommand?: CommandRunner }} [options]
 * @returns {void}
 */
export function installPlasmaLayout(options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const userHome = options.home ?? home;
  const runtimeRoot = options.runtimeRoot ?? path.join(userHome, TYRIAN_INSTALL_HOME);
  const apply = options.apply ?? false;
  const runCommand = options.runCommand ?? execFileSync;
  const backupRoot = buildTyrianBackupRoot(userHome, 'rice-layout-apply');

  checkRiceSnapshot({ repoRoot: root });

  const sourceEntries = RICE_LAYOUT_FILES.map((file) => ({
    file,
    targetPath: path.join(userHome, file.homePath),
    sourceContent: fs.readFileSync(path.join(root, file.snapshotPath), 'utf8'),
  }));
  const currentActivityId = apply ? readCurrentPlasmaActivityId(runCommand) : '';
  const primaryTarget = apply
    ? readPrimaryPlasmaTarget(runCommand)
    : { height: 0, screen: 0, width: 0 };
  const installEntries = sourceEntries.map(({ file, targetPath, sourceContent }) => {
    let installedContent = sourceContent.replaceAll('{{TYRIAN_RICE_ROOT}}', runtimeRoot);

    if (apply && file.portableWallpaper) {
      installedContent = hydratePlasmaDesktopActivityIds(installedContent, currentActivityId);
      installedContent = hydratePlasmaPrimaryScreenAssignments(installedContent, primaryTarget);
    } else if (apply && file.homePath === RICE_LAYOUT_FILES[1].homePath) {
      installedContent = hydratePlasmaShellPanelViews(installedContent, primaryTarget);
    }

    return {
      file,
      installedContent,
      targetPath,
    };
  });

  operation(apply, `${apply ? 'stop' : 'would stop'} Plasma shell before restoring layout`, () => {
    stopPlasmaShell(runCommand);
  });

  for (const { installedContent, targetPath } of installEntries) {
    operation(apply, `${apply ? 'restore' : 'would restore'} ${targetPath}`, () => {
      backupPath(targetPath, backupRoot, userHome);
      writeTextFileRaw(targetPath, installedContent, { finalNewline: true });
    });
  }

  operation(apply, `${apply ? 'start' : 'would start'} Plasma shell`, () => {
    startPlasmaShell(runCommand);
  });

  const panelStateById = readSnapshotPanelStateById(
    installEntries.find(({ file }) => file.portableWallpaper)?.installedContent ?? ''
  );

  operation(apply, `${apply ? 'restore' : 'would restore'} Plasma panel runtime state`, () => {
    restorePlasmaPanelState(panelStateById, primaryTarget.screen, runCommand);
  });

  const wallpaperPath = path.join(runtimeRoot, RICE_WALLPAPER_PATH);

  operation(apply, `${apply ? 'apply' : 'would apply'} Plasma wallpaper ${wallpaperPath}`, () => {
    applyPlasmaWallpaper(wallpaperPath, runCommand);
  });
}

/**
 * @param {string} desktopLayout
 * @param {string} activityId
 * @returns {string}
 */
export function hydratePlasmaDesktopActivityIds(desktopLayout, activityId) {
  if (!activityId) {
    throw new Error('Cannot restore Plasma desktop containments without the current activity ID');
  }

  return desktopLayout
    .split(/(?=^\[)/gmu)
    .map((section) => {
      const sectionHeader = section.split('\n', 1)[0];

      if (!/^\[Containments\]\[\d+\]$/u.test(sectionHeader)) {
        return section;
      }

      const isDesktopContainment =
        /^formfactor=0$/mu.test(section) &&
        /^location=0$/mu.test(section) &&
        /^plugin=(?:org\.kde\.desktopcontainment|org\.kde\.plasma\.folder)$/mu.test(section);

      if (!isDesktopContainment) {
        return section;
      }

      return section.replace(/^activityId=.*$/mu, `activityId=${activityId}`);
    })
    .join('');
}

/**
 * @param {string} desktopLayout
 * @param {{ screen: number; width: number; height: number; otherScreens?: number[] }} primaryTarget
 * @returns {string}
 */
function hydratePlasmaPrimaryScreenAssignments(desktopLayout, primaryTarget) {
  const primaryScreenValue = String(primaryTarget.screen);
  const otherScreens = primaryTarget.otherScreens ?? [];
  let nextSecondaryDesktopScreenIndex = 0;

  return replaceContainmentSections(desktopLayout, (section) => {
    if (/^plugin=org\.kde\.desktopcontainment$/mu.test(section)) {
      let nextSection = upsertSectionKey(section, 'lastScreen', primaryScreenValue);
      nextSection = hydratePrimaryDesktopGeometry(nextSection, primaryTarget);

      return nextSection;
    }

    if (/^plugin=org\.kde\.plasma\.folder$/mu.test(section)) {
      const screen = otherScreens[nextSecondaryDesktopScreenIndex++] ?? primaryTarget.screen;

      return upsertSectionKey(section, 'lastScreen', String(screen));
    }

    if (/^plugin=org\.kde\.panel$/mu.test(section)) {
      return upsertSectionKey(section, 'lastScreen', primaryScreenValue);
    }

    return section;
  });
}

/**
 * @param {string} shellConfig
 * @param {{ width: number }} primaryTarget
 * @returns {string}
 */
function hydratePlasmaShellPanelViews(shellConfig, primaryTarget) {
  if (primaryTarget.width <= 0) {
    return shellConfig;
  }

  const targetWidth = String(primaryTarget.width);

  return shellConfig
    .split(/(?=^\[)/gmu)
    .map((section) => {
      const header = section.split('\n', 1)[0];

      if (/^\[PlasmaViews\]\[Panel \d+\]\[Horizontal\d+\]$/u.test(header)) {
        return '';
      }

      if (!/^\[PlasmaViews\]\[Panel \d+\]\[Defaults\]$/u.test(header)) {
        return section;
      }

      let nextSection = section;
      nextSection = upsertSectionKey(nextSection, 'length', targetWidth);
      nextSection = upsertSectionKey(nextSection, 'maxLength', targetWidth);
      nextSection = upsertSectionKey(nextSection, 'minLength', targetWidth);

      return nextSection;
    })
    .join('');
}

/**
 * @param {string} section
 * @param {{ width: number; height: number }} primaryTarget
 * @returns {string}
 */
function hydratePrimaryDesktopGeometry(section, primaryTarget) {
  if (primaryTarget.width <= 0 || primaryTarget.height <= 0) {
    return section;
  }

  const sourceSize = readDesktopGeometrySourceSize(section);

  if (!sourceSize) {
    return section;
  }

  const targetSize = `${primaryTarget.width}x${primaryTarget.height}`;
  let nextSection = section.replace(
    /^ItemGeometries-(\d+)x(\d+)=(.*)$/gmu,
    (_line, width, height, entries) =>
      `ItemGeometries-${targetSize}=${scaleDesktopAppletGeometries(
        entries,
        Number(width),
        Number(height),
        primaryTarget.width,
        primaryTarget.height
      )}`
  );

  nextSection = nextSection.replace(
    /^ItemGeometriesHorizontal=(.*)$/gmu,
    (_line, entries) =>
      `ItemGeometriesHorizontal=${scaleDesktopAppletGeometries(
        entries,
        sourceSize.width,
        sourceSize.height,
        primaryTarget.width,
        primaryTarget.height
      )}`
  );

  return upsertSectionKey(nextSection, 'lastResolution', targetSize);
}

/**
 * @param {string} section
 * @returns {{ width: number; height: number } | undefined}
 */
function readDesktopGeometrySourceSize(section) {
  const itemGeometrySize = section.match(/^ItemGeometries-(\d+)x(\d+)=/mu);

  if (itemGeometrySize) {
    return {
      height: Number(itemGeometrySize[2]),
      width: Number(itemGeometrySize[1]),
    };
  }

  const lastResolution = section.match(/^lastResolution=(\d+)x(\d+)$/mu);

  if (lastResolution) {
    return {
      height: Number(lastResolution[2]),
      width: Number(lastResolution[1]),
    };
  }

  return undefined;
}

/**
 * @param {string} value
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @param {number} targetWidth
 * @param {number} targetHeight
 * @returns {string}
 */
function scaleDesktopAppletGeometries(value, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return value;
  }

  const xRatio = targetWidth / sourceWidth;
  const yRatio = targetHeight / sourceHeight;
  const hasTrailingSeparator = value.endsWith(';');
  const entries = value
    .split(';')
    .filter((entry, index, allEntries) => entry.length > 0 || index < allEntries.length - 1)
    .map((entry) =>
      entry.replace(
        /^(Applet-\d+):(-?\d+),(-?\d+),(\d+),(\d+),(.*)$/u,
        (_match, applet, x, y, width, height, suffix) =>
          [
            `${applet}:${Math.round(Number(x) * xRatio)}`,
            Math.round(Number(y) * yRatio),
            Math.round(Number(width) * xRatio),
            Math.round(Number(height) * yRatio),
            suffix,
          ].join(',')
      )
    );

  return `${entries.join(';')}${hasTrailingSeparator ? ';' : ''}`;
}

/**
 * @param {CommandRunner} runCommand
 * @returns {string}
 */
function readCurrentPlasmaActivityId(runCommand) {
  const activityId = String(
    runCommand(
      'qdbus6',
      [
        'org.kde.ActivityManager',
        '/ActivityManager/Activities',
        'org.kde.ActivityManager.Activities.CurrentActivity',
      ],
      { encoding: 'utf8' }
    )
  ).trim();

  if (!activityId) {
    throw new Error('Could not read the current Plasma activity ID');
  }

  return activityId;
}

/**
 * @param {CommandRunner} runCommand
 * @returns {{ screen: number; width: number; height: number; otherScreens: number[] }}
 */
function readPrimaryPlasmaTarget(runCommand) {
  const primaryGeometry = readPrimaryOutputGeometry(runCommand);
  const plasmaScreens = readPlasmaScreenGeometries(runCommand);
  const matchingScreen = plasmaScreens.find(
    (screen) =>
      screen.x === primaryGeometry.x &&
      screen.y === primaryGeometry.y &&
      screen.width === primaryGeometry.width &&
      screen.height === primaryGeometry.height
  );

  return {
    height: primaryGeometry.height,
    otherScreens: plasmaScreens
      .map((screen) => screen.screen)
      .filter((screen) => screen !== (matchingScreen?.screen ?? 0)),
    screen: matchingScreen?.screen ?? 0,
    width: primaryGeometry.width,
  };
}

/**
 * @param {CommandRunner} runCommand
 * @returns {{ x: number; y: number; width: number; height: number }}
 */
function readPrimaryOutputGeometry(runCommand) {
  const output = stripAnsi(String(runCommand('kscreen-doctor', ['-o'], { encoding: 'utf8' })));
  const blocks = output.split(/\n(?=Output:\s+\d+\s)/u);
  const outputBlocks = blocks
    .map((block) => ({
      block,
      priority: Number(block.match(/priority\s+(\d+)/u)?.[1] ?? Number.MAX_SAFE_INTEGER),
      geometry: block.match(/Geometry:\s+(-?\d+),(-?\d+)\s+(\d+)x(\d+)/u),
      enabled: /\benabled\b/u.test(block),
      connected: /\bconnected\b/u.test(block),
    }))
    .filter(({ connected, enabled, geometry }) => connected && enabled && geometry);
  const primary = outputBlocks.sort((left, right) => left.priority - right.priority)[0];

  if (!primary?.geometry) {
    throw new Error('Could not read primary monitor geometry from kscreen-doctor.');
  }

  return {
    x: Number(primary.geometry[1]),
    y: Number(primary.geometry[2]),
    width: Number(primary.geometry[3]),
    height: Number(primary.geometry[4]),
  };
}

/**
 * @param {CommandRunner} runCommand
 * @returns {Array<{ screen: number; x: number; y: number; width: number; height: number }>}
 */
function readPlasmaScreenGeometries(runCommand) {
  const output = String(
    runCommand(
      'qdbus6',
      [
        'org.kde.plasmashell',
        '/PlasmaShell',
        'org.kde.PlasmaShell.evaluateScript',
        [
          'var values = [];',
          'var seen = {};',
          'var allDesktops = desktops();',
          'for (var desktopIndex = 0; desktopIndex < allDesktops.length; desktopIndex++) {',
          '  var i = allDesktops[desktopIndex].screen;',
          '  if (seen[i]) continue;',
          '  seen[i] = true;',
          '  try {',
          '    var geometry = screenGeometry(i);',
          '    if (geometry.valid && !geometry.empty) {',
          '      values.push({ screen: i, x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height });',
          '    }',
          '  } catch (error) {}',
          '}',
          'print(JSON.stringify(values));',
        ].join('\n'),
      ],
      { encoding: 'utf8' }
    )
  ).trim();
  const parsed = parseJsonFromQdbusOutput(output);

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter(
    (screen) =>
      Number.isSafeInteger(screen?.screen) &&
      Number.isFinite(screen.x) &&
      Number.isFinite(screen.y) &&
      Number.isFinite(screen.width) &&
      Number.isFinite(screen.height)
  );
}

/**
 * @param {CommandRunner} runCommand
 * @returns {Map<string, { hiding?: string; alignment?: string; lengthRatio?: number; height?: number }>}
 */
function readLivePanelStateById(runCommand) {
  try {
    const output = String(
      runCommand(
        'qdbus6',
        [
          'org.kde.plasmashell',
          '/PlasmaShell',
          'org.kde.PlasmaShell.evaluateScript',
          [
            'var values = [];',
            'var fallbackWidth = 0;',
            'desktops().forEach(function(desktop) {',
            '  try {',
            '    var desktopGeometry = screenGeometry(desktop.screen);',
            '    fallbackWidth = Math.max(fallbackWidth, desktopGeometry.width);',
            '  } catch (error) {}',
            '});',
            'var ids = panelIds;',
            'for (var i = 0; i < ids.length; i++) {',
            '  var panel = panelById(ids[i]);',
            '  var width = fallbackWidth;',
            '  panel.currentConfigGroup = [];',
            '  var lastScreen = Number(panel.readConfig("lastScreen"));',
            '  try {',
            '    var panelGeometry = screenGeometry(lastScreen);',
            '    if (panelGeometry.width > 0) width = panelGeometry.width;',
            '  } catch (error) {}',
            '  values.push({',
            '    id: String(ids[i]),',
            '    hiding: String(panel.hiding),',
            '    alignment: String(panel.alignment),',
            '    lengthRatio: width > 0 ? panel.length / width : 1,',
            '    height: panel.height',
            '  });',
            '}',
            'print(JSON.stringify(values));',
          ].join('\n'),
        ],
        { encoding: 'utf8' }
      )
    ).trim();

    return parsePanelStateJson(output);
  } catch (error) {
    console.warn(`Could not capture live Plasma panel runtime state: ${String(error)}`);
    return new Map();
  }
}

/**
 * @param {string} output
 * @returns {Map<string, { hiding?: string; alignment?: string; lengthRatio?: number; height?: number }>}
 */
function parsePanelStateJson(output) {
  const parsed = parseJsonFromQdbusOutput(output);

  if (!Array.isArray(parsed)) {
    return new Map();
  }

  return new Map(
    parsed
      .filter(
        (entry) =>
          typeof entry?.id === 'string' &&
          (typeof entry.hiding === 'string' ||
            typeof entry.alignment === 'string' ||
            Number.isFinite(entry.lengthRatio) ||
            Number.isFinite(entry.height))
      )
      .map((entry) => [
        entry.id,
        {
          alignment: typeof entry.alignment === 'string' ? entry.alignment : undefined,
          height: Number.isFinite(entry.height) ? Number(entry.height) : undefined,
          hiding: typeof entry.hiding === 'string' ? entry.hiding : undefined,
          lengthRatio: Number.isFinite(entry.lengthRatio) ? Number(entry.lengthRatio) : undefined,
        },
      ])
  );
}

/**
 * @param {string} desktopLayout
 * @param {Map<string, { hiding?: string; alignment?: string; lengthRatio?: number; height?: number }>} panelStateById
 * @returns {string}
 */
function applyPanelStateToDesktopLayout(desktopLayout, panelStateById) {
  if (panelStateById.size === 0) {
    return desktopLayout;
  }

  return replaceContainmentSections(desktopLayout, (section, id) => {
    if (!/^plugin=org\.kde\.panel$/mu.test(section)) {
      return section;
    }

    const state = panelStateById.get(id);

    if (!state) {
      return section;
    }

    let nextSection = section;

    if (state.hiding) {
      nextSection = upsertSectionKey(nextSection, 'hiding', state.hiding);
    }

    if (state.alignment) {
      nextSection = upsertSectionKey(nextSection, 'tyrianPanelAlignment', state.alignment);
    }

    if (state.lengthRatio !== undefined) {
      nextSection = upsertSectionKey(
        nextSection,
        'tyrianPanelLengthRatio',
        String(state.lengthRatio)
      );
    }

    if (state.height !== undefined) {
      nextSection = upsertSectionKey(nextSection, 'tyrianPanelHeight', String(state.height));
    }

    return nextSection;
  });
}

/**
 * @param {string} desktopLayout
 * @returns {Map<string, { hiding?: string; alignment?: string; lengthRatio?: number; height?: number }>}
 */
function readSnapshotPanelStateById(desktopLayout) {
  const panelStateById = new Map();

  replaceContainmentSections(desktopLayout, (section, id) => {
    if (!/^plugin=org\.kde\.panel$/mu.test(section)) {
      return section;
    }

    panelStateById.set(id, {
      alignment: section.match(/^tyrianPanelAlignment=(.+)$/mu)?.[1],
      height: parseOptionalNumber(section.match(/^tyrianPanelHeight=(.+)$/mu)?.[1]),
      hiding: section.match(/^hiding=(.+)$/mu)?.[1],
      lengthRatio: parseOptionalNumber(section.match(/^tyrianPanelLengthRatio=(.+)$/mu)?.[1]),
    });

    return section;
  });

  return panelStateById;
}

/**
 * @param {Map<string, { hiding?: string; alignment?: string; lengthRatio?: number; height?: number }>} panelStateById
 * @param {number} primaryScreen
 * @param {CommandRunner} runCommand
 * @returns {void}
 */
function restorePlasmaPanelState(panelStateById, primaryScreen, runCommand) {
  if (panelStateById.size === 0) {
    return;
  }

  runCommand(
    'qdbus6',
    [
      'org.kde.plasmashell',
      '/PlasmaShell',
      'org.kde.PlasmaShell.evaluateScript',
      buildPlasmaPanelStateScript(panelStateById, primaryScreen),
    ],
    { stdio: 'inherit' }
  );
}

/**
 * @param {Map<string, { hiding?: string; alignment?: string; lengthRatio?: number; height?: number }>} panelStateById
 * @param {number} primaryScreen
 * @returns {string}
 */
function buildPlasmaPanelStateScript(panelStateById, primaryScreen) {
  return [
    `var panelStateById = ${JSON.stringify(Object.fromEntries(panelStateById))};`,
    `var primaryScreen = ${JSON.stringify(primaryScreen)};`,
    'var primaryGeometry = screenGeometry(primaryScreen);',
    'for (var id in panelStateById) {',
    '  var panel = panelById(Number(id));',
    '  if (panel) {',
    '    var state = panelStateById[id];',
    '    panel.currentConfigGroup = [];',
    '    panel.writeConfig("lastScreen", String(primaryScreen));',
    '    if (state.hiding) panel.hiding = state.hiding;',
    '    if (state.alignment) panel.alignment = state.alignment;',
    '    if (state.height) panel.height = state.height;',
    '    if (state.lengthRatio) {',
    '      var length = Math.round(primaryGeometry.width * state.lengthRatio);',
    '      panel.minimumLength = length;',
    '      panel.maximumLength = length;',
    '      panel.length = length;',
    '    }',
    '    panel.reloadConfig();',
    '  }',
    '}',
  ].join('\n');
}

/**
 * @param {string | undefined} value
 * @returns {number | undefined}
 */
function parseOptionalNumber(value) {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * @param {string} output
 * @returns {unknown}
 */
function parseJsonFromQdbusOutput(output) {
  const jsonStarts = Array.from(output.matchAll(/\{|\[/gu), (match) => match.index).filter(
    (index) => index !== undefined
  );

  for (let index = jsonStarts.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(output.slice(jsonStarts[index]).trim());
    } catch {
      // Keep scanning: qdbus can prepend warnings that contain bracketed text.
    }
  }

  return undefined;
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripAnsi(value) {
  const escape = String.fromCharCode(27);

  return value.replaceAll(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, 'gu'), '');
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * @param {string} content
 * @param {(section: string, id: string) => string} replaceSection
 * @returns {string}
 */
function replaceContainmentSections(content, replaceSection) {
  return content.replace(
    /(\[Containments\]\[(\d+)\]\n(?:(?!^\[).*\n?)*)/gmu,
    (section, _fullMatch, id) => replaceSection(section, id)
  );
}

/**
 * @param {string} section
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
function upsertSectionKey(section, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${escapeRegExp(key)}=.*$`, 'mu');

  if (pattern.test(section)) {
    return section.replace(pattern, line);
  }

  return section.endsWith('\n') ? `${section}${line}\n` : `${section}\n${line}\n`;
}

/**
 * @param {string} root
 * @param {string} runtimeRoot
 * @param {boolean} apply
 * @returns {void}
 */
function materializeRiceLayoutAssets(root, runtimeRoot, apply) {
  const sourcePath = path.join(root, RICE_WALLPAPER_PATH);
  const targetPath = path.join(runtimeRoot, RICE_WALLPAPER_PATH);

  operation(apply, `${apply ? 'copy' : 'would copy'} ${sourcePath} -> ${targetPath}`, () => {
    installManagedPathRaw('copy', sourcePath, targetPath);
  });
}

/**
 * @param {string} wallpaperPath
 * @returns {string}
 */
export function buildPlasmaWallpaperScript(wallpaperPath) {
  const wallpaperUri = pathToFileURL(wallpaperPath).href;

  return [
    `var wallpaperImage = ${JSON.stringify(wallpaperUri)};`,
    'var allDesktops = desktops();',
    'for (var i = 0; i < allDesktops.length; i++) {',
    '  var desktop = allDesktops[i];',
    '  desktop.wallpaperPlugin = "org.kde.image";',
    '  desktop.currentConfigGroup = ["Wallpaper", "org.kde.image", "General"];',
    '  desktop.writeConfig("Image", wallpaperImage);',
    '}',
  ].join('\n');
}

/**
 * @param {string} wallpaperPath
 * @param {CommandRunner} runCommand
 * @returns {void}
 */
function applyPlasmaWallpaper(wallpaperPath, runCommand) {
  runCommand(
    'qdbus6',
    [
      'org.kde.plasmashell',
      '/PlasmaShell',
      'org.kde.PlasmaShell.evaluateScript',
      buildPlasmaWallpaperScript(wallpaperPath),
    ],
    { stdio: 'inherit' }
  );
}

/**
 * @param {string} desktopLayout
 * @returns {string | undefined}
 */
function findWallpaperSource(desktopLayout) {
  const imagePaths = Array.from(desktopLayout.matchAll(/^Image=(.+)$/gmu), (match) => match[1]);

  return imagePaths.map(parseWallpaperImagePath).find((imagePath) => exists(imagePath));
}

/**
 * @param {string} imagePath
 * @returns {string}
 */
function parseWallpaperImagePath(imagePath) {
  if (!imagePath.startsWith('file://')) {
    return imagePath;
  }

  return fileURLToPath(imagePath);
}

/**
 * @param {string} desktopLayout
 * @param {string} wallpaperSource
 * @returns {string}
 */
function makeWallpaperPortable(desktopLayout, wallpaperSource) {
  const wallpaperSourceUrl = pathToFileURL(wallpaperSource).href;

  return desktopLayout
    .replaceAll(`Image=${wallpaperSource}`, `Image=${RICE_WALLPAPER_PLACEHOLDER}`)
    .replaceAll(`Image=${wallpaperSourceUrl}`, `Image=${RICE_WALLPAPER_PLACEHOLDER}`)
    .replaceAll(`PreviewImage=${wallpaperSource}`, `PreviewImage=${RICE_WALLPAPER_PLACEHOLDER}`)
    .replaceAll(`PreviewImage=${wallpaperSourceUrl}`, `PreviewImage=${RICE_WALLPAPER_PLACEHOLDER}`);
}

/**
 * @param {string} desktopLayout
 * @returns {string}
 */
function sanitizePlasmaDesktopLayout(desktopLayout) {
  return desktopLayout
    .replaceAll(/^activityId=.+$/gmu, 'activityId=')
    .replaceAll(/^lastScreen=.+$/gmu, '')
    .replaceAll(/^positions=.+$/gmu, 'positions={}')
    .replaceAll(/^itemsOnDisabledScreens=.+$/gmu, 'itemsOnDisabledScreens=')
    .replaceAll(/^screenMapping=.+$/gmu, 'screenMapping=')
    .replaceAll(/^lastPreset=\/.+$/gmu, 'lastPreset=');
}

/**
 * @param {string} shellConfig
 * @returns {string}
 */
function sanitizePlasmaShellConfig(shellConfig) {
  return shellConfig
    .split(/(?=^\[)/gmu)
    .map((section) => {
      const header = section.split('\n', 1)[0];

      if (/^\[Updates\]$/u.test(header)) {
        return '';
      }

      if (/^\[PlasmaViews\]\[Panel \d+\]\[Horizontal\d+\]$/u.test(header)) {
        return '';
      }

      if (!/^\[PlasmaViews\]\[Panel \d+\]\[Defaults\]$/u.test(header)) {
        return section;
      }

      return section
        .replaceAll(/^length=.+\n?/gmu, '')
        .replaceAll(/^maxLength=.+\n?/gmu, '')
        .replaceAll(/^minLength=.+\n?/gmu, '');
    })
    .join('');
}

/**
 * @param {string} desktopLayout
 * @returns {void}
 */
function assertPortablePlasmaLayoutSnapshot(desktopLayout) {
  /** @type {Array<[RegExp, string]>} */
  const forbiddenPatterns = [
    [/^(?:Image|PreviewImage)=\//mu, 'absolute wallpaper path'],
    [/^(?:Image|PreviewImage)=file:\/\//mu, 'file URI wallpaper path'],
    [/^activityId=.+$/mu, 'KDE activity UUID'],
    [/^lastScreen=.+$/mu, 'display screen assignment state'],
    [/^positions=.+desktop:\//mu, 'desktop icon positions'],
    [/^itemsOnDisabledScreens=.+desktop:\//mu, 'disabled-screen desktop items'],
    [/^screenMapping=.+desktop:\//mu, 'screen desktop item mapping'],
    [/^lastPreset=\/.+$/mu, 'absolute panel-colorizer preset path'],
    [/desktop:\//u, 'desktop file URL'],
  ];

  for (const [pattern, label] of forbiddenPatterns) {
    if (pattern.test(desktopLayout)) {
      throw new Error(`Plasma desktop snapshot contains ${label}; recapture or sanitize the rice`);
    }
  }
}

/**
 * @param {Map<string, string>} layoutContents
 * @returns {void}
 */
function assertNoHomePaths(layoutContents) {
  for (const [snapshotPath, content] of layoutContents) {
    if (/\/home\/[^/\s]+/u.test(content)) {
      throw new Error(`${snapshotPath} contains a user home path; recapture or sanitize the rice`);
    }

    if (/^performed=\/.+$/mu.test(content)) {
      throw new Error(
        `${snapshotPath} contains KDE update-state paths; recapture or sanitize the rice`
      );
    }

    if (/^\[PlasmaViews\]\[Panel \d+\]\[Horizontal\d+\]$/mu.test(content)) {
      throw new Error(
        `${snapshotPath} contains per-resolution Plasma panel view state; recapture or sanitize the rice`
      );
    }

    if (
      /^\[PlasmaViews\]\[Panel \d+\]\[Defaults\]\n(?:[^[\n].*\n?)*^(?:length|maxLength|minLength)=/mu.test(
        content
      )
    ) {
      throw new Error(
        `${snapshotPath} contains fixed Plasma panel pixel widths; recapture or sanitize the rice`
      );
    }
  }
}

/**
 * @returns {{ version: number; owner: string; requirements: string; wallpaperAsset: string; layoutFiles: Array<{ homePath: string; snapshotPath: string; portableWallpaper: boolean }> }}
 */
function buildRiceManifest() {
  return {
    version: 1,
    owner: 'Tyrian Night rice',
    requirements: RICE_REQUIREMENTS_PATH,
    wallpaperAsset: RICE_WALLPAPER_PATH,
    layoutFiles: RICE_LAYOUT_FILES,
  };
}

/**
 * @param {unknown} manifest
 * @returns {asserts manifest is { version: number; owner: string; requirements: string; wallpaperAsset: string; layoutFiles: typeof RICE_LAYOUT_FILES }}
 */
function assertRiceManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Rice layout manifest is not an object');
  }

  const candidate =
    /** @type {{ version?: unknown; requirements?: unknown; wallpaperAsset?: unknown; layoutFiles?: unknown }} */ (
      manifest
    );

  if (candidate.version !== 1) {
    throw new Error('Rice layout manifest has an unsupported version');
  }

  if (candidate.requirements !== RICE_REQUIREMENTS_PATH) {
    throw new Error(`Rice layout manifest must reference ${RICE_REQUIREMENTS_PATH}`);
  }

  if (candidate.wallpaperAsset !== RICE_WALLPAPER_PATH) {
    throw new Error(`Rice layout manifest must reference ${RICE_WALLPAPER_PATH}`);
  }

  if (JSON.stringify(candidate.layoutFiles) !== JSON.stringify(RICE_LAYOUT_FILES)) {
    throw new Error('Rice layout manifest layoutFiles do not match the rice installer contract');
  }
}

/**
 * @param {string} targetPath
 * @param {string} backupRoot
 * @param {string} userHome
 * @returns {void}
 */
function backupPath(targetPath, backupRoot, userHome) {
  const backupPathTarget = backupHomePath(targetPath, backupRoot, userHome);

  if (backupPathTarget) {
    console.log(`backup: ${targetPath} -> ${backupPathTarget}`);
  }
}

/**
 * @param {CommandRunner} runCommand
 * @returns {void}
 */
function stopPlasmaShell(runCommand) {
  try {
    runCommand('systemctl', ['--user', 'stop', 'plasma-plasmashell.service'], {
      stdio: 'inherit',
    });
  } catch (error) {
    console.warn('Could not stop Plasma shell automatically; layout restore may be overwritten.');
    console.warn(String(error));
  }
}

/**
 * @param {CommandRunner} runCommand
 * @returns {void}
 */
function startPlasmaShell(runCommand) {
  try {
    runCommand('systemctl', ['--user', 'start', 'plasma-plasmashell.service'], {
      stdio: 'inherit',
    });
  } catch (error) {
    console.warn('Could not start Plasma shell automatically; log out/in or start plasmashell.');
    console.warn(String(error));
  }
}

/**
 * @param {string} filePath
 * @param {string} content
 * @param {string} message
 * @returns {void}
 */
function writeTextFile(filePath, content, message) {
  console.log(message);
  writeTextFileRaw(filePath, content, { finalNewline: true });
}

/**
 * @param {string} filePath
 * @param {Buffer} content
 * @param {string} message
 * @returns {void}
 */
function writeBinaryFile(filePath, content, message) {
  console.log(message);
  writeBinaryFileRaw(filePath, content);
}

/**
 * @returns {void}
 */
function main() {
  const args = parseFlags(process.argv.slice(2), [
    '--apply',
    '--capture-layout',
    '--check',
    '--layout-only',
    '--link',
    '--style-only',
  ]);

  if (args.has('--layout-only') && args.has('--style-only')) {
    throw new Error('Tyrian rice flags --layout-only and --style-only are mutually exclusive.');
  }

  if (args.has('--capture-layout')) {
    captureRiceLayout();
    return;
  }

  if (args.has('--check')) {
    checkRiceSnapshot();
    return;
  }

  installRice({
    apply: args.has('--apply'),
    withPlasmaLayout: !args.has('--style-only'),
    layoutOnly: args.has('--layout-only'),
    link: args.has('--link'),
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}

/**
 * @param {string[]} argv
 * @param {string[]} allowedFlags
 * @returns {Set<string>}
 */
function parseFlags(argv, allowedFlags) {
  const allowed = new Set(allowedFlags);
  const parsed = new Set();

  for (const flag of argv) {
    if (!allowed.has(flag)) {
      throw new Error(`Unknown Tyrian rice flag '${flag}'.`);
    }

    parsed.add(flag);
  }

  return parsed;
}
