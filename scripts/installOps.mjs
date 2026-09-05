// @ts-check

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** @typedef {{ targetPath: string; backupPath: string; disposable: boolean; existed: boolean; type?: 'file' | 'directory' | 'symlink'; originalGeneration: string; publishedGeneration: string; mutationGeneration: string }} SnapshotEntry */
/** @typedef {{ backupRoot: string; entries: SnapshotEntry[]; missingBackupParents: string[]; ownerRoot: string; snapshotId: string; recoveryId?: string }} OwnedSnapshot */
/**
 * @typedef {{
 *   ownerRoot: string;
 *   label: string;
 *   admitTarget: (targetPath: string, operation: string) => string;
 *   admitPublicationSource: (targetPath: string, operation: string) => string;
 *   recordIntent: (targetPath: string, generation: string) => void;
 *   recordCompletion: (targetPath: string, generation: string) => void;
 *   snapshotIdFor: (targetPath: string) => string | undefined;
 * }} OwnedMutationAuthority
 */

/** @type {Map<string, { state: 'held'; depth: number; token: string } | { state: 'release-failed'; token: string }>} */
const heldTokenLocks = new Map();
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_CORRUPT_LOCK_STALE_MS = 2_000;
/** @type {boolean | undefined} */
let atomicDirectoryExchangeSupport;

/**
 * @typedef {'copy' | 'link'} ManagedPathMode
 */

/**
 * @param {boolean} apply
 * @param {string} message
 * @param {() => void} action
 * @returns {void}
 */
export function operation(apply, message, action) {
  console.log(`${apply ? 'apply' : 'dry-run'}: ${message}`);

  if (apply) {
    action();
  }
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
export function exists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return false;
    }

    throw error;
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Directory generations require an atomic exchange primitive. Probe that
 * protocol capability before a transaction allocates evidence or mutates its
 * first owned target.
 *
 * @returns {void}
 */
export function assertAtomicDirectoryExchangeAvailable() {
  if (atomicDirectoryExchangeSupport === undefined) {
    const help = spawnSync('mv', ['--help'], { encoding: 'utf8' });
    atomicDirectoryExchangeSupport =
      help.status === 0 && String(help.stdout).includes('--exchange');
  }

  if (!atomicDirectoryExchangeSupport) {
    throw new Error('Atomic directory publication is unsupported: mv --exchange is unavailable');
  }
}

/**
 * Resolve aliases through the deepest existing ancestor while retaining a
 * missing suffix. Every filesystem owner uses this identity for lock keys and
 * overlap checks.
 *
 * @param {string} candidatePath
 * @returns {string}
 */
export function resolvePathIdentity(candidatePath) {
  let currentPath = path.resolve(candidatePath);
  /** @type {string[]} */
  const missingSegments = [];

  while (!exists(currentPath)) {
    const parentPath = path.dirname(currentPath);

    if (parentPath === currentPath) {
      break;
    }

    missingSegments.unshift(path.basename(currentPath));
    currentPath = parentPath;
  }

  const resolvedAncestor = exists(currentPath) ? fs.realpathSync.native(currentPath) : currentPath;
  return path.resolve(resolvedAncestor, ...missingSegments);
}

/**
 * Admit exact mutation leaves under one physical owner. Existing ancestors
 * must remain ordinary directories; aliases never become mutation authority.
 *
 * @param {string} requestedOwnerRoot
 * @param {string[]} requestedTargetPaths
 * @param {string} [ownerLabel]
 * @returns {string[]}
 */
export function admitOwnedPaths(
  requestedOwnerRoot,
  requestedTargetPaths,
  ownerLabel = 'Filesystem owner'
) {
  const ownerRoot = resolvePathIdentity(requestedOwnerRoot);

  return requestedTargetPaths.map((requestedTargetPath) => {
    const targetPath = path.resolve(requestedTargetPath);
    const relativePath = path.relative(ownerRoot, targetPath);

    if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error(`${ownerLabel} escapes its physical root: ${targetPath}`);
    }

    let currentPath = ownerRoot;

    for (const segment of relativePath.split(path.sep).slice(0, -1)) {
      currentPath = path.join(currentPath, segment);

      if (!exists(currentPath)) continue;
      const stats = fs.lstatSync(currentPath);

      if (stats.isSymbolicLink()) {
        throw new Error(`${ownerLabel} traverses a symbolic link: ${targetPath}`);
      }

      if (!stats.isDirectory()) {
        throw new Error(`${ownerLabel} has a non-directory ancestor: ${targetPath}`);
      }
    }

    const physicalTarget = path.join(
      resolvePathIdentity(path.dirname(targetPath)),
      path.basename(targetPath)
    );

    if (!isSameOrDescendant(ownerRoot, physicalTarget)) {
      throw new Error(`${ownerLabel} escapes its physical root: ${targetPath}`);
    }

    return physicalTarget;
  });
}

/**
 * Admit paths that will own descendants. Existing leaves must be real
 * directories; callers may then create absent leaves without following links.
 *
 * @param {string} requestedOwnerRoot
 * @param {string[]} requestedDirectoryPaths
 * @param {string} [ownerLabel]
 * @returns {string[]}
 */
export function admitOwnedDirectories(
  requestedOwnerRoot,
  requestedDirectoryPaths,
  ownerLabel = 'Filesystem owner'
) {
  const directories = admitOwnedPaths(requestedOwnerRoot, requestedDirectoryPaths, ownerLabel);

  for (const directory of directories) {
    if (!exists(directory)) continue;
    const stats = fs.lstatSync(directory);

    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`${ownerLabel} must be an absent path or ordinary directory: ${directory}`);
    }
  }

  return directories;
}

/**
 * Acquire a cross-process token lock by hard-linking a fully written owner
 * record to the fixed claim path. The callback is reentrant in-process.
 *
 * @template T
 * @param {string} requestedLockPath
 * @param {() => T} action
 * @param {{ ownerRoot: string; timeoutMs?: number; corruptStaleMs?: number; testBeforeReap?: (() => void); testBeforeRelease?: (() => void) }} options
 * @returns {T}
 */
export function withTokenFileLock(requestedLockPath, action, options) {
  requireOwnedRoot(options);
  const requestedAbsolutePath = path.resolve(requestedLockPath);
  const ownerRoot = resolvePathIdentity(options.ownerRoot);
  const heldLock = heldTokenLocks.get(requestedAbsolutePath);

  if (heldLock) {
    if (heldLock.state === 'release-failed') {
      throw new Error(`Lock ${requestedAbsolutePath} release previously failed in this process`);
    }

    heldLock.depth += 1;

    try {
      return action();
    } finally {
      heldLock.depth -= 1;
    }
  }

  const missingParents = collectMissingParentDirectories([requestedAbsolutePath]);

  try {
    return withAnchoredParent(ownerRoot, requestedAbsolutePath, true, ({ anchoredPath }) =>
      withAnchoredTokenFileLock(requestedAbsolutePath, anchoredPath, action, options)
    );
  } finally {
    removeOwnedEmptyDirectoriesUnderRoot(ownerRoot, missingParents);
  }
}

/**
 * @template T
 * @param {string} lockIdentity
 * @param {string} lockPath
 * @param {() => T} action
 * @param {{ ownerRoot: string; timeoutMs?: number; corruptStaleMs?: number; testBeforeReap?: (() => void); testBeforeRelease?: (() => void) }} options
 * @returns {T}
 */
function withAnchoredTokenFileLock(lockIdentity, lockPath, action, options) {
  const token = randomUUID();
  const ownerFileName = `${path.basename(lockPath)}.owner-${token}.json`;
  const ownerPath = path.join(path.dirname(lockPath), ownerFileName);
  const owner = createTokenLockOwner(ownerFileName, token);
  writeExclusiveJson(ownerPath, owner);
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const corruptStaleMs = options.corruptStaleMs ?? DEFAULT_CORRUPT_LOCK_STALE_MS;
  let acquired = false;

  try {
    while (!acquired) {
      try {
        fs.linkSync(ownerPath, lockPath);
        fsyncDirectory(path.dirname(lockPath));
        acquired = true;
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
          throw error;
        }

        const generation = readLockGeneration(lockPath);
        const reclaimable = generation.owner
          ? !isProcessAlive(generation.owner)
          : Date.now() - generation.stats.mtimeMs >= corruptStaleMs;

        if (Date.now() >= deadline) {
          const ownerLabel = reclaimable
            ? 'a stale owner awaiting reclamation'
            : generation.owner
              ? `live process ${generation.owner.pid}`
              : 'a not-yet-stale corrupt owner';
          throw new Error(`Lock ${lockPath} is held by ${ownerLabel}`);
        }

        if (reclaimable) {
          reapLockGeneration(lockPath, generation, options.testBeforeReap);
        } else {
          sleepSync(25);
        }
      }
    }

    const claimedStats = fs.lstatSync(lockPath);
    const ownerStats = fs.lstatSync(ownerPath);

    if (claimedStats.dev !== ownerStats.dev || claimedStats.ino !== ownerStats.ino) {
      throw new Error(`Lock ${lockPath} did not retain its published owner inode`);
    }

    heldTokenLocks.set(lockIdentity, { state: 'held', depth: 1, token });
    /** @type {T | undefined} */
    let result;
    /** @type {unknown} */
    let actionFailure;
    let actionFailed = false;

    try {
      result = action();
    } catch (error) {
      actionFailed = true;
      actionFailure = error;
    }

    let releaseFailure;

    try {
      options.testBeforeRelease?.();
      releaseOwnedLock(lockPath, ownerPath, token);
      heldTokenLocks.delete(lockIdentity);
    } catch (error) {
      releaseFailure = error;

      try {
        if (readLockGeneration(lockPath).owner?.token === token) {
          heldTokenLocks.set(lockIdentity, { state: 'release-failed', token });
        } else {
          heldTokenLocks.delete(lockIdentity);

          try {
            fs.rmSync(ownerPath, { force: true });
          } catch {
            // The release warning below remains the observable failure.
          }
        }
      } catch {
        heldTokenLocks.delete(lockIdentity);

        try {
          fs.rmSync(ownerPath, { force: true });
        } catch {
          // The release warning below remains the observable failure.
        }
      }
    }

    if (actionFailed) {
      if (releaseFailure) {
        throw new AggregateError(
          [actionFailure, releaseFailure],
          `Action failed and lock ${lockPath} could not be released`
        );
      }

      throw actionFailure;
    }

    if (releaseFailure) {
      console.warn(`Lock release deferred for recovery: ${String(releaseFailure)}`);
    }

    return /** @type {T} */ (result);
  } finally {
    if (!acquired) {
      try {
        fs.rmSync(ownerPath, { force: true });
      } catch (error) {
        console.warn(`Unclaimed lock owner cleanup failed: ${String(error)}`);
      }
    }
  }
}

/**
 * Construct an explicitly nontransactional capability for fixed recovery,
 * maintenance, or capture paths.  It never discovers an open transaction;
 * callers must choose this narrower owner when no live transaction exists.
 *
 * @param {string} requestedOwnerRoot
 * @param {{ paths?: string[]; directories?: string[] }} scope
 * @param {string} [ownerLabel]
 * @returns {{ installManagedPath: (mode: ManagedPathMode, sourcePath: string, targetPath: string) => void; writeText: (filePath: string, content: string, options?: { finalNewline?: boolean; followFinalSymlink?: boolean }) => void; writeBinary: (filePath: string, content: Buffer) => void; writeRecoveryCandidate: (candidatePath: string, content: string) => void; publishStaged: (stagedPath: string, targetPath: string) => void; remove: (targetPath: string) => void; removeEmptyDirectories: (directories: string[]) => void }}
 */
export function createOwnedFilesystemMaintenance(
  requestedOwnerRoot,
  scope,
  ownerLabel = 'Owned filesystem maintenance'
) {
  const ownerRoot = resolvePathIdentity(requestedOwnerRoot);
  const paths = admitOwnedPaths(ownerRoot, scope.paths ?? [], ownerLabel);
  const directories = admitOwnedDirectories(ownerRoot, scope.directories ?? [], ownerLabel);

  if (paths.length === 0 && directories.length === 0) {
    throw new Error(`${ownerLabel} requires at least one admitted path`);
  }

  return createOwnedMutationCapability(
    createOwnedMutationAuthority(ownerRoot, ownerLabel, (targetPath) => {
      const target = path.resolve(targetPath);
      if (
        paths.includes(target) ||
        directories.some((directory) => isSameOrDescendant(directory, target))
      ) {
        return target;
      }
      throw new Error(`${ownerLabel} mutation is outside its admitted scope: ${target}`);
    })
  );
}

/**
 * @param {OwnedMutationAuthority} authority
 * @returns {{ installManagedPath: (mode: ManagedPathMode, sourcePath: string, targetPath: string) => void; writeText: (filePath: string, content: string, options?: { finalNewline?: boolean; followFinalSymlink?: boolean }) => void; writeBinary: (filePath: string, content: Buffer) => void; writeRecoveryCandidate: (candidatePath: string, content: string) => void; publishStaged: (stagedPath: string, targetPath: string) => void; remove: (targetPath: string) => void; removeEmptyDirectories: (directories: string[]) => void }}
 */
function createOwnedMutationCapability(authority) {
  return Object.freeze({
    installManagedPath(mode, sourcePath, targetPath) {
      installManagedPath(authority, mode, sourcePath, targetPath);
    },
    writeText(filePath, content, options = {}) {
      writeTextFile(authority, filePath, content, options);
    },
    writeBinary(filePath, content) {
      writeBinaryFile(authority, filePath, content);
    },
    writeRecoveryCandidate(candidatePath, content) {
      writeOwnedRecoveryCandidate(authority, candidatePath, content);
    },
    publishStaged(stagedPath, targetPath) {
      publishStagedOwnedPath(authority, stagedPath, targetPath);
    },
    remove(targetPath) {
      removeOwnedPath(authority, targetPath);
    },
    removeEmptyDirectories(directories) {
      removeOwnedEmptyDirectories(authority, directories);
    },
  });
}

/** @param {string} ownerRoot @param {string[]} directories */
function removeOwnedEmptyDirectoriesUnderRoot(ownerRoot, directories) {
  if (directories.length === 0) return;
  const maintenance = createOwnedFilesystemMaintenance(
    ownerRoot,
    { directories },
    'Owned filesystem cleanup'
  );
  maintenance.removeEmptyDirectories(directories);
}

/** @param {string} ownerRoot @param {string} targetPath @param {string} [label] */
function removeOwnedMaintenancePath(ownerRoot, targetPath, label = 'Owned filesystem maintenance') {
  createOwnedFilesystemMaintenance(ownerRoot, { paths: [targetPath] }, label).remove(targetPath);
}

/**
 * @param {string} ownerRoot
 * @param {string} label
 * @param {(targetPath: string, operation: string) => string} admitTarget
 * @param {{ admitPublicationSource?: (targetPath: string, operation: string) => string; recordIntent?: (targetPath: string, generation: string) => void; recordCompletion?: (targetPath: string, generation: string) => void; snapshotIdFor?: (targetPath: string) => string | undefined }} [hooks]
 * @returns {OwnedMutationAuthority}
 */
function createOwnedMutationAuthority(ownerRoot, label, admitTarget, hooks = {}) {
  return {
    ownerRoot,
    label,
    admitTarget,
    admitPublicationSource: hooks.admitPublicationSource ?? admitTarget,
    recordIntent: hooks.recordIntent ?? (() => {}),
    recordCompletion: hooks.recordCompletion ?? (() => {}),
    snapshotIdFor: hooks.snapshotIdFor ?? (() => undefined),
  };
}

/** @param {OwnedMutationAuthority} authority @param {ManagedPathMode} mode @param {string} sourcePath @param {string} targetPath */
function installManagedPath(authority, mode, sourcePath, targetPath) {
  const admittedTarget = authority.admitTarget(targetPath, 'installManagedPath');

  if (
    fs.lstatSync(sourcePath).isDirectory() ||
    (exists(admittedTarget) && fs.lstatSync(admittedTarget).isDirectory())
  ) {
    assertAtomicDirectoryExchangeAvailable();
  }

  withAnchoredParent(authority.ownerRoot, admittedTarget, true, (parent) => {
    publishStagedPathAtomically(authority, parent, admittedTarget, (temporaryPath) => {
      if (mode === 'link') {
        fs.symlinkSync(path.resolve(sourcePath), temporaryPath);
        return;
      }

      copyPathToStaging(sourcePath, temporaryPath);
    });
  });
}

/** @param {OwnedMutationAuthority} authority @param {string} filePath @param {string} content @param {{ finalNewline?: boolean; followFinalSymlink?: boolean }} options */
function writeTextFile(authority, filePath, content, options) {
  const finalContent =
    options.finalNewline === true && !content.endsWith('\n') ? `${content}\n` : content;

  publishRegularFileAtomically(
    authority,
    filePath,
    (temporaryPath, mode) => {
      const descriptor = fs.openSync(temporaryPath, 'wx', mode);

      try {
        if (mode !== undefined) fs.fchmodSync(descriptor, mode);
        fs.writeFileSync(descriptor, finalContent, 'utf8');
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    },
    { followFinalSymlink: options.followFinalSymlink !== false, preserveTargetMode: true }
  );
}

/** @param {OwnedMutationAuthority} authority @param {string} filePath @param {Buffer} content */
function writeBinaryFile(authority, filePath, content) {
  publishRegularFileAtomically(
    authority,
    filePath,
    (temporaryPath, mode) => {
      const descriptor = fs.openSync(temporaryPath, 'wx', mode);

      try {
        if (mode !== undefined) fs.fchmodSync(descriptor, mode);
        fs.writeFileSync(descriptor, content);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    },
    { followFinalSymlink: true, preserveTargetMode: true }
  );
}

/** @param {OwnedMutationAuthority} authority @param {string} candidatePath @param {string} content */
function writeOwnedRecoveryCandidate(authority, candidatePath, content) {
  const admittedCandidate = authority.admitTarget(candidatePath, 'writeRecoveryCandidate');
  withAnchoredParent(
    authority.ownerRoot,
    admittedCandidate,
    true,
    ({ anchoredPath, descriptor }) => {
      if (exists(anchoredPath)) removePathIfReachable(anchoredPath);
      fs.writeFileSync(anchoredPath, content, {
        encoding: 'utf8',
        flag: 'wx',
        flush: true,
        mode: 0o600,
      });
      fsyncDirectoryDescriptor(descriptor);
    }
  );
}

/** @param {OwnedMutationAuthority} authority @param {string} targetPath */
function removeOwnedPath(authority, targetPath) {
  const admittedTarget = authority.admitTarget(targetPath, 'remove');
  authority.recordIntent(admittedTarget, 'absent');
  const snapshot = authority.snapshotIdFor(admittedTarget);
  if (snapshot !== undefined) {
    removeSnapshotGeneration(
      authority.ownerRoot,
      admittedTarget,
      snapshotTemporaryPath(admittedTarget, snapshot)
    );
    authority.recordCompletion(admittedTarget, 'absent');
    return;
  }

  try {
    withAnchoredParent(authority.ownerRoot, admittedTarget, false, (parent) => {
      removePathIfReachable(parent.anchoredPath);
      fsyncDirectoryDescriptor(parent.descriptor);
    });
  } catch (error) {
    if (!(error instanceof MissingOwnedParentError)) throw error;
  }
  authority.recordCompletion(admittedTarget, 'absent');
}

/** @param {OwnedMutationAuthority} authority @param {string} stagedPath @param {string} targetPath */
function publishStagedOwnedPath(authority, stagedPath, targetPath) {
  const admittedStage = authority.admitPublicationSource(stagedPath, 'publishStaged source');
  const admittedTarget = authority.admitTarget(targetPath, 'publishStaged target');
  withAnchoredParent(authority.ownerRoot, admittedStage, false, (sourceParent) => {
    withAnchoredParent(authority.ownerRoot, admittedTarget, true, (targetParent) => {
      const stagedGeneration = readStableAnchoredGeneration(sourceParent.anchoredPath);
      authority.recordIntent(admittedTarget, stagedGeneration);
      if (
        exists(targetParent.anchoredPath) &&
        pathNeedsExchange(sourceParent.anchoredPath, targetParent.anchoredPath)
      ) {
        exchangeAnchoredPathsAcrossParents(
          sourceParent.descriptor,
          sourceParent.leafName,
          targetParent.descriptor,
          targetParent.leafName
        );
        removePathIfReachable(sourceParent.anchoredPath);
      } else {
        fs.renameSync(sourceParent.anchoredPath, targetParent.anchoredPath);
      }
      authority.recordIntent(admittedStage, 'absent');
      fsyncDirectoryDescriptor(sourceParent.descriptor);

      if (sourceParent.descriptor !== targetParent.descriptor) {
        fsyncDirectoryDescriptor(targetParent.descriptor);
      }
      authority.recordCompletion(admittedTarget, stagedGeneration);
      authority.recordCompletion(admittedStage, 'absent');
    });
  });
}

/**
 * Flush owned paths and their directory entries. Missing paths still flush
 * their nearest existing parent so deletions become durable.
 *
 * @param {string[]} requestedPaths
 * @returns {void}
 */
export function syncPathsDurably(requestedPaths) {
  const directories = new Set();

  for (const requestedPath of requestedPaths) {
    const targetPath = path.resolve(requestedPath);

    if (exists(targetPath)) {
      fsyncTree(targetPath);
      addDirectoryChain(
        directories,
        fs.lstatSync(targetPath).isDirectory() ? targetPath : path.dirname(targetPath)
      );
    } else {
      let parentPath = path.dirname(targetPath);

      while (!exists(parentPath)) {
        const nextParent = path.dirname(parentPath);

        if (nextParent === parentPath) {
          break;
        }

        parentPath = nextParent;
      }

      if (exists(parentPath)) {
        addDirectoryChain(directories, parentPath);
      }
    }
  }

  for (const directory of directories) {
    fsyncDirectory(directory);
  }
}

/**
 * A durable child is not reachable after a crash unless every directory entry
 * created or replaced on its path is durable as well.
 *
 * @param {Set<string>} directories
 * @param {string} startDirectory
 * @returns {void}
 */
function addDirectoryChain(directories, startDirectory) {
  let directory = startDirectory;

  while (exists(directory)) {
    const stats = fs.lstatSync(directory);

    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      break;
    }

    directories.add(directory);
    const parent = path.dirname(directory);

    if (parent === directory) {
      break;
    }

    directory = parent;
  }
}

/**
 * Start one owned filesystem transaction.  The returned capability is the
 * only path that can publish to its live targets; snapshot data is an internal
 * recovery representation, not ambient process state.
 *
 * @param {string[]} targetPaths
 * @param {string} backupRoot
 * @param {{ ownerRoot: string; snapshotId?: string; temporaryPaths?: string[] }} options
 * @returns {{ backupRoot: string; snapshotId: string; targetPaths: string[]; installManagedPath: (mode: ManagedPathMode, sourcePath: string, targetPath: string) => void; writeText: (filePath: string, content: string, options?: { finalNewline?: boolean; followFinalSymlink?: boolean }) => void; writeBinary: (filePath: string, content: Buffer) => void; publishStaged: (stagedPath: string, targetPath: string) => void; remove: (targetPath: string) => void; discard: () => void; rollback: () => void; seal: () => void }}
 */
export function beginOwnedFilesystemTransaction(targetPaths, backupRoot, options) {
  requireOwnedRoot(options);
  const ownerRoot = resolvePathIdentity(options.ownerRoot);
  const uniquePaths = [...new Set(targetPaths.map((targetPath) => path.resolve(targetPath)))];
  admitOwnedPaths(ownerRoot, uniquePaths, 'Owned filesystem snapshot');
  const snapshotId = options.snapshotId ?? randomUUID();
  assertSnapshotId(snapshotId);
  if (
    uniquePaths.some((target) =>
      uniquePaths.some((other) => target !== other && isSameOrDescendant(other, target))
    )
  ) {
    throw new Error('Snapshot targets must have independent generation boundaries');
  }
  const temporaryPaths = new Set(
    (options.temporaryPaths ?? []).map((target) => path.resolve(target))
  );
  if ([...temporaryPaths].some((target) => !uniquePaths.includes(target) || exists(target))) {
    throw new Error('Disposable transaction paths must be absent snapshot targets');
  }
  const scratchPaths = [
    ...uniquePaths.map((target) => snapshotTemporaryPath(target, snapshotId)),
    ...temporaryPaths,
  ];
  for (const scratch of scratchPaths) {
    for (const reserved of [scratch, `${scratch}.retired`]) {
      if ((!temporaryPaths.has(reserved) && uniquePaths.includes(reserved)) || exists(reserved)) {
        throw new Error(
          `Transaction temporary path already exists or overlaps a target: ${reserved}`
        );
      }
    }
  }
  /** @type {string[]} */
  const missingBackupParents = [];
  let backupParent = path.dirname(backupRoot);

  while (!exists(backupParent)) {
    missingBackupParents.push(backupParent);
    const nextParent = path.dirname(backupParent);

    if (nextParent === backupParent) {
      break;
    }

    backupParent = nextParent;
  }

  const entries = uniquePaths.map((targetPath, index) => {
    const existed = exists(targetPath);
    const type = existed ? snapshotPathType(targetPath) : undefined;
    const originalGeneration = readStablePathGeneration(ownerRoot, targetPath);

    return {
      backupPath: path.join(backupRoot, 'snapshot', String(index)),
      disposable: temporaryPaths.has(targetPath),
      existed,
      mutationGeneration: originalGeneration,
      publishedGeneration: originalGeneration,
      originalGeneration,
      targetPath,
      type,
    };
  });

  if (entries.some(({ type }) => type === 'directory')) {
    assertAtomicDirectoryExchangeAvailable();
  }

  /** @type {OwnedSnapshot} */
  const snapshotState = {
    backupRoot: path.resolve(backupRoot),
    entries,
    missingBackupParents,
    ownerRoot,
    snapshotId,
  };
  const backupAuthority = createOwnedMutationAuthority(
    ownerRoot,
    'Owned filesystem snapshot backup',
    (targetPath) => {
      const target = path.resolve(targetPath);
      if (!isSameOrDescendant(snapshotState.backupRoot, target)) {
        throw new Error(`Owned filesystem snapshot backup escapes its root: ${target}`);
      }
      return target;
    }
  );
  const backupOperations = createOwnedMutationCapability(backupAuthority);
  let lifecycle = /** @type {'open' | 'sealed' | 'revoked' | 'discarded' | 'rolledBack'} */ (
    'open'
  );
  /** @param {string} targetPath @param {string} operation @returns {string} */
  const admitOpenTransactionPath = (targetPath, operation) => {
    if (lifecycle !== 'open') {
      throw new Error(`Owned filesystem transaction is ${lifecycle}; cannot ${operation}`);
    }
    return path.resolve(targetPath);
  };
  const transactionAuthority = createOwnedMutationAuthority(
    ownerRoot,
    'Owned filesystem transaction',
    (targetPath, operation) => {
      const target = admitOpenTransactionPath(targetPath, operation);
      const exactEntry = entries.find((entry) => entry.targetPath === target);
      if (exactEntry !== undefined) return target;
      if (
        entries.some((entry) => entry.disposable && isSameOrDescendant(entry.targetPath, target))
      ) {
        return target;
      }
      if (
        entries.some((entry) => !entry.disposable && isSameOrDescendant(entry.targetPath, target))
      ) {
        throw new Error(
          `Directory transaction requires complete-generation replacement: ${target}`
        );
      }
      throw new Error(
        `Owned filesystem transaction mutation is outside its admitted scope: ${target}`
      );
    },
    {
      admitPublicationSource(stagedPath, operation) {
        const stage = admitOpenTransactionPath(stagedPath, operation);
        if (
          entries.some((entry) => entry.disposable && isSameOrDescendant(entry.targetPath, stage))
        ) {
          return stage;
        }
        throw new Error(
          `Owned filesystem transaction publication source must be an admitted disposable stage: ${stage}`
        );
      },
      recordIntent(targetPath, generation) {
        recordSnapshotMutationIntent(snapshotState, targetPath, generation);
      },
      recordCompletion(targetPath, generation) {
        recordSnapshotMutationCompletion(snapshotState, targetPath, generation);
      },
      snapshotIdFor(targetPath) {
        return entries.some((entry) => !entry.disposable && entry.targetPath === targetPath)
          ? snapshotId
          : undefined;
      },
    }
  );

  try {
    withAnchoredParent(ownerRoot, backupRoot, true, ({ anchoredPath, descriptor }) => {
      fs.mkdirSync(anchoredPath);
      fsyncDirectoryDescriptor(descriptor);
    });

    for (const entry of entries) {
      if (!entry.existed) {
        continue;
      }

      withAnchoredParent(ownerRoot, entry.backupPath, true, (parent) => {
        publishStagedPathAtomically(
          backupAuthority,
          parent,
          entry.backupPath,
          (temporaryPath) => {
            withAnchoredParent(ownerRoot, entry.targetPath, false, ({ anchoredPath }) => {
              copyPathToStaging(anchoredPath, temporaryPath);
            });
          },
          false
        );
      });
    }

    for (const entry of entries) {
      if (readStablePathGeneration(ownerRoot, entry.targetPath) !== entry.originalGeneration) {
        throw new Error(
          `Owned filesystem generation changed while its snapshot was being created: ${entry.targetPath}`
        );
      }

      if (
        entry.existed &&
        readStablePathGeneration(ownerRoot, entry.backupPath) !== entry.originalGeneration
      ) {
        throw new Error(`Owned filesystem snapshot copy is incomplete for ${entry.targetPath}`);
      }
    }

    writeSnapshotManifest(snapshotState);
    syncPathsDurably([backupRoot, path.dirname(backupRoot)]);
  } catch (error) {
    try {
      backupOperations.remove(backupRoot);
      removeOwnedEmptyDirectoriesUnderRoot(ownerRoot, missingBackupParents);
    } catch {
      // The snapshot error remains the useful failure when cleanup is impossible.
    }

    throw error;
  }

  const { installManagedPath, publishStaged, remove, writeBinary, writeText } =
    createOwnedMutationCapability(transactionAuthority);
  return Object.freeze({
    installManagedPath,
    publishStaged,
    remove,
    writeBinary,
    writeText,
    backupRoot,
    snapshotId,
    targetPaths: uniquePaths,
    seal() {
      if (lifecycle !== 'open') {
        throw new Error(`Owned filesystem transaction is already ${lifecycle}`);
      }
      lifecycle = 'sealed';
    },
    discard() {
      if (lifecycle === 'discarded' || lifecycle === 'rolledBack' || lifecycle === 'revoked') {
        throw new Error(`Owned filesystem transaction is already ${lifecycle}`);
      }
      lifecycle = 'revoked';
      backupOperations.remove(backupRoot);
      removeOwnedEmptyDirectoriesUnderRoot(ownerRoot, missingBackupParents);

      syncPathsDurably([path.dirname(backupRoot)]);
      lifecycle = 'discarded';
    },
    rollback() {
      if (lifecycle === 'discarded' || lifecycle === 'rolledBack' || lifecycle === 'revoked') {
        throw new Error(`Owned filesystem transaction is already ${lifecycle}`);
      }
      lifecycle = 'revoked';

      if (
        entries.some(
          ({ targetPath, type }) =>
            type === 'directory' || (exists(targetPath) && fs.lstatSync(targetPath).isDirectory())
        )
      ) {
        assertAtomicDirectoryExchangeAvailable();
      }

      /** @type {unknown[]} */
      const failures = [];

      const recoveryIdentity = prepareSnapshotRecovery(snapshotState, 6);
      const recoveryAuthority = createSnapshotRecoveryAuthority(snapshotState);
      for (const entry of entries) {
        try {
          restoreSnapshotEntry(entry, recoveryAuthority, recoveryIdentity);
        } catch (error) {
          failures.push(error);
        }
      }

      if (failures.length > 0) {
        throw new AggregateError(failures, 'Could not restore the owned filesystem snapshot');
      }

      syncPathsDurably(entries.map(({ targetPath }) => targetPath));
      backupOperations.remove(backupRoot);
      removeOwnedEmptyDirectoriesUnderRoot(ownerRoot, missingBackupParents);
      syncPathsDurably([path.dirname(backupRoot)]);

      lifecycle = 'rolledBack';
    },
  });
}

/**
 * Restore a persisted snapshot without deleting its backup. Retaining the
 * backup makes recovery repeatable until the transaction owner durably records
 * that rollback completed.
 *
 * @param {string} requestedBackupRoot
 * @param {{ allowedRoots: string[]; expectedTargetPaths: string[]; snapshotId: string; temporaryPaths?: string[] }} options
 * @returns {void}
 */
export function restoreOwnedPathSnapshot(requestedBackupRoot, options) {
  admitPersistedBackupRoot(requestedBackupRoot, options.allowedRoots);
  const backupRoot = resolvePathIdentity(requestedBackupRoot);
  const manifest = readValidatedSnapshotManifest(backupRoot, options);
  if (
    manifest.entries.some(
      ({ targetPath, type }) =>
        type === 'directory' || (exists(targetPath) && fs.lstatSync(targetPath).isDirectory())
    )
  ) {
    assertAtomicDirectoryExchangeAvailable();
  }
  const ownerRoot = options.allowedRoots
    .map(resolvePathIdentity)
    .find(
      (root) =>
        isSameOrDescendant(root, backupRoot) &&
        manifest.entries.every((entry) => isSameOrDescendant(root, entry.targetPath))
    );
  if (ownerRoot === undefined)
    throw new Error('Owned filesystem snapshot has no single admitted owner');
  const snapshot = { ...manifest, backupRoot, ownerRoot, snapshotId: options.snapshotId };
  const recoveryIdentity = prepareSnapshotRecovery(snapshot, manifest.version);
  const recoveryAuthority = createSnapshotRecoveryAuthority(snapshot);
  /** @type {unknown[]} */
  const failures = [];
  for (const entry of manifest.entries) {
    try {
      restoreSnapshotEntry(entry, recoveryAuthority, recoveryIdentity);
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, 'Could not restore the persisted owned filesystem snapshot');
  }

  syncPathsDurably(manifest.entries.map(({ targetPath }) => targetPath));
}

/**
 * Delete a persisted snapshot only after its owner has durably recorded the
 * final transaction phase.
 *
 * @param {string} requestedBackupRoot
 * @param {{ allowedRoots: string[]; expectedTargetPaths: string[]; snapshotId: string; temporaryPaths?: string[] }} options
 * @returns {void}
 */
export function discardOwnedPathSnapshot(requestedBackupRoot, options) {
  admitPersistedBackupRoot(requestedBackupRoot, options.allowedRoots);
  const backupRoot = resolvePathIdentity(requestedBackupRoot);
  readValidatedSnapshotManifest(backupRoot, options);
  const ownerRoot = options.allowedRoots
    .map(resolvePathIdentity)
    .find((root) => isSameOrDescendant(root, backupRoot));

  if (!ownerRoot) {
    throw new Error('Owned filesystem snapshot is outside its allowed roots');
  }

  removeOwnedMaintenancePath(ownerRoot, backupRoot, 'Owned filesystem snapshot backup');
  syncPathsDurably([path.dirname(backupRoot)]);
}

/**
 * @param {string} requestedBackupRoot
 * @param {string[]} requestedAllowedRoots
 * @returns {void}
 */
function admitPersistedBackupRoot(requestedBackupRoot, requestedAllowedRoots) {
  const backupRoot = path.resolve(requestedBackupRoot);
  const ownerRoot = requestedAllowedRoots
    .map((allowedRoot) => resolvePathIdentity(allowedRoot))
    .find((allowedRoot) => isSameOrDescendant(allowedRoot, backupRoot));

  if (ownerRoot === undefined) {
    throw new Error('Owned filesystem snapshot is outside its allowed roots');
  }

  admitOwnedPaths(
    ownerRoot,
    [path.join(backupRoot, 'snapshot.json')],
    'Owned filesystem snapshot backup'
  );
}

/**
 * @param {string} filePath
 * @returns {'file' | 'directory' | 'symlink'}
 */
function snapshotPathType(filePath) {
  const stats = fs.lstatSync(filePath);
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  throw new Error(`Owned filesystem snapshot cannot preserve special path ${filePath}`);
}

/**
 * @param {string} backupRoot
 * @param {{ allowedRoots: string[]; expectedTargetPaths: string[]; snapshotId: string; temporaryPaths?: string[] }} options
 * @returns {{ version: 5 | 6; entries: SnapshotEntry[]; missingBackupParents: string[]; recoveryId?: string }}
 */
function readValidatedSnapshotManifest(backupRoot, options) {
  const allowedRoots = options.allowedRoots.map(resolvePathIdentity);
  const expectedTargetPaths = options.expectedTargetPaths.map((targetPath) =>
    path.resolve(targetPath)
  );

  if (!allowedRoots.some((root) => isSameOrDescendant(root, backupRoot))) {
    throw new Error('Owned filesystem snapshot is outside its allowed roots');
  }

  const manifestPath = path.join(backupRoot, 'snapshot.json');
  admitOwnedPaths(backupRoot, [manifestPath], 'Owned filesystem snapshot backup');
  const manifestStats = fs.lstatSync(manifestPath);

  if (manifestStats.isSymbolicLink() || !manifestStats.isFile()) {
    throw new Error('Owned filesystem snapshot manifest must be a regular file');
  }

  const candidate =
    /** @type {{ version?: unknown; snapshotId?: unknown; recoveryId?: unknown; entries?: unknown; missingOwnedParents?: unknown; missingBackupParents?: unknown }} */ (
      JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    );

  if (candidate?.version !== 5 && candidate?.version !== 6) {
    throw new Error('Owned filesystem snapshot manifest must use version 5 or 6');
  }
  if (candidate.version === 6) assertSnapshotId(options.snapshotId);
  const recoveryId = candidate.recoveryId;
  if (recoveryId !== undefined) {
    if (candidate.version !== 6 || typeof recoveryId !== 'string') {
      throw new Error('Owned filesystem snapshot has an invalid recovery identity');
    }
    assertSnapshotId(recoveryId);
  }
  const temporaryPaths = new Set(options.temporaryPaths ?? []);
  if ([...temporaryPaths].some((target) => !expectedTargetPaths.includes(target))) {
    throw new Error('Disposable transaction path is outside the snapshot targets');
  }

  if (
    candidate.snapshotId !== options.snapshotId ||
    !Array.isArray(candidate.entries) ||
    candidate.entries.length !== expectedTargetPaths.length ||
    candidate.missingOwnedParents !== undefined ||
    !Array.isArray(candidate.missingBackupParents)
  ) {
    throw new Error('Owned filesystem snapshot manifest is corrupt');
  }

  const seenTargets = new Set();
  const seenBackups = new Set();
  const entries = candidate.entries.map((entryCandidate, index) => {
    const entry =
      /** @type {{ targetPath?: unknown; backupPath?: unknown; existed?: unknown; disposable?: unknown; type?: unknown; originalGeneration?: unknown; publishedGeneration?: unknown; mutationGeneration?: unknown }} */ (
        entryCandidate
      );
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.targetPath !== 'string' ||
      typeof entry.backupPath !== 'string' ||
      typeof entry.existed !== 'boolean' ||
      typeof entry.originalGeneration !== 'string' ||
      typeof entry.mutationGeneration !== 'string' ||
      !isOwnedPathGeneration(entry.originalGeneration) ||
      !isOwnedPathGeneration(entry.mutationGeneration) ||
      (entry.existed && entry.originalGeneration === 'absent') ||
      (entry.existed
        ? !['file', 'directory', 'symlink'].includes(/** @type {string} */ (entry.type))
        : entry.type !== undefined)
    ) {
      throw new Error('Owned filesystem snapshot manifest is corrupt');
    }

    const targetPath = path.resolve(entry.targetPath);
    const backupPath = path.resolve(backupRoot, entry.backupPath);
    const expectedBackupPath = path.join(backupRoot, 'snapshot', String(index));
    const targetOwner = allowedRoots.find((root) => isSameOrDescendant(root, targetPath));
    const physicalTargetPath = targetOwner
      ? admitOwnedPaths(targetOwner, [targetPath], 'Owned filesystem snapshot')[0]
      : targetPath;

    if (
      targetOwner === undefined ||
      entry.targetPath !== targetPath ||
      entry.backupPath !== path.join('snapshot', String(index)) ||
      targetPath !== expectedTargetPaths[index] ||
      backupPath !== expectedBackupPath ||
      seenTargets.has(targetPath) ||
      seenBackups.has(backupPath) ||
      !allowedRoots.some((root) => isSameOrDescendant(root, physicalTargetPath)) ||
      !isSameOrDescendant(backupRoot, backupPath)
    ) {
      throw new Error('Owned filesystem snapshot manifest escapes its allowed roots');
    }

    admitOwnedPaths(backupRoot, [backupPath], 'Owned filesystem snapshot backup');
    seenTargets.add(targetPath);
    seenBackups.add(backupPath);
    if (entry.existed) {
      if (!exists(backupPath)) {
        throw new Error(`Owned filesystem snapshot backup is missing for ${targetPath}`);
      }

      if (snapshotPathType(backupPath) !== entry.type) {
        throw new Error(`Owned filesystem snapshot backup type changed for ${targetPath}`);
      }

      const backupGeneration = readStablePathGeneration(backupRoot, backupPath);

      if (backupGeneration !== entry.originalGeneration) {
        throw new Error(`Owned filesystem snapshot backup generation changed for ${targetPath}`);
      }
    } else if (exists(backupPath)) {
      throw new Error(`Owned filesystem snapshot contains an unexpected backup for ${targetPath}`);
    } else if (entry.originalGeneration !== 'absent') {
      throw new Error('Owned filesystem snapshot manifest is corrupt');
    }

    const disposable = temporaryPaths.has(targetPath);
    const publishedGeneration =
      candidate.version === 5 ? entry.originalGeneration : entry.publishedGeneration;
    if (typeof publishedGeneration !== 'string' || !isOwnedPathGeneration(publishedGeneration)) {
      throw new Error('Owned filesystem snapshot has an invalid published generation');
    }
    if (
      (disposable && entry.existed) ||
      (candidate.version === 6 && entry.disposable !== disposable)
    ) {
      throw new Error('Owned filesystem snapshot has invalid disposable-path authority');
    }
    return {
      targetPath,
      backupPath,
      disposable,
      existed: entry.existed,
      originalGeneration: entry.originalGeneration,
      mutationGeneration: entry.mutationGeneration,
      publishedGeneration,
      ...(entry.type !== undefined
        ? { type: /** @type {'file' | 'directory' | 'symlink'} */ (entry.type) }
        : {}),
    };
  });
  /**
   * @param {unknown[]} parents
   * @returns {string[]}
   */
  const validateBackupParents = (parents) =>
    parents.map((parent) => {
      if (typeof parent !== 'string') {
        throw new Error('Owned filesystem snapshot manifest is corrupt');
      }

      const resolvedParent = path.resolve(parent);
      const physicalParent = resolvePathIdentity(resolvedParent);

      if (
        !allowedRoots.some((root) => isSameOrDescendant(root, resolvedParent)) ||
        !allowedRoots.some((root) => isSameOrDescendant(root, physicalParent))
      ) {
        throw new Error('Owned filesystem snapshot parent escapes its allowed roots');
      }

      return resolvedParent;
    });

  return {
    version: candidate.version,
    recoveryId,
    entries,
    missingBackupParents: validateBackupParents(candidate.missingBackupParents),
  };
}

/**
 * @param {string} ancestor
 * @param {string} candidate
 * @returns {boolean}
 */
export function isSameOrDescendant(ancestor, candidate) {
  const relativePath = path.relative(ancestor, candidate);

  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

/**
 * @param {string[]} targetPaths
 * @returns {string[]}
 */
function collectMissingParentDirectories(targetPaths) {
  const missingParents = new Set();

  for (const targetPath of targetPaths) {
    let parentPath = path.dirname(targetPath);

    while (!exists(parentPath)) {
      missingParents.add(parentPath);
      const nextParent = path.dirname(parentPath);

      if (nextParent === parentPath) {
        break;
      }

      parentPath = nextParent;
    }
  }

  return [...missingParents].toSorted((left, right) => right.length - left.length);
}

/**
 * Remove transaction-created empty directories through the same admitted owner
 * namespace used to create them.
 *
 * @param {OwnedMutationAuthority} authority
 * @param {string[]} directories
 * @returns {void}
 */
function removeOwnedEmptyDirectories(authority, directories) {
  const physicalOwnerRoot = resolvePathIdentity(authority.ownerRoot);

  for (const directory of [...new Set(directories)].toSorted(
    (left, right) => right.length - left.length
  )) {
    const admittedDirectory = authority.admitTarget(directory, 'removeEmptyDirectories');
    if (admittedDirectory === physicalOwnerRoot) {
      continue;
    }

    try {
      withAnchoredParent(
        authority.ownerRoot,
        admittedDirectory,
        false,
        ({ anchoredPath, descriptor }) => {
          fs.rmdirSync(anchoredPath);
          fsyncDirectoryDescriptor(descriptor);
        }
      );
    } catch (error) {
      if (
        error instanceof MissingOwnedParentError ||
        (error instanceof Error &&
          'code' in error &&
          (error.code === 'ENOENT' || error.code === 'ENOTEMPTY' || error.code === 'EEXIST'))
      ) {
        continue;
      }

      throw error;
    }
  }
}

/**
 * `rmSync({ force: true })` still throws ENOTDIR when an ancestor is a file.
 * Both ENOENT and ENOTDIR mean the owned descendant is absent.
 *
 * @param {string} targetPath
 * @returns {void}
 */
function removePathIfReachable(targetPath) {
  try {
    fs.rmSync(targetPath, { force: true, recursive: true });
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return;
    }

    throw error;
  }
}

/**
 * Restore regular files by replacement, not deletion followed by copying. A
 * reader of an existing file therefore sees either the current generation or
 * the complete snapshot generation.
 *
 * @param {{ targetPath: string; backupPath: string; disposable: boolean; existed: boolean; type?: 'file' | 'directory' | 'symlink'; originalGeneration: string; publishedGeneration: string; mutationGeneration: string }} entry
 * @param {OwnedMutationAuthority} authority
 * @param {string} snapshotId
 * @returns {void}
 */
function restoreSnapshotEntry(entry, authority, snapshotId) {
  if (entry.disposable) return;
  const ownerRoot = authority.ownerRoot;
  authority.admitTarget(entry.targetPath, 'restore snapshot');
  const currentGeneration = readStablePathGeneration(ownerRoot, entry.targetPath);

  if (currentGeneration === entry.originalGeneration) {
    return;
  }

  if (
    currentGeneration !== entry.mutationGeneration &&
    currentGeneration !== entry.publishedGeneration
  ) {
    throw new Error(`Owned filesystem snapshot found external drift at ${entry.targetPath}`);
  }

  if (!entry.existed) {
    removeSnapshotGeneration(
      ownerRoot,
      entry.targetPath,
      snapshotTemporaryPath(entry.targetPath, snapshotId)
    );
    return;
  }

  withAnchoredParent(ownerRoot, entry.targetPath, true, (parent) => {
    publishStagedPathAtomically(
      authority,
      parent,
      entry.targetPath,
      (temporaryPath) => {
        copyPathToStaging(entry.backupPath, temporaryPath);

        if (readStableAnchoredGeneration(temporaryPath) !== entry.originalGeneration) {
          throw new Error(
            `Owned filesystem snapshot backup changed during restore for ${entry.targetPath}`
          );
        }
      },
      false,
      snapshotId
    );
  });

  const restoredGeneration = readStablePathGeneration(ownerRoot, entry.targetPath);

  if (restoredGeneration !== entry.originalGeneration) {
    throw new Error(`Owned filesystem snapshot could not verify restore for ${entry.targetPath}`);
  }
}

/**
 * Deletion publishes absence atomically. Removing a directory recursively at
 * its live name would leave an unrecognized partial generation after SIGKILL.
 * @param {string} ownerRoot
 * @param {string} targetPath
 * @param {string} scratchPath
 * @returns {void}
 */
function removeSnapshotGeneration(ownerRoot, targetPath, scratchPath) {
  if (path.dirname(targetPath) !== path.dirname(scratchPath)) {
    throw new Error('Snapshot deletion scratch must share its target parent');
  }
  try {
    withAnchoredParent(ownerRoot, targetPath, false, (parent) => {
      const scratch = `/proc/self/fd/${parent.descriptor}/${path.basename(scratchPath)}`;
      if (exists(scratch)) throw new Error(`Snapshot deletion scratch is occupied: ${scratchPath}`);
      if (!exists(parent.anchoredPath)) return;
      fs.renameSync(parent.anchoredPath, scratch);
      fsyncDirectoryDescriptor(parent.descriptor);
      removePathIfReachable(scratch);
      fsyncDirectoryDescriptor(parent.descriptor);
    });
  } catch (error) {
    if (!(error instanceof MissingOwnedParentError)) throw error;
  }
}

/**
 * Fence every previous publisher before reading any target. Recovery uses a
 * fresh identity, persisted before population, so neither an original helper
 * nor an orphan from an earlier recovery can publish through a reused name.
 * The backup is independent authority; revoked candidates can be discarded.
 * @param {OwnedSnapshot} snapshot
 * @param {5 | 6} version
 * @returns {string}
 */
function prepareSnapshotRecovery(snapshot, version) {
  const { ownerRoot, snapshotId, entries } = snapshot;
  assertSnapshotId(snapshotId);
  const originalScratch = entries.map(({ targetPath }) =>
    snapshotTemporaryPath(targetPath, snapshotId)
  );
  if (version === 5) {
    // Legacy writers did not journal UUID publication filenames. Never guess
    // that an unrecorded candidate is disposable or race an orphan using it.
    for (const { targetPath } of entries) {
      const parent = path.dirname(targetPath);
      if (!exists(parent)) continue;
      const prefix = `.${path.basename(targetPath)}.`;
      const candidates = fs
        .readdirSync(parent)
        .filter(
          (name) =>
            name.startsWith(prefix) && /^[0-9a-f-]{36}\.tmp$/iu.test(name.slice(prefix.length))
        );
      if (candidates.length > 0) {
        throw new Error(
          `Legacy snapshot has unrecorded publication evidence beside ${targetPath}; leave it intact until its publisher has stopped and the evidence is reconciled`
        );
      }
    }
    for (const scratch of originalScratch) {
      if (exists(scratch) || exists(`${scratch}.retired`)) {
        throw new Error('Legacy snapshot recovery name is already occupied');
      }
    }
  }
  const oldScratch = [
    ...originalScratch,
    ...entries.filter((entry) => entry.disposable).map((entry) => entry.targetPath),
    ...(snapshot.recoveryId === undefined
      ? []
      : entries.map(({ targetPath }) =>
          snapshotTemporaryPath(targetPath, `${snapshotId}-recovery-${snapshot.recoveryId}`)
        )),
  ];
  for (const scratch of oldScratch) retireSnapshotTemporaryPath(ownerRoot, scratch);
  const recoveryId = randomUUID();
  const recoveryIdentity = `${snapshotId}-recovery-${recoveryId}`;
  for (const { targetPath } of entries) {
    const scratch = snapshotTemporaryPath(targetPath, recoveryIdentity);
    if (exists(scratch) || exists(`${scratch}.retired`)) {
      throw new Error('Snapshot recovery name is already occupied');
    }
  }
  snapshot.recoveryId = recoveryId;
  writeSnapshotManifest(snapshot);
  return recoveryIdentity;
}

/**
 * Revoke a publication name before observing the target. An mv child can
 * survive its lock-owning parent: rename serializes with its exchange syscall,
 * so it either completed before revocation or subsequently fails with ENOENT.
 * Recursive deletion alone would let that child publish a half-deleted tree.
 * Both names are reserved by the snapshot owner before mutation.
 * @param {string} ownerRoot
 * @param {string} temporaryPath
 * @returns {void}
 */
function retireSnapshotTemporaryPath(ownerRoot, temporaryPath) {
  const retiredPath = `${temporaryPath}.retired`;
  removeOwnedMaintenancePath(ownerRoot, retiredPath, 'Owned filesystem recovery scratch');
  try {
    withAnchoredParent(ownerRoot, temporaryPath, false, (parent) => {
      if (exists(parent.anchoredPath)) {
        fs.renameSync(
          parent.anchoredPath,
          `/proc/self/fd/${parent.descriptor}/${parent.leafName}.retired`
        );
        fsyncDirectoryDescriptor(parent.descriptor);
      }
    });
  } catch (error) {
    if (!(error instanceof MissingOwnedParentError)) throw error;
  }
  removeOwnedMaintenancePath(ownerRoot, retiredPath, 'Owned filesystem recovery scratch');
}

/**
 * Publish a complete regular file with the filesystem's atomic rename
 * primitive. The temporary file lives beside the destination so replacement
 * cannot cross filesystems.
 *
 * @param {OwnedMutationAuthority} authority
 * @param {string} requestedPath
 * @param {(temporaryPath: string, mode: number | undefined) => void} populate
 * @param {{ followFinalSymlink?: boolean; preserveTargetMode?: boolean }} options
 * @returns {void}
 */
function publishRegularFileAtomically(authority, requestedPath, populate, options) {
  const filePath = authority.admitTarget(requestedPath, 'publish regular file');
  const publishPath = options.followFinalSymlink
    ? resolveFinalSymlinkTarget(filePath, authority.ownerRoot)
    : filePath;
  authority.admitTarget(publishPath, 'publish regular-file referent');

  withAnchoredParent(authority.ownerRoot, publishPath, true, (parent) => {
    const targetStats = exists(parent.anchoredPath) ? fs.lstatSync(parent.anchoredPath) : undefined;
    const mode =
      options.preserveTargetMode && targetStats?.isFile() ? targetStats.mode & 0o7777 : undefined;

    publishStagedPathAtomically(authority, parent, publishPath, (temporaryPath) => {
      populate(temporaryPath, mode);
    });
  });
}

/**
 * Writes historically follow a final symbolic link. Resolve only that leaf so
 * atomic publication updates its referent without replacing the link itself.
 *
 * @param {string} requestedPath
 * @param {string} ownerRoot
 * @returns {string}
 */
function resolveFinalSymlinkTarget(requestedPath, ownerRoot) {
  let targetPath = requestedPath;
  const visited = new Set();

  while (readStablePathGeneration(ownerRoot, targetPath).startsWith('symlink:')) {
    if (visited.has(targetPath)) {
      throw new Error(`Cannot publish through a symbolic-link cycle: ${requestedPath}`);
    }

    visited.add(targetPath);
    const linkTarget = withAnchoredParent(ownerRoot, targetPath, false, ({ anchoredPath }) =>
      fs.readlinkSync(anchoredPath)
    );
    targetPath = path.resolve(path.dirname(targetPath), linkTarget);

    if (!isSameOrDescendant(resolvePathIdentity(ownerRoot), targetPath)) {
      throw new Error(`Cannot publish through a symbolic link outside its owner: ${requestedPath}`);
    }
  }

  return targetPath;
}

/**
 * @param {{ ownerRoot?: unknown } | undefined} options
 * @returns {asserts options is { ownerRoot: string }}
 */
function requireOwnedRoot(options) {
  if (!options || typeof options.ownerRoot !== 'string' || options.ownerRoot.length === 0) {
    throw new Error('Owned filesystem owner requires an explicit root');
  }
}

/**
 * Linux exposes held directory descriptors through procfs. Node does not expose
 * openat/renameat directly, so unsupported platforms fail before mutation
 * instead of falling back to a racy string-path recheck.
 *
 * @template T
 * @param {string} requestedOwnerRoot
 * @param {string} requestedTargetPath
 * @param {boolean} createParents
 * @param {(parent: { descriptor: number; anchoredPath: string; leafName: string }) => T} action
 * @returns {T}
 */
function withAnchoredParent(requestedOwnerRoot, requestedTargetPath, createParents, action) {
  if (process.platform !== 'linux' || !exists('/proc/self/fd')) {
    throw new Error('Descriptor-anchored filesystem mutation is unsupported on this platform');
  }

  const ownerRoot = resolvePathIdentity(requestedOwnerRoot);
  const targetPath = path.resolve(requestedTargetPath);
  const relativePath = path.relative(ownerRoot, targetPath);

  if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Owned filesystem mutation escapes its physical root: ${targetPath}`);
  }

  const segments = relativePath.split(path.sep);
  const leafName = segments.pop();

  if (!leafName || leafName === '.' || leafName === '..') {
    throw new Error(`Owned filesystem mutation has an invalid leaf: ${targetPath}`);
  }

  const expectedRootStats = fs.lstatSync(ownerRoot);

  if (expectedRootStats.isSymbolicLink() || !expectedRootStats.isDirectory()) {
    throw new Error(`Owned filesystem root is not an ordinary directory: ${ownerRoot}`);
  }

  let descriptor = fs.openSync(
    ownerRoot,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
  );

  try {
    const openedRootStats = fs.fstatSync(descriptor);

    if (
      openedRootStats.dev !== expectedRootStats.dev ||
      openedRootStats.ino !== expectedRootStats.ino
    ) {
      throw new Error(`Owned filesystem root changed during admission: ${ownerRoot}`);
    }

    for (const segment of segments) {
      const childPath = `/proc/self/fd/${descriptor}/${segment}`;
      let childDescriptor;

      try {
        childDescriptor = fs.openSync(
          childPath,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
        );
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
          throw new Error(`Owned filesystem mutation has an unsafe parent: ${targetPath}`, {
            cause: error,
          });
        }

        if (!createParents) {
          throw new MissingOwnedParentError(targetPath);
        }

        fs.mkdirSync(childPath);
        fsyncDirectoryDescriptor(descriptor);
        childDescriptor = fs.openSync(
          childPath,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
        );
      }

      fs.closeSync(descriptor);
      descriptor = childDescriptor;
    }

    return action({
      descriptor,
      anchoredPath: `/proc/self/fd/${descriptor}/${leafName}`,
      leafName,
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

class MissingOwnedParentError extends Error {}

/**
 * @param {OwnedMutationAuthority} authority
 * @param {{ descriptor: number; anchoredPath: string; leafName: string }} parent
 * @param {string} targetPath
 * @param {(temporaryPath: string) => void} populate
 * @param {boolean} [recordMutation]
 * @param {string} [snapshotId]
 * @returns {void}
 */
function publishStagedPathAtomically(
  authority,
  parent,
  targetPath,
  populate,
  recordMutation = true,
  snapshotId
) {
  const admittedTarget = authority.admitTarget(targetPath, 'publish staged path');
  snapshotId ??= authority.snapshotIdFor(admittedTarget);
  const temporaryLeaf =
    snapshotId === undefined
      ? `.${parent.leafName}.${randomUUID()}.tmp`
      : path.basename(snapshotTemporaryPath(targetPath, snapshotId));
  const temporaryPath = `/proc/self/fd/${parent.descriptor}/${temporaryLeaf}`;

  try {
    populate(temporaryPath);
    const desiredGeneration = readStableAnchoredGeneration(temporaryPath);

    if (recordMutation) {
      authority.recordIntent(admittedTarget, desiredGeneration);
    }

    if (exists(parent.anchoredPath) && pathNeedsExchange(temporaryPath, parent.anchoredPath)) {
      exchangeAnchoredPaths(parent.descriptor, temporaryLeaf, parent.leafName);
      removePathIfReachable(temporaryPath);
    } else {
      fs.renameSync(temporaryPath, parent.anchoredPath);
    }

    fsyncDirectoryDescriptor(parent.descriptor);
    if (recordMutation) authority.recordCompletion(admittedTarget, desiredGeneration);
  } finally {
    if (exists(temporaryPath)) {
      removePathIfReachable(temporaryPath);
      fsyncDirectoryDescriptor(parent.descriptor);
    }
  }
}

/**
 * One bounded publication scratch path per admitted snapshot target. It is
 * reserved absent during allocation and remains disposable through rollback.
 * @param {string} targetPath
 * @param {string} snapshotId
 * @returns {string}
 */
function snapshotTemporaryPath(targetPath, snapshotId) {
  return path.join(
    path.dirname(targetPath),
    `.tyrian-night-${snapshotId}-${path.basename(targetPath)}.tmp`
  );
}

/**
 * POSIX rename can replace files and symlinks directly, but replacing a
 * non-empty directory or replacing a directory with another type requires an
 * atomic exchange to avoid an observable absent/partial generation.
 *
 * @param {string} stagedPath
 * @param {string} targetPath
 * @returns {boolean}
 */
function pathNeedsExchange(stagedPath, targetPath) {
  return fs.lstatSync(stagedPath).isDirectory() || fs.lstatSync(targetPath).isDirectory();
}

/**
 * @param {number} parentDescriptor
 * @param {string} stagedLeaf
 * @param {string} targetLeaf
 * @returns {void}
 */
function exchangeAnchoredPaths(parentDescriptor, stagedLeaf, targetLeaf) {
  exchangeAnchoredPathsAcrossParents(parentDescriptor, stagedLeaf, parentDescriptor, targetLeaf);
}

/**
 * @param {number} sourceParentDescriptor
 * @param {string} sourceLeaf
 * @param {number} targetParentDescriptor
 * @param {string} targetLeaf
 * @returns {void}
 */
function exchangeAnchoredPathsAcrossParents(
  sourceParentDescriptor,
  sourceLeaf,
  targetParentDescriptor,
  targetLeaf
) {
  assertAtomicDirectoryExchangeAvailable();

  const result = spawnSync(
    'mv',
    [
      '--exchange',
      '--no-copy',
      '--no-target-directory',
      `/proc/self/fd/3/${sourceLeaf}`,
      `/proc/self/fd/4/${targetLeaf}`,
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe', sourceParentDescriptor, targetParentDescriptor],
    }
  );

  if (result.status !== 0) {
    throw new Error(`Atomic directory publication failed: ${String(result.stderr).trim()}`);
  }
}

/**
 * @param {number} descriptor
 * @returns {void}
 */
function fsyncDirectoryDescriptor(descriptor) {
  fs.fsyncSync(descriptor);
}

/**
 * @param {string} sourcePath
 * @param {string} stagedPath
 * @returns {void}
 */
function copyPathToStaging(sourcePath, stagedPath) {
  const sourceStats = fs.lstatSync(sourcePath);

  if (sourceStats.isFile()) {
    fs.cpSync(sourcePath, stagedPath, { preserveTimestamps: true });
    const descriptor = fs.openSync(stagedPath, 'r');

    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    return;
  }

  fs.cpSync(sourcePath, stagedPath, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  fsyncTree(stagedPath);
}

/**
 * @param {string} ownerRoot
 * @param {string} targetPath
 * @returns {string}
 */
function readStablePathGeneration(ownerRoot, targetPath) {
  try {
    const first = withAnchoredParent(ownerRoot, targetPath, false, ({ anchoredPath }) =>
      readStableAnchoredGeneration(anchoredPath)
    );
    const second = withAnchoredParent(ownerRoot, targetPath, false, ({ anchoredPath }) =>
      readStableAnchoredGeneration(anchoredPath)
    );

    if (first !== second) {
      throw new Error(`Owned filesystem generation changed while being recorded: ${targetPath}`);
    }

    return first;
  } catch (error) {
    if (error instanceof MissingOwnedParentError) {
      return 'absent';
    }

    throw error;
  }
}

/**
 * @param {string} anchoredPath
 * @returns {string}
 */
function readStableAnchoredGeneration(anchoredPath) {
  if (!exists(anchoredPath)) return 'absent';
  const stats = fs.lstatSync(anchoredPath);
  const hash = createHash('sha256');
  hash.update(`${stats.mode & 0o7777}\0`);

  if (stats.isSymbolicLink()) {
    hash.update(fs.readlinkSync(anchoredPath));
    return `symlink:${hash.digest('hex')}`;
  }

  if (stats.isFile()) {
    hash.update(fs.readFileSync(anchoredPath));
    return `file:${hash.digest('hex')}`;
  }

  if (!stats.isDirectory()) {
    throw new Error(`Owned filesystem generation contains a special path: ${anchoredPath}`);
  }

  hashDirectoryGeneration(anchoredPath, hash);
  return `directory:${hash.digest('hex')}`;
}

/**
 * @param {string} directory
 * @param {import('node:crypto').Hash} hash
 * @returns {void}
 */
function hashDirectoryGeneration(directory, hash) {
  for (const entry of fs.readdirSync(directory).toSorted()) {
    const childPath = path.join(directory, entry);
    const stats = fs.lstatSync(childPath);
    hash.update(`${entry}\0${stats.mode & 0o7777}\0`);

    if (stats.isSymbolicLink()) {
      hash.update(`link\0${fs.readlinkSync(childPath)}\0`);
    } else if (stats.isFile()) {
      hash.update('file\0');
      hash.update(fs.readFileSync(childPath));
      hash.update('\0');
    } else if (stats.isDirectory()) {
      hash.update('directory\0');
      hashDirectoryGeneration(childPath, hash);
    } else {
      throw new Error(`Owned filesystem generation contains a special path: ${childPath}`);
    }
  }
}

/** @param {string} snapshotId */
function assertSnapshotId(snapshotId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(snapshotId)) {
    throw new Error('Owned filesystem snapshot requires a UUID identity');
  }
}

/**
 * @param {OwnedSnapshot} snapshot
 * @param {string} targetPath
 * @param {string} desiredGeneration
 * @returns {void}
 */
function recordSnapshotMutationIntent(snapshot, targetPath, desiredGeneration) {
  const resolvedTarget = path.resolve(targetPath);
  const entry = snapshot.entries.find(
    /** @param {{ targetPath: string }} candidate */ (candidate) =>
      candidate.targetPath === resolvedTarget
  );
  if (!entry || entry.disposable) return;
  entry.mutationGeneration = desiredGeneration;
  writeSnapshotManifest(snapshot);
}

/**
 * Intent and completed publication are distinct durable facts. A second write
 * may die after recording its intent while the previous owned generation is
 * still visible, so recovery must retain both until publication completes.
 * @param {OwnedSnapshot} snapshot
 * @param {string} targetPath
 * @param {string} generation
 * @returns {void}
 */
function recordSnapshotMutationCompletion(snapshot, targetPath, generation) {
  const entry = snapshot.entries.find(
    /** @param {{ targetPath: string }} candidate */ (candidate) =>
      candidate.targetPath === path.resolve(targetPath)
  );
  if (!entry || entry.disposable) return;
  entry.publishedGeneration = generation;
  writeSnapshotManifest(snapshot);
}

/** @param {OwnedSnapshot} snapshot @returns {OwnedMutationAuthority} */
function createSnapshotRecoveryAuthority(snapshot) {
  return createOwnedMutationAuthority(
    snapshot.ownerRoot,
    'Owned filesystem snapshot recovery',
    (targetPath) => {
      const target = path.resolve(targetPath);
      if (!snapshot.entries.some((entry) => entry.targetPath === target)) {
        throw new Error(
          `Owned filesystem snapshot recovery is outside its admitted scope: ${target}`
        );
      }
      return target;
    },
    {
      snapshotIdFor(targetPath) {
        return snapshot.entries.some(
          (entry) => !entry.disposable && entry.targetPath === targetPath
        )
          ? snapshot.snapshotId
          : undefined;
      },
    }
  );
}

/** @param {OwnedSnapshot} snapshot @returns {OwnedMutationAuthority} */
function createSnapshotMetadataAuthority(snapshot) {
  const manifestPath = path.join(snapshot.backupRoot, 'snapshot.json');
  return createOwnedMutationAuthority(
    snapshot.ownerRoot,
    'Owned filesystem snapshot metadata',
    (targetPath) => {
      const target = path.resolve(targetPath);
      if (target !== manifestPath) {
        throw new Error(
          `Owned filesystem snapshot metadata is outside its admitted scope: ${target}`
        );
      }
      return target;
    }
  );
}

/**
 * @param {OwnedSnapshot} snapshot
 * @returns {void}
 */
function writeSnapshotManifest(snapshot) {
  const manifestPath = path.join(snapshot.backupRoot, 'snapshot.json');
  const content = `${JSON.stringify(
    {
      version: 6,
      snapshotId: snapshot.snapshotId,
      recoveryId: snapshot.recoveryId,
      entries: snapshot.entries.map(
        ({
          backupPath,
          disposable,
          existed,
          mutationGeneration,
          publishedGeneration,
          originalGeneration,
          targetPath,
          type,
        }) => ({
          backupPath: path.relative(snapshot.backupRoot, backupPath),
          disposable,
          existed,
          mutationGeneration,
          publishedGeneration,
          originalGeneration,
          targetPath,
          ...(type !== undefined ? { type } : {}),
        })
      ),
      missingBackupParents: snapshot.missingBackupParents,
    },
    null,
    2
  )}\n`;

  publishRegularFileAtomically(
    createSnapshotMetadataAuthority(snapshot),
    manifestPath,
    (temporaryPath) => {
      const descriptor = fs.openSync(temporaryPath, 'wx', 0o600);

      try {
        fs.writeFileSync(descriptor, content, 'utf8');
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    },
    { followFinalSymlink: false, preserveTargetMode: true }
  );
}

/**
 * @param {string} generation
 * @returns {boolean}
 */
function isOwnedPathGeneration(generation) {
  return generation === 'absent' || /^(?:file|directory|symlink):[0-9a-f]{64}$/u.test(generation);
}

/**
 * @param {string} filePath
 * @param {unknown} value
 * @returns {void}
 */
function writeExclusiveJson(filePath, value) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);

  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      flush: true,
      mode: 0o600,
    });

    // Hard-link publication retains create-if-absent ownership without exposing
    // the record while it is being written.
    fs.linkSync(temporaryPath, filePath);
    fsyncDirectory(directory);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
    fsyncDirectory(directory);
  }
}

/**
 * @param {string} lockPath
 * @returns {{ stats: fs.Stats; owner?: { pid: number; token: string; ownerFileName: string; processIdentity: string } }}
 */
function readLockGeneration(lockPath) {
  const stats = fs.lstatSync(lockPath);

  if (!stats.isFile() || stats.isSymbolicLink()) {
    return { stats };
  }

  /** @type {any} */
  let candidate;
  try {
    candidate = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return { stats };
  }

  if (
    candidate !== null &&
    typeof candidate === 'object' &&
    !Array.isArray(candidate) &&
    Object.hasOwn(candidate, 'version') &&
    candidate.version !== 2
  ) {
    throw new Error('Token lock owner must use version 2');
  }

  if (
    candidate?.version !== 2 ||
    !Number.isSafeInteger(candidate.pid) ||
    candidate.pid <= 0 ||
    typeof candidate.token !== 'string' ||
    candidate.token.length === 0 ||
    candidate.ownerFileName !== `${path.basename(lockPath)}.owner-${candidate.token}.json` ||
    typeof candidate.processIdentity !== 'string' ||
    candidate.processIdentity.length === 0
  ) {
    return { stats };
  }

  return {
    stats,
    owner: {
      pid: candidate.pid,
      token: candidate.token,
      ownerFileName: candidate.ownerFileName,
      processIdentity: candidate.processIdentity,
    },
  };
}

/**
 * @param {string} lockPath
 * @param {{ stats: fs.Stats; owner?: { pid: number; token: string; ownerFileName: string; processIdentity: string } }} generation
 * @param {(() => void) | undefined} testBeforeReap
 * @returns {void}
 */
function reapLockGeneration(lockPath, generation, testBeforeReap) {
  const generationKey =
    generation.owner?.token ?? `${generation.stats.dev}-${generation.stats.ino}`;
  const reaperPath = `${lockPath}.reaper-${generationKey}`;
  const reaperToken = randomUUID();

  try {
    writeExclusiveJson(reaperPath, {
      ...createTokenLockOwner(
        `${path.basename(reaperPath)}.owner-${reaperToken}.json`,
        reaperToken
      ),
      generationKey,
    });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
      throw error;
    }

    const reaper = readLockGeneration(reaperPath);

    if (reaper.owner && isProcessAlive(reaper.owner)) {
      sleepSync(25);
      return;
    }

    if (Date.now() - reaper.stats.mtimeMs < DEFAULT_CORRUPT_LOCK_STALE_MS) {
      sleepSync(25);
      return;
    }

    fs.rmSync(reaperPath, { force: true });
    fsyncDirectory(path.dirname(lockPath));
    return;
  }

  try {
    testBeforeReap?.();
    const current = readLockGeneration(lockPath);
    const sameGeneration =
      current.stats.dev === generation.stats.dev &&
      current.stats.ino === generation.stats.ino &&
      current.owner?.token === generation.owner?.token;

    if (!sameGeneration) {
      return;
    }

    fs.rmSync(lockPath, { force: true, recursive: true });
    fsyncDirectory(path.dirname(lockPath));

    if (generation.owner) {
      const ownerPath = path.join(path.dirname(lockPath), generation.owner.ownerFileName);

      try {
        const ownerStats = fs.lstatSync(ownerPath);

        if (ownerStats.dev === generation.stats.dev && ownerStats.ino === generation.stats.ino) {
          fs.rmSync(ownerPath, { force: true });
        }
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
          throw error;
        }
      }
    }
  } finally {
    fs.rmSync(reaperPath, { force: true });
    fsyncDirectory(path.dirname(lockPath));
  }
}

/**
 * @param {string} lockPath
 * @param {string} ownerPath
 * @param {string} token
 * @returns {void}
 */
function releaseOwnedLock(lockPath, ownerPath, token) {
  const generation = readLockGeneration(lockPath);
  const ownerStats = fs.lstatSync(ownerPath);

  if (
    generation.owner?.token !== token ||
    generation.stats.dev !== ownerStats.dev ||
    generation.stats.ino !== ownerStats.ino
  ) {
    throw new Error(`Lock ${lockPath} ownership changed before release`);
  }

  fs.rmSync(lockPath, { force: true });
  fsyncDirectory(path.dirname(lockPath));
  fs.rmSync(ownerPath, { force: true });
  fsyncDirectory(path.dirname(lockPath));
}

/**
 * @param {{ pid: number; processIdentity: string }} owner
 * @returns {boolean}
 */
function isProcessAlive(owner) {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EPERM') return false;
  }

  const currentIdentity = readLinuxProcessIdentity(owner.pid);
  return currentIdentity === undefined || currentIdentity === owner.processIdentity;
}

/**
 * @param {string} ownerFileName
 * @param {string} token
 * @returns {{ version: 2; pid: number; token: string; ownerFileName: string; createdAtMs: number; processIdentity: string }}
 */
function createTokenLockOwner(ownerFileName, token) {
  const processIdentity = readLinuxProcessIdentity(process.pid);

  if (processIdentity === undefined) {
    throw new Error('Cannot determine current process identity for token lock');
  }

  return {
    version: 2,
    pid: process.pid,
    token,
    ownerFileName,
    createdAtMs: Date.now(),
    processIdentity,
  };
}

/**
 * @param {number} pid
 * @returns {string | undefined}
 */
function readLinuxProcessIdentity(pid) {
  if (process.platform !== 'linux') return undefined;

  try {
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd === -1) return undefined;
    const startTime = stat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/u)[19];

    return bootId && startTime ? `${bootId}:${startTime}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {number} milliseconds
 * @returns {void}
 */
function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * @param {string} directory
 * @returns {void}
 */
export function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');

  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * @param {string} root
 * @returns {void}
 */
function fsyncTree(root) {
  const stats = fs.lstatSync(root);

  if (stats.isSymbolicLink()) {
    return;
  }

  if (stats.isFile()) {
    const descriptor = fs.openSync(root, 'r');

    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }

    return;
  }

  for (const entry of fs.readdirSync(root)) {
    fsyncTree(path.join(root, entry));
  }

  fsyncDirectory(root);
}
