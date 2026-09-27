// @ts-check

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkRequiredCommands, hasCommand } from './commandChecks.mjs';
import {
  buildLiveInstallPlan,
  installLiveTyrian,
  LIVE_INSTALL_BACKUP_OWNER,
  prepareLiveInstallRepository,
} from './installLiveTyrian.mjs';
import { resolveDesktopXdgConfigPath, resolveDesktopXdgRoots } from './desktopPaths.mjs';
import {
  admitOwnedPaths,
  createBackup,
  discardBackup,
  escapeRegExp,
  exists,
  findLatestBackup,
  installPath,
  isSameOrDescendant,
  operation,
  readBackupManifest,
  reexecUnderDesktopLock,
  removePath,
  resolvePathIdentity,
  restoreBackup,
  writeFileAtomic,
} from './installOps.mjs';
import {
  PLASMA_LIFECYCLE_PATH,
  TYRIAN_INSTALL_HOME,
  WALLPAPER_ASSET_PATH,
} from './installPaths.mjs';
import { isDirectRun } from '../../../scripts/cli.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const home = os.homedir();

export const RICE_ROOT = 'rice';
const RICE_ROOT_PLACEHOLDER = '{{TYRIAN_RICE_ROOT}}';
export const RICE_WALLPAPER_PLACEHOLDER = `${RICE_ROOT_PLACEHOLDER}/${WALLPAPER_ASSET_PATH}`;
export const RICE_WALLPAPER_PATH = WALLPAPER_ASSET_PATH;
export const RICE_MANIFEST_PATH = `${RICE_ROOT}/plasma-layout/manifest.json`;
export const RICE_MANIFEST_OWNER = 'Tyrian Night rice';
export const RICE_REQUIREMENTS_PATH = `${RICE_ROOT}/plasma-layout/requirements.md`;
// `homePath` is a persistent manifest key. It describes a logical XDG config
// location, not a physical path below the destination home. Keep it stable so
// existing rice snapshots and manifests remain valid.
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
export const RICE_LAYOUT_REQUIRED_COMMANDS = ['qdbus6', 'kscreen-doctor', 'systemctl'];
const PLASMA_PANEL_ALIGNMENTS = new Set(['left', 'center', 'right']);
const PLASMA_PANEL_HIDING_MODES = new Set(['none', 'autohide', 'dodgewindows', 'windowsgobelow']);
const PLASMA_KCONFIG_LOCATION_ENTRIES = /** @type {const} */ ([
  [0, 'floating'],
  [3, 'top'],
  [4, 'bottom'],
  [5, 'left'],
  [6, 'right'],
]);
/** @type {ReadonlyMap<number, PanelLocation>} */
const PLASMA_KCONFIG_LOCATION_TO_SEMANTIC = new Map(PLASMA_KCONFIG_LOCATION_ENTRIES);
const PLASMA_SEMANTIC_LOCATION_TO_KCONFIG = new Map(
  PLASMA_KCONFIG_LOCATION_ENTRIES.map(([numeric, semantic]) => [semantic, numeric])
);
export const RICE_LAYOUT_BACKUP_OWNER = 'rice-layout-apply';
const PLASMA_SHELL_SERVICE = 'plasma-plasmashell.service';
// Preserve KDE's alias applet IDs: icontasks/minimizeall have X-Plasma-RootPath
// metadata that resolves to compiled taskmanager/showdesktop roots, and replacing
// the IDs changes the exact panel mode/look even though Plasma logs mainscript warnings.

/**
 * @typedef {(command: string, args: string[], options?: import('node:child_process').ExecFileSyncOptions) => Buffer | string} CommandRunner
 * @typedef {'top' | 'bottom' | 'left' | 'right' | 'floating'} PanelLocation
 * @typedef {{ hiding: string; alignment: string; lengthRatio: number; height: number; location: PanelLocation }} PanelSnapshotState
 * @typedef {PanelSnapshotState & { screen: number }} PanelRuntimeState
 * @typedef {{ activityId: string; screen: number; image: string; wallpaperPlugin: string }} WallpaperRuntimeState
 * @typedef {import('./desktopPaths.mjs').DesktopXdgRoots} DesktopXdgRoots
 * @typedef {{
 *   apply: boolean;
 *   home: string;
 *   installEntries: Array<{
 *     file: (typeof RICE_LAYOUT_FILES)[number];
 *     installedContent: string;
 *     targetPath: string;
 *   }>;
 *   panelStateById: Map<string, PanelSnapshotState>;
 *   previousPanelStateById: Map<string, PanelRuntimeState>;
 *   previousWallpaperState: WallpaperRuntimeState[];
 *   primaryTarget: { screen: number; width: number; height: number; otherScreens: number[] };
 *   runCommand: CommandRunner;
 *   materializeWallpaper: boolean;
 *   wallpaperSourcePath: string;
 *   wallpaperPath: string;
 *   testInterruptAfterStop?: boolean;
 *   testInterruptAfterRuntime?: boolean;
 * }} PreparedPlasmaLayoutInstall
 * @typedef {{ previousPanels: unknown[]; previousWallpapers: WallpaperRuntimeState[]; primaryScreen: number }} PlasmaRuntimeSnapshot
 * @typedef {{ owner: 'layout'; backupRoot: string } | ({ owner: 'capture' } & PlasmaRuntimeSnapshot)} PlasmaLifecycle
 */

/**
 * Translate the persistent layout key into its physical location for this
 * destination. The key intentionally remains rooted at `.config/` for
 * manifest compatibility while the XDG resolver owns the actual root.
 *
 * @param {DesktopXdgRoots} xdgRoots
 * @param {(typeof RICE_LAYOUT_FILES)[number]} file
 * @returns {string}
 */
function resolveRiceLayoutFilePath(xdgRoots, file) {
  const configPrefix = '.config/';

  if (!file.homePath.startsWith(configPrefix)) {
    throw new Error(`Rice layout key must be rooted at .config/: ${file.homePath}`);
  }

  return resolveDesktopXdgConfigPath(xdgRoots, file.homePath.slice(configPrefix.length));
}

/**
 * @param {ReturnType<typeof buildLiveInstallPlan>} plan
 * @returns {DesktopXdgRoots}
 */
function getPlanXdgRoots(plan) {
  return {
    configRoot: plan.configRoot,
    dataRoot: plan.dataRoot,
    stateRoot: plan.stateRoot,
  };
}

/**
 * @param {{ repoRoot?: string; home?: string }} [options]
 * @returns {void}
 */
export function checkRiceSnapshot(options = {}) {
  const root = resolvePathIdentity(options.repoRoot ?? repoRoot);
  const captureHome = options.home ? resolvePathIdentity(options.home) : undefined;

  checkRiceSnapshotOwned(root, captureHome);
}

/**
 * @param {string} root
 * @param {string | undefined} captureHome
 * @returns {void}
 */
function checkRiceSnapshotOwned(root, captureHome) {
  const layoutContents = new Map();

  for (const file of RICE_LAYOUT_FILES) {
    const snapshotPath = path.join(root, file.snapshotPath);

    if (!exists(snapshotPath)) {
      throw new Error(`Missing rice layout snapshot: ${file.snapshotPath}`);
    }

    assertRegularSourceFileUnder(root, snapshotPath, file.snapshotPath);
    layoutContents.set(file.snapshotPath, fs.readFileSync(snapshotPath, 'utf8'));
  }

  const wallpaperPath = path.join(root, RICE_WALLPAPER_PATH);

  if (!exists(wallpaperPath)) {
    throw new Error(`Missing rice wallpaper asset: ${RICE_WALLPAPER_PATH}`);
  }

  assertRegularSourceFileUnder(root, wallpaperPath, RICE_WALLPAPER_PATH);

  const desktopLayout = layoutContents.get(RICE_LAYOUT_FILES[0].snapshotPath);

  if (desktopLayout === undefined) {
    throw new Error(`Missing rice desktop layout snapshot: ${RICE_LAYOUT_FILES[0].snapshotPath}`);
  }

  if (!desktopLayout.includes(RICE_WALLPAPER_PLACEHOLDER)) {
    throw new Error('Plasma desktop snapshot does not use the portable wallpaper placeholder');
  }

  assertPortablePlasmaLayoutSnapshot(desktopLayout);
  readSnapshotPanelStateById(desktopLayout);
  assertNoHomePaths(layoutContents, captureHome);

  const manifestPath = path.join(root, RICE_MANIFEST_PATH);

  if (!exists(manifestPath)) {
    throw new Error(`Missing rice layout manifest: ${RICE_MANIFEST_PATH}`);
  }

  assertRegularSourceFileUnder(root, manifestPath, RICE_MANIFEST_PATH);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assertRiceManifest(manifest);

  if (!exists(path.join(root, manifest.requirements))) {
    throw new Error(`Missing rice layout requirements: ${manifest.requirements}`);
  }

  assertRegularSourceFileUnder(root, path.join(root, manifest.requirements), manifest.requirements);
}

/**
 * Capture the live Plasma layout into the repository's `rice/` snapshot. The
 * snapshot is tracked by git, which is its history and backup: every file is
 * validated before the first write and then replaced atomically.
 *
 * @param {{ repoRoot?: string; home?: string; environment?: NodeJS.ProcessEnv; runCommand?: CommandRunner; hasCommand?: (command: string) => boolean; testInterruptAfterStop?: boolean; testInterruptAfterRestart?: boolean }} [options]
 * @returns {void}
 */
export function captureRiceLayout(options = {}) {
  const root = resolvePathIdentity(options.repoRoot ?? repoRoot);
  const userHome = resolvePathIdentity(options.home ?? home);
  const environment = options.environment ?? (options.home === undefined ? process.env : {});
  const xdgRoots = resolveDesktopXdgRoots(userHome, environment);
  const runCommand = options.runCommand ?? execFileSync;
  const commandExists = options.hasCommand ?? (options.runCommand ? () => true : hasCommand);
  assertCurrentSessionHome(userHome, options.runCommand !== undefined, 'Rice capture');
  checkRequiredCommands(RICE_LAYOUT_REQUIRED_COMMANDS, true, commandExists, 'Tyrian rice capture');
  admitOwnedPaths(
    root,
    [
      path.join(root, RICE_WALLPAPER_PATH),
      ...RICE_LAYOUT_FILES.map(({ snapshotPath }) => path.join(root, snapshotPath)),
      path.join(root, RICE_MANIFEST_PATH),
    ],
    'Rice capture destination'
  );

  recoverPlasmaLifecycle(userHome, runCommand);
  captureRiceLayoutOwned(
    root,
    userHome,
    xdgRoots,
    runCommand,
    options.testInterruptAfterStop,
    options.testInterruptAfterRestart
  );
}

/**
 * @param {string} root
 * @param {string} userHome
 * @param {DesktopXdgRoots} xdgRoots
 * @param {CommandRunner} runCommand
 * @param {boolean | undefined} testInterruptAfterStop
 * @param {boolean | undefined} testInterruptAfterRestart
 * @returns {void}
 */
function captureRiceLayoutOwned(
  root,
  userHome,
  xdgRoots,
  runCommand,
  testInterruptAfterStop,
  testInterruptAfterRestart
) {
  assertPlasmaShellActive(runCommand, 'Rice capture');
  const desktopLayoutPath = resolveRiceLayoutFilePath(xdgRoots, RICE_LAYOUT_FILES[0]);
  assertRegularSourceFileUnder(userHome, desktopLayoutPath, desktopLayoutPath);
  const beforeStopDesktop = fs.readFileSync(desktopLayoutPath, 'utf8');
  const beforeStopPanels = readSnapshotPanelGenerationById(beforeStopDesktop);
  const preStopPanelState = readLivePanelStateById(runCommand);
  const preStopWallpaperState = readLivePlasmaWallpaperState(runCommand);
  const primaryScreen = readPrimaryPlasmaTarget(runCommand).screen;

  for (const panelId of beforeStopPanels.keys()) {
    if (!preStopPanelState.has(panelId)) {
      throw new Error(`Could not capture runtime state for Plasma panel ${panelId}`);
    }
  }

  /** @type {{ wallpaperSource: string; wallpaperContent: Buffer; rawLayoutContents: Map<string, string> } | undefined} */
  let frozenCapture;
  /** @type {unknown} */
  let captureFailure;
  let stopAttempted = false;
  let preserveInterruptedLifecycle = false;

  try {
    writePlasmaLifecycle(userHome, {
      owner: 'capture',
      ...snapshotPlasmaRuntime(preStopPanelState, preStopWallpaperState, primaryScreen),
    });
    stopAttempted = true;
    stopPlasmaShell(runCommand);

    if (testInterruptAfterStop) {
      preserveInterruptedLifecycle = true;
      throw new SimulatedPlasmaStopInterruption();
    }

    const frozenDesktop = fs.readFileSync(desktopLayoutPath, 'utf8');
    const frozenPanels = readSnapshotPanelGenerationById(frozenDesktop);

    if (
      beforeStopPanels.size !== frozenPanels.size ||
      [...beforeStopPanels].some((panelId) => !frozenPanels.has(panelId))
    ) {
      throw new Error('Plasma panel generation changed while the capture was being frozen');
    }

    const wallpaperSource = findWallpaperSource(frozenDesktop);

    if (!wallpaperSource) {
      throw new Error(`Could not find an existing wallpaper Image= path in ${desktopLayoutPath}`);
    }

    assertRegularSourceFile(wallpaperSource, `captured wallpaper ${wallpaperSource}`);
    const wallpaperContent = fs.readFileSync(wallpaperSource);
    const rawLayoutContents = new Map();

    for (const file of RICE_LAYOUT_FILES) {
      const sourcePath = resolveRiceLayoutFilePath(xdgRoots, file);
      assertRegularSourceFileUnder(userHome, sourcePath, sourcePath);
      rawLayoutContents.set(file.snapshotPath, fs.readFileSync(sourcePath, 'utf8'));
    }

    frozenCapture = { rawLayoutContents, wallpaperContent, wallpaperSource };
  } catch (error) {
    captureFailure = error;
  } finally {
    try {
      if (stopAttempted && !preserveInterruptedLifecycle && !captureFailure) {
        ensurePlasmaShellActive(runCommand, 'Rice capture recovery');
      }
    } catch (restoreError) {
      captureFailure = captureFailure
        ? new AggregateError(
            [captureFailure, restoreError],
            'Rice capture failed and the Plasma shell lifecycle could not be restored'
          )
        : restoreError;
    }
  }

  if (captureFailure) {
    if (
      !(captureFailure instanceof SimulatedPlasmaStopInterruption) &&
      exists(path.join(userHome, PLASMA_LIFECYCLE_PATH))
    ) {
      try {
        recoverPlasmaLifecycle(userHome, runCommand);
      } catch (recoveryError) {
        throw new AggregateError(
          [captureFailure, recoveryError],
          'Rice capture failed and its persisted Plasma state could not be restored'
        );
      }
    }

    throw captureFailure;
  }

  if (!frozenCapture) {
    throw new Error('Rice capture completed without a frozen snapshot');
  }

  if (testInterruptAfterRestart) {
    throw new SimulatedCaptureProofInterruption();
  }

  /** @type {Map<string, PanelRuntimeState>} */
  let postStartPanelState;

  try {
    postStartPanelState = readLivePanelStateById(runCommand);
    const postStartWallpaperState = readLivePlasmaWallpaperState(runCommand);
    const panelDrifted = !samePanelRuntimeState(preStopPanelState, postStartPanelState);
    const wallpaperDrifted = !sameWallpaperRuntimeState(
      preStopWallpaperState,
      postStartWallpaperState
    );

    if (panelDrifted || wallpaperDrifted) {
      const driftError = new Error(
        panelDrifted
          ? 'Plasma panel runtime state changed across the capture shell round-trip'
          : 'Plasma wallpaper runtime state changed across the capture shell round-trip'
      );

      restorePlasmaPanelState(preStopPanelState, primaryScreen, runCommand);
      restorePlasmaWallpaperState(preStopWallpaperState, runCommand);
      const reconciledState = readLivePanelStateById(runCommand);
      const reconciledWallpaperState = readLivePlasmaWallpaperState(runCommand);

      if (
        !samePanelRuntimeState(preStopPanelState, reconciledState) ||
        !sameWallpaperRuntimeState(preStopWallpaperState, reconciledWallpaperState)
      ) {
        throw new Error('Plasma runtime reconciliation did not restore the exact prior state');
      }

      finishPlasmaLifecycle(userHome);
      throw driftError;
    }

    finishPlasmaLifecycle(userHome);
  } catch (error) {
    if (exists(path.join(userHome, PLASMA_LIFECYCLE_PATH))) {
      try {
        recoverPlasmaLifecycle(userHome, runCommand);
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          'Plasma panel state drifted and persisted reconciliation failed'
        );
      }
    }

    throw error;
  }

  const layoutContents = new Map();

  for (const file of RICE_LAYOUT_FILES) {
    let content = frozenCapture.rawLayoutContents.get(file.snapshotPath) ?? '';

    if (file.portableWallpaper) {
      content = sanitizePlasmaDesktopLayout(
        makeWallpaperPortable(content, frozenCapture.wallpaperSource)
      );
      content = applyPanelStateToDesktopLayout(content, postStartPanelState);
    } else if (file.snapshotPath === RICE_LAYOUT_FILES[1].snapshotPath) {
      content = sanitizePlasmaShellConfig(content);
    }

    layoutContents.set(file.snapshotPath, content);
  }

  validateCapturedRiceSnapshot(layoutContents, userHome);

  const capturedFiles = [
    {
      content: frozenCapture.wallpaperContent,
      message: `capture wallpaper ${frozenCapture.wallpaperSource}`,
      targetPath: path.join(root, RICE_WALLPAPER_PATH),
    },
    ...RICE_LAYOUT_FILES.map((file) => ({
      content: Buffer.from(
        `${(layoutContents.get(file.snapshotPath) ?? '').replace(/\n?$/u, '')}\n`,
        'utf8'
      ),
      message: `capture ${resolveRiceLayoutFilePath(xdgRoots, file)}`,
      targetPath: path.join(root, file.snapshotPath),
    })),
    {
      content: Buffer.from(`${JSON.stringify(buildRiceManifest(), null, 2)}\n`, 'utf8'),
      message: 'write rice layout manifest',
      targetPath: path.join(root, RICE_MANIFEST_PATH),
    },
  ];

  for (const { content, message, targetPath } of capturedFiles) {
    console.log(message);
    writeFileAtomic(targetPath, content);
  }
}

class SimulatedPlasmaStopInterruption extends Error {
  constructor() {
    super('Simulated interruption while the Plasma shell is stopped');
  }
}

class SimulatedCaptureProofInterruption extends Error {
  constructor() {
    super('Simulated interruption before proving the restarted Plasma state');
  }
}

/**
 * @param {Map<string, PanelRuntimeState>} panels
 * @param {WallpaperRuntimeState[]} wallpapers
 * @param {number} primaryScreen
 * @returns {PlasmaRuntimeSnapshot}
 */
function snapshotPlasmaRuntime(panels, wallpapers, primaryScreen) {
  return {
    previousPanels: [...panels].map(([id, state]) => ({ id, ...state })),
    previousWallpapers: wallpapers,
    primaryScreen,
  };
}

/**
 * Validate a recorded runtime snapshot from a lifecycle record or backup.
 *
 * @param {unknown} value
 * @param {string} source
 * @returns {PlasmaRuntimeSnapshot}
 */
function requirePlasmaRuntimeSnapshot(value, source) {
  const snapshot = /** @type {Partial<PlasmaRuntimeSnapshot> | null | undefined} */ (value);
  if (
    !Array.isArray(snapshot?.previousPanels) ||
    !Array.isArray(snapshot.previousWallpapers) ||
    !snapshot.previousWallpapers.every(isWallpaperRuntimeState) ||
    !Number.isSafeInteger(snapshot.primaryScreen) ||
    /** @type {number} */ (snapshot.primaryScreen) < 0
  ) {
    throw new Error(`${source} has no valid Plasma runtime state`);
  }
  parsePanelStateJson(JSON.stringify(snapshot.previousPanels));
  return /** @type {PlasmaRuntimeSnapshot} */ (snapshot);
}

/**
 * Put the Plasma shell back to a recorded runtime state and prove it.
 *
 * @param {PlasmaRuntimeSnapshot} snapshot
 * @param {CommandRunner} runCommand
 * @returns {void}
 */
function restorePlasmaRuntime(snapshot, runCommand) {
  ensurePlasmaShellActive(runCommand, 'Plasma runtime restore');
  const previousPanels = parsePanelStateJson(JSON.stringify(snapshot.previousPanels));
  restorePlasmaPanelState(previousPanels, snapshot.primaryScreen, runCommand);

  if (!samePanelRuntimeState(previousPanels, readLivePanelStateById(runCommand))) {
    throw new Error('Plasma recovery did not restore the exact prior panel state');
  }

  restorePlasmaWallpaperState(snapshot.previousWallpapers, runCommand);

  if (
    !sameWallpaperRuntimeState(
      snapshot.previousWallpapers,
      readLivePlasmaWallpaperState(runCommand)
    )
  ) {
    throw new Error('Plasma recovery did not restore the exact prior wallpaper state');
  }
}

/**
 * Restore a Plasma layout backup: files are replaced while the shell is
 * stopped, because a running shell rewrites its layout on exit; the recorded
 * panel and wallpaper state is then reapplied and proved. The backup holds
 * that runtime state, so it is kept until the caller has finished with it.
 *
 * @param {string} userHome
 * @param {string} backupRoot
 * @param {CommandRunner} runCommand
 * @returns {void}
 */
function restorePlasmaLayoutBackup(userHome, backupRoot, runCommand) {
  const runtime = requirePlasmaRuntimeSnapshot(
    readBackupManifest(userHome, backupRoot).details,
    `Plasma layout backup ${backupRoot}`
  );

  if (isPlasmaShellActive(runCommand)) {
    stopPlasmaShell(runCommand);
  }

  restoreBackup(userHome, backupRoot);
  restorePlasmaRuntime(runtime, runCommand);
}

/**
 * Finish a Plasma lifecycle a previous process left open: a layout apply is
 * rolled back from its backup, a capture only restarts the shell and restores
 * its runtime state. Returns whether a lifecycle was recovered.
 *
 * @param {string} userHome
 * @param {CommandRunner} runCommand
 * @returns {boolean}
 */
function recoverPlasmaLifecycle(userHome, runCommand) {
  const lifecycle = readPlasmaLifecycle(userHome);

  if (lifecycle === undefined) {
    return false;
  }

  // An open layout lifecycle always has its complete backup: the backup is
  // written before the lifecycle opens and discarded only after it closes.
  if (lifecycle.owner === 'layout') {
    if (!exists(lifecycle.backupRoot)) {
      throw new Error(
        `The interrupted Plasma layout run cannot be rolled back: its backup ${lifecycle.backupRoot} is missing. Restore the Plasma layout manually, then delete ${path.join(userHome, PLASMA_LIFECYCLE_PATH)}.`
      );
    }
    restorePlasmaLayoutBackup(userHome, lifecycle.backupRoot, runCommand);
    finishPlasmaLifecycle(userHome);
    discardBackup(lifecycle.backupRoot);
    return true;
  }

  restorePlasmaRuntime(lifecycle, runCommand);
  finishPlasmaLifecycle(userHome);
  return true;
}

/**
 * Undo the most recent rice change: an interrupted Plasma lifecycle first,
 * otherwise the latest backup, whether a Plasma layout or a style install.
 *
 * @param {{ home?: string; runCommand?: CommandRunner }} [options]
 * @returns {'interrupted' | 'backup' | 'none'}
 */
export function recoverRice(options = {}) {
  const userHome = resolvePathIdentity(options.home ?? home);
  const runCommand = options.runCommand ?? execFileSync;

  if (recoverPlasmaLifecycle(userHome, runCommand)) {
    console.log('Tyrian rice recovery rolled back an interrupted Plasma run.');
    return 'interrupted';
  }

  const latest = findLatestBackup(userHome);
  if (latest === undefined) {
    console.log('No Tyrian backup to restore.');
    return 'none';
  }

  if (latest.manifest.owner === RICE_LAYOUT_BACKUP_OWNER) {
    restorePlasmaLayoutBackup(userHome, latest.backupRoot, runCommand);
  } else if (latest.manifest.owner === LIVE_INSTALL_BACKUP_OWNER) {
    restoreBackup(userHome, latest.backupRoot);
  } else {
    throw new Error(`Unknown Tyrian backup owner '${latest.manifest.owner}'.`);
  }
  discardBackup(latest.backupRoot);
  console.log(`Restored Tyrian backup from ${latest.manifest.createdAt}.`);
  return 'backup';
}

/**
 * @param {string} userHome
 * @param {PlasmaLifecycle} lifecycle
 * @returns {void}
 */
function writePlasmaLifecycle(userHome, lifecycle) {
  const lifecyclePath = path.join(userHome, PLASMA_LIFECYCLE_PATH);

  if (exists(lifecyclePath)) {
    throw new Error('A Plasma lifecycle journal is already active');
  }

  writeFileAtomic(lifecyclePath, `${JSON.stringify(lifecycle, null, 2)}\n`);
}

/**
 * @param {string} userHome
 * @returns {PlasmaLifecycle | undefined}
 */
function readPlasmaLifecycle(userHome) {
  const lifecyclePath = path.join(userHome, PLASMA_LIFECYCLE_PATH);

  if (!exists(lifecyclePath)) {
    return undefined;
  }

  const lifecycle = /** @type {any} */ (JSON.parse(fs.readFileSync(lifecyclePath, 'utf8')));
  const fields =
    lifecycle !== null && typeof lifecycle === 'object' && !Array.isArray(lifecycle)
      ? Object.keys(lifecycle).toSorted().join(',')
      : '';

  if (
    lifecycle?.owner === 'capture' &&
    fields === 'owner,previousPanels,previousWallpapers,primaryScreen'
  ) {
    requirePlasmaRuntimeSnapshot(lifecycle, 'Plasma lifecycle journal');
    return lifecycle;
  }
  if (
    lifecycle?.owner === 'layout' &&
    fields === 'backupRoot,owner' &&
    typeof lifecycle.backupRoot === 'string' &&
    path.isAbsolute(lifecycle.backupRoot)
  ) {
    return lifecycle;
  }
  throw new Error('Plasma lifecycle journal is corrupt');
}

/**
 * @param {string} userHome
 * @returns {void}
 */
function finishPlasmaLifecycle(userHome) {
  removePath(path.join(userHome, PLASMA_LIFECYCLE_PATH));
}

/**
 * @param {Map<string, string>} layoutContents
 * @param {string} captureHome
 * @returns {void}
 */
function validateCapturedRiceSnapshot(layoutContents, captureHome) {
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
  readSnapshotPanelStateById(desktopLayout);
  assertNoHomePaths(layoutContents, captureHome);
}

/**
 * @param {string} sourcePath
 * @param {string} label
 * @returns {void}
 */
function assertRegularSourceFile(sourcePath, label) {
  const stats = fs.lstatSync(sourcePath);

  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular file, not a symbolic link or another file type`);
  }
}

/**
 * @param {string} root
 * @param {string} sourcePath
 * @param {string} label
 * @returns {void}
 */
function assertRegularSourceFileUnder(root, sourcePath, label) {
  const relativePath = path.relative(root, sourcePath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`${label} is outside its owning root`);
  }

  let currentPath = root;

  for (const segment of relativePath.split(path.sep)) {
    currentPath = path.join(currentPath, segment);
    const stats = fs.lstatSync(currentPath);

    if (stats.isSymbolicLink()) {
      throw new Error(`${label} traverses a symbolic link`);
    }
  }

  assertRegularSourceFile(sourcePath, label);
}

/**
 * @param {string} leftRoot
 * @param {string} rightRoot
 * @param {string} owner
 * @returns {void}
 */
function assertIndependentRoots(leftRoot, rightRoot, owner) {
  const left = resolvePathIdentity(leftRoot);
  const right = resolvePathIdentity(rightRoot);

  if (isSameOrDescendant(left, right) || isSameOrDescendant(right, left)) {
    throw new Error(`${owner} must not overlap: ${leftRoot} <-> ${rightRoot}`);
  }
}

/**
 * @param {string} userHome
 * @param {boolean} customRunner
 * @param {string} owner
 * @returns {void}
 */
function assertCurrentSessionHome(userHome, customRunner, owner) {
  if (!customRunner && resolvePathIdentity(home) !== userHome) {
    throw new Error(`${owner} cannot mutate the current Plasma session for another home`);
  }
}

/**
 * @param {CommandRunner} runCommand
 * @returns {boolean}
 */
function isPlasmaShellActive(runCommand) {
  try {
    runCommand('systemctl', ['--user', 'is-active', '--quiet', PLASMA_SHELL_SERVICE], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {CommandRunner} runCommand
 * @param {string} owner
 * @returns {void}
 */
function assertPlasmaShellActive(runCommand, owner) {
  if (!isPlasmaShellActive(runCommand)) {
    throw new Error(`${owner} requires an active ${PLASMA_SHELL_SERVICE}`);
  }
}

/**
 * @param {Map<string, PanelRuntimeState>} before
 * @param {Map<string, PanelRuntimeState>} after
 * @returns {boolean}
 */
function samePanelRuntimeState(before, after) {
  return (
    before.size === after.size &&
    [...before].every(([panelId, expected]) => {
      const actual = after.get(panelId);

      return (
        actual !== undefined &&
        actual.hiding === expected.hiding &&
        actual.alignment === expected.alignment &&
        actual.screen === expected.screen &&
        actual.location === expected.location &&
        Math.abs((actual.lengthRatio ?? 0) - (expected.lengthRatio ?? 0)) <= 0.002 &&
        Math.abs((actual.height ?? 0) - (expected.height ?? 0)) <= 0.5
      );
    })
  );
}

/**
 * @param {WallpaperRuntimeState[]} before
 * @param {WallpaperRuntimeState[]} after
 * @returns {boolean}
 */
function sameWallpaperRuntimeState(before, after) {
  /**
   * @param {WallpaperRuntimeState[]} states
   */
  const normalize = (states) =>
    states
      .map(({ activityId, screen, image, wallpaperPlugin }) => ({
        activityId,
        screen,
        image,
        wallpaperPlugin,
      }))
      .toSorted((left, right) =>
        `${left.activityId}:${left.screen}`.localeCompare(`${right.activityId}:${right.screen}`)
      );

  return JSON.stringify(normalize(before)) === JSON.stringify(normalize(after));
}

/**
 * @param {Map<string, PanelSnapshotState>} panelStateById
 * @param {number} screen
 * @returns {Map<string, PanelRuntimeState>}
 */
function buildDesiredPanelRuntimeState(panelStateById, screen) {
  return new Map(
    [...panelStateById].map(([panelId, state]) => {
      const location = state.location;

      if (!location || !PLASMA_SEMANTIC_LOCATION_TO_KCONFIG.has(location)) {
        throw new Error(`Plasma panel ${panelId} has no owned placement in the layout snapshot`);
      }

      return [panelId, { ...state, location, screen }];
    })
  );
}

/**
 * Install the rice: the Plasma style (convergent, see installLiveTyrian) and
 * then the Plasma layout, which rolls itself back if the shell does not come
 * back in the requested state. A layout failure leaves the style installed.
 *
 * @param {{ repoRoot?: string; home?: string; apply?: boolean; withPlasmaLayout?: boolean; layoutOnly?: boolean; link?: boolean; environment?: NodeJS.ProcessEnv; runCommand?: CommandRunner; hasCommand?: (command: string) => boolean; testInterruptAfterStop?: boolean; testInterruptAfterRuntime?: boolean }} [options]
 * @returns {void}
 */
export function installRice(options = {}) {
  const root = resolvePathIdentity(options.repoRoot ?? repoRoot);
  const userHome = resolvePathIdentity(options.home ?? home);
  const apply = options.apply ?? false;
  const withPlasmaLayout = options.withPlasmaLayout ?? true;
  const layoutOnly = options.layoutOnly ?? false;
  const link = options.link ?? false;
  const runCommand = options.runCommand ?? execFileSync;
  const commandExists = options.hasCommand ?? (options.runCommand ? () => true : hasCommand);
  const environment = options.environment ?? (options.home === undefined ? process.env : {});
  const runtimeRoot = resolvePathIdentity(link ? root : path.join(userHome, TYRIAN_INSTALL_HOME));

  if (apply && withPlasmaLayout) {
    assertCurrentSessionHome(userHome, options.runCommand !== undefined, 'Plasma layout install');
  }

  if (layoutOnly) {
    assertIndependentRoots(root, runtimeRoot, 'Rice repository and layout runtime root');
  }

  if (apply) {
    recoverPlasmaLifecycle(userHome, runCommand);
  }

  const livePlan = !layoutOnly
    ? buildLiveInstallPlan({
        repoRoot: root,
        home: userHome,
        apply,
        link,
        target: 'plasma',
        environment,
      })
    : undefined;
  if (withPlasmaLayout) {
    checkRequiredCommands(RICE_LAYOUT_REQUIRED_COMMANDS, apply, commandExists, 'Tyrian rice');
  }

  // Validate the layout and read the live shell before the style changes anything.
  const preparedLayout = withPlasmaLayout
    ? preparePlasmaLayoutInstallOwned({
        repoRoot: root,
        home: userHome,
        xdgRoots: livePlan
          ? getPlanXdgRoots(livePlan)
          : resolveDesktopXdgRoots(userHome, environment),
        runtimeRoot,
        materializeWallpaper: layoutOnly && !link,
        apply,
        runCommand,
        testInterruptAfterStop: options.testInterruptAfterStop,
        testInterruptAfterRuntime: options.testInterruptAfterRuntime,
      })
    : undefined;

  if (!layoutOnly) {
    installLiveTyrian({
      repoRoot: root,
      home: userHome,
      apply,
      link,
      target: 'plasma',
      environment,
      stagingRoot: livePlan?.stagingRoot,
    });
  }

  if (preparedLayout) {
    installPreparedPlasmaLayout(preparedLayout);
  } else {
    console.log(
      `${apply ? 'apply' : 'dry-run'}: Plasma layout restore skipped by explicit partial install mode`
    );
  }
}

/**
 * @param {{ repoRoot?: string; home?: string; runtimeRoot?: string; apply?: boolean; environment?: NodeJS.ProcessEnv; runCommand?: CommandRunner; hasCommand?: (command: string) => boolean; testInterruptAfterStop?: boolean; testInterruptAfterRuntime?: boolean }} [options]
 * @returns {void}
 */
export function installPlasmaLayout(options = {}) {
  const root = resolvePathIdentity(options.repoRoot ?? repoRoot);
  const userHome = resolvePathIdentity(options.home ?? home);
  const runtimeRoot = resolvePathIdentity(
    options.runtimeRoot ?? path.join(userHome, TYRIAN_INSTALL_HOME)
  );
  const apply = options.apply ?? false;
  const environment = options.environment ?? (options.home === undefined ? process.env : {});
  const xdgRoots = resolveDesktopXdgRoots(userHome, environment);
  const runCommand = options.runCommand ?? execFileSync;
  const commandExists = options.hasCommand ?? (options.runCommand ? () => true : hasCommand);

  if (apply) {
    assertCurrentSessionHome(userHome, options.runCommand !== undefined, 'Plasma layout install');
    if (recoverPlasmaLifecycle(userHome, runCommand)) {
      console.log('Rolled back an interrupted Plasma run before applying the layout.');
    }
  }

  checkRequiredCommands(
    RICE_LAYOUT_REQUIRED_COMMANDS,
    apply,
    commandExists,
    'Plasma layout install'
  );
  installPreparedPlasmaLayout(
    preparePlasmaLayoutInstallOwned({
      repoRoot: root,
      home: userHome,
      xdgRoots,
      runtimeRoot,
      materializeWallpaper: true,
      apply,
      runCommand,
      testInterruptAfterStop: options.testInterruptAfterStop,
      testInterruptAfterRuntime: options.testInterruptAfterRuntime,
    })
  );
}

/**
 * @param {{ repoRoot?: string; home?: string; xdgRoots: DesktopXdgRoots; runtimeRoot?: string; materializeWallpaper?: boolean; apply?: boolean; runCommand?: CommandRunner; testInterruptAfterStop?: boolean; testInterruptAfterRuntime?: boolean }} options
 * @returns {PreparedPlasmaLayoutInstall}
 */
function preparePlasmaLayoutInstallOwned(options) {
  const root = options.repoRoot ?? repoRoot;
  const userHome = options.home ?? home;
  const xdgRoots = options.xdgRoots;
  const runtimeRoot = options.runtimeRoot ?? path.join(userHome, TYRIAN_INSTALL_HOME);
  const apply = options.apply ?? false;
  const runCommand = options.runCommand ?? execFileSync;

  checkRiceSnapshotOwned(root, userHome);

  if (apply) {
    assertPlasmaShellActive(runCommand, 'Plasma layout install');
  }

  const sourceEntries = RICE_LAYOUT_FILES.map((file) => ({
    file,
    targetPath: resolveRiceLayoutFilePath(xdgRoots, file),
    sourceContent: fs.readFileSync(path.join(root, file.snapshotPath), 'utf8'),
  }));
  admitOwnedPaths(
    userHome,
    sourceEntries.map(({ targetPath }) => targetPath),
    'Plasma layout target'
  );
  const currentActivityId = apply ? readCurrentPlasmaActivityId(runCommand) : '';
  const primaryTarget = apply
    ? readPrimaryPlasmaTarget(runCommand)
    : { height: 0, otherScreens: [], screen: 0, width: 0 };
  const previousPanelStateById = apply ? readLivePanelStateById(runCommand) : new Map();
  const previousWallpaperState = apply ? readLivePlasmaWallpaperState(runCommand) : [];
  const installEntries = sourceEntries.map(({ file, targetPath, sourceContent }) => {
    let installedContent = sourceContent.replaceAll(RICE_ROOT_PLACEHOLDER, () => runtimeRoot);

    if (apply && file.portableWallpaper) {
      installedContent = hydratePlasmaDesktopActivityIds(installedContent, currentActivityId);
      installedContent = hydratePlasmaPrimaryScreenAssignments(installedContent, primaryTarget);
    } else if (apply && file.homePath === RICE_LAYOUT_FILES[1].homePath) {
      installedContent = hydratePlasmaShellPanelViews(installedContent, primaryTarget);
    }

    return {
      file,
      installedContent: installedContent.endsWith('\n')
        ? installedContent
        : `${installedContent}\n`,
      targetPath,
    };
  });

  const panelStateById = readSnapshotPanelStateById(
    installEntries.find(({ file }) => file.portableWallpaper)?.installedContent ?? ''
  );
  const wallpaperSourcePath = path.join(root, RICE_WALLPAPER_PATH);
  const wallpaperPath = path.join(runtimeRoot, RICE_WALLPAPER_PATH);
  const materializeWallpaper =
    (options.materializeWallpaper ?? false) &&
    path.resolve(wallpaperSourcePath) !== path.resolve(wallpaperPath);

  return {
    apply,
    home: userHome,
    installEntries,
    panelStateById,
    previousPanelStateById,
    previousWallpaperState,
    primaryTarget,
    runCommand,
    materializeWallpaper,
    wallpaperSourcePath,
    wallpaperPath,
    testInterruptAfterStop: options.testInterruptAfterStop,
    testInterruptAfterRuntime: options.testInterruptAfterRuntime,
  };
}

/**
 * Back up the layout, record the open lifecycle, then replace the layout with
 * the shell stopped and prove the restarted shell. Any failure restores the
 * backup and the prior runtime state; a crash leaves the lifecycle record for
 * the next rice command to roll back.
 *
 * @param {PreparedPlasmaLayoutInstall} plan
 * @returns {void}
 */
function installPreparedPlasmaLayout(plan) {
  if (!plan.apply) {
    if (plan.materializeWallpaper) {
      operation(false, `would copy ${plan.wallpaperSourcePath} -> ${plan.wallpaperPath}`, () => {});
    }
    operation(false, 'would stop Plasma shell before restoring layout', () => {});

    for (const { targetPath } of plan.installEntries) {
      operation(false, `would restore ${targetPath}`, () => {});
    }

    operation(false, 'would start Plasma shell', () => {});
    operation(false, 'would restore Plasma panel runtime state', () => {});
    operation(false, `would apply Plasma wallpaper ${plan.wallpaperPath}`, () => {});
    return;
  }

  const desiredPanelState = buildDesiredPanelRuntimeState(
    plan.panelStateById,
    plan.primaryTarget.screen
  );
  const backupRoot = createBackup(
    plan.home,
    RICE_LAYOUT_BACKUP_OWNER,
    [
      ...plan.installEntries.map(({ targetPath }) => targetPath),
      ...(plan.materializeWallpaper ? [plan.wallpaperPath] : []),
    ],
    snapshotPlasmaRuntime(
      plan.previousPanelStateById,
      plan.previousWallpaperState,
      plan.primaryTarget.screen
    )
  );
  writePlasmaLifecycle(plan.home, { owner: 'layout', backupRoot });

  try {
    if (plan.materializeWallpaper) {
      operation(true, `copy ${plan.wallpaperSourcePath} -> ${plan.wallpaperPath}`, () => {
        installPath('copy', plan.wallpaperSourcePath, plan.wallpaperPath);
      });
    }

    console.log('apply: stop Plasma shell before restoring layout');
    stopPlasmaShell(plan.runCommand);

    if (plan.testInterruptAfterStop) {
      throw new SimulatedPlasmaStopInterruption();
    }

    for (const entry of plan.installEntries) {
      console.log(`apply: restore ${entry.targetPath}`);
      writeFileAtomic(entry.targetPath, entry.installedContent);
    }

    console.log('apply: start Plasma shell');
    startPlasmaShell(plan.runCommand);

    operation(true, 'restore Plasma panel runtime state', () => {
      restorePlasmaPanelState(desiredPanelState, plan.primaryTarget.screen, plan.runCommand);
    });

    operation(true, `apply Plasma wallpaper ${plan.wallpaperPath}`, () => {
      applyPlasmaWallpaper(plan.wallpaperPath, plan.runCommand);
    });

    const appliedPanelState = readLivePanelStateById(plan.runCommand);

    if (!samePanelRuntimeState(desiredPanelState, appliedPanelState)) {
      throw new Error(
        `Plasma panel runtime state did not match the requested layout: expected ${JSON.stringify(Object.fromEntries(desiredPanelState))}, received ${JSON.stringify(Object.fromEntries(appliedPanelState))}`
      );
    }

    assertPlasmaWallpaperApplied(plan.wallpaperPath, plan.runCommand);

    if (plan.testInterruptAfterRuntime) {
      throw new SimulatedPlasmaRuntimeInterruption();
    }
  } catch (error) {
    if (
      error instanceof SimulatedPlasmaStopInterruption ||
      error instanceof SimulatedPlasmaRuntimeInterruption
    ) {
      throw error;
    }

    try {
      recoverPlasmaLifecycle(plan.home, plan.runCommand);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Plasma layout install and its rollback both failed'
      );
    }
    throw error;
  }

  finishPlasmaLifecycle(plan.home);
  console.log(`Plasma layout install complete. Backup: ${backupRoot}`);
}

class SimulatedPlasmaRuntimeInterruption extends Error {
  constructor() {
    super('Simulated interruption after applying Plasma runtime state');
  }
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

      return section.replace(/^activityId=.*$/mu, () => `activityId=${activityId}`);
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

  if (plasmaScreens.length === 0) {
    throw new Error('Could not read Plasma screen geometries.');
  }

  const matchingScreen = plasmaScreens.find(
    (screen) =>
      screen.x === primaryGeometry.x &&
      screen.y === primaryGeometry.y &&
      screen.width === primaryGeometry.width &&
      screen.height === primaryGeometry.height
  );

  if (!matchingScreen) {
    throw new Error('Plasma screen geometry does not match the primary output.');
  }

  return {
    height: primaryGeometry.height,
    otherScreens: plasmaScreens
      .map((screen) => screen.screen)
      .filter((screen) => screen !== matchingScreen.screen),
    screen: matchingScreen.screen,
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
 * @returns {Map<string, PanelRuntimeState>}
 */
function readLivePanelStateById(runCommand) {
  const output = String(
    runCommand(
      'qdbus6',
      [
        'org.kde.plasmashell',
        '/PlasmaShell',
        'org.kde.PlasmaShell.evaluateScript',
        [
          'var values = [];',
          'var ids = panelIds;',
          'for (var i = 0; i < ids.length; i++) {',
          '  var panel = panelById(ids[i]);',
          '  var width = 0;',
          '  panel.currentConfigGroup = [];',
          '  var lastScreen = Number(panel.readConfig("lastScreen"));',
          '  var actualScreen = Number(panel.screen);',
          '  if (actualScreen < 0) actualScreen = lastScreen;',
          '  try {',
          '    var panelGeometry = screenGeometry(actualScreen);',
          '    if (panelGeometry.width > 0) width = panelGeometry.width;',
          '  } catch (error) {}',
          '  values.push({',
          '    id: String(ids[i]),',
          '    hiding: String(panel.hiding),',
          '    alignment: String(panel.alignment),',
          '    screen: actualScreen,',
          '    location: String(panel.location),',
          '    lengthRatio: width > 0 ? panel.length / width : null,',
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
}

/**
 * @param {string} output
 * @returns {Map<string, PanelRuntimeState>}
 */
function parsePanelStateJson(output) {
  const parsed = parseJsonFromQdbusOutput(output);

  if (!Array.isArray(parsed)) {
    throw new Error('Could not parse live Plasma panel runtime state.');
  }

  const states = new Map();

  for (const entry of parsed) {
    if (
      typeof entry?.id !== 'string' ||
      entry.id.length === 0 ||
      !PLASMA_PANEL_HIDING_MODES.has(entry.hiding) ||
      !PLASMA_PANEL_ALIGNMENTS.has(entry.alignment) ||
      !Number.isSafeInteger(entry.screen) ||
      entry.screen < 0 ||
      !PLASMA_SEMANTIC_LOCATION_TO_KCONFIG.has(entry.location) ||
      !Number.isFinite(entry.lengthRatio) ||
      entry.lengthRatio <= 0 ||
      !Number.isFinite(entry.height) ||
      entry.height <= 0
    ) {
      throw new Error('Could not parse live Plasma panel runtime state.');
    }

    if (states.has(entry.id)) {
      throw new Error(`Plasma panel ${entry.id} appeared more than once in runtime state.`);
    }

    states.set(entry.id, {
      alignment: entry.alignment,
      height: Number(entry.height),
      hiding: entry.hiding,
      lengthRatio: Number(entry.lengthRatio),
      location: entry.location,
      screen: Number(entry.screen),
    });
  }

  return states;
}

/**
 * @param {string} desktopLayout
 * @param {Map<string, PanelRuntimeState>} panelStateById
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

    if (state.location !== undefined) {
      const numericLocation = PLASMA_SEMANTIC_LOCATION_TO_KCONFIG.get(state.location);

      if (numericLocation === undefined) {
        throw new Error(`Plasma panel ${id} has unsupported runtime location ${state.location}`);
      }

      nextSection = upsertSectionKey(nextSection, 'location', String(numericLocation));
    }

    return nextSection;
  });
}

/**
 * @param {string} desktopLayout
 * @returns {Map<string, PanelSnapshotState>}
 */
function readSnapshotPanelStateById(desktopLayout) {
  /** @type {Map<string, Partial<PanelSnapshotState>>} */
  const candidates = new Map();

  replaceContainmentSections(desktopLayout, (section, id) => {
    if (!/^plugin=org\.kde\.panel$/mu.test(section)) {
      return section;
    }

    const alignment = section.match(/^tyrianPanelAlignment=(.+)$/mu)?.[1];
    const height = parseOptionalNumber(section.match(/^tyrianPanelHeight=(.+)$/mu)?.[1]);
    const hiding = section.match(/^hiding=(.+)$/mu)?.[1];
    const lengthRatio = parseOptionalNumber(section.match(/^tyrianPanelLengthRatio=(.+)$/mu)?.[1]);
    const location = parsePanelLocationFromKConfig(section.match(/^location=(.+)$/mu)?.[1], id);
    assertUniqueSnapshotPanelIdentity(candidates, id);
    candidates.set(id, {
      ...(alignment === undefined ? {} : { alignment }),
      ...(height === undefined ? {} : { height }),
      ...(hiding === undefined ? {} : { hiding }),
      ...(lengthRatio === undefined ? {} : { lengthRatio }),
      ...(location === undefined ? {} : { location }),
    });

    return section;
  });

  /** @type {Map<string, PanelSnapshotState>} */
  const panelStateById = new Map();
  for (const [id, state] of candidates) {
    if (
      !PLASMA_PANEL_ALIGNMENTS.has(state.alignment ?? '') ||
      !PLASMA_PANEL_HIDING_MODES.has(state.hiding ?? '') ||
      state.height === undefined ||
      !Number.isFinite(state.height) ||
      state.height <= 0 ||
      state.lengthRatio === undefined ||
      !Number.isFinite(state.lengthRatio) ||
      state.lengthRatio <= 0 ||
      state.location === undefined
    ) {
      throw new Error(
        `Plasma panel ${id} has incomplete or invalid owned runtime state: ${JSON.stringify(state)}`
      );
    }

    panelStateById.set(id, /** @type {PanelSnapshotState} */ (state));
  }

  return panelStateById;
}

/**
 * Capture reads the raw Plasma file before repository-owned runtime metadata is
 * projected into it. At that boundary only panel identity is authoritative.
 *
 * @param {string} desktopLayout
 * @returns {Set<string>}
 */
function readSnapshotPanelGenerationById(desktopLayout) {
  const panels = new Set();

  replaceContainmentSections(desktopLayout, (section, id) => {
    if (!/^plugin=org\.kde\.panel$/mu.test(section)) return section;
    assertUniqueSnapshotPanelIdentity(panels, id);
    panels.add(id);
    return section;
  });

  return panels;
}

/**
 * @param {Map<string, unknown> | Set<string>} panels
 * @param {string} id
 * @returns {void}
 */
function assertUniqueSnapshotPanelIdentity(panels, id) {
  if (panels.has(id)) {
    throw new Error(`Plasma snapshot contains duplicate panel identity ${id}.`);
  }
}

/**
 * @param {Map<string, PanelRuntimeState>} panelStateById
 * @param {number} primaryScreen
 * @param {CommandRunner} runCommand
 * @returns {void}
 */
function restorePlasmaPanelState(panelStateById, primaryScreen, runCommand) {
  const output = String(
    runCommand(
      'qdbus6',
      [
        'org.kde.plasmashell',
        '/PlasmaShell',
        'org.kde.PlasmaShell.evaluateScript',
        buildPlasmaPanelStateScript(panelStateById, primaryScreen),
      ],
      { encoding: 'utf8' }
    )
  );
  const result = /** @type {{ requested?: unknown; updated?: unknown; missing?: unknown }} */ (
    parseJsonFromQdbusOutput(output)
  );
  const requestedIds = [...panelStateById.keys()].toSorted();
  const updatedIds = Array.isArray(result?.updated)
    ? result.updated.map(String).toSorted()
    : undefined;

  if (
    !Array.isArray(result?.requested) ||
    !Array.isArray(result?.missing) ||
    result.missing.length > 0 ||
    JSON.stringify(result.requested.map(String).toSorted()) !== JSON.stringify(requestedIds) ||
    JSON.stringify(updatedIds) !== JSON.stringify(requestedIds)
  ) {
    throw new Error('Plasma panel runtime mutation did not update every requested panel');
  }
}

/**
 * @param {Map<string, PanelRuntimeState>} panelStateById
 * @param {number} primaryScreen
 * @returns {string}
 */
function buildPlasmaPanelStateScript(panelStateById, primaryScreen) {
  return [
    `var panelStateById = ${JSON.stringify(Object.fromEntries(panelStateById))};`,
    `var primaryScreen = ${JSON.stringify(primaryScreen)};`,
    'var mutation = { requested: [], updated: [], missing: [], removed: [] };',
    'var existingPanelIds = panelIds.slice();',
    'for (var existingIndex = 0; existingIndex < existingPanelIds.length; existingIndex++) {',
    '  var existingId = String(existingPanelIds[existingIndex]);',
    '  if (!Object.prototype.hasOwnProperty.call(panelStateById, existingId)) {',
    '    var stalePanel = panelById(Number(existingId));',
    '    if (stalePanel) {',
    '      stalePanel.remove();',
    '      mutation.removed.push(existingId);',
    '    }',
    '  }',
    '}',
    'for (var id in panelStateById) {',
    '  mutation.requested.push(String(id));',
    '  var panel = panelById(Number(id));',
    '  if (panel) {',
    '    var state = panelStateById[id];',
    '    var targetScreen = typeof state.screen === "number" ? state.screen : primaryScreen;',
    '    var targetGeometry = screenGeometry(targetScreen);',
    '    panel.currentConfigGroup = [];',
    '    panel.writeConfig("lastScreen", String(targetScreen));',
    '    panel.screen = targetScreen;',
    '    if (typeof state.location === "string") panel.location = state.location;',
    '    if (state.hiding) panel.hiding = state.hiding;',
    '    if (state.alignment) panel.alignment = state.alignment;',
    '    if (state.height) panel.height = state.height;',
    '    if (state.lengthRatio) {',
    '      var length = Math.round(targetGeometry.width * state.lengthRatio);',
    '      panel.minimumLength = length;',
    '      panel.maximumLength = length;',
    '      panel.length = length;',
    '    }',
    '    panel.reloadConfig();',
    '    mutation.updated.push(String(id));',
    '  } else {',
    '    mutation.missing.push(String(id));',
    '  }',
    '}',
    'print(JSON.stringify(mutation));',
  ].join('\n');
}

/**
 * Convert Plasma's persisted KConfig enum at the file boundary. Runtime state
 * remains semantic because the Plasma scripting API accepts named locations.
 *
 * @param {string | undefined} value
 * @param {string} panelId
 * @returns {PanelLocation | undefined}
 */
function parsePanelLocationFromKConfig(value, panelId) {
  if (value === undefined) return undefined;
  const numericLocation = Number(value);
  const location = Number.isSafeInteger(numericLocation)
    ? PLASMA_KCONFIG_LOCATION_TO_SEMANTIC.get(numericLocation)
    : undefined;

  if (!location) {
    throw new Error(`Plasma panel ${panelId} has unsupported KConfig location ${value}`);
  }

  return /** @type {PanelLocation} */ (location);
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
  const escapeCharacter = String.fromCharCode(27);

  return value.replaceAll(new RegExp(`${escapeCharacter}\\[[0-?]*[ -/]*[@-~]`, 'gu'), '');
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
    return section.replace(pattern, () => line);
  }

  return section.endsWith('\n') ? `${section}${line}\n` : `${section}\n${line}\n`;
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
 * @param {CommandRunner} runCommand
 * @returns {WallpaperRuntimeState[]}
 */
function readLivePlasmaWallpaperState(runCommand) {
  const output = String(
    runCommand(
      'qdbus6',
      [
        'org.kde.plasmashell',
        '/PlasmaShell',
        'org.kde.PlasmaShell.evaluateScript',
        [
          'var wallpaperStates = [];',
          'var allDesktops = desktops();',
          'for (var i = 0; i < allDesktops.length; i++) {',
          '  var desktop = allDesktops[i];',
          '  desktop.currentConfigGroup = ["Wallpaper", "org.kde.image", "General"];',
          '  wallpaperStates.push({',
          '    activityId: String(desktop.activityId),',
          '    screen: Number(desktop.screen),',
          '    wallpaperPlugin: desktop.wallpaperPlugin,',
          '    image: String(desktop.readConfig("Image"))',
          '  });',
          '}',
          'print(JSON.stringify(wallpaperStates));',
        ].join('\n'),
      ],
      { encoding: 'utf8' }
    )
  );
  const parsed = parseJsonFromQdbusOutput(output);

  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isWallpaperRuntimeState)) {
    throw new Error('Could not read live Plasma wallpaper runtime state');
  }

  return parsed.map(({ activityId, screen, image, wallpaperPlugin }) => ({
    activityId,
    screen,
    image,
    wallpaperPlugin,
  }));
}

/** @param {unknown} candidate @returns {candidate is WallpaperRuntimeState} */
function isWallpaperRuntimeState(candidate) {
  const wallpaper =
    /** @type {{ activityId?: unknown; screen?: unknown; image?: unknown; wallpaperPlugin?: unknown }} */ (
      candidate
    );

  return (
    typeof wallpaper?.activityId === 'string' &&
    Number.isSafeInteger(wallpaper.screen) &&
    Number(wallpaper.screen) >= 0 &&
    typeof wallpaper.image === 'string' &&
    wallpaper.image.length > 0 &&
    typeof wallpaper.wallpaperPlugin === 'string' &&
    wallpaper.wallpaperPlugin.length > 0
  );
}

/**
 * @param {WallpaperRuntimeState[]} wallpaperState
 * @param {CommandRunner} runCommand
 * @returns {void}
 */
function restorePlasmaWallpaperState(wallpaperState, runCommand) {
  if (wallpaperState.length === 0) {
    return;
  }

  const output = String(
    runCommand(
      'qdbus6',
      [
        'org.kde.plasmashell',
        '/PlasmaShell',
        'org.kde.PlasmaShell.evaluateScript',
        [
          `var wallpaperState = ${JSON.stringify(wallpaperState)};`,
          'var mutation = { requested: wallpaperState.length, updated: 0 };',
          'var allDesktops = desktops();',
          'for (var i = 0; i < allDesktops.length; i++) {',
          '  var desktop = allDesktops[i];',
          '  for (var j = 0; j < wallpaperState.length; j++) {',
          '    var state = wallpaperState[j];',
          '    if (String(desktop.activityId) === state.activityId && Number(desktop.screen) === state.screen) {',
          '      desktop.wallpaperPlugin = "org.kde.image";',
          '      desktop.currentConfigGroup = ["Wallpaper", "org.kde.image", "General"];',
          '      desktop.writeConfig("Image", state.image);',
          '      desktop.wallpaperPlugin = state.wallpaperPlugin;',
          '      mutation.updated += 1;',
          '      break;',
          '    }',
          '  }',
          '}',
          'print(JSON.stringify(mutation));',
        ].join('\n'),
      ],
      { encoding: 'utf8' }
    )
  );
  const result = /** @type {{ requested?: unknown; updated?: unknown }} */ (
    parseJsonFromQdbusOutput(output)
  );

  if (result.requested !== wallpaperState.length || result.updated !== wallpaperState.length) {
    throw new Error('Plasma wallpaper runtime mutation did not restore every prior desktop');
  }
}

/**
 * @param {string} wallpaperPath
 * @param {CommandRunner} runCommand
 * @returns {WallpaperRuntimeState[]}
 */
function assertPlasmaWallpaperApplied(wallpaperPath, runCommand) {
  const expectedPath = path.resolve(wallpaperPath);
  const wallpaperStats = fs.lstatSync(expectedPath);

  if (wallpaperStats.isSymbolicLink() || !wallpaperStats.isFile()) {
    throw new Error('Plasma wallpaper asset is not a regular file at the requested path');
  }

  fs.accessSync(expectedPath, fs.constants.R_OK);
  const actualState = readLivePlasmaWallpaperState(runCommand);

  if (
    actualState.some(
      ({ image, wallpaperPlugin }) =>
        wallpaperPlugin !== 'org.kde.image' ||
        path.resolve(parseWallpaperImagePath(image)) !== expectedPath
    )
  ) {
    throw new Error('Plasma wallpaper runtime state did not match the requested wallpaper');
  }

  return actualState;
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
 * @param {string} [captureHome]
 * @returns {void}
 */
function assertNoHomePaths(layoutContents, captureHome) {
  for (const [snapshotPath, content] of layoutContents) {
    const normalizedCaptureHome = captureHome ? path.resolve(captureHome) : undefined;

    if (
      /\/(?:home|var\/home)\/[^/\s]+/u.test(content) ||
      /\/root(?:\/|\s|$)/u.test(content) ||
      (normalizedCaptureHome &&
        (content.includes(normalizedCaptureHome) ||
          content.includes(pathToFileURL(normalizedCaptureHome).href)))
    ) {
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
 * @returns {{ owner: string; requirements: string; wallpaperAsset: string; layoutFiles: Array<{ homePath: string; snapshotPath: string; portableWallpaper: boolean }> }}
 */
function buildRiceManifest() {
  return {
    owner: RICE_MANIFEST_OWNER,
    requirements: RICE_REQUIREMENTS_PATH,
    wallpaperAsset: RICE_WALLPAPER_PATH,
    layoutFiles: RICE_LAYOUT_FILES,
  };
}

/**
 * @param {unknown} manifest
 * @returns {asserts manifest is { owner: string; requirements: string; wallpaperAsset: string; layoutFiles: typeof RICE_LAYOUT_FILES }}
 */
function assertRiceManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Rice layout manifest is not an object');
  }

  const candidate =
    /** @type {{ owner?: unknown; requirements?: unknown; wallpaperAsset?: unknown; layoutFiles?: unknown }} */ (
      manifest
    );

  if (
    Object.keys(candidate).toSorted().join(',') !== 'layoutFiles,owner,requirements,wallpaperAsset'
  ) {
    throw new Error('Rice layout manifest has unsupported or missing fields');
  }

  if (candidate.owner !== RICE_MANIFEST_OWNER) {
    throw new Error(`Rice layout manifest owner must be ${RICE_MANIFEST_OWNER}`);
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
 * @param {CommandRunner} runCommand
 * @returns {void}
 */
function stopPlasmaShell(runCommand) {
  runCommand('systemctl', ['--user', 'stop', PLASMA_SHELL_SERVICE], {
    stdio: 'inherit',
  });

  if (isPlasmaShellActive(runCommand)) {
    throw new Error(`${PLASMA_SHELL_SERVICE} remained active after stop`);
  }
}

/**
 * @param {CommandRunner} runCommand
 * @returns {void}
 */
function startPlasmaShell(runCommand) {
  runCommand('systemctl', ['--user', 'start', PLASMA_SHELL_SERVICE], {
    stdio: 'inherit',
  });
  assertPlasmaShellActive(runCommand, 'Plasma shell start');
}

/**
 * @param {CommandRunner} runCommand
 * @param {string} owner
 * @returns {void}
 */
function ensurePlasmaShellActive(runCommand, owner) {
  if (!isPlasmaShellActive(runCommand)) {
    startPlasmaShell(runCommand);
  }

  assertPlasmaShellActive(runCommand, owner);
}

/**
 * @returns {void}
 */
function main() {
  const { values: args } = parseArgs({
    args: process.argv.slice(2),
    options: {
      apply: { type: 'boolean' },
      'capture-layout': { type: 'boolean' },
      check: { type: 'boolean' },
      'layout-only': { type: 'boolean' },
      link: { type: 'boolean' },
      recover: { type: 'boolean' },
      'style-only': { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });

  if (args.apply || args.recover || args['capture-layout']) {
    const lockedExitCode = reexecUnderDesktopLock(home);
    if (lockedExitCode !== undefined) {
      process.exitCode = lockedExitCode;
      return;
    }
  }

  if (args.recover) {
    if (Object.values(args).filter(Boolean).length !== 1) {
      throw new Error('Tyrian rice recovery cannot be combined with another mode.');
    }

    recoverRice();
    return;
  }

  if (args['layout-only'] && args['style-only']) {
    throw new Error('Tyrian rice flags --layout-only and --style-only are mutually exclusive.');
  }

  if (args['capture-layout']) {
    captureRiceLayout({ hasCommand });
    return;
  }

  if (args.check) {
    checkRiceSnapshot();
    return;
  }

  if (args.apply && !args['layout-only']) {
    prepareLiveInstallRepository(repoRoot, {
      home,
      link: args.link,
      target: 'plasma',
    });
  }

  installRice({
    apply: args.apply,
    withPlasmaLayout: !args['style-only'],
    layoutOnly: args['layout-only'],
    link: args.link,
  });
}

if (isDirectRun(import.meta)) {
  main();
}
