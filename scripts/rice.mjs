// @ts-check

import { execFileSync } from 'node:child_process';
import { hash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkRequiredCommands, hasCommand } from './commandChecks.mjs';
import {
  buildLiveInstallPlan,
  finishCommittedHomeFilesystemTransaction,
  installLiveTyrian,
  prepareLiveInstallRepository,
  readLiveInstallTransactionTargets,
  recoverHomeFilesystemTransaction,
  withHomeFilesystemTransaction,
  withLiveInstallLock,
} from './installLiveTyrian.mjs';
import { resolveDesktopXdgConfigPath, resolveDesktopXdgRoots } from './desktopPaths.mjs';
import {
  admitOwnedPaths,
  escapeRegExp,
  exists,
  fsyncDirectory,
  installManagedPathRaw,
  isSameOrDescendant,
  operation,
  publishStagedOwnedPathRaw,
  removeOwnedPathRaw,
  resolvePathIdentity,
  withTokenFileLock,
  writeBinaryFileRaw,
  writeOwnedRecoveryCandidateRaw,
  writeTextFileRaw,
} from './installOps.mjs';
import {
  buildTyrianBackupRoot,
  TYRIAN_INSTALL_HOME,
  WALLPAPER_ASSET_PATH,
} from './portableAssets.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const home = os.homedir();

export const RICE_ROOT = 'rice';
export const RICE_WALLPAPER_PLACEHOLDER = `{{TYRIAN_RICE_ROOT}}/${WALLPAPER_ASSET_PATH}`;
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
const CAPTURE_LOCK_PATH = '.tyrian-rice-capture.lock';
const CAPTURE_JOURNAL_PATH = '.tyrian-rice-capture-journal.json';
const CAPTURE_JOURNAL_CANDIDATE_PATH = `${CAPTURE_JOURNAL_PATH}.next`;
const CAPTURE_TRANSACTION_PREFIX = '.tyrian-rice-capture-transaction-';
const PLASMA_SHELL_SERVICE = 'plasma-plasmashell.service';
const PLASMA_LIFECYCLE_PATH = '.local/state/tyrian-night/plasma-lifecycle.json';
const PLASMA_LIFECYCLE_CANDIDATE_PATH = `${PLASMA_LIFECYCLE_PATH}.next`;
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
 *   backupRoot: string;
 *   home: string;
 *   installEntries: Array<{
 *     file: (typeof RICE_LAYOUT_FILES)[number];
 *     installedContent: string;
 *     stagedPath: string;
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
 *   testInterruptAfterCommit?: boolean;
 * }} PreparedPlasmaLayoutInstall
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

  withCaptureLock(root, () => {
    recoverCapturePublication(root);
    checkRiceSnapshotOwned(root, captureHome);
  });
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
 * @param {{ repoRoot?: string; home?: string; environment?: NodeJS.ProcessEnv; runCommand?: CommandRunner; hasCommand?: (command: string) => boolean; testInterruptPublicationAfter?: number; testInterruptAfterStop?: boolean; testInterruptAfterRestart?: boolean }} [options]
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
      path.join(root, CAPTURE_LOCK_PATH),
      path.join(root, CAPTURE_JOURNAL_PATH),
      path.join(root, CAPTURE_JOURNAL_CANDIDATE_PATH),
      path.join(root, RICE_WALLPAPER_PATH),
      ...RICE_LAYOUT_FILES.map(({ snapshotPath }) => path.join(root, snapshotPath)),
      path.join(root, RICE_MANIFEST_PATH),
    ],
    'Rice capture destination'
  );

  withLiveInstallLock(
    userHome,
    () => {
      recoverRiceHomeState(userHome, runCommand);
      withCaptureLock(root, () => {
        recoverCapturePublication(root);
        captureRiceLayoutOwned(
          root,
          userHome,
          xdgRoots,
          runCommand,
          options.testInterruptPublicationAfter,
          options.testInterruptAfterStop,
          options.testInterruptAfterRestart
        );
      });
    },
    { allowPlasmaRecovery: true }
  );
}

/**
 * @param {string} root
 * @param {string} userHome
 * @param {DesktopXdgRoots} xdgRoots
 * @param {CommandRunner} runCommand
 * @param {number | undefined} testInterruptPublicationAfter
 * @param {boolean | undefined} testInterruptAfterStop
 * @param {boolean | undefined} testInterruptAfterRestart
 * @returns {void}
 */
function captureRiceLayoutOwned(
  root,
  userHome,
  xdgRoots,
  runCommand,
  testInterruptPublicationAfter,
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
    beginPlasmaLifecycle(userHome, 'capture', {
      previousPanelStateById: preStopPanelState,
      previousWallpaperState: preStopWallpaperState,
      primaryScreen,
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
        recoverPlasmaLifecycle(userHome, runCommand, 'none');
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
        recoverPlasmaLifecycle(userHome, runCommand, 'none');
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

  publishCapturedRiceSnapshot(root, capturedFiles, testInterruptPublicationAfter);
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
 * @param {string} userHome
 * @param {'capture' | 'layout'} owner
 * @param {{ previousPanelStateById: Map<string, PanelRuntimeState>; previousWallpaperState: WallpaperRuntimeState[]; primaryScreen: number }} previousState
 * @returns {void}
 */
function beginPlasmaLifecycle(userHome, owner, previousState) {
  const journalPath = path.join(userHome, PLASMA_LIFECYCLE_PATH);
  removePlasmaLifecycleCandidate(userHome);

  if (exists(journalPath)) {
    throw new Error('A Plasma lifecycle journal is already active');
  }

  writePlasmaLifecycle(userHome, {
    version: 3,
    owner,
    phase: 'prepared',
    initiallyActive: true,
    previousPanels: [...previousState.previousPanelStateById].map(([id, state]) => ({
      id,
      ...state,
    })),
    previousWallpapers: previousState.previousWallpaperState,
    primaryScreen: previousState.primaryScreen,
  });
}

/**
 * @param {string} userHome
 * @param {CommandRunner} runCommand
 * @param {'none' | 'rolledBack' | 'committed'} filesystemOutcome
 * @returns {void}
 */
function recoverPlasmaLifecycle(userHome, runCommand, filesystemOutcome) {
  const journalPath = path.join(userHome, PLASMA_LIFECYCLE_PATH);
  removePlasmaLifecycleCandidate(userHome);

  if (!exists(journalPath)) {
    return;
  }

  const journal = readPlasmaLifecycle(userHome);

  if (
    filesystemOutcome === 'committed' &&
    (journal.owner !== 'layout' || journal.phase !== 'runtimeApplied')
  ) {
    throw new Error('Committed Plasma lifecycle journal does not record applied runtime state');
  }

  if (journal.owner === 'layout' && filesystemOutcome === 'rolledBack') {
    if (isPlasmaShellActive(runCommand)) {
      stopPlasmaShell(runCommand);
    }
  }

  ensurePlasmaShellActive(runCommand, 'Plasma lifecycle recovery');

  if (filesystemOutcome !== 'committed') {
    const previousPanels = parsePanelStateJson(JSON.stringify(journal.previousPanels));
    restorePlasmaPanelState(previousPanels, journal.primaryScreen, runCommand);
    const restoredPanels = readLivePanelStateById(runCommand);

    if (!samePanelRuntimeState(previousPanels, restoredPanels)) {
      throw new Error('Plasma lifecycle recovery did not restore exact prior panel state');
    }

    restorePlasmaWallpaperState(journal.previousWallpapers, runCommand);
    const restoredWallpapers = readLivePlasmaWallpaperState(runCommand);

    if (!sameWallpaperRuntimeState(journal.previousWallpapers, restoredWallpapers)) {
      throw new Error('Plasma lifecycle recovery did not restore exact prior wallpaper state');
    }
  } else {
    const desiredPanels = parsePanelStateJson(JSON.stringify(journal.desiredPanels));
    const desiredWallpapers = journal.desiredWallpapers;

    if (!desiredWallpapers) {
      throw new Error('Committed Plasma lifecycle has no desired wallpaper state');
    }

    restorePlasmaPanelState(desiredPanels, journal.primaryScreen, runCommand);
    const restoredPanels = readLivePanelStateById(runCommand);

    if (!samePanelRuntimeState(desiredPanels, restoredPanels)) {
      throw new Error('Committed Plasma recovery did not restore exact desired panel state');
    }

    restorePlasmaWallpaperState(desiredWallpapers, runCommand);
    const restoredWallpapers = readLivePlasmaWallpaperState(runCommand);

    if (!sameWallpaperRuntimeState(desiredWallpapers, restoredWallpapers)) {
      throw new Error('Committed Plasma recovery did not restore exact desired wallpaper state');
    }
  }

  finishPlasmaLifecycle(userHome);
}

/**
 * Files are recovered before external shell state. The lifecycle journal is
 * deliberately not interpreted by the filesystem owner.
 *
 * @param {string} userHome
 * @param {CommandRunner} runCommand
 * @param {{ testInterruptAfterFilesystem?: boolean }} [options]
 * @returns {'none' | 'committed' | 'rolledBack'}
 */
function recoverRiceHomeState(userHome, runCommand, options = {}) {
  const filesystemOutcome = recoverHomeFilesystemTransaction(userHome, {
    deferCommittedCleanup: true,
  });

  if (filesystemOutcome === 'committed' && options.testInterruptAfterFilesystem) {
    throw new SimulatedCommittedHandoffInterruption();
  }

  recoverPlasmaLifecycle(userHome, runCommand, filesystemOutcome);

  if (filesystemOutcome === 'committed') {
    finishCommittedHomeFilesystemTransaction(userHome);
  }

  return filesystemOutcome;
}

/**
 * Recover one interrupted rice filesystem and Plasma lifecycle generation.
 * Preview never calls this capability.
 *
 * @param {{ home?: string; runCommand?: CommandRunner; testInterruptAfterFilesystem?: boolean }} [options]
 * @returns {'none' | 'committed' | 'rolledBack'}
 */
export function recoverRice(options = {}) {
  const userHome = resolvePathIdentity(options.home ?? home);
  const runCommand = options.runCommand ?? execFileSync;

  return withLiveInstallLock(
    userHome,
    () => {
      const outcome = recoverRiceHomeState(userHome, runCommand, {
        testInterruptAfterFilesystem: options.testInterruptAfterFilesystem,
      });
      console.log(`Tyrian rice recovery completed (filesystem outcome: ${outcome}).`);
      return outcome;
    },
    { allowPlasmaRecovery: true, recoverBeforeAction: false }
  );
}

class SimulatedCommittedHandoffInterruption extends Error {
  constructor() {
    super('Simulated interruption during the committed filesystem handoff');
  }
}

/**
 * @param {string} userHome
 * @param {Map<string, PanelRuntimeState>} desiredPanelState
 * @param {WallpaperRuntimeState[]} desiredWallpaperState
 * @returns {void}
 */
function markPlasmaLifecycleRuntimeApplied(userHome, desiredPanelState, desiredWallpaperState) {
  const journal = readPlasmaLifecycle(userHome);

  if (journal.owner !== 'layout' || journal.phase !== 'prepared') {
    throw new Error('Plasma lifecycle journal cannot record runtime application in this phase');
  }

  writePlasmaLifecycle(userHome, {
    ...journal,
    phase: 'runtimeApplied',
    desiredPanels: [...desiredPanelState].map(([id, state]) => ({ id, ...state })),
    desiredWallpapers: desiredWallpaperState,
  });
}

/**
 * @param {string} userHome
 * @param {Record<string, unknown>} journal
 * @returns {void}
 */
function writePlasmaLifecycle(userHome, journal) {
  const journalPath = path.join(userHome, PLASMA_LIFECYCLE_PATH);
  const temporaryPath = path.join(userHome, PLASMA_LIFECYCLE_CANDIDATE_PATH);

  try {
    writeOwnedRecoveryCandidateRaw(
      userHome,
      temporaryPath,
      `${JSON.stringify(journal, null, 2)}\n`
    );
    publishStagedOwnedPathRaw(userHome, temporaryPath, journalPath);
  } finally {
    if (exists(temporaryPath)) removeOwnedPathRaw(userHome, temporaryPath);
  }
}

/**
 * @param {string} userHome
 * @returns {{ version: 3; owner: 'capture' | 'layout'; phase: 'prepared' | 'runtimeApplied'; initiallyActive: true; previousPanels: unknown[]; previousWallpapers: WallpaperRuntimeState[]; desiredPanels?: unknown[]; desiredWallpapers?: WallpaperRuntimeState[]; primaryScreen: number }}
 */
function readPlasmaLifecycle(userHome) {
  const journalPath = path.join(userHome, PLASMA_LIFECYCLE_PATH);
  const stats = fs.lstatSync(journalPath);
  const journal =
    stats.isFile() && !stats.isSymbolicLink()
      ? JSON.parse(fs.readFileSync(journalPath, 'utf8'))
      : undefined;
  /** @type {unknown[]} */
  const previousWallpapers = Array.isArray(journal?.previousWallpapers)
    ? journal.previousWallpapers
    : [];
  const wallpapersValid = previousWallpapers.every(isWallpaperRuntimeState);
  /** @type {unknown[]} */
  const desiredWallpapers = Array.isArray(journal?.desiredWallpapers)
    ? journal.desiredWallpapers
    : [];
  const desiredWallpapersValid = desiredWallpapers.every(isWallpaperRuntimeState);

  if (
    journal?.version !== 3 ||
    journal.initiallyActive !== true ||
    !['capture', 'layout'].includes(journal.owner) ||
    !['prepared', 'runtimeApplied'].includes(journal.phase) ||
    (journal.owner === 'capture' && journal.phase !== 'prepared') ||
    !Array.isArray(journal.previousPanels) ||
    !Array.isArray(journal.previousWallpapers) ||
    (journal.phase === 'runtimeApplied' &&
      (!Array.isArray(journal.desiredPanels) ||
        !Array.isArray(journal.desiredWallpapers) ||
        !desiredWallpapersValid)) ||
    !Number.isSafeInteger(journal.primaryScreen) ||
    journal.primaryScreen < 0 ||
    !wallpapersValid
  ) {
    throw new Error('Plasma lifecycle journal is corrupt');
  }

  parsePanelStateJson(JSON.stringify(journal.previousPanels));

  if (journal.phase === 'runtimeApplied') {
    parsePanelStateJson(JSON.stringify(journal.desiredPanels));
  }

  return /** @type {ReturnType<typeof readPlasmaLifecycle>} */ (journal);
}

/**
 * @param {string} userHome
 * @returns {void}
 */
function finishPlasmaLifecycle(userHome) {
  const journalPath = path.join(userHome, PLASMA_LIFECYCLE_PATH);
  if (exists(journalPath)) removeOwnedPathRaw(userHome, journalPath);
  removePlasmaLifecycleCandidate(userHome);
}

/**
 * @param {string} userHome
 * @returns {void}
 */
function removePlasmaLifecycleCandidate(userHome) {
  const candidatePath = path.join(userHome, PLASMA_LIFECYCLE_CANDIDATE_PATH);
  if (exists(candidatePath)) removeOwnedPathRaw(userHome, candidatePath);
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
 * @param {string} root
 * @param {Array<{ content: Buffer; message: string; targetPath: string }>} capturedFiles
 * @param {number | undefined} testInterruptPublicationAfter
 * @returns {void}
 */
function publishCapturedRiceSnapshot(root, capturedFiles, testInterruptPublicationAfter) {
  const token = randomUUID();
  const transactionRoot = path.join(root, `${CAPTURE_TRANSACTION_PREFIX}${token}`);
  const journalPath = path.join(root, CAPTURE_JOURNAL_PATH);
  const entries = capturedFiles.map((capturedFile, index) => {
    const originalChecksum = readCaptureFileGeneration(capturedFile.targetPath);

    return {
      ...capturedFile,
      backupPath: path.join(transactionRoot, 'backup', String(index)),
      existed: originalChecksum !== null,
      originalChecksum,
      desiredChecksum: captureChecksum(capturedFile.content),
      stagedPath: path.join(transactionRoot, 'stage', String(index)),
    };
  });
  const allocatingJournal = buildCaptureJournal(root, token, 'allocating', entries);

  admitOwnedPaths(
    root,
    [
      journalPath,
      path.join(root, CAPTURE_JOURNAL_CANDIDATE_PATH),
      transactionRoot,
      ...entries.flatMap(({ targetPath, backupPath, stagedPath }) => [
        targetPath,
        backupPath,
        stagedPath,
      ]),
    ],
    'Rice capture destination'
  );

  try {
    writeCaptureJournal(root, allocatingJournal);

    for (const entry of entries) {
      if (entry.existed) {
        installManagedPathRaw('copy', entry.targetPath, entry.backupPath, { ownerRoot: root });

        if (readCaptureFileGeneration(entry.backupPath) !== entry.originalChecksum) {
          throw new Error(`Rice capture backup verification failed for ${entry.targetPath}`);
        }
      }

      const { content, message, stagedPath } = entry;
      console.log(message);
      writeBinaryFileRaw(stagedPath, content, { ownerRoot: root });
    }

    fsyncDirectory(path.join(transactionRoot, 'stage'));

    if (exists(path.join(transactionRoot, 'backup'))) {
      fsyncDirectory(path.join(transactionRoot, 'backup'));
    }

    fsyncDirectory(transactionRoot);

    const journal = { ...allocatingJournal, phase: /** @type {const} */ ('prepared') };
    writeCaptureJournal(root, journal);

    for (let index = 0; index < entries.length; index += 1) {
      const { stagedPath, targetPath, originalChecksum } = entries[index];
      assertCaptureFileGeneration(targetPath, originalChecksum, 'before publication');
      publishStagedOwnedPathRaw(root, stagedPath, targetPath);

      if (testInterruptPublicationAfter === index + 1) {
        throw new SimulatedCaptureInterruption();
      }
    }

    for (const entry of entries) {
      if (!fs.readFileSync(entry.targetPath).equals(entry.content)) {
        throw new Error(`Rice capture verification failed for ${entry.targetPath}`);
      }
    }

    writeCaptureJournal(root, { ...journal, phase: 'verified' });
    finalizeCapturePublication(root, journalPath, transactionRoot);
  } catch (error) {
    if (error instanceof SimulatedCaptureInterruption) {
      throw error;
    }

    try {
      if (exists(journalPath)) {
        recoverCapturePublication(root);
      } else {
        if (exists(transactionRoot)) removeOwnedPathRaw(root, transactionRoot);
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Rice capture publication and recovery both failed'
      );
    }

    throw error;
  }
}

class SimulatedCaptureInterruption extends Error {
  constructor() {
    super('Simulated interruption during rice capture publication');
  }
}

/**
 * @param {Buffer} content
 * @returns {string}
 */
function captureChecksum(content) {
  return hash('sha256', content, 'hex');
}

/**
 * @param {string} filePath
 * @returns {string | null}
 */
function readCaptureFileGeneration(filePath) {
  let stats;

  try {
    stats = fs.lstatSync(filePath);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return null;
    }

    throw error;
  }

  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Rice capture generation is not a regular file: ${filePath}`);
  }

  return captureChecksum(fs.readFileSync(filePath));
}

/**
 * @param {string} filePath
 * @param {string | null} expectedChecksum
 * @param {string} phase
 * @returns {void}
 */
function assertCaptureFileGeneration(filePath, expectedChecksum, phase) {
  if (readCaptureFileGeneration(filePath) !== expectedChecksum) {
    throw new Error(`Rice capture target changed ${phase}: ${filePath}`);
  }
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
 * @param {string} root
 * @param {() => void} action
 * @returns {void}
 */
function withCaptureLock(root, action) {
  return withTokenFileLock(path.join(root, CAPTURE_LOCK_PATH), action, { ownerRoot: root });
}

/**
 * @param {string} root
 * @param {string} token
 * @param {'allocating' | 'prepared' | 'verified' | 'rolledBack'} phase
 * @param {Array<{ targetPath: string; stagedPath: string; backupPath: string; existed: boolean; originalChecksum: string | null; desiredChecksum: string }>} entries
 * @returns {{ version: 3; token: string; phase: 'allocating' | 'prepared' | 'verified' | 'rolledBack'; transactionRoot: string; entries: Array<{ targetPath: string; stagedPath: string; backupPath: string; existed: boolean; originalChecksum: string | null; desiredChecksum: string }> }}
 */
function buildCaptureJournal(root, token, phase, entries) {
  return {
    version: 3,
    token,
    phase,
    transactionRoot: `${CAPTURE_TRANSACTION_PREFIX}${token}`,
    entries: entries.map(
      ({ targetPath, stagedPath, backupPath, existed, originalChecksum, desiredChecksum }) => ({
        targetPath: path.relative(root, targetPath),
        stagedPath: path.relative(root, stagedPath),
        backupPath: path.relative(root, backupPath),
        existed,
        originalChecksum,
        desiredChecksum,
      })
    ),
  };
}

/**
 * @param {string} root
 * @param {ReturnType<typeof buildCaptureJournal>} journal
 * @returns {void}
 */
function writeCaptureJournal(root, journal) {
  const journalPath = path.join(root, CAPTURE_JOURNAL_PATH);
  const temporaryPath = path.join(root, CAPTURE_JOURNAL_CANDIDATE_PATH);

  try {
    writeOwnedRecoveryCandidateRaw(root, temporaryPath, `${JSON.stringify(journal, null, 2)}\n`);
    publishStagedOwnedPathRaw(root, temporaryPath, journalPath);
  } finally {
    if (exists(temporaryPath)) removeOwnedPathRaw(root, temporaryPath);
  }
}

/**
 * @param {string} root
 * @returns {void}
 */
function recoverCapturePublication(root) {
  const journalPath = path.join(root, CAPTURE_JOURNAL_PATH);
  const candidatePath = path.join(root, CAPTURE_JOURNAL_CANDIDATE_PATH);

  if (exists(candidatePath)) {
    removeOwnedPathRaw(root, candidatePath);
  }

  if (!exists(journalPath)) {
    return;
  }

  let candidate;

  try {
    const stats = fs.lstatSync(journalPath);

    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error('journal is not a regular file');
    }

    candidate = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  } catch (error) {
    throw new Error(`Rice capture journal is corrupt: ${String(error)}`);
  }

  const journal = validateCaptureJournal(root, candidate);
  const transactionRoot = path.join(root, journal.transactionRoot);
  admitOwnedPaths(
    root,
    [
      journalPath,
      candidatePath,
      transactionRoot,
      ...journal.entries.flatMap((entry) => [
        path.join(root, entry.targetPath),
        path.join(root, entry.backupPath),
        path.join(root, entry.stagedPath),
      ]),
    ],
    'Rice capture recovery'
  );

  if (journal.phase === 'allocating') {
    finalizeCapturePublication(root, journalPath, transactionRoot);
    return;
  }

  if (journal.phase === 'prepared') {
    for (const entry of journal.entries) {
      const backupPath = path.join(root, entry.backupPath);
      const backupChecksum = readCaptureFileGeneration(backupPath);

      if (entry.existed ? backupChecksum !== entry.originalChecksum : backupChecksum !== null) {
        throw new Error(`Rice capture journal backup is invalid: ${entry.backupPath}`);
      }
    }

    const failures = [];
    for (const [index, entry] of journal.entries
      .map((entry, index) => /** @type {const} */ ([index, entry]))
      .toReversed()) {
      const targetPath = path.join(root, entry.targetPath);
      const currentChecksum = readCaptureFileGeneration(targetPath);

      if (currentChecksum === entry.originalChecksum) continue;
      if (currentChecksum !== entry.desiredChecksum) {
        failures.push(
          new Error(`Rice capture recovery found external drift at ${entry.targetPath}`)
        );
        continue;
      }

      try {
        assertCaptureFileGeneration(targetPath, entry.desiredChecksum, 'before rollback');

        if (entry.existed) {
          const restorePath = path.join(transactionRoot, 'restore', String(index));
          installManagedPathRaw('copy', path.join(root, entry.backupPath), restorePath, {
            ownerRoot: root,
          });
          if (readCaptureFileGeneration(restorePath) !== entry.originalChecksum) {
            throw new Error(`Rice capture recovery restore copy changed for ${entry.targetPath}`);
          }

          assertCaptureFileGeneration(targetPath, entry.desiredChecksum, 'before rollback');
          publishStagedOwnedPathRaw(root, restorePath, targetPath);
        } else {
          assertCaptureFileGeneration(targetPath, entry.desiredChecksum, 'before rollback');
          removeOwnedPathRaw(root, targetPath);
        }
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'Rice capture recovery could not safely restore every target'
      );
    }

    writeCaptureJournal(root, { ...journal, phase: 'rolledBack' });
  }

  finalizeCapturePublication(root, journalPath, transactionRoot);
}

/**
 * @param {string} root
 * @param {unknown} candidate
 * @returns {ReturnType<typeof buildCaptureJournal>}
 */
function validateCaptureJournal(root, candidate) {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Rice capture journal is corrupt');
  }

  const journal = /** @type {Record<string, any>} */ (candidate);
  const allowedTargets = [
    RICE_WALLPAPER_PATH,
    ...RICE_LAYOUT_FILES.map(({ snapshotPath }) => snapshotPath),
    RICE_MANIFEST_PATH,
  ];

  if (
    journal.version !== 3 ||
    typeof journal.token !== 'string' ||
    !/^[0-9a-f-]+$/u.test(journal.token) ||
    !['allocating', 'prepared', 'verified', 'rolledBack'].includes(journal.phase) ||
    journal.transactionRoot !== `${CAPTURE_TRANSACTION_PREFIX}${journal.token}` ||
    !Array.isArray(journal.entries) ||
    journal.entries.length !== allowedTargets.length
  ) {
    throw new Error('Rice capture journal is corrupt');
  }

  const seenTargets = new Set();

  for (let index = 0; index < journal.entries.length; index += 1) {
    const entry = journal.entries[index];
    const expectedStage = path.posix.join(journal.transactionRoot, 'stage', String(index));
    const expectedBackup = path.posix.join(journal.transactionRoot, 'backup', String(index));

    if (
      !entry ||
      typeof entry !== 'object' ||
      entry.targetPath !== allowedTargets[index] ||
      seenTargets.has(entry.targetPath) ||
      entry.stagedPath !== expectedStage ||
      entry.backupPath !== expectedBackup ||
      typeof entry.existed !== 'boolean' ||
      (entry.originalChecksum !== null &&
        (typeof entry.originalChecksum !== 'string' ||
          !/^[0-9a-f]{64}$/u.test(entry.originalChecksum))) ||
      typeof entry.desiredChecksum !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(entry.desiredChecksum) ||
      entry.existed !== (entry.originalChecksum !== null)
    ) {
      throw new Error('Rice capture journal is corrupt');
    }

    for (const relativePath of [entry.targetPath, entry.stagedPath, entry.backupPath]) {
      const absolutePath = path.resolve(root, relativePath);

      if (!isSameOrDescendant(root, absolutePath)) {
        throw new Error('Rice capture journal escapes its repository root');
      }
    }

    seenTargets.add(entry.targetPath);
  }

  return /** @type {ReturnType<typeof buildCaptureJournal>} */ (journal);
}

/**
 * @param {string} root
 * @param {string} journalPath
 * @param {string} transactionRoot
 * @returns {void}
 */
function finalizeCapturePublication(root, journalPath, transactionRoot) {
  if (!isSameOrDescendant(root, transactionRoot)) {
    throw new Error('Rice capture transaction root escapes its repository');
  }

  if (exists(transactionRoot)) removeOwnedPathRaw(root, transactionRoot);
  if (exists(journalPath)) removeOwnedPathRaw(root, journalPath);
  const candidatePath = path.join(root, CAPTURE_JOURNAL_CANDIDATE_PATH);
  if (exists(candidatePath)) removeOwnedPathRaw(root, candidatePath);
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
 * @param {{ repoRoot?: string; home?: string; apply?: boolean; withPlasmaLayout?: boolean; layoutOnly?: boolean; link?: boolean; environment?: NodeJS.ProcessEnv; runCommand?: CommandRunner; hasCommand?: (command: string) => boolean; testInterruptAfterStyle?: boolean; testInterruptAfterStop?: boolean; testInterruptAfterRuntime?: boolean; testInterruptAfterCommit?: boolean; testInterruptRecoveryAfterFilesystem?: boolean }} [options]
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

  const executeInstall = () => {
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

    const preparedLayout = withPlasmaLayout
      ? preparePlasmaLayoutInstallOwned({
          repoRoot: root,
          home: userHome,
          xdgRoots: livePlan
            ? getPlanXdgRoots(livePlan)
            : resolveDesktopXdgRoots(userHome, environment),
          runtimeRoot,
          apply,
          runCommand,
          testInterruptAfterStop: options.testInterruptAfterStop,
          testInterruptAfterRuntime: options.testInterruptAfterRuntime,
        })
      : undefined;
    const runInstall = () =>
      installRiceOwned({
        root,
        userHome,
        apply,
        withPlasmaLayout,
        layoutOnly,
        link,
        environment,
        runtimeRoot,
        livePlan,
        preparedLayout,
        testInterruptAfterStyle: options.testInterruptAfterStyle,
      });

    if (!apply || !withPlasmaLayout) {
      runInstall();
      return;
    }

    const targetPaths = [
      ...(livePlan
        ? readLiveInstallTransactionTargets(livePlan)
        : !link
          ? [path.join(runtimeRoot, RICE_WALLPAPER_PATH)]
          : []),
      ...(preparedLayout?.installEntries.flatMap(({ stagedPath, targetPath }) => [
        targetPath,
        stagedPath,
      ]) ?? []),
    ];
    const backupRoot = buildTyrianBackupRoot(userHome, 'rice-full-apply');

    for (const targetPath of [...targetPaths, backupRoot]) {
      assertIndependentRoots(root, targetPath, 'Rice repository and filesystem transaction target');
    }

    withHomeFilesystemTransaction(
      userHome,
      {
        targetPaths,
        temporaryPaths: [
          ...(livePlan ? [livePlan.stagingRoot] : []),
          ...(preparedLayout?.installEntries.map(({ stagedPath }) => stagedPath) ?? []),
        ],
        backupRoot,
        owner: 'rice',
        shouldLeavePrepared: (error) =>
          error instanceof SimulatedRiceInterruption ||
          error instanceof SimulatedPlasmaStopInterruption ||
          error instanceof SimulatedPlasmaRuntimeInterruption,
        afterRollback: () => recoverPlasmaLifecycle(userHome, runCommand, 'rolledBack'),
        afterCommit: () => {
          if (options.testInterruptAfterCommit) {
            throw new SimulatedRiceCommitInterruption();
          }

          finishPlasmaLifecycle(userHome);
        },
      },
      runInstall
    );
    console.log(`Tyrian rice install complete. Backup: ${backupRoot}`);
  };

  if (!apply) {
    executeInstall();
    return;
  }

  withLiveInstallLock(
    userHome,
    () => {
      recoverRiceHomeState(userHome, runCommand, {
        testInterruptAfterFilesystem: options.testInterruptRecoveryAfterFilesystem,
      });
      withCaptureLock(root, () => {
        recoverCapturePublication(root);
        executeInstall();
      });
    },
    { allowPlasmaRecovery: true }
  );
}

/**
 * @param {{ root: string; userHome: string; apply: boolean; withPlasmaLayout: boolean; layoutOnly: boolean; link: boolean; environment?: NodeJS.ProcessEnv; runtimeRoot: string; livePlan?: ReturnType<typeof buildLiveInstallPlan>; preparedLayout?: PreparedPlasmaLayoutInstall; testInterruptAfterStyle?: boolean }} options
 * @returns {void}
 */
function installRiceOwned(options) {
  const {
    root,
    userHome,
    apply,
    withPlasmaLayout,
    layoutOnly,
    link,
    environment,
    runtimeRoot,
    livePlan,
    preparedLayout,
    testInterruptAfterStyle,
  } = options;

  /** @type {{ backupRoot: string; rollback: () => void } | undefined} */
  let filesystemReceipt;

  try {
    if (!layoutOnly) {
      filesystemReceipt = installLiveTyrian({
        repoRoot: root,
        home: userHome,
        apply,
        link,
        target: 'plasma',
        environment,
        stagingRoot: livePlan?.stagingRoot,
      });
    } else if (withPlasmaLayout && !link) {
      materializeRiceLayoutAsset(
        path.join(root, RICE_WALLPAPER_PATH),
        userHome,
        path.join(runtimeRoot, RICE_WALLPAPER_PATH),
        apply
      );
    }

    if (testInterruptAfterStyle) {
      throw new SimulatedRiceInterruption();
    }

    if (preparedLayout) {
      installPreparedPlasmaLayout(preparedLayout);
    } else {
      console.log(
        `${apply ? 'apply' : 'dry-run'}: Plasma layout restore skipped by explicit partial install mode`
      );
    }
  } catch (error) {
    if (filesystemReceipt) {
      try {
        filesystemReceipt.rollback();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Tyrian rice install and style rollback both failed'
        );
      }
    }

    throw error;
  }
}

class SimulatedRiceInterruption extends Error {
  constructor() {
    super('Simulated interruption between rice style and layout');
  }
}

class SimulatedRiceCommitInterruption extends Error {
  constructor() {
    super('Simulated interruption after the rice filesystem commit');
  }
}

/**
 * @param {{ repoRoot?: string; home?: string; runtimeRoot?: string; apply?: boolean; environment?: NodeJS.ProcessEnv; runCommand?: CommandRunner; hasCommand?: (command: string) => boolean; testInterruptAfterStop?: boolean; testInterruptAfterRuntime?: boolean; testInterruptAfterCommit?: boolean }} [options]
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
  }

  const executeInstall = () => {
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
        testInterruptAfterCommit: options.testInterruptAfterCommit,
      })
    );
  };

  if (!apply) {
    executeInstall();
    return;
  }

  withLiveInstallLock(
    userHome,
    () => {
      const recoveryOutcome = recoverRiceHomeState(userHome, runCommand);

      if (recoveryOutcome !== 'none') {
        console.log(`Recovered prior rice transaction: ${recoveryOutcome}`);
      }

      withCaptureLock(root, () => {
        recoverCapturePublication(root);
        executeInstall();
      });
    },
    { allowPlasmaRecovery: true }
  );
}

/**
 * @param {{ repoRoot?: string; home?: string; xdgRoots: DesktopXdgRoots; runtimeRoot?: string; materializeWallpaper?: boolean; apply?: boolean; runCommand?: CommandRunner; testInterruptAfterStop?: boolean; testInterruptAfterRuntime?: boolean; testInterruptAfterCommit?: boolean }} options
 * @returns {PreparedPlasmaLayoutInstall}
 */
function preparePlasmaLayoutInstallOwned(options) {
  const root = options.repoRoot ?? repoRoot;
  const userHome = options.home ?? home;
  const xdgRoots = options.xdgRoots;
  const runtimeRoot = options.runtimeRoot ?? path.join(userHome, TYRIAN_INSTALL_HOME);
  const apply = options.apply ?? false;
  const runCommand = options.runCommand ?? execFileSync;
  const backupRoot = buildTyrianBackupRoot(userHome, 'rice-layout-apply');

  checkRiceSnapshotOwned(root, userHome);

  if (apply) {
    assertPlasmaShellActive(runCommand, 'Plasma layout install');
  }

  const sourceEntries = RICE_LAYOUT_FILES.map((file) => ({
    file,
    targetPath: resolveRiceLayoutFilePath(xdgRoots, file),
    sourceContent: fs.readFileSync(path.join(root, file.snapshotPath), 'utf8'),
  }));
  const currentActivityId = apply ? readCurrentPlasmaActivityId(runCommand) : '';
  const primaryTarget = apply
    ? readPrimaryPlasmaTarget(runCommand)
    : { height: 0, otherScreens: [], screen: 0, width: 0 };
  const previousPanelStateById = apply ? readLivePanelStateById(runCommand) : new Map();
  const previousWallpaperState = apply ? readLivePlasmaWallpaperState(runCommand) : [];
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
      stagedPath: buildUnusedStagedPath(targetPath),
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
    backupRoot,
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
    testInterruptAfterCommit: options.testInterruptAfterCommit,
  };
}

/**
 * @param {PreparedPlasmaLayoutInstall} plan
 * @returns {void}
 */
function installPreparedPlasmaLayout(plan) {
  if (!plan.apply) {
    if (plan.materializeWallpaper) {
      materializeRiceLayoutAsset(plan.wallpaperSourcePath, plan.home, plan.wallpaperPath, false);
    }
    applyPlasmaLayoutInstall(plan);
    return;
  }

  const transaction = withHomeFilesystemTransaction(
    plan.home,
    {
      targetPaths: plan.installEntries
        .flatMap(({ stagedPath, targetPath }) => [targetPath, stagedPath])
        .concat(plan.materializeWallpaper ? [plan.wallpaperPath] : []),
      temporaryPaths: plan.installEntries.map(({ stagedPath }) => stagedPath),
      backupRoot: plan.backupRoot,
      owner: 'layout',
      shouldLeavePrepared: (error) =>
        error instanceof SimulatedPlasmaStopInterruption ||
        error instanceof SimulatedPlasmaRuntimeInterruption,
      afterRollback: () => recoverPlasmaLifecycle(plan.home, plan.runCommand, 'rolledBack'),
      afterCommit: () => {
        if (plan.testInterruptAfterCommit) {
          throw new SimulatedRiceCommitInterruption();
        }

        finishPlasmaLifecycle(plan.home);
      },
    },
    () => {
      if (plan.materializeWallpaper) {
        materializeRiceLayoutAsset(plan.wallpaperSourcePath, plan.home, plan.wallpaperPath, true);
      }
      applyPlasmaLayoutInstall(plan);
    }
  );

  if (transaction.receipt) {
    console.log(`Plasma layout install complete. Backup: ${transaction.receipt.backupRoot}`);
  }
}

/**
 * @param {PreparedPlasmaLayoutInstall} plan
 * @returns {void}
 */
function applyPlasmaLayoutInstall(plan) {
  if (!plan.apply) {
    operation(false, 'would stop Plasma shell before restoring layout', () => {});

    for (const { targetPath } of plan.installEntries) {
      operation(false, `would restore ${targetPath}`, () => {});
    }

    operation(false, 'would start Plasma shell', () => {});
    operation(false, 'would restore Plasma panel runtime state', () => {});
    operation(false, `would apply Plasma wallpaper ${plan.wallpaperPath}`, () => {});
    return;
  }

  const preparedEntries = plan.installEntries;
  const desiredPanelState = buildDesiredPanelRuntimeState(
    plan.panelStateById,
    plan.primaryTarget.screen
  );

  try {
    for (const entry of preparedEntries) {
      writeTextFileRaw(entry.stagedPath, entry.installedContent, {
        finalNewline: true,
        ownerRoot: plan.home,
      });
    }

    console.log('apply: stop Plasma shell before restoring layout');
    beginPlasmaLifecycle(plan.home, 'layout', {
      previousPanelStateById: plan.previousPanelStateById,
      previousWallpaperState: plan.previousWallpaperState,
      primaryScreen: plan.primaryTarget.screen,
    });
    stopPlasmaShell(plan.runCommand);

    if (plan.testInterruptAfterStop) {
      throw new SimulatedPlasmaStopInterruption();
    }

    for (const entry of preparedEntries) {
      console.log(`apply: restore ${entry.targetPath}`);
      publishStagedOwnedPathRaw(plan.home, entry.stagedPath, entry.targetPath);
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

    const appliedWallpaperState = assertPlasmaWallpaperApplied(plan.wallpaperPath, plan.runCommand);
    markPlasmaLifecycleRuntimeApplied(plan.home, desiredPanelState, appliedWallpaperState);

    if (plan.testInterruptAfterRuntime) {
      throw new SimulatedPlasmaRuntimeInterruption();
    }
  } finally {
    for (const { stagedPath } of preparedEntries) {
      if (exists(stagedPath)) removeOwnedPathRaw(plan.home, stagedPath);
    }
  }
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
    return section.replace(pattern, line);
  }

  return section.endsWith('\n') ? `${section}${line}\n` : `${section}\n${line}\n`;
}

/**
 * @param {string} sourcePath
 * @param {string} ownerRoot
 * @param {string} targetPath
 * @param {boolean} apply
 * @returns {void}
 */
function materializeRiceLayoutAsset(sourcePath, ownerRoot, targetPath, apply) {
  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    return;
  }

  if (!apply) {
    operation(false, `would copy ${sourcePath} -> ${targetPath}`, () => {});
    return;
  }

  operation(true, `copy ${sourcePath} -> ${targetPath}`, () => {
    installManagedPathRaw('copy', sourcePath, targetPath, { ownerRoot });
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
 * @returns {{ version: number; owner: string; requirements: string; wallpaperAsset: string; layoutFiles: Array<{ homePath: string; snapshotPath: string; portableWallpaper: boolean }> }}
 */
function buildRiceManifest() {
  return {
    version: 1,
    owner: RICE_MANIFEST_OWNER,
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
    /** @type {{ version?: unknown; owner?: unknown; requirements?: unknown; wallpaperAsset?: unknown; layoutFiles?: unknown }} */ (
      manifest
    );

  if (candidate.version !== 1) {
    throw new Error('Rice layout manifest has an unsupported version');
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
 * @param {string} targetPath
 * @returns {string}
 */
function buildUnusedStagedPath(targetPath) {
  /** @type {string} */
  let stagedPath;

  do {
    stagedPath = path.join(
      path.dirname(targetPath),
      `.${path.basename(targetPath)}.tyrian-${randomUUID()}.tmp`
    );
  } while (exists(stagedPath));

  return stagedPath;
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

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  main();
}
