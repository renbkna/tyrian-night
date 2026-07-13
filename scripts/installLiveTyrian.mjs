// @ts-check

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDesktopThemeAssets, writeDesktopThemeAssets } from './desktopThemes.mjs';
import {
  admitOwnedDirectories,
  admitOwnedPaths,
  assertAtomicDirectoryExchangeAvailable,
  discardOwnedPathSnapshot,
  exists,
  installManagedPathRaw as installManagedPathWithMode,
  operation,
  publishStagedOwnedPathRaw,
  recordOwnedPathGeneration,
  removeOwnedEmptyDirectoriesRaw,
  removeOwnedPathRaw,
  resolvePathIdentity,
  restoreOwnedPathSnapshot,
  snapshotOwnedPaths,
  syncPathsDurably,
  withTokenFileLock,
  writeOwnedRecoveryCandidateRaw,
  writeTextFileRaw,
} from './installOps.mjs';
import {
  buildTyrianBackupRoot,
  FASTFETCH_IMAGE_ASSET_PATH,
  TYRIAN_INSTALL_HOME,
  WALLPAPER_ASSET_PATH,
} from './portableAssets.mjs';
import {
  buildFishStartupConfig,
  buildFootConfig,
  buildGhosttyConfig,
  buildTerminalThemeAssets,
  writeTerminalThemeAssets,
} from './terminalThemes.mjs';
import { readThemeSources } from './themeSources.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = os.homedir();
const LIVE_INSTALL_LOCK_RELATIVE_PATH = '.tyrian-night-live-install.lock';
const LIVE_INSTALL_TRANSACTION_RELATIVE_PATH =
  '.local/state/tyrian-night/live-install-transaction.json';
export const LIVE_INSTALL_OWNERSHIP_RELATIVE_PATH =
  '.local/state/tyrian-night/live-owned-paths.json';
export const LIVE_INSTALL_MIGRATION_RETIREMENT_RELATIVE_PATH =
  '.local/state/tyrian-night/live-legacy-migration-retired.json';
const PLASMA_LIFECYCLE_RELATIVE_PATH = '.local/state/tyrian-night/plasma-lifecycle.json';
// One-time migration inventory for installs predating owned-path state. The
// separate retirement marker prevents a lost manifest from reviving deletion.
const RELEASED_THEME_SLUGS = [
  'tyrian-night',
  'tyrian-nocturne',
  'tyrian-night-old',
  'tyrian-abyss',
  'tyrian-dawn',
];
const LIVE_INSTALL_TARGETS = new Set(['plasma', 'caelestia']);
const HYPRLAND_MODES = new Set(['lua', 'legacy']);
/** @type {Map<string, { depth: number; owner: 'live' | 'rice' | 'layout'; targetPaths: string[] }>} */
const activeHomeTransactions = new Map();

/**
 * @typedef {'copy' | 'link'} InstallMode
 * @typedef {'plasma' | 'caelestia'} LiveInstallTarget
 * @typedef {'lua' | 'legacy'} HyprlandMode
 * @typedef {(command: string, args: string[], options?: import('node:child_process').ExecFileSyncOptions) => Buffer | string} CommandRunner
 * @typedef {{ source: string; target: string }} CopyRoot
 * @typedef {{
 *   target: LiveInstallTarget;
 *   mode: InstallMode;
 *   apply: boolean;
 *   repoRoot: string;
 *   home: string;
 *   installRoot: string;
 *   stagingRoot: string;
 *   sourceRoot: string;
 *   backupRoot: string;
 *   configRoot: string;
 *   dataRoot: string;
 *   stateRoot: string;
 *   materializedRoots: CopyRoot[];
 *   materializedPaths: string[];
 *   terminalThemeSlugs: string[];
 *   livePaths: Record<string, string>;
 *   sourcePaths: Record<string, string>;
 *   legacyPaths: LiveOwnedRegistry;
 *   commonOwnedPaths: string[];
 *   targetOwnedPaths: string[];
 *   ownershipManifestPath: string;
 *   migrationRetirementPath: string;
 *   touchedPaths: string[];
 *   hyprlandMode?: HyprlandMode;
 * }} LiveInstallPlan
 * @typedef {{
 *   fishStartupConfig: string;
 *   footConfig: string;
 *   ghosttyConfig: string;
 * }} PreparedCommonInstall
 * @typedef {{ target: 'plasma'; screenLockerConfig: string; kdeglobals: string; plasmarc: string }} PreparedPlasmaInstall
 * @typedef {{ target: 'caelestia'; caelestiaSequences: string }} PreparedCaelestiaInstall
 * @typedef {{ common: PreparedCommonInstall; desktop: PreparedPlasmaInstall | PreparedCaelestiaInstall }} PreparedLiveInstall
 * @typedef {{ common: string[]; plasma: string[]; caelestia: string[] }} LiveOwnedRegistry
 * @typedef {{ backupRoot: string; rollback: () => void }} LiveInstallReceipt
 */

const MATERIALIZED_INSTALL_DIRECTORIES = new Set([
  'desktop/kde/plasma/desktoptheme/TyrianNight',
  'desktop/kde/plasma/look-and-feel/TyrianNight',
]);

/**
 * Materialize the generated assets consumed by the install contract. This belongs
 * to the CLI boundary so a clean checkout never depends on ignored build output.
 *
 * @param {string} root
 * @param {{ home?: string; link?: boolean; target: LiveInstallTarget; hyprlandMode?: HyprlandMode; runCommand?: CommandRunner }} options
 * @returns {void}
 */
export function prepareLiveInstallRepository(root, options) {
  const physicalRoot = resolvePathIdentity(root);
  const userHome = resolvePathIdentity(options.home ?? home);
  const plan = buildLiveInstallPlan({
    repoRoot: physicalRoot,
    home: userHome,
    link: options.link,
    target: options.target,
    hyprlandMode: options.hyprlandMode,
    runCommand: options.runCommand,
  });

  assertRepositoryIndependentOfTargets(physicalRoot, buildPlanMutationTargets(plan));
  preflightGeneratedRepository(physicalRoot);
  writeTerminalThemeAssets(physicalRoot);
  writeDesktopThemeAssets(physicalRoot);
}

/**
 * Validate every generator input and the type of every existing output
 * ancestor before either generator receives write authority.
 *
 * @param {string} root
 * @returns {Array<{ path: string; content: string }>}
 */
function preflightGeneratedRepository(root) {
  assertRegularPathUnder(root, path.join(root, 'package.json'), 'package.json');
  assertRegularPathUnder(
    root,
    path.join(root, 'apps/desktop/package.json'),
    'apps/desktop/package.json'
  );
  const catalogPath = path.join(root, 'source/themeCatalog.json');
  assertRegularPathUnder(root, catalogPath, 'source/themeCatalog.json');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

  if (!Array.isArray(catalog)) {
    throw new Error('source/themeCatalog.json must contain an array');
  }

  for (const entry of catalog) {
    if (!entry || typeof entry.slug !== 'string' || !/^[a-z0-9-]+$/u.test(entry.slug)) {
      throw new Error('source/themeCatalog.json contains an invalid theme slug');
    }

    const relativePath = `source/themes/${entry.slug}.json`;
    assertRegularPathUnder(root, path.join(root, relativePath), relativePath);
  }

  assertRegularTreeUnder(root, path.join(root, 'source/union-css'), 'source/union-css');
  const assets = [...buildTerminalThemeAssets(root), ...buildDesktopThemeAssets(root)];

  for (const asset of assets) {
    assertGeneratedOutputAncestors(root, asset.path);
  }

  return assets;
}

/**
 * @param {string} root
 * @param {string} filePath
 * @param {string} label
 * @returns {void}
 */
function assertRegularPathUnder(root, filePath, label) {
  const relativePath = path.relative(root, filePath);
  let currentPath = root;

  for (const segment of relativePath.split(path.sep)) {
    currentPath = path.join(currentPath, segment);
    const stats = fs.lstatSync(currentPath);

    if (stats.isSymbolicLink()) {
      throw new Error(`Generator input traverses a symbolic link: ${label}`);
    }
  }

  if (!fs.lstatSync(filePath).isFile()) {
    throw new Error(`Generator input must be a regular file: ${label}`);
  }
}

/**
 * @param {string} root
 * @param {string} directory
 * @param {string} label
 * @returns {void}
 */
function assertRegularTreeUnder(root, directory, label) {
  const relativePath = path.relative(root, directory);
  let currentPath = root;

  for (const segment of relativePath.split(path.sep)) {
    currentPath = path.join(currentPath, segment);
    const stats = fs.lstatSync(currentPath);

    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Generator input tree has an invalid ancestor: ${label}`);
    }
  }

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const childPath = path.join(directory, entry.name);
    const childLabel = path.posix.join(label, entry.name);

    if (entry.isSymbolicLink()) {
      throw new Error(`Generator input tree contains a symbolic link: ${childLabel}`);
    }

    if (entry.isDirectory()) {
      assertRegularTreeUnder(root, childPath, childLabel);
    } else if (!entry.isFile()) {
      throw new Error(`Generator input tree contains a non-file entry: ${childLabel}`);
    }
  }
}

/**
 * @param {string} root
 * @param {string} relativeOutput
 * @returns {void}
 */
function assertGeneratedOutputAncestors(root, relativeOutput) {
  if (path.isAbsolute(relativeOutput) || relativeOutput.split('/').includes('..')) {
    throw new Error(`Generator output escapes the repository: ${relativeOutput}`);
  }

  const segments = relativeOutput.split('/');
  let currentPath = root;

  for (let index = 0; index < segments.length; index += 1) {
    currentPath = path.join(currentPath, segments[index]);

    if (!exists(currentPath)) {
      continue;
    }

    const stats = fs.lstatSync(currentPath);
    const isLeaf = index === segments.length - 1;

    if (stats.isSymbolicLink() || (isLeaf ? !stats.isFile() : !stats.isDirectory())) {
      throw new Error(`Generator output has an invalid existing path: ${relativeOutput}`);
    }
  }
}

/**
 * @param {{ repoRoot?: string; home?: string; apply?: boolean; link?: boolean; stagingRoot?: string; environment?: NodeJS.ProcessEnv; target: LiveInstallTarget; hyprlandMode?: HyprlandMode; runCommand?: CommandRunner }} options
 * @returns {LiveInstallPlan}
 */
export function buildLiveInstallPlan(options) {
  const root = resolvePathIdentity(options.repoRoot ?? repoRoot);
  const userHome = resolvePathIdentity(options.home ?? home);
  const target = requireLiveInstallTarget(options.target);
  const xdgRoots = resolveXdgRoots(
    userHome,
    options.environment ?? (options.home === undefined ? process.env : {})
  );
  const mode = options.link ? 'link' : 'copy';
  const installRoot = path.join(userHome, TYRIAN_INSTALL_HOME);
  const stagingRoot = options.stagingRoot ?? buildUnusedInstallStagingRoot(installRoot);
  const sourceRoot = mode === 'link' ? root : installRoot;
  if (
    target === 'caelestia' &&
    options.hyprlandMode === undefined &&
    options.runCommand === undefined &&
    userHome !== resolvePathIdentity(home)
  ) {
    throw new Error(
      'Cannot infer Hyprland mode for a different destination home; pass hyprlandMode "lua" or "legacy"'
    );
  }
  const hyprlandMode =
    target === 'caelestia'
      ? selectHyprlandMode(options.hyprlandMode, options.runCommand ?? execFileSync)
      : undefined;
  if (target === 'plasma' && options.hyprlandMode !== undefined) {
    throw new Error('Hyprland mode is only valid for the Caelestia target');
  }
  const livePaths = buildLivePaths(xdgRoots, hyprlandMode);
  const legacyPaths = buildLegacyPaths(userHome, xdgRoots);
  const sourcePaths = buildSourcePaths(sourceRoot, hyprlandMode);
  const terminalThemeSlugs = readThemeSources(root).map((source) => source.slug);
  const materializedPaths = buildMaterializedInstallPaths(terminalThemeSlugs);
  const materializedRoots =
    mode === 'copy'
      ? materializedPaths.map((relativePath) => ({
          source: path.join(root, relativePath),
          target: path.join(installRoot, relativePath),
        }))
      : [
          {
            source: path.join(root, FASTFETCH_IMAGE_ASSET_PATH),
            target: path.join(installRoot, FASTFETCH_IMAGE_ASSET_PATH),
          },
          {
            source: path.join(root, 'assets/wallpaper-tyrian.png'),
            target: path.join(installRoot, 'assets/wallpaper-tyrian.png'),
          },
        ];
  const commonOwnedPaths = buildCommonOwnedPaths(
    livePaths,
    terminalThemeSlugs,
    mode,
    installRoot,
    materializedRoots
  );
  const targetOwnedPaths = buildTargetOwnedPaths(target, livePaths, hyprlandMode);
  const ownershipManifestPath = path.join(userHome, LIVE_INSTALL_OWNERSHIP_RELATIVE_PATH);
  const migrationRetirementPath = path.join(
    userHome,
    LIVE_INSTALL_MIGRATION_RETIREMENT_RELATIVE_PATH
  );

  return {
    target,
    mode,
    apply: options.apply ?? false,
    repoRoot: root,
    home: userHome,
    installRoot,
    stagingRoot,
    sourceRoot,
    backupRoot: buildTyrianBackupRoot(userHome, 'live-tyrian-apply'),
    configRoot: xdgRoots.configRoot,
    dataRoot: xdgRoots.dataRoot,
    stateRoot: xdgRoots.stateRoot,
    materializedPaths,
    materializedRoots,
    livePaths,
    sourcePaths,
    terminalThemeSlugs,
    legacyPaths,
    commonOwnedPaths,
    targetOwnedPaths,
    ownershipManifestPath,
    migrationRetirementPath,
    touchedPaths: [...commonOwnedPaths, ...targetOwnedPaths],
    hyprlandMode,
  };
}

/**
 * @param {string} installRoot
 * @returns {string}
 */
function buildUnusedInstallStagingRoot(installRoot) {
  /** @type {string} */
  let stagingRoot;

  do {
    stagingRoot = `${installRoot}.stage-${randomUUID()}`;
  } while (exists(stagingRoot));

  return stagingRoot;
}

/**
 * @param {string[]} themeSlugs
 * @returns {string[]}
 */
function buildMaterializedInstallPaths(themeSlugs) {
  return [
    FASTFETCH_IMAGE_ASSET_PATH,
    WALLPAPER_ASSET_PATH,
    ...themeSlugs.map((slug) => `terminal/ghostty/themes/${slug}`),
    ...themeSlugs.map((slug) => `terminal/foot/themes/${slug}.ini`),
    ...themeSlugs.map((slug) => `terminal/fish/themes/${slug}.fish`),
    'terminal/fish/functions/fish_greeting.fish',
    'terminal/fastfetch/tyrian-night.jsonc',
    'terminal/starship/tyrian-night.toml',
    'desktop/kde/color-schemes/TyrianNight.colors',
    'desktop/kde/plasma/desktoptheme/TyrianNight',
    'desktop/kde/plasma/look-and-feel/TyrianNight',
    'desktop/caelestia/state/tyrian-night.scheme.json',
    'desktop/caelestia/hypr/tyrian-night.conf',
    'desktop/caelestia/hypr/tyrian-night.lua',
  ];
}

/**
 * @param {{ repoRoot?: string; home?: string; apply?: boolean; link?: boolean; stagingRoot?: string; environment?: NodeJS.ProcessEnv; target: LiveInstallTarget; hyprlandMode?: HyprlandMode; runCommand?: CommandRunner; testInterruptAfterMutation?: boolean; testFailCommit?: boolean }} options
 * @returns {LiveInstallReceipt | undefined}
 */
export function installLiveTyrian(options) {
  const plan = buildLiveInstallPlan(options);

  assertRepositoryIndependentOfTargets(plan.repoRoot, buildPlanMutationTargets(plan));
  assertNoDestinationSymlinkAncestors(plan.home, [...buildPlanMutationTargets(plan)]);
  admitOwnedDirectories(
    plan.home,
    [plan.stagingRoot, plan.backupRoot],
    'Live install transaction container'
  );
  if (!plan.apply) {
    return installLiveTyrianOwned(plan, options);
  }

  return withLiveInstallLock(plan.home, () => installLiveTyrianOwned(plan, options));
}

/**
 * Recover an interrupted live filesystem transaction under the same lock as apply.
 * Preview never calls this capability.
 *
 * @param {{ home?: string }} [options]
 * @returns {'none' | 'committed' | 'rolledBack'}
 */
export function recoverLiveTyrian(options = {}) {
  const userHome = resolvePathIdentity(options.home ?? home);

  return withLiveInstallLock(
    userHome,
    () => {
      const outcome = recoverHomeFilesystemTransaction(userHome);
      console.log(`Tyrian live recovery completed (filesystem outcome: ${outcome}).`);
      return outcome;
    },
    { recoverBeforeAction: false }
  );
}

/**
 * @template T
 * @param {string} requestedHome
 * @param {() => T} action
 * @param {{ allowPlasmaRecovery?: boolean; recoverBeforeAction?: boolean }} [options]
 * @returns {T}
 */
export function withLiveInstallLock(requestedHome, action, options = {}) {
  const userHome = resolvePathIdentity(requestedHome);
  const lockPath = path.join(userHome, LIVE_INSTALL_LOCK_RELATIVE_PATH);
  assertNoDestinationSymlinkAncestors(userHome, [
    lockPath,
    path.join(userHome, LIVE_INSTALL_TRANSACTION_RELATIVE_PATH),
  ]);

  return withTokenFileLock(
    lockPath,
    () => {
      if (
        exists(path.join(userHome, PLASMA_LIFECYCLE_RELATIVE_PATH)) &&
        !options.allowPlasmaRecovery
      ) {
        throw new Error(
          'An unfinished Plasma lifecycle requires recovery through the rice command'
        );
      }

      if (
        !activeHomeTransactions.has(userHome) &&
        !options.allowPlasmaRecovery &&
        options.recoverBeforeAction !== false
      ) {
        recoverHomeFilesystemTransaction(userHome);
      }

      return action();
    },
    { ownerRoot: userHome }
  );
}

/**
 * @template T
 * @param {string} requestedHome
 * @param {{ targetPaths: string[]; backupRoot: string; owner: 'live' | 'rice' | 'layout'; shouldLeavePrepared?: (error: unknown) => boolean; afterRollback?: () => void; afterCommit?: () => void; testFailCommit?: boolean }} transaction
 * @param {() => T} action
 * @returns {{ result: T; receipt?: LiveInstallReceipt }}
 */
export function withHomeFilesystemTransaction(requestedHome, transaction, action) {
  const userHome = resolvePathIdentity(requestedHome);
  const canonicalTargetPaths = [
    ...new Set(canonicalizeOwnedHomePaths(userHome, transaction.targetPaths)),
  ];
  const targetPaths = canonicalTargetPaths.filter(
    (candidate) =>
      !canonicalTargetPaths.some(
        (possibleAncestor) =>
          possibleAncestor !== candidate && isSameOrDescendant(possibleAncestor, candidate)
      )
  );
  const [backupRoot] = canonicalizeOwnedHomePaths(userHome, [transaction.backupRoot]);
  admitOwnedDirectories(userHome, [backupRoot], `${transaction.owner} backup container`);

  return withLiveInstallLock(userHome, () => {
    const active = activeHomeTransactions.get(userHome);

    if (active) {
      const outsideOwner = targetPaths.find(
        (targetPath) =>
          !active.targetPaths.some((ownedPath) => isSameOrDescendant(ownedPath, targetPath))
      );

      if (outsideOwner) {
        throw new Error(`Nested home transaction target is outside its owner: ${outsideOwner}`);
      }

      active.depth += 1;

      try {
        return { result: action() };
      } finally {
        active.depth -= 1;
      }
    }

    assertAtomicDirectoryExchangeAvailable();

    const snapshotId = randomUUID();
    /** @type {{ version: 3; owner: 'live' | 'rice' | 'layout'; phase: 'allocating'; backupRoot: string; snapshotId: string; targetPaths: string[] }} */
    const allocatingPointer = {
      version: 3,
      owner: transaction.owner,
      phase: 'allocating',
      backupRoot: path.relative(userHome, backupRoot),
      snapshotId,
      targetPaths: targetPaths.map((targetPath) => path.relative(userHome, targetPath)),
    };
    writeLiveInstallTransaction(userHome, allocatingPointer);
    /** @type {ReturnType<typeof snapshotOwnedPaths> | undefined} */
    let snapshot;

    try {
      snapshot = snapshotOwnedPaths(targetPaths, backupRoot, { ownerRoot: userHome, snapshotId });
      syncPathsDurably([backupRoot, path.dirname(backupRoot)]);
      writeLiveInstallTransaction(userHome, { ...allocatingPointer, phase: 'prepared' });
    } catch (error) {
      snapshot?.discard();
      removeLiveInstallTransaction(userHome);
      throw error;
    }

    const pointer = { ...allocatingPointer, phase: /** @type {const} */ ('prepared') };

    activeHomeTransactions.set(userHome, { depth: 1, owner: transaction.owner, targetPaths });
    /** @type {T | undefined} */
    let result;

    try {
      result = action();
    } catch (error) {
      activeHomeTransactions.delete(userHome);
      snapshot.seal();

      if (transaction.shouldLeavePrepared?.(error)) {
        throw error;
      }

      /** @type {unknown[]} */
      const rollbackFailures = [];

      try {
        recoverHomeFilesystemTransaction(userHome);
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }

      if (rollbackFailures.length === 0) {
        try {
          transaction.afterRollback?.();
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      }

      if (rollbackFailures.length > 0) {
        throw new AggregateError(
          [error, ...rollbackFailures],
          `${transaction.owner} transaction and rollback both failed`
        );
      }

      throw error;
    }

    activeHomeTransactions.delete(userHome);
    snapshot.seal();

    try {
      syncPathsDurably(targetPaths);

      if (transaction.testFailCommit) {
        throw new Error(`Simulated ${transaction.owner} commit write failure`);
      }

      writeLiveInstallTransaction(userHome, { ...pointer, phase: 'committed' });
    } catch (commitError) {
      /** @type {unknown[]} */
      const rollbackFailures = [];

      try {
        recoverHomeFilesystemTransaction(userHome);
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }

      if (rollbackFailures.length === 0) {
        try {
          transaction.afterRollback?.();
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      }

      if (rollbackFailures.length > 0) {
        throw new AggregateError(
          [commitError, ...rollbackFailures],
          `${transaction.owner} commit and rollback both failed`
        );
      }

      throw commitError;
    }

    let finalizationDeferred = false;

    try {
      transaction.afterCommit?.();
    } catch (error) {
      finalizationDeferred = true;
      console.warn(`Committed ${transaction.owner} finalization was deferred: ${String(error)}`);
    }

    if (!finalizationDeferred) {
      try {
        removeLiveInstallTransaction(userHome);
      } catch (error) {
        console.warn(`Committed ${transaction.owner} cleanup was deferred: ${String(error)}`);
      }
    }

    return {
      result: /** @type {T} */ (result),
      receipt: {
        backupRoot,
        rollback() {
          snapshot.rollback();
        },
      },
    };
  });
}

/**
 * @param {string} userHome
 * @param {string[]} targetPaths
 * @returns {void}
 */
function assertNoDestinationSymlinkAncestors(userHome, targetPaths) {
  canonicalizeOwnedHomePaths(userHome, targetPaths);
}

/**
 * Resolve fixed leaves through verified physical parents. Transaction admission
 * and persisted recovery therefore use the same path identity.
 *
 * @param {string} userHome
 * @param {string[]} targetPaths
 * @returns {string[]}
 */
function canonicalizeOwnedHomePaths(userHome, targetPaths) {
  return admitOwnedPaths(userHome, targetPaths, 'Live install destination');
}

/**
 * @param {LiveInstallPlan} plan
 * @param {{ testInterruptAfterMutation?: boolean; testFailCommit?: boolean }} options
 * @returns {LiveInstallReceipt | undefined}
 */
function installLiveTyrianOwned(plan, options) {
  const prepared = plan.apply ? prepareLiveInstall(plan) : prepareLiveInstallPreview(plan);
  const { desiredOwnedRegistry, staleOwnedPaths, targetPaths } =
    resolveLiveInstallTransactionScope(plan);

  if (!plan.apply) {
    materializeSourceRoot(plan);
    cleanupStaleOwnedPaths(plan, staleOwnedPaths);
    installTerminalLayer(plan, prepared.common);
    installTargetLayer(plan, prepared.desktop);
    publishLiveOwnedPaths(plan, desiredOwnedRegistry);
    publishLiveMigrationRetirement(plan);
    console.log(
      `Dry run complete for ${plan.target}. Re-run with --apply --target=${plan.target} to ${plan.mode === 'link' ? 'link live config to the repo' : `copy Tyrian into ${plan.installRoot}`}.`
    );
    return undefined;
  }

  const transaction = withHomeFilesystemTransaction(
    plan.home,
    {
      targetPaths,
      backupRoot: plan.backupRoot,
      owner: 'live',
      shouldLeavePrepared: (error) => error instanceof SimulatedLiveInstallInterruption,
      testFailCommit: options.testFailCommit,
    },
    () => {
      materializeSourceRoot(plan);

      if (options.testInterruptAfterMutation) {
        throw new SimulatedLiveInstallInterruption();
      }

      cleanupStaleOwnedPaths(plan, staleOwnedPaths);
      installTerminalLayer(plan, prepared.common);
      installTargetLayer(plan, prepared.desktop);
      publishLiveOwnedPaths(plan, desiredOwnedRegistry);
      publishLiveMigrationRetirement(plan);
    }
  );

  if (transaction.receipt) {
    console.log(`Live Tyrian install complete. Backup: ${transaction.receipt.backupRoot}`);
  }

  return transaction.receipt;
}

/**
 * Project the complete target set required by a surrounding rice transaction.
 * The live installer remains the sole authority for interpreting its manifest.
 *
 * @param {LiveInstallPlan} plan
 * @returns {string[]}
 */
export function readLiveInstallTransactionTargets(plan) {
  return resolveLiveInstallTransactionScope(plan).targetPaths;
}

/**
 * @param {LiveInstallPlan} plan
 * @returns {{ desiredOwnedRegistry: LiveOwnedRegistry; staleOwnedPaths: string[]; targetPaths: string[] }}
 */
function resolveLiveInstallTransactionScope(plan) {
  const previousOwnedRegistry = readLiveOwnedRegistry(plan);
  const desiredOwnedRegistry = {
    common: [...new Set(plan.commonOwnedPaths)],
    plasma:
      plan.target === 'plasma' ? [...new Set(plan.targetOwnedPaths)] : previousOwnedRegistry.plasma,
    caelestia:
      plan.target === 'caelestia'
        ? [...new Set(plan.targetOwnedPaths)]
        : previousOwnedRegistry.caelestia,
  };
  assertLiveOwnedRegistry(plan, desiredOwnedRegistry);

  const previousActivePaths = [
    ...previousOwnedRegistry.common,
    ...previousOwnedRegistry[plan.target],
  ];
  const desiredActivePaths = [...desiredOwnedRegistry.common, ...desiredOwnedRegistry[plan.target]];
  const staleOwnedPaths = previousActivePaths.filter(
    (ownedPath) =>
      !desiredActivePaths.some(
        (desiredPath) =>
          isSameOrDescendant(ownedPath, desiredPath) || isSameOrDescendant(desiredPath, ownedPath)
      )
  );

  const targetPaths = [
    ...(plan.mode === 'copy' ? [plan.installRoot, plan.stagingRoot] : []),
    ...plan.materializedRoots
      .map(({ target }) => target)
      .filter((target) => plan.mode !== 'copy' || !isSameOrDescendant(plan.installRoot, target)),
    plan.ownershipManifestPath,
    plan.migrationRetirementPath,
    ...plan.touchedPaths,
    ...staleOwnedPaths,
  ];
  assertRepositoryIndependentOfTargets(plan.repoRoot, targetPaths);
  admitOwnedPaths(plan.home, targetPaths, 'Live install transaction');
  admitOwnedDirectories(
    plan.home,
    [plan.stagingRoot, plan.backupRoot],
    'Live install transaction container'
  );

  return {
    desiredOwnedRegistry,
    staleOwnedPaths,
    targetPaths,
  };
}

/**
 * @param {LiveInstallPlan} plan
 * @returns {LiveOwnedRegistry}
 */
function readLiveOwnedRegistry(plan) {
  if (!exists(plan.ownershipManifestPath)) {
    if (isLiveMigrationRetired(plan)) {
      return { common: [], plasma: [], caelestia: [] };
    }

    return {
      common: [
        ...RELEASED_THEME_SLUGS.map((slug) => path.join(plan.livePaths.ghosttyThemes, slug)),
        ...RELEASED_THEME_SLUGS.map((slug) => path.join(plan.livePaths.footThemes, `${slug}.ini`)),
        path.join(plan.configRoot, 'ghostty/ghostty.css'),
        ...plan.legacyPaths.common,
      ].filter(exists),
      plasma: plan.legacyPaths.plasma.filter(exists),
      caelestia: plan.legacyPaths.caelestia.filter(exists),
    };
  }

  const stats = fs.lstatSync(plan.ownershipManifestPath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('Live install ownership manifest must be a regular file');
  }

  const candidate = JSON.parse(fs.readFileSync(plan.ownershipManifestPath, 'utf8'));
  if (candidate?.owner !== 'Tyrian Night live install') {
    throw new Error('Live install ownership manifest is corrupt');
  }

  /** @type {LiveOwnedRegistry} */
  let registry;
  if (candidate.version === 1 && Array.isArray(candidate.paths)) {
    registry = { common: [], plasma: [], caelestia: [] };
    for (const ownedPath of decodeLiveOwnedPaths(plan, candidate.paths)) {
      const profile = classifyLiveOwnedPath(plan, ownedPath);
      if (profile === undefined) {
        throw new Error(
          `Live install ownership manifest contains an unowned path: ${path.relative(plan.home, ownedPath)}`
        );
      }
      registry[profile].push(ownedPath);
    }
  } else if (
    candidate.version === 2 &&
    candidate.profiles !== null &&
    typeof candidate.profiles === 'object' &&
    Object.keys(candidate.profiles).toSorted().join(',') === 'caelestia,common,plasma' &&
    Array.isArray(candidate.profiles.common) &&
    Array.isArray(candidate.profiles.plasma) &&
    Array.isArray(candidate.profiles.caelestia)
  ) {
    registry = {
      common: decodeLiveOwnedPaths(plan, candidate.profiles.common, 'common'),
      plasma: decodeLiveOwnedPaths(plan, candidate.profiles.plasma, 'plasma'),
      caelestia: decodeLiveOwnedPaths(plan, candidate.profiles.caelestia, 'caelestia'),
    };
  } else {
    throw new Error('Live install ownership manifest is corrupt');
  }

  assertLiveOwnedRegistry(plan, registry);
  return registry;
}

/**
 * @param {LiveInstallPlan} plan
 * @param {unknown[]} relativePaths
 * @param {keyof LiveOwnedRegistry} [expectedProfile]
 * @returns {string[]}
 */
function decodeLiveOwnedPaths(plan, relativePaths, expectedProfile) {
  return relativePaths.map((relativePath) => {
    if (
      typeof relativePath !== 'string' ||
      relativePath.length === 0 ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error('Live install ownership manifest is corrupt');
    }

    const ownedPath = path.resolve(plan.home, relativePath);
    const profile = classifyLiveOwnedPath(plan, ownedPath);
    if (relativePath !== path.relative(plan.home, ownedPath) || profile === undefined) {
      throw new Error(`Live install ownership manifest contains an unowned path: ${relativePath}`);
    }
    if (expectedProfile !== undefined && profile !== expectedProfile) {
      throw new Error(
        `Live install ownership manifest assigns ${relativePath} to ${expectedProfile}, not ${profile}`
      );
    }

    return ownedPath;
  });
}

/**
 * @param {LiveInstallPlan} plan
 * @param {LiveOwnedRegistry} registry
 * @returns {void}
 */
function assertLiveOwnedRegistry(plan, registry) {
  const entries = /** @type {Array<[keyof LiveOwnedRegistry, string]>} */ (
    Object.entries(registry).flatMap(([profile, ownedPaths]) =>
      ownedPaths.map((ownedPath) => [profile, ownedPath])
    )
  );
  const uniquePaths = new Set(entries.map(([, ownedPath]) => ownedPath));
  if (uniquePaths.size !== entries.length) {
    throw new Error('Live install ownership manifest contains duplicate paths');
  }

  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    const [leftProfile, leftPath] = entries[leftIndex];
    if (classifyLiveOwnedPath(plan, leftPath) !== leftProfile) {
      throw new Error(`Live install ownership registry contains an invalid ${leftProfile} path`);
    }

    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const [rightProfile, rightPath] = entries[rightIndex];
      if (
        leftProfile !== rightProfile &&
        (isSameOrDescendant(leftPath, rightPath) || isSameOrDescendant(rightPath, leftPath))
      ) {
        throw new Error('Live install ownership profiles overlap');
      }
    }
  }
}

/**
 * @param {LiveInstallPlan} plan
 * @returns {boolean}
 */
function isLiveMigrationRetired(plan) {
  if (!exists(plan.migrationRetirementPath)) return false;
  const stats = fs.lstatSync(plan.migrationRetirementPath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('Live legacy migration retirement marker must be a regular file');
  }

  const marker = JSON.parse(fs.readFileSync(plan.migrationRetirementPath, 'utf8'));
  if (
    marker?.version !== 1 ||
    marker.owner !== 'Tyrian Night live install' ||
    marker.legacyMigrationRetired !== true
  ) {
    throw new Error('Live legacy migration retirement marker is corrupt');
  }

  return true;
}

/**
 * @param {LiveInstallPlan} plan
 * @param {string} ownedPath
 * @returns {keyof LiveOwnedRegistry | undefined}
 */
function classifyLiveOwnedPath(plan, ownedPath) {
  if (isSameOrDescendant(plan.installRoot, ownedPath)) return 'common';
  if (plan.commonOwnedPaths.includes(ownedPath)) return 'common';
  if (plan.legacyPaths.common.includes(ownedPath)) return 'common';
  if (plan.legacyPaths.plasma.includes(ownedPath)) return 'plasma';
  if (plan.legacyPaths.caelestia.includes(ownedPath)) return 'caelestia';
  if (ownedPath === path.join(plan.configRoot, 'ghostty/ghostty.css')) return 'common';
  const ghosttyRelative = path.relative(plan.livePaths.ghosttyThemes, ownedPath);
  if (/^tyrian-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(ghosttyRelative)) return 'common';

  const footRelative = path.relative(plan.livePaths.footThemes, ownedPath);
  if (/^tyrian-[a-z0-9]+(?:-[a-z0-9]+)*\.ini$/u.test(footRelative)) return 'common';

  if (buildTargetOwnedPaths('plasma', plan.livePaths, undefined).includes(ownedPath)) {
    return 'plasma';
  }
  if (
    [
      plan.livePaths.caelestiaSchemeState,
      plan.livePaths.caelestiaSequences,
      plan.livePaths.hyprCurrentLua,
      plan.livePaths.hyprCurrentLegacy,
    ].includes(ownedPath)
  ) {
    return 'caelestia';
  }

  return undefined;
}

/**
 * @param {LiveInstallPlan} plan
 * @param {string[]} staleOwnedPaths
 * @returns {void}
 */
function cleanupStaleOwnedPaths(plan, staleOwnedPaths) {
  for (const stalePath of staleOwnedPaths) {
    operation(plan.apply, `remove stale owned path ${stalePath}`, () => {
      removeOwnedPathRaw(plan.home, stalePath);
    });
  }
}

/**
 * @param {LiveInstallPlan} plan
 * @param {LiveOwnedRegistry} registry
 * @returns {void}
 */
function publishLiveOwnedPaths(plan, registry) {
  assertLiveOwnedRegistry(plan, registry);
  const relativeProfiles = Object.fromEntries(
    Object.entries(registry).map(([profile, ownedPaths]) => [
      profile,
      ownedPaths.map((ownedPath) => path.relative(plan.home, ownedPath)).toSorted(),
    ])
  );
  const content = `${JSON.stringify(
    {
      version: 2,
      owner: 'Tyrian Night live install',
      profiles: relativeProfiles,
    },
    null,
    2
  )}\n`;

  operation(plan.apply, `write ${plan.ownershipManifestPath}`, () => {
    writeFileRaw(plan.home, plan.ownershipManifestPath, content);
  });
}

/**
 * @param {LiveInstallPlan} plan
 * @returns {void}
 */
function publishLiveMigrationRetirement(plan) {
  const content = `${JSON.stringify(
    {
      version: 1,
      owner: 'Tyrian Night live install',
      legacyMigrationRetired: true,
    },
    null,
    2
  )}\n`;

  operation(plan.apply, `write ${plan.migrationRetirementPath}`, () => {
    writeFileRaw(plan.home, plan.migrationRetirementPath, content);
  });
}

class SimulatedLiveInstallInterruption extends Error {
  constructor() {
    super('Simulated interruption during live Tyrian installation');
  }
}

/**
 * @param {string} userHome
 * @param {{ deferCommittedCleanup?: boolean }} [options]
 * @returns {'none' | 'committed' | 'rolledBack'}
 */
export function recoverHomeFilesystemTransaction(userHome, options = {}) {
  const transactionPath = path.join(userHome, LIVE_INSTALL_TRANSACTION_RELATIVE_PATH);
  const transactionCandidatePath = `${transactionPath}.next`;

  if (exists(transactionCandidatePath)) {
    removeOwnedPathRaw(userHome, transactionCandidatePath);
  }

  if (!exists(transactionPath)) {
    return 'none';
  }

  const transaction = readLiveInstallTransaction(userHome);
  const backupRoot = path.resolve(userHome, transaction.backupRoot);

  if (transaction.version === 2) {
    if (transaction.phase === 'committed') {
      if (!options.deferCommittedCleanup) {
        removeLiveInstallTransaction(userHome);
      }

      return 'committed';
    }

    throw new Error(
      `Legacy live transaction ${transaction.phase} cannot be recovered safely because it has no generation evidence; preserve ${backupRoot}`
    );
  }

  if (transaction.phase === 'allocating') {
    if (exists(backupRoot)) {
      removeOwnedPathRaw(userHome, backupRoot);
    }

    removeLiveInstallTransaction(userHome);
    return 'rolledBack';
  }

  if (transaction.phase === 'committed') {
    if (!options.deferCommittedCleanup) {
      removeLiveInstallTransaction(userHome);
    }

    return 'committed';
  }

  if (transaction.phase === 'prepared') {
    restoreOwnedPathSnapshot(backupRoot, {
      allowedRoots: [userHome],
      expectedTargetPaths: transaction.targetPaths.map((targetPath) =>
        path.resolve(userHome, targetPath)
      ),
      snapshotId: transaction.snapshotId,
    });
    writeLiveInstallTransaction(userHome, {
      ...transaction,
      version: 3,
      phase: 'rolledBack',
    });
  }

  if (exists(backupRoot)) {
    discardOwnedPathSnapshot(backupRoot, {
      allowedRoots: [userHome],
      expectedTargetPaths: transaction.targetPaths.map((targetPath) =>
        path.resolve(userHome, targetPath)
      ),
      snapshotId: transaction.snapshotId,
    });
  }

  removeLiveInstallTransaction(userHome);
  return 'rolledBack';
}

/**
 * Complete the committed handoff only after the external lifecycle owner has
 * durably closed its journal.
 *
 * @param {string} userHome
 * @returns {void}
 */
export function finishCommittedHomeFilesystemTransaction(userHome) {
  const transactionPath = path.join(userHome, LIVE_INSTALL_TRANSACTION_RELATIVE_PATH);

  if (!exists(transactionPath)) {
    return;
  }

  if (readLiveInstallTransaction(userHome).phase !== 'committed') {
    throw new Error('Cannot finish a home filesystem transaction that is not committed');
  }

  removeLiveInstallTransaction(userHome);
}

/**
 * @param {string} userHome
 * @param {{ version: 3; owner: 'live' | 'rice' | 'layout'; phase: 'allocating' | 'prepared' | 'committed' | 'rolledBack'; backupRoot: string; snapshotId: string; targetPaths: string[] }} transaction
 * @returns {void}
 */
function writeLiveInstallTransaction(userHome, transaction) {
  const transactionPath = path.join(userHome, LIVE_INSTALL_TRANSACTION_RELATIVE_PATH);
  // The fixed candidate is an explicit recovery artifact. A crash before
  // publication leaves one bounded path for the next lock owner to remove.
  const temporaryPath = `${transactionPath}.next`;

  try {
    writeOwnedRecoveryCandidateRaw(
      userHome,
      temporaryPath,
      `${JSON.stringify(transaction, null, 2)}\n`
    );
    publishStagedOwnedPathRaw(userHome, temporaryPath, transactionPath);
  } finally {
    if (exists(temporaryPath)) {
      removeOwnedPathRaw(userHome, temporaryPath);
    }
  }
}

/**
 * @param {string} userHome
 * @returns {{ version: 2 | 3; owner: 'live' | 'rice' | 'layout'; phase: 'allocating' | 'prepared' | 'committed' | 'rolledBack'; backupRoot: string; snapshotId: string; targetPaths: string[] }}
 */
function readLiveInstallTransaction(userHome) {
  const transactionPath = path.join(userHome, LIVE_INSTALL_TRANSACTION_RELATIVE_PATH);
  const stats = fs.lstatSync(transactionPath);

  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('Live install transaction pointer must be a regular file');
  }

  const candidate = JSON.parse(fs.readFileSync(transactionPath, 'utf8'));
  const backupBase = path.join(userHome, '.local/state/tyrian-night/backups');
  const backupRoot =
    typeof candidate?.backupRoot === 'string'
      ? path.resolve(userHome, candidate.backupRoot)
      : undefined;
  const expectedBackupPrefix =
    candidate?.owner === 'live'
      ? 'live-tyrian-apply-'
      : candidate?.owner === 'rice'
        ? 'rice-full-apply-'
        : candidate?.owner === 'layout'
          ? 'rice-layout-apply-'
          : '';
  const targetPaths = Array.isArray(candidate?.targetPaths)
    ? /** @type {unknown[]} */ (candidate.targetPaths).map((relativePath) => {
        if (
          typeof relativePath !== 'string' ||
          relativePath.length === 0 ||
          path.isAbsolute(relativePath)
        ) {
          throw new Error('Live install transaction pointer is corrupt');
        }

        const targetPath = path.resolve(userHome, relativePath);
        if (relativePath !== path.relative(userHome, targetPath)) {
          throw new Error('Live install transaction pointer is corrupt');
        }

        return targetPath;
      })
    : undefined;

  if (
    ![2, 3].includes(candidate?.version) ||
    !['live', 'rice', 'layout'].includes(candidate.owner) ||
    !['allocating', 'prepared', 'committed', 'rolledBack'].includes(candidate.phase) ||
    (candidate.version === 2 && candidate.phase === 'allocating') ||
    !backupRoot ||
    typeof candidate.snapshotId !== 'string' ||
    !/^[0-9a-f-]{36}$/iu.test(candidate.snapshotId) ||
    !targetPaths ||
    targetPaths.length === 0 ||
    new Set(targetPaths).size !== targetPaths.length ||
    path.isAbsolute(candidate.backupRoot) ||
    !isSameOrDescendant(backupBase, backupRoot) ||
    !path.basename(backupRoot).startsWith(expectedBackupPrefix)
  ) {
    throw new Error('Live install transaction pointer is corrupt');
  }

  return {
    version: candidate.version,
    owner: candidate.owner,
    phase: candidate.phase,
    backupRoot: path.relative(userHome, backupRoot),
    snapshotId: candidate.snapshotId,
    targetPaths: canonicalizeOwnedHomePaths(userHome, targetPaths).map((targetPath) =>
      path.relative(userHome, targetPath)
    ),
  };
}

/**
 * @param {string} userHome
 * @returns {void}
 */
function removeLiveInstallTransaction(userHome) {
  const transactionPath = path.join(userHome, LIVE_INSTALL_TRANSACTION_RELATIVE_PATH);
  removeOwnedPathRaw(userHome, transactionPath);
  removeOwnedPathRaw(userHome, `${transactionPath}.next`);
  const absentParents = [];
  let parent = path.dirname(transactionPath);

  while (parent !== userHome && isSameOrDescendant(userHome, parent)) {
    absentParents.push(parent);
    parent = path.dirname(parent);
  }

  removeOwnedEmptyDirectoriesRaw(userHome, absentParents);
}

/**
 * @param {string} userHome
 * @param {NodeJS.ProcessEnv} environment
 * @returns {{ configRoot: string; dataRoot: string; stateRoot: string }}
 */
function resolveXdgRoots(userHome, environment) {
  /**
   * @param {'XDG_CONFIG_HOME' | 'XDG_DATA_HOME' | 'XDG_STATE_HOME'} variable
   * @param {string} fallback
   * @returns {string}
   */
  const resolveRoot = (variable, fallback) => {
    const configured = environment[variable];

    if (configured !== undefined && !path.isAbsolute(configured)) {
      throw new Error(`${variable} must be an absolute path`);
    }

    const root = resolvePathIdentity(configured ?? path.join(userHome, fallback));

    if (!isSameOrDescendant(userHome, root)) {
      throw new Error(`${variable} outside the destination home is unsupported for recovery`);
    }

    return root;
  };

  return {
    configRoot: resolveRoot('XDG_CONFIG_HOME', '.config'),
    dataRoot: resolveRoot('XDG_DATA_HOME', '.local/share'),
    stateRoot: resolveRoot('XDG_STATE_HOME', '.local/state'),
  };
}

/**
 * @param {unknown} target
 * @returns {LiveInstallTarget}
 */
function requireLiveInstallTarget(target) {
  if (typeof target !== 'string' || !LIVE_INSTALL_TARGETS.has(target)) {
    throw new Error('Tyrian desktop install requires target "plasma" or "caelestia"');
  }

  return /** @type {LiveInstallTarget} */ (target);
}

/**
 * Caelestia follows the provider owned by the active Hyprland instance. An
 * offline install has no truthful provider observation and must name its mode.
 *
 * @param {HyprlandMode | undefined} requestedMode
 * @param {CommandRunner} runCommand
 * @returns {HyprlandMode}
 */
function selectHyprlandMode(requestedMode, runCommand) {
  if (requestedMode !== undefined) {
    if (!HYPRLAND_MODES.has(requestedMode)) {
      throw new Error('Hyprland mode must be "lua" or "legacy"');
    }

    return requestedMode;
  }

  let status;
  try {
    status = JSON.parse(
      String(
        runCommand('hyprctl', ['-j', 'status'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      )
    );
  } catch (cause) {
    throw new Error(
      'Cannot determine the active Hyprland config provider; run inside the target Hyprland session or pass --hyprland-mode=lua|legacy',
      { cause }
    );
  }

  const provider = status?.configProvider;
  if (provider === 'lua') return 'lua';
  if (provider === 'hyprlang') return 'legacy';

  throw new Error(
    `Unsupported Hyprland config provider ${JSON.stringify(provider)}; pass --hyprland-mode=lua|legacy only if that provider consumes the matching Caelestia projection`
  );
}

/**
 * @param {{ configRoot: string; dataRoot: string; stateRoot: string }} xdgRoots
 * @param {HyprlandMode | undefined} hyprlandMode
 * @returns {Record<string, string>}
 */
function buildLivePaths(xdgRoots, hyprlandMode) {
  const { configRoot, dataRoot, stateRoot } = xdgRoots;
  const hyprCurrentLua = path.join(configRoot, 'hypr/scheme/current.lua');
  const hyprCurrentLegacy = path.join(configRoot, 'hypr/scheme/current.conf');

  return {
    ghosttyConfig: path.join(configRoot, 'ghostty/config'),
    ghosttyThemes: path.join(configRoot, 'ghostty/themes'),
    footConfig: path.join(configRoot, 'foot/foot.ini'),
    footThemes: path.join(configRoot, 'foot/themes'),
    fishStartupConfig: path.join(configRoot, 'fish/conf.d/tyrian-night.fish'),
    fishGreeting: path.join(configRoot, 'fish/functions/fish_greeting.fish'),
    kdeglobals: path.join(configRoot, 'kdeglobals'),
    plasmarc: path.join(configRoot, 'plasmarc'),
    screenLockerConfig: path.join(configRoot, 'kscreenlockerrc'),
    kdeTyrianScheme: path.join(dataRoot, 'color-schemes/TyrianNight.colors'),
    plasmaTyrianTheme: path.join(dataRoot, 'plasma/desktoptheme/TyrianNight'),
    lookAndFeelTyrian: path.join(dataRoot, 'plasma/look-and-feel/TyrianNight'),
    caelestiaSchemeState: path.join(stateRoot, 'caelestia/scheme.json'),
    caelestiaSequences: path.join(stateRoot, 'caelestia/sequences.txt'),
    hyprCurrentLua,
    hyprCurrentLegacy,
    hyprCurrentScheme:
      hyprlandMode === 'lua' ? hyprCurrentLua : hyprlandMode === 'legacy' ? hyprCurrentLegacy : '',
  };
}

/**
 * @param {string} userHome
 * @param {{ configRoot: string; dataRoot: string; stateRoot: string }} xdgRoots
 * @returns {LiveOwnedRegistry}
 */
function buildLegacyPaths(userHome, xdgRoots) {
  const fastfetchRoot = path.join(userHome, '.local/share/caelestia/fastfetch');
  const legacyFishRoot = path.join(userHome, '.local/share/caelestia/fish');

  return {
    common: [],
    plasma: [
      path.join(userHome, '.local/share/union/css/styles/TyrianNight'),
      path.join(userHome, '.config/environment.d/tyrian-union.conf'),
    ],
    caelestia: [
      path.join(legacyFishRoot, 'config.fish'),
      path.join(legacyFishRoot, 'functions/fish_greeting.fish'),
      path.join(fastfetchRoot, 'sewerslvt.gif'),
      path.join(fastfetchRoot, 'tyrian-logo.png'),
      path.join(fastfetchRoot, 'tyrian-fetch.webp'),
      path.join(xdgRoots.dataRoot, 'caelestia/fastfetch/config.jsonc'),
      path.join(xdgRoots.dataRoot, 'caelestia/starship.toml'),
    ],
  };
}

/**
 * @param {string} sourceRoot
 * @param {HyprlandMode | undefined} hyprlandMode
 * @returns {Record<string, string>}
 */
function buildSourcePaths(sourceRoot, hyprlandMode) {
  const hyprCurrentLua = path.join(sourceRoot, 'desktop/caelestia/hypr/tyrian-night.lua');
  const hyprCurrentLegacy = path.join(sourceRoot, 'desktop/caelestia/hypr/tyrian-night.conf');

  return {
    fishGreeting: path.join(sourceRoot, 'terminal/fish/functions/fish_greeting.fish'),
    fastfetchConfig: path.join(sourceRoot, 'terminal/fastfetch/tyrian-night.jsonc'),
    fastfetchImage: path.join(sourceRoot, FASTFETCH_IMAGE_ASSET_PATH),
    wallpaper: path.join(sourceRoot, WALLPAPER_ASSET_PATH),
    starshipConfig: path.join(sourceRoot, 'terminal/starship/tyrian-night.toml'),
    kdeTyrianScheme: path.join(sourceRoot, 'desktop/kde/color-schemes/TyrianNight.colors'),
    plasmaTyrianThemeRoot: path.join(sourceRoot, 'desktop/kde/plasma/desktoptheme/TyrianNight'),
    lookAndFeelTyrianRoot: path.join(sourceRoot, 'desktop/kde/plasma/look-and-feel/TyrianNight'),
    caelestiaSchemeState: path.join(sourceRoot, 'desktop/caelestia/state/tyrian-night.scheme.json'),
    hyprCurrentLua,
    hyprCurrentLegacy,
    hyprCurrentScheme:
      hyprlandMode === 'lua' ? hyprCurrentLua : hyprlandMode === 'legacy' ? hyprCurrentLegacy : '',
  };
}

/**
 * @param {Record<string, string>} livePaths
 * @param {string[]} themeSlugs
 * @param {InstallMode} mode
 * @param {string} installRoot
 * @param {CopyRoot[]} materializedRoots
 * @returns {string[]}
 */
function buildCommonOwnedPaths(livePaths, themeSlugs, mode, installRoot, materializedRoots) {
  return [
    ...new Set([
      ...(mode === 'copy' ? [installRoot] : []),
      ...materializedRoots.map(({ target }) => target),
      livePaths.ghosttyConfig,
      ...themeSlugs.map((slug) => path.join(livePaths.ghosttyThemes, slug)),
      livePaths.footConfig,
      ...themeSlugs.map((slug) => path.join(livePaths.footThemes, `${slug}.ini`)),
      livePaths.fishStartupConfig,
      livePaths.fishGreeting,
    ]),
  ];
}

/**
 * @param {LiveInstallTarget} target
 * @param {Record<string, string>} livePaths
 * @param {HyprlandMode | undefined} hyprlandMode
 * @returns {string[]}
 */
function buildTargetOwnedPaths(target, livePaths, hyprlandMode) {
  if (target === 'plasma') {
    return [
      livePaths.kdeglobals,
      livePaths.plasmarc,
      livePaths.screenLockerConfig,
      livePaths.kdeTyrianScheme,
      livePaths.plasmaTyrianTheme,
      livePaths.lookAndFeelTyrian,
    ];
  }

  if (hyprlandMode === undefined || livePaths.hyprCurrentScheme === '') {
    throw new Error('Caelestia install plan is missing its Hyprland projection mode');
  }

  return [
    livePaths.caelestiaSchemeState,
    livePaths.caelestiaSequences,
    livePaths.hyprCurrentScheme,
  ];
}

/**
 * @param {LiveInstallPlan} plan
 * @returns {string[]}
 */
function buildPlanMutationTargets(plan) {
  return [
    plan.installRoot,
    plan.stagingRoot,
    plan.backupRoot,
    plan.ownershipManifestPath,
    plan.migrationRetirementPath,
    ...plan.materializedRoots.map(({ target }) => target),
    ...plan.touchedPaths,
  ];
}

/**
 * @param {LiveInstallPlan} plan
 * @returns {void}
 */
function validateInstallSources(plan) {
  return validateInstallSourcesWithGenerated(plan, new Set());
}

/**
 * @param {LiveInstallPlan} plan
 * @param {Set<string>} generatedPaths
 * @returns {void}
 */
function validateInstallSourcesWithGenerated(plan, generatedPaths) {
  const relativeSourcePaths = [
    ...plan.materializedPaths,
    'source/themeCatalog.json',
    ...plan.terminalThemeSlugs.map((slug) => `source/themes/${slug}.json`),
  ];
  const sourcePaths = relativeSourcePaths.map((relativePath) =>
    path.join(plan.repoRoot, relativePath)
  );

  for (let index = 0; index < sourcePaths.length; index += 1) {
    const sourcePath = sourcePaths[index];
    const relativePath = relativeSourcePaths[index];

    if (!exists(sourcePath)) {
      const generated =
        generatedPaths.has(relativePath) ||
        [...generatedPaths].some((generatedPath) => generatedPath.startsWith(`${relativePath}/`));

      if (generated) continue;
      throw new Error(`Missing Tyrian install source: ${installSourceLabel(plan, sourcePath)}`);
    }

    assertNoSymlinkPath(plan.repoRoot, sourcePath, relativePath);
    const expectsDirectory = MATERIALIZED_INSTALL_DIRECTORIES.has(relativePath);
    assertInstallSourceType(sourcePath, relativePath, expectsDirectory);
  }
}

/**
 * @param {string} root
 * @param {string} sourcePath
 * @param {string} label
 * @returns {void}
 */
function assertNoSymlinkPath(root, sourcePath, label) {
  const relativePath = path.relative(root, sourcePath);
  let currentPath = root;

  for (const segment of relativePath.split(path.sep)) {
    currentPath = path.join(currentPath, segment);

    if (fs.lstatSync(currentPath).isSymbolicLink()) {
      throw new Error(`Invalid Tyrian install source type: ${label} traverses a symbolic link`);
    }
  }
}

/**
 * @param {string} sourcePath
 * @param {string} label
 * @param {boolean} expectsDirectory
 * @returns {void}
 */
function assertInstallSourceType(sourcePath, label, expectsDirectory) {
  const stats = fs.lstatSync(sourcePath);

  if (stats.isSymbolicLink()) {
    throw new Error(`Invalid Tyrian install source type: ${label} must not be a symbolic link`);
  }

  if (expectsDirectory ? !stats.isDirectory() : !stats.isFile()) {
    throw new Error(
      `Invalid Tyrian install source type: ${label} must be a ${expectsDirectory ? 'directory' : 'file'}`
    );
  }

  if (!expectsDirectory) {
    return;
  }

  for (const entry of fs.readdirSync(sourcePath)) {
    const childPath = path.join(sourcePath, entry);
    const childLabel = path.posix.join(label, entry);
    const childStats = fs.lstatSync(childPath);

    if (childStats.isSymbolicLink()) {
      throw new Error(
        `Invalid Tyrian install source type: ${childLabel} must not be a symbolic link`
      );
    }

    if (childStats.isDirectory()) {
      assertInstallSourceType(childPath, childLabel, true);
    } else if (!childStats.isFile()) {
      throw new Error(
        `Invalid Tyrian install source type: ${childLabel} must be a regular file or directory`
      );
    }
  }
}

/**
 * @param {string} repositoryRoot
 * @param {string} installRoot
 * @returns {void}
 */
function assertIndependentInstallRoot(repositoryRoot, installRoot) {
  const resolvedRepositoryRoot = resolvePathIdentity(repositoryRoot);
  const resolvedInstallRoot = resolvePathIdentity(installRoot);

  if (
    isSameOrDescendant(resolvedRepositoryRoot, resolvedInstallRoot) ||
    isSameOrDescendant(resolvedInstallRoot, resolvedRepositoryRoot)
  ) {
    throw new Error(
      `Tyrian repository and install root must not overlap: ${repositoryRoot} <-> ${installRoot}`
    );
  }
}

/**
 * @param {string} repositoryRoot
 * @param {string[]} targetPaths
 * @returns {void}
 */
function assertRepositoryIndependentOfTargets(repositoryRoot, targetPaths) {
  for (const targetPath of targetPaths) {
    assertIndependentInstallRoot(repositoryRoot, targetPath);
  }
}

/**
 * @param {string} ancestor
 * @param {string} candidate
 * @returns {boolean}
 */
function isSameOrDescendant(ancestor, candidate) {
  const relativePath = path.relative(ancestor, candidate);

  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

/**
 * @param {LiveInstallPlan} plan
 * @returns {PreparedLiveInstall}
 */
function prepareLiveInstall(plan) {
  validateInstallSources(plan);

  const common = {
    fishStartupConfig: buildFishStartupConfig({
      repoRoot: plan.repoRoot,
      tyrianRoot: plan.sourceRoot,
    }),
    footConfig: buildFootConfig({
      repoRoot: plan.repoRoot,
      themeDirectory: plan.livePaths.footThemes,
    }),
    ghosttyConfig: buildGhosttyConfig({ repoRoot: plan.repoRoot }),
  };

  if (plan.target === 'caelestia') {
    return {
      common,
      desktop: {
        target: 'caelestia',
        caelestiaSequences: buildCaelestiaSequences(
          path.join(plan.repoRoot, 'desktop/caelestia/state/tyrian-night.scheme.json')
        ),
      },
    };
  }

  const screenLockerContent = exists(plan.livePaths.screenLockerConfig)
    ? fs.readFileSync(plan.livePaths.screenLockerConfig, 'utf8')
    : '';
  const kdeglobalsContent = exists(plan.livePaths.kdeglobals)
    ? fs.readFileSync(plan.livePaths.kdeglobals, 'utf8')
    : '';
  const plasmarcContent = exists(plan.livePaths.plasmarc)
    ? fs.readFileSync(plan.livePaths.plasmarc, 'utf8')
    : '';

  return {
    common,
    desktop: {
      target: 'plasma',
      kdeglobals: patchIniSection(
        patchIniSection(kdeglobalsContent, 'KDE', {
          LookAndFeelPackage: 'TyrianNight',
          widgetStyle: 'Breeze',
        }),
        'General',
        { ColorScheme: 'TyrianNight' }
      ),
      plasmarc: patchIniSection(plasmarcContent, 'Theme', { name: 'TyrianNight' }),
      screenLockerConfig: patchIniSection(
        screenLockerContent,
        'Greeter][Wallpaper][org.kde.image][General',
        {
          Image: plan.sourcePaths.wallpaper,
          PreviewImage: plan.sourcePaths.wallpaper,
        }
      ),
    },
  };
}

/**
 * Validate generator inputs and planned source ownership without publishing
 * generated assets or reading content that is only needed by apply.
 *
 * @param {LiveInstallPlan} plan
 * @returns {PreparedLiveInstall}
 */
function prepareLiveInstallPreview(plan) {
  const generatedPaths = new Set(
    preflightGeneratedRepository(plan.repoRoot).map(({ path: generatedPath }) => generatedPath)
  );
  validateInstallSourcesWithGenerated(plan, generatedPaths);

  const common = {
    fishStartupConfig: '',
    footConfig: '',
    ghosttyConfig: '',
  };

  return plan.target === 'plasma'
    ? {
        common,
        desktop: {
          target: 'plasma',
          screenLockerConfig: '',
          kdeglobals: '',
          plasmarc: '',
        },
      }
    : { common, desktop: { target: 'caelestia', caelestiaSequences: '' } };
}

/**
 * @param {LiveInstallPlan} plan
 * @returns {void}
 */
function materializeSourceRoot(plan) {
  if (plan.mode === 'copy') {
    operation(plan.apply, `copy Tyrian install source to ${plan.installRoot}`, () => {
      const stagingRoot = plan.stagingRoot;

      try {
        for (const root of plan.materializedRoots) {
          const relativeTarget = path.relative(plan.installRoot, root.target);
          installManagedPathWithMode('copy', root.source, path.join(stagingRoot, relativeTarget), {
            ownerRoot: plan.home,
          });
        }

        recordOwnedPathGeneration(plan.home, stagingRoot);
        publishStagedOwnedPathRaw(plan.home, stagingRoot, plan.installRoot);
      } catch (error) {
        if (exists(stagingRoot)) {
          removeOwnedPathRaw(plan.home, stagingRoot);
        }
        throw error;
      }
    });
    return;
  }

  for (const root of plan.materializedRoots) {
    installManagedPath(plan, root.source, root.target);
  }
}

/**
 * @param {LiveInstallPlan} plan
 * @param {PreparedCommonInstall} prepared
 * @returns {void}
 */
function installTerminalLayer(plan, prepared) {
  for (const slug of plan.terminalThemeSlugs) {
    installManagedPath(
      plan,
      path.join(plan.sourceRoot, `terminal/ghostty/themes/${slug}`),
      path.join(plan.livePaths.ghosttyThemes, slug)
    );
    installManagedPath(
      plan,
      path.join(plan.sourceRoot, `terminal/foot/themes/${slug}.ini`),
      path.join(plan.livePaths.footThemes, `${slug}.ini`)
    );
  }

  writeFile(plan, plan.livePaths.ghosttyConfig, prepared.ghosttyConfig);
  writeFile(plan, plan.livePaths.footConfig, prepared.footConfig);

  writeFile(plan, plan.livePaths.fishStartupConfig, prepared.fishStartupConfig);
  installManagedPath(plan, plan.sourcePaths.fishGreeting, plan.livePaths.fishGreeting);
}

/**
 * @param {LiveInstallPlan} plan
 * @param {PreparedPlasmaInstall | PreparedCaelestiaInstall} prepared
 * @returns {void}
 */
function installTargetLayer(plan, prepared) {
  if (plan.target !== prepared.target) {
    throw new Error('Prepared desktop target does not match the live install plan');
  }

  if (prepared.target === 'plasma') {
    installPlasmaLayer(plan, prepared);
    return;
  }

  installCaelestiaLayer(plan, prepared);
}

/**
 * @param {LiveInstallPlan} plan
 * @param {PreparedPlasmaInstall} prepared
 * @returns {void}
 */
function installPlasmaLayer(plan, prepared) {
  installManagedPath(plan, plan.sourcePaths.kdeTyrianScheme, plan.livePaths.kdeTyrianScheme);
  installPlasmaDesktopTheme(plan);
  installLookAndFeelPackage(plan);
  writeFile(plan, plan.livePaths.kdeglobals, prepared.kdeglobals);
  writeFile(plan, plan.livePaths.plasmarc, prepared.plasmarc);
  writeFile(plan, plan.livePaths.screenLockerConfig, prepared.screenLockerConfig);
}

/**
 * @param {LiveInstallPlan} plan
 * @param {PreparedCaelestiaInstall} prepared
 * @returns {void}
 */
function installCaelestiaLayer(plan, prepared) {
  publishRuntimeFile(
    plan,
    plan.sourcePaths.caelestiaSchemeState,
    plan.livePaths.caelestiaSchemeState
  );
  publishRuntimeFile(plan, plan.sourcePaths.hyprCurrentScheme, plan.livePaths.hyprCurrentScheme);
  writeFile(plan, plan.livePaths.caelestiaSequences, prepared.caelestiaSequences);
}

/**
 * @param {LiveInstallPlan} plan
 * @param {string} sourcePath
 * @param {string} targetPath
 * @returns {void}
 */
function installManagedPath(plan, sourcePath, targetPath) {
  const verb = plan.mode === 'link' ? 'link' : 'copy';

  operation(plan.apply, `${verb} ${sourcePath} -> ${targetPath}`, () => {
    installManagedPathRaw(plan, sourcePath, targetPath);
  });
}

/**
 * Runtime readers must observe one complete generation. These files therefore
 * remain atomically replaced regular files even when stable assets use --link.
 * @param {LiveInstallPlan} plan
 * @param {string} sourcePath
 * @param {string} targetPath
 */
function publishRuntimeFile(plan, sourcePath, targetPath) {
  operation(plan.apply, `publish ${sourcePath} -> ${targetPath}`, () => {
    installManagedPathWithMode('copy', sourcePath, targetPath, { ownerRoot: plan.home });
  });
}

/**
 * @param {LiveInstallPlan} plan
 * @param {string} sourcePath
 * @param {string} targetPath
 * @returns {void}
 */
function installManagedPathRaw(plan, sourcePath, targetPath) {
  installManagedPathWithMode(plan.mode, sourcePath, targetPath, { ownerRoot: plan.home });
}

/**
 * @param {LiveInstallPlan} plan
 * @returns {void}
 */
function installPlasmaDesktopTheme(plan) {
  installManagedPath(
    plan,
    plan.sourcePaths.plasmaTyrianThemeRoot,
    plan.livePaths.plasmaTyrianTheme
  );
}

/**
 * @param {LiveInstallPlan} plan
 * @returns {void}
 */
function installLookAndFeelPackage(plan) {
  operation(
    plan.apply,
    `materialize ${plan.sourcePaths.lookAndFeelTyrianRoot} -> ${plan.livePaths.lookAndFeelTyrian}`,
    () => {
      installManagedPathWithMode(
        'copy',
        plan.sourcePaths.lookAndFeelTyrianRoot,
        plan.livePaths.lookAndFeelTyrian,
        { ownerRoot: plan.home }
      );
    }
  );
}

/**
 * @param {string} content
 * @param {string} sectionName
 * @param {Record<string, string>} values
 * @returns {string}
 */
export function patchIniSection(content, sectionName, values) {
  const sectionHeader = `[${sectionName}]`;
  const sectionPattern = new RegExp(
    `^\\[${escapeRegExp(sectionName)}\\]\\n(?:(?!^\\[).*(?:\\n|$))*`,
    'mu'
  );
  const normalizedContent = content.endsWith('\n') || content === '' ? content : `${content}\n`;
  const existingSection = normalizedContent.match(sectionPattern)?.[0];
  const patchedSection = patchIniSectionContent(existingSection ?? `${sectionHeader}\n`, values);

  if (existingSection) {
    return normalizedContent.replace(sectionPattern, patchedSection);
  }

  return `${normalizedContent.replace(/\s*$/u, '')}\n\n${patchedSection}`.replace(/^\n+/u, '');
}

/**
 * @param {string} sectionContent
 * @param {Record<string, string>} values
 * @returns {string}
 */
function patchIniSectionContent(sectionContent, values) {
  let patched = sectionContent.endsWith('\n') ? sectionContent : `${sectionContent}\n`;

  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${escapeRegExp(key)}=.*$`, 'mu');

    patched = pattern.test(patched) ? patched.replace(pattern, line) : `${patched}${line}\n`;
  }

  return patched.endsWith('\n') ? patched : `${patched}\n`;
}

/**
 * @param {LiveInstallPlan} plan
 * @param {string} filePath
 * @param {string} content
 * @returns {void}
 */
function writeFile(plan, filePath, content) {
  operation(plan.apply, `write ${filePath}`, () => {
    writeFileRaw(plan.home, filePath, content);
  });
}

/**
 * @param {string} ownerRoot
 * @param {string} filePath
 * @param {string} content
 * @returns {void}
 */
function writeFileRaw(ownerRoot, filePath, content) {
  writeTextFileRaw(filePath, content, { followFinalSymlink: false, ownerRoot });
}

/**
 * @param {string} schemePath
 * @returns {string}
 */
function buildCaelestiaSequences(schemePath) {
  const colours = JSON.parse(fs.readFileSync(schemePath, 'utf8')).colours;

  return (
    hexToAnsi(colours.onSurface, 10) +
    hexToAnsi(colours.surface, 11) +
    hexToAnsi(colours.secondary, 12) +
    hexToAnsi(colours.secondary, 17) +
    Array.from({ length: 16 }, (_, index) => hexToAnsi(colours[`term${index}`], 4, index)).join(
      ''
    ) +
    hexToAnsi(colours.primary, 4, 16) +
    hexToAnsi(colours.secondary, 4, 17) +
    hexToAnsi(colours.tertiary, 4, 18)
  );
}

/**
 * @param {string} color
 * @param {number[]} indexes
 * @returns {string}
 */
function hexToAnsi(color, ...indexes) {
  return `\x1b]${indexes.join(';')};rgb:${color.slice(0, 2)}/${color.slice(2, 4)}/${color.slice(4, 6)}\x1b\\`;
}

/**
 * @param {LiveInstallPlan} plan
 * @param {string} sourcePath
 * @returns {string}
 */
function installSourceLabel(plan, sourcePath) {
  const relativeSourcePath = path.relative(plan.repoRoot, sourcePath);

  if (!relativeSourcePath.startsWith('..') && !path.isAbsolute(relativeSourcePath)) {
    return relativeSourcePath;
  }

  return sourcePath;
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * @returns {void}
 */
function main() {
  const args = parseLiveInstallArguments(process.argv.slice(2));

  if (args.recover) {
    if (args.apply || args.link || args.target !== undefined || args.hyprlandMode !== undefined) {
      throw new Error('Tyrian live recovery cannot be combined with install options.');
    }

    recoverLiveTyrian();
    return;
  }

  const target = requireLiveInstallTarget(args.target);
  const installOptions = {
    apply: args.apply,
    link: args.link,
    target,
    hyprlandMode: args.hyprlandMode,
  };
  if (args.apply) {
    prepareLiveInstallRepository(repoRoot, { home, ...installOptions });
  }
  installLiveTyrian(installOptions);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}

/**
 * @param {string[]} argv
 * @returns {{ apply: boolean; link: boolean; recover: boolean; target?: LiveInstallTarget; hyprlandMode?: HyprlandMode }}
 */
function parseLiveInstallArguments(argv) {
  /** @type {{ apply: boolean; link: boolean; recover: boolean; target?: LiveInstallTarget; hyprlandMode?: HyprlandMode }} */
  const parsed = { apply: false, link: false, recover: false };
  const seen = new Set();

  for (const argument of argv) {
    const optionName = argument.split('=', 1)[0];
    if (seen.has(optionName)) {
      throw new Error(`Duplicate Tyrian live install option '${optionName}'.`);
    }
    seen.add(optionName);

    if (argument === '--apply') {
      parsed.apply = true;
    } else if (argument === '--link') {
      parsed.link = true;
    } else if (argument === '--recover') {
      parsed.recover = true;
    } else if (argument.startsWith('--target=')) {
      parsed.target = requireLiveInstallTarget(argument.slice('--target='.length));
    } else if (argument.startsWith('--hyprland-mode=')) {
      const mode = argument.slice('--hyprland-mode='.length);
      if (!HYPRLAND_MODES.has(mode)) {
        throw new Error('Hyprland mode must be "lua" or "legacy"');
      }
      parsed.hyprlandMode = /** @type {HyprlandMode} */ (mode);
    } else {
      throw new Error(`Unknown Tyrian live install option '${argument}'.`);
    }
  }

  return parsed;
}
