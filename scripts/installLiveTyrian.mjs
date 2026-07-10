// @ts-check

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDesktopThemeAssets, writeDesktopThemeAssets } from './desktopThemes.mjs';
import {
  admitOwnedDirectories,
  admitOwnedPaths,
  discardOwnedPathSnapshot,
  exists,
  installManagedPathRaw as installManagedPathWithMode,
  operation,
  resolvePathIdentity,
  restoreOwnedPathSnapshot,
  snapshotOwnedPaths,
  syncPathsDurably,
  withTokenFileLock,
  writeTextFileRaw,
} from './installOps.mjs';
import {
  FASTFETCH_IMAGE_ASSET_PATH,
  FASTFETCH_IMAGE_HOME_PATH,
  TYRIAN_INSTALL_HOME,
  WALLPAPER_ASSET_PATH,
  buildTyrianBackupRoot,
} from './portableAssets.mjs';
import {
  buildFishStartupConfig,
  buildFootConfig,
  buildGhosttyConfig,
  buildTerminalThemeAssets,
  writeTerminalThemeAssets,
} from './terminalThemes.mjs';
import { readThemeSources } from './themeSources.mjs';

const repoRoot = process.cwd();
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
/** @type {Map<string, { depth: number; owner: 'live' | 'rice' | 'layout'; targetPaths: string[] }>} */
const activeHomeTransactions = new Map();

/**
 * @typedef {'copy' | 'link'} InstallMode
 * @typedef {{ source: string; target: string }} CopyRoot
 * @typedef {{
 *   mode: InstallMode;
 *   apply: boolean;
 *   repoRoot: string;
 *   home: string;
 *   installRoot: string;
 *   stagingRoot: string;
 *   sourceRoot: string;
 *   backupRoot: string;
 *   materializedRoots: CopyRoot[];
 *   materializedPaths: string[];
 *   terminalThemeSlugs: string[];
 *   livePaths: Record<string, string>;
 *   sourcePaths: Record<string, string>;
 *   legacyPaths: string[];
 *   ownedPaths: string[];
 *   ownershipManifestPath: string;
 *   migrationRetirementPath: string;
 *   touchedPaths: string[];
 * }} LiveInstallPlan
 * @typedef {{
 *   caelestiaSequences: string;
 *   fishStartupConfig: string;
 *   footConfig: string;
 *   ghosttyConfig: string;
 *   screenLockerConfig: string;
 *   kdeglobals: string;
 *   plasmarc: string;
 * }} PreparedLiveInstall
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
 * @param {string} [root]
 * @param {{ home?: string; link?: boolean }} [options]
 * @returns {void}
 */
export function prepareLiveInstallRepository(root = repoRoot, options = {}) {
  const physicalRoot = resolvePathIdentity(root);
  const userHome = resolvePathIdentity(options.home ?? home);
  const plan = buildLiveInstallPlan({ repoRoot: physicalRoot, home: userHome, link: options.link });

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
 * @returns {void}
 */
function preflightGeneratedRepository(root) {
  assertRegularPathUnder(root, path.join(root, 'package.json'), 'package.json');
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
 * @param {{ repoRoot?: string; home?: string; apply?: boolean; link?: boolean; stagingRoot?: string }} [options]
 * @returns {LiveInstallPlan}
 */
export function buildLiveInstallPlan(options = {}) {
  const root = resolvePathIdentity(options.repoRoot ?? repoRoot);
  const userHome = resolvePathIdentity(options.home ?? home);
  const mode = options.link ? 'link' : 'copy';
  const installRoot = path.join(userHome, TYRIAN_INSTALL_HOME);
  const stagingRoot = options.stagingRoot ?? buildUnusedInstallStagingRoot(installRoot);
  const sourceRoot = mode === 'link' ? root : installRoot;
  const livePaths = buildLivePaths(userHome);
  const legacyPaths = buildLegacyPaths(userHome);
  const sourcePaths = buildSourcePaths(sourceRoot);
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
            target: path.join(userHome, FASTFETCH_IMAGE_HOME_PATH),
          },
          {
            source: path.join(root, 'assets/wallpaper-tyrian.png'),
            target: path.join(installRoot, 'assets/wallpaper-tyrian.png'),
          },
        ];
  const liveOwnedPaths = buildLiveOwnedPaths(livePaths, terminalThemeSlugs);
  const ownershipManifestPath = path.join(userHome, LIVE_INSTALL_OWNERSHIP_RELATIVE_PATH);
  const migrationRetirementPath = path.join(
    userHome,
    LIVE_INSTALL_MIGRATION_RETIREMENT_RELATIVE_PATH
  );

  return {
    mode,
    apply: options.apply ?? false,
    repoRoot: root,
    home: userHome,
    installRoot,
    stagingRoot,
    sourceRoot,
    backupRoot: buildTyrianBackupRoot(userHome, 'live-tyrian-apply'),
    materializedPaths,
    materializedRoots,
    livePaths,
    sourcePaths,
    terminalThemeSlugs,
    legacyPaths,
    ownedPaths: [
      ...new Set([
        installRoot,
        ...materializedRoots.map(({ target }) => target),
        ...liveOwnedPaths,
      ]),
    ],
    ownershipManifestPath,
    migrationRetirementPath,
    touchedPaths: liveOwnedPaths,
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
    'terminal/ghostty/ghostty.css',
    'terminal/fish/functions/fish_greeting.fish',
    'terminal/fastfetch/tyrian-night.jsonc',
    'terminal/starship/tyrian-night.toml',
    'desktop/kde/color-schemes/TyrianNight.colors',
    'desktop/kde/plasma/desktoptheme/TyrianNight',
    'desktop/kde/plasma/look-and-feel/TyrianNight',
    'desktop/caelestia/state/tyrian-night.scheme.json',
    'desktop/caelestia/hypr/tyrian-night.conf',
  ];
}

/**
 * @param {{ repoRoot?: string; home?: string; apply?: boolean; link?: boolean; stagingRoot?: string; testInterruptAfterMutation?: boolean; testFailCommit?: boolean }} [options]
 * @returns {LiveInstallReceipt | undefined}
 */
export function installLiveTyrian(options = {}) {
  const plan = buildLiveInstallPlan(options);

  assertRepositoryIndependentOfTargets(plan.repoRoot, buildPlanMutationTargets(plan));
  assertNoDestinationSymlinkAncestors(plan.home, [...buildPlanMutationTargets(plan)]);
  admitOwnedDirectories(
    plan.home,
    [plan.stagingRoot, plan.backupRoot],
    'Live install transaction container'
  );
  return withLiveInstallLock(plan.home, () => installLiveTyrianOwned(plan, options));
}

/**
 * @template T
 * @param {string} requestedHome
 * @param {() => T} action
 * @param {{ allowPlasmaRecovery?: boolean }} [options]
 * @returns {T}
 */
export function withLiveInstallLock(requestedHome, action, options = {}) {
  const userHome = resolvePathIdentity(requestedHome);
  const lockPath = path.join(userHome, LIVE_INSTALL_LOCK_RELATIVE_PATH);
  assertNoDestinationSymlinkAncestors(userHome, [
    lockPath,
    path.join(userHome, LIVE_INSTALL_TRANSACTION_RELATIVE_PATH),
  ]);

  return withTokenFileLock(lockPath, () => {
    if (
      exists(path.join(userHome, PLASMA_LIFECYCLE_RELATIVE_PATH)) &&
      !options.allowPlasmaRecovery
    ) {
      throw new Error('An unfinished Plasma lifecycle requires recovery through the rice command');
    }

    if (!activeHomeTransactions.has(userHome) && !options.allowPlasmaRecovery) {
      recoverHomeFilesystemTransaction(userHome);
    }

    return action();
  });
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
  const targetPaths = [...new Set(canonicalizeOwnedHomePaths(userHome, transaction.targetPaths))];
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

    const snapshot = snapshotOwnedPaths(targetPaths, backupRoot);
    /** @type {{ version: 2; owner: 'live' | 'rice' | 'layout'; phase: 'prepared'; backupRoot: string; snapshotId: string; targetPaths: string[] }} */
    const pointer = {
      version: 2,
      owner: transaction.owner,
      phase: 'prepared',
      backupRoot: path.relative(userHome, backupRoot),
      snapshotId: snapshot.snapshotId,
      targetPaths: snapshot.targetPaths.map((targetPath) => path.relative(userHome, targetPath)),
    };

    try {
      syncPathsDurably([backupRoot, path.dirname(backupRoot)]);
      writeLiveInstallTransaction(userHome, pointer);
    } catch (error) {
      snapshot.discard();
      throw error;
    }

    activeHomeTransactions.set(userHome, { depth: 1, owner: transaction.owner, targetPaths });
    /** @type {T | undefined} */
    let result;

    try {
      result = action();
    } catch (error) {
      activeHomeTransactions.delete(userHome);

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
  const prepared = prepareLiveInstall(plan);
  const { desiredOwnedPaths, staleOwnedPaths, targetPaths } =
    resolveLiveInstallTransactionScope(plan);

  if (!plan.apply) {
    materializeSourceRoot(plan);
    cleanupStaleOwnedPaths(plan, staleOwnedPaths);
    installTerminalLayer(plan, prepared);
    installDesktopLayer(plan, prepared);
    publishLiveOwnedPaths(plan, desiredOwnedPaths);
    publishLiveMigrationRetirement(plan);
    console.log(
      `Dry run complete. Re-run with --apply to ${plan.mode === 'link' ? 'link live config to the repo' : `copy Tyrian into ${plan.installRoot}`}.`
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
      installTerminalLayer(plan, prepared);
      installDesktopLayer(plan, prepared);
      publishLiveOwnedPaths(plan, desiredOwnedPaths);
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
 * @returns {{ desiredOwnedPaths: string[]; staleOwnedPaths: string[]; targetPaths: string[] }}
 */
function resolveLiveInstallTransactionScope(plan) {
  const previousOwnedPaths = readLiveOwnedPaths(plan);
  const desiredOwnedPaths = [...new Set(plan.ownedPaths)];
  const desiredOwnedPathSet = new Set(desiredOwnedPaths);
  const staleOwnedPaths = previousOwnedPaths.filter(
    (ownedPath) => !desiredOwnedPathSet.has(ownedPath)
  );

  const targetPaths = [
    plan.installRoot,
    plan.stagingRoot,
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
    desiredOwnedPaths,
    staleOwnedPaths,
    targetPaths,
  };
}

/**
 * @param {LiveInstallPlan} plan
 * @returns {string[]}
 */
function readLiveOwnedPaths(plan) {
  if (!exists(plan.ownershipManifestPath)) {
    if (isLiveMigrationRetired(plan)) return [];

    return [
      ...RELEASED_THEME_SLUGS.map((slug) => path.join(plan.livePaths.ghosttyThemes, slug)),
      ...RELEASED_THEME_SLUGS.map((slug) => path.join(plan.livePaths.footThemes, `${slug}.ini`)),
      ...plan.legacyPaths,
    ];
  }

  const stats = fs.lstatSync(plan.ownershipManifestPath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('Live install ownership manifest must be a regular file');
  }

  const candidate = JSON.parse(fs.readFileSync(plan.ownershipManifestPath, 'utf8'));
  if (
    candidate?.version !== 1 ||
    candidate.owner !== 'Tyrian Night live install' ||
    !Array.isArray(candidate.paths)
  ) {
    throw new Error('Live install ownership manifest is corrupt');
  }

  const ownedPaths = /** @type {unknown[]} */ (candidate.paths).map((relativePath) => {
    if (
      typeof relativePath !== 'string' ||
      relativePath.length === 0 ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error('Live install ownership manifest is corrupt');
    }

    const ownedPath = path.resolve(plan.home, relativePath);
    if (
      relativePath !== path.relative(plan.home, ownedPath) ||
      !isAllowedLiveOwnedPath(plan, ownedPath)
    ) {
      throw new Error(`Live install ownership manifest contains an unowned path: ${relativePath}`);
    }

    return ownedPath;
  });

  if (new Set(ownedPaths).size !== ownedPaths.length) {
    throw new Error('Live install ownership manifest contains duplicate paths');
  }

  return admitOwnedPaths(plan.home, ownedPaths, 'Live install ownership manifest');
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
 * @returns {boolean}
 */
function isAllowedLiveOwnedPath(plan, ownedPath) {
  if (isSameOrDescendant(plan.installRoot, ownedPath)) return true;
  if (plan.ownedPaths.includes(ownedPath)) return true;

  const ghosttyRelative = path.relative(plan.livePaths.ghosttyThemes, ownedPath);
  if (/^tyrian-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(ghosttyRelative)) return true;

  const footRelative = path.relative(plan.livePaths.footThemes, ownedPath);
  return /^tyrian-[a-z0-9]+(?:-[a-z0-9]+)*\.ini$/u.test(footRelative);
}

/**
 * @param {LiveInstallPlan} plan
 * @param {string[]} staleOwnedPaths
 * @returns {void}
 */
function cleanupStaleOwnedPaths(plan, staleOwnedPaths) {
  for (const stalePath of staleOwnedPaths) {
    operation(plan.apply, `remove stale owned path ${stalePath}`, () => {
      fs.rmSync(stalePath, { recursive: true, force: true });
    });
  }
}

/**
 * @param {LiveInstallPlan} plan
 * @param {string[]} ownedPaths
 * @returns {void}
 */
function publishLiveOwnedPaths(plan, ownedPaths) {
  const relativePaths = ownedPaths
    .map((ownedPath) => path.relative(plan.home, ownedPath))
    .toSorted();
  const content = `${JSON.stringify(
    {
      version: 1,
      owner: 'Tyrian Night live install',
      paths: relativePaths,
    },
    null,
    2
  )}\n`;

  operation(plan.apply, `write ${plan.ownershipManifestPath}`, () => {
    writeFileRaw(plan.ownershipManifestPath, content);
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
    writeFileRaw(plan.migrationRetirementPath, content);
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

  if (!exists(transactionPath)) {
    return 'none';
  }

  const transaction = readLiveInstallTransaction(userHome);
  const backupRoot = path.resolve(userHome, transaction.backupRoot);

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
    writeLiveInstallTransaction(userHome, { ...transaction, phase: 'rolledBack' });
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
 * @param {{ version: 2; owner: 'live' | 'rice' | 'layout'; phase: 'prepared' | 'committed' | 'rolledBack'; backupRoot: string; snapshotId: string; targetPaths: string[] }} transaction
 * @returns {void}
 */
function writeLiveInstallTransaction(userHome, transaction) {
  const transactionPath = path.join(userHome, LIVE_INSTALL_TRANSACTION_RELATIVE_PATH);
  const temporaryPath = `${transactionPath}.${randomUUID()}.tmp`;

  try {
    writeTextFileRaw(temporaryPath, `${JSON.stringify(transaction, null, 2)}\n`);
    fsyncFile(temporaryPath);
    fs.renameSync(temporaryPath, transactionPath);
    fsyncDirectory(path.dirname(transactionPath));
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

/**
 * @param {string} userHome
 * @returns {{ version: 2; owner: 'live' | 'rice' | 'layout'; phase: 'prepared' | 'committed' | 'rolledBack'; backupRoot: string; snapshotId: string; targetPaths: string[] }}
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
    candidate?.version !== 2 ||
    !['live', 'rice', 'layout'].includes(candidate.owner) ||
    !['prepared', 'committed', 'rolledBack'].includes(candidate.phase) ||
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
    version: 2,
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
  fs.rmSync(transactionPath, { force: true });
  fsyncDirectory(path.dirname(transactionPath));
  removeEmptyParentsWithin(path.dirname(transactionPath), userHome);
}

/**
 * @param {string} startDirectory
 * @param {string} boundary
 * @returns {void}
 */
function removeEmptyParentsWithin(startDirectory, boundary) {
  let current = startDirectory;

  while (current !== boundary && isSameOrDescendant(boundary, current)) {
    try {
      fs.rmdirSync(current);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTEMPTY' || error.code === 'EEXIST')
      ) {
        return;
      }

      throw error;
    }

    current = path.dirname(current);
  }
}

/**
 * @param {string} filePath
 * @returns {void}
 */
function fsyncFile(filePath) {
  const descriptor = fs.openSync(filePath, 'r');

  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * @param {string} directory
 * @returns {void}
 */
function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');

  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * @param {string} userHome
 * @returns {Record<string, string>}
 */
function buildLivePaths(userHome) {
  return {
    ghosttyConfig: path.join(userHome, '.config/ghostty/config'),
    ghosttyCss: path.join(userHome, '.config/ghostty/ghostty.css'),
    ghosttyThemes: path.join(userHome, '.config/ghostty/themes'),
    footConfig: path.join(userHome, '.config/foot/foot.ini'),
    footThemes: path.join(userHome, '.config/foot/themes'),
    fishStartupConfig: path.join(userHome, '.config/fish/conf.d/tyrian-night.fish'),
    fishGreeting: path.join(userHome, '.config/fish/functions/fish_greeting.fish'),
    fastfetchConfig: path.join(userHome, '.local/share/caelestia/fastfetch/config.jsonc'),
    starshipConfig: path.join(userHome, '.local/share/caelestia/starship.toml'),
    kdeglobals: path.join(userHome, '.config/kdeglobals'),
    plasmarc: path.join(userHome, '.config/plasmarc'),
    screenLockerConfig: path.join(userHome, '.config/kscreenlockerrc'),
    kdeTyrianScheme: path.join(userHome, '.local/share/color-schemes/TyrianNight.colors'),
    plasmaTyrianTheme: path.join(userHome, '.local/share/plasma/desktoptheme/TyrianNight'),
    lookAndFeelTyrian: path.join(userHome, '.local/share/plasma/look-and-feel/TyrianNight'),
    caelestiaSchemeState: path.join(userHome, '.local/state/caelestia/scheme.json'),
    caelestiaSequences: path.join(userHome, '.local/state/caelestia/sequences.txt'),
    hyprCurrentScheme: path.join(userHome, '.config/hypr/scheme/current.conf'),
  };
}

/**
 * @param {string} userHome
 * @returns {string[]}
 */
function buildLegacyPaths(userHome) {
  const fastfetchRoot = path.join(userHome, '.local/share/caelestia/fastfetch');
  const legacyFishRoot = path.join(userHome, '.local/share/caelestia/fish');

  return [
    path.join(legacyFishRoot, 'config.fish'),
    path.join(legacyFishRoot, 'functions/fish_greeting.fish'),
    path.join(fastfetchRoot, 'sewerslvt.gif'),
    path.join(fastfetchRoot, 'tyrian-logo.png'),
    path.join(fastfetchRoot, 'tyrian-fetch.webp'),
    path.join(userHome, '.local/share/union/css/styles/TyrianNight'),
    path.join(userHome, '.config/environment.d/tyrian-union.conf'),
  ];
}

/**
 * @param {string} sourceRoot
 * @returns {Record<string, string>}
 */
function buildSourcePaths(sourceRoot) {
  return {
    ghosttyCss: path.join(sourceRoot, 'terminal/ghostty/ghostty.css'),
    fishGreeting: path.join(sourceRoot, 'terminal/fish/functions/fish_greeting.fish'),
    fastfetchConfig: path.join(sourceRoot, 'terminal/fastfetch/tyrian-night.jsonc'),
    fastfetchImage: path.join(sourceRoot, FASTFETCH_IMAGE_ASSET_PATH),
    wallpaper: path.join(sourceRoot, WALLPAPER_ASSET_PATH),
    starshipConfig: path.join(sourceRoot, 'terminal/starship/tyrian-night.toml'),
    kdeTyrianScheme: path.join(sourceRoot, 'desktop/kde/color-schemes/TyrianNight.colors'),
    plasmaTyrianThemeRoot: path.join(sourceRoot, 'desktop/kde/plasma/desktoptheme/TyrianNight'),
    lookAndFeelTyrianRoot: path.join(sourceRoot, 'desktop/kde/plasma/look-and-feel/TyrianNight'),
    caelestiaSchemeState: path.join(sourceRoot, 'desktop/caelestia/state/tyrian-night.scheme.json'),
    hyprCurrentScheme: path.join(sourceRoot, 'desktop/caelestia/hypr/tyrian-night.conf'),
  };
}

/**
 * @param {Record<string, string>} livePaths
 * @param {string[]} themeSlugs
 * @returns {string[]}
 */
function buildLiveOwnedPaths(livePaths, themeSlugs) {
  return [
    livePaths.ghosttyConfig,
    livePaths.ghosttyCss,
    ...themeSlugs.map((slug) => path.join(livePaths.ghosttyThemes, slug)),
    livePaths.footConfig,
    ...themeSlugs.map((slug) => path.join(livePaths.footThemes, `${slug}.ini`)),
    livePaths.fishStartupConfig,
    livePaths.fishGreeting,
    livePaths.fastfetchConfig,
    livePaths.starshipConfig,
    livePaths.kdeglobals,
    livePaths.plasmarc,
    livePaths.screenLockerConfig,
    livePaths.kdeTyrianScheme,
    livePaths.plasmaTyrianTheme,
    livePaths.lookAndFeelTyrian,
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
    ...plan.touchedPaths,
  ];
}

/**
 * @param {LiveInstallPlan} plan
 * @returns {void}
 */
function validateInstallSources(plan) {
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
    caelestiaSequences: buildCaelestiaSequences(
      path.join(plan.repoRoot, 'desktop/caelestia/state/tyrian-night.scheme.json')
    ),
    fishStartupConfig: buildFishStartupConfig({
      repoRoot: plan.repoRoot,
      tyrianRoot: plan.sourceRoot,
    }),
    footConfig: buildFootConfig({
      repoRoot: plan.repoRoot,
      themeDirectory: plan.livePaths.footThemes,
    }),
    ghosttyConfig: buildGhosttyConfig({
      gtkCustomCss: plan.livePaths.ghosttyCss,
      repoRoot: plan.repoRoot,
    }),
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
  };
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
        fs.mkdirSync(path.dirname(stagingRoot), { recursive: true });
        fs.mkdirSync(stagingRoot);

        for (const root of plan.materializedRoots) {
          const relativeTarget = path.relative(plan.installRoot, root.target);
          installManagedPathWithMode('copy', root.source, path.join(stagingRoot, relativeTarget));
        }

        fs.rmSync(plan.installRoot, { recursive: true, force: true });
        fs.renameSync(stagingRoot, plan.installRoot);
      } catch (error) {
        fs.rmSync(stagingRoot, { recursive: true, force: true });
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
 * @param {PreparedLiveInstall} prepared
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

  installManagedPath(plan, plan.sourcePaths.ghosttyCss, plan.livePaths.ghosttyCss);
  writeFile(plan, plan.livePaths.ghosttyConfig, prepared.ghosttyConfig);
  writeFile(plan, plan.livePaths.footConfig, prepared.footConfig);

  writeFile(plan, plan.livePaths.fishStartupConfig, prepared.fishStartupConfig);
  installManagedPath(plan, plan.sourcePaths.fishGreeting, plan.livePaths.fishGreeting);
  installManagedPath(plan, plan.sourcePaths.fastfetchConfig, plan.livePaths.fastfetchConfig);
  installManagedPath(plan, plan.sourcePaths.starshipConfig, plan.livePaths.starshipConfig);
}

/**
 * @param {LiveInstallPlan} plan
 * @param {PreparedLiveInstall} prepared
 * @returns {void}
 */
function installDesktopLayer(plan, prepared) {
  installManagedPath(plan, plan.sourcePaths.kdeTyrianScheme, plan.livePaths.kdeTyrianScheme);
  installPlasmaDesktopTheme(plan);
  installLookAndFeelPackage(plan);
  writeFile(plan, plan.livePaths.kdeglobals, prepared.kdeglobals);
  writeFile(plan, plan.livePaths.plasmarc, prepared.plasmarc);
  writeFile(plan, plan.livePaths.screenLockerConfig, prepared.screenLockerConfig);
  installManagedPath(
    plan,
    plan.sourcePaths.caelestiaSchemeState,
    plan.livePaths.caelestiaSchemeState
  );
  installManagedPath(plan, plan.sourcePaths.hyprCurrentScheme, plan.livePaths.hyprCurrentScheme);
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
 * @param {LiveInstallPlan} plan
 * @param {string} sourcePath
 * @param {string} targetPath
 * @returns {void}
 */
function installManagedPathRaw(plan, sourcePath, targetPath) {
  installManagedPathWithMode(plan.mode, sourcePath, targetPath);
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
  installManagedPath(
    plan,
    plan.sourcePaths.lookAndFeelTyrianRoot,
    plan.livePaths.lookAndFeelTyrian
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
    writeFileRaw(filePath, content);
  });
}

/**
 * @param {string} filePath
 * @param {string} content
 * @returns {void}
 */
function writeFileRaw(filePath, content) {
  fs.rmSync(filePath, { force: true, recursive: true });
  writeTextFileRaw(filePath, content);
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
  const args = parseFlags(process.argv.slice(2), ['--apply', '--link']);

  prepareLiveInstallRepository(repoRoot, { home, link: args.has('--link') });
  installLiveTyrian({
    apply: args.has('--apply'),
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
      throw new Error(`Unknown Tyrian live install flag '${flag}'.`);
    }

    parsed.add(flag);
  }

  return parsed;
}
