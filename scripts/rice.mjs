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
export const RICE_REQUIRED_COMMANDS = [
  'chafa',
  'fastfetch',
  'fish',
  'ghostty',
  'kwriteconfig6',
  'plasma-apply-colorscheme',
  'plasma-apply-desktoptheme',
  'starship',
];
export const RICE_LAYOUT_REQUIRED_COMMANDS = ['qdbus6'];

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
 * @param {{ repoRoot?: string; home?: string }} [options]
 * @returns {void}
 */
export function captureRiceLayout(options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const userHome = options.home ?? home;
  const desktopLayoutPath = path.join(userHome, RICE_LAYOUT_FILES[0].homePath);
  const desktopLayout = fs.readFileSync(desktopLayoutPath, 'utf8');
  const wallpaperSource = findWallpaperSource(desktopLayout);

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
    checkRequiredCommands(RICE_REQUIRED_COMMANDS, apply, commandExists);
  }

  if (withPlasmaLayout) {
    checkRequiredCommands(RICE_LAYOUT_REQUIRED_COMMANDS, apply, commandExists);
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
  const installEntries = sourceEntries.map(({ file, targetPath, sourceContent }) => {
    let installedContent = sourceContent.replaceAll('{{TYRIAN_RICE_ROOT}}', runtimeRoot);

    if (apply && file.portableWallpaper) {
      installedContent = hydratePlasmaDesktopActivityIds(installedContent, currentActivityId);
    }

    return {
      installedContent,
      targetPath,
    };
  });

  for (const { installedContent, targetPath } of installEntries) {
    operation(`${apply ? 'restore' : 'would restore'} ${targetPath}`, apply, () => {
      backupPath(targetPath, backupRoot, userHome);
      writeTextFileRaw(targetPath, installedContent);
    });
  }

  operation(`${apply ? 'restart' : 'would restart'} Plasma shell`, apply, () => {
    restartPlasmaShell(runCommand);
  });

  const wallpaperPath = path.join(runtimeRoot, RICE_WALLPAPER_PATH);

  operation(`${apply ? 'apply' : 'would apply'} Plasma wallpaper ${wallpaperPath}`, apply, () => {
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
 * @param {string} root
 * @param {string} runtimeRoot
 * @param {boolean} apply
 * @returns {void}
 */
function materializeRiceLayoutAssets(root, runtimeRoot, apply) {
  const sourcePath = path.join(root, RICE_WALLPAPER_PATH);
  const targetPath = path.join(runtimeRoot, RICE_WALLPAPER_PATH);

  operation(`${apply ? 'copy' : 'would copy'} ${sourcePath} -> ${targetPath}`, apply, () => {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
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
 * @param {string[]} commands
 * @param {boolean} apply
 * @param {(command: string) => boolean} commandExists
 * @returns {void}
 */
function checkRequiredCommands(commands, apply, commandExists) {
  const missingCommands = commands.filter((command) => !commandExists(command));

  if (missingCommands.length === 0) {
    return;
  }

  const message = `Missing Tyrian rice commands: ${missingCommands.join(', ')}\nInstall them first. On CachyOS/Arch: sudo pacman -S --needed ${missingCommands.join(' ')}`;

  if (apply) {
    throw new Error(message);
  }

  console.warn(message);
}

/**
 * @param {string} command
 * @returns {boolean}
 */
function hasCommand(command) {
  for (const searchDir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!searchDir) {
      continue;
    }

    const candidate = path.join(searchDir, command);

    if (isExecutable(candidate)) {
      return true;
    }
  }

  return false;
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isExecutable(filePath) {
  try {
    const stat = fs.statSync(filePath);

    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
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
    .replaceAll(/^ItemGeometries[^=]*=.*$/gmu, '')
    .replaceAll(/^activityId=.+$/gmu, 'activityId=')
    .replaceAll(/^lastResolution=.+$/gmu, '')
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
  return shellConfig.replaceAll(/^\[Updates\]\n(?:[^[\n].*\n?)*/gmu, '');
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
    [/^ItemGeometries[^=]*=.+$/mu, 'display geometry state'],
    [/^lastResolution=.+$/mu, 'display resolution state'],
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
  if (!exists(targetPath)) {
    return;
  }

  const relativePath = path.relative(userHome, targetPath);

  if (relativePath.startsWith('..')) {
    return;
  }

  const backupPathTarget = path.join(backupRoot, 'home', relativePath);
  fs.mkdirSync(path.dirname(backupPathTarget), { recursive: true });
  fs.cpSync(targetPath, backupPathTarget, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  console.log(`backup: ${targetPath} -> ${backupPathTarget}`);
}

/**
 * @param {CommandRunner} runCommand
 * @returns {void}
 */
function restartPlasmaShell(runCommand) {
  try {
    runCommand('systemctl', ['--user', 'restart', 'plasma-plasmashell.service'], {
      stdio: 'inherit',
    });
  } catch (error) {
    console.warn(
      'Could not restart Plasma shell automatically; log out/in or restart plasmashell.'
    );
    console.warn(String(error));
  }
}

/**
 * @param {string} message
 * @param {boolean} apply
 * @param {() => void} action
 * @returns {void}
 */
function operation(message, apply, action) {
  console.log(`${apply ? 'apply' : 'dry-run'}: ${message}`);

  if (apply) {
    action();
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
  writeTextFileRaw(filePath, content);
}

/**
 * @param {string} filePath
 * @param {string} content
 * @returns {void}
 */
function writeTextFileRaw(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
}

/**
 * @param {string} filePath
 * @param {Buffer} content
 * @param {string} message
 * @returns {void}
 */
function writeBinaryFile(filePath, content, message) {
  console.log(message);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function exists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
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
