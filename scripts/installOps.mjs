// @ts-check

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** @type {Map<string, { state: 'held'; depth: number; token: string } | { state: 'release-failed'; token: string }>} */
const heldTokenLocks = new Map();
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_CORRUPT_LOCK_STALE_MS = 2_000;
const activeOwnedSnapshots = new Set();
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
  requireOwnedMutationOptions(options);
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
    removeOwnedEmptyDirectoriesRaw(ownerRoot, missingParents);
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

        if (reclaimable) {
          reapLockGeneration(lockPath, generation, options.testBeforeReap);
          continue;
        }

        if (Date.now() >= deadline) {
          const ownerLabel = generation.owner
            ? `live process ${generation.owner.pid}`
            : 'a not-yet-stale corrupt owner';
          throw new Error(`Lock ${lockPath} is held by ${ownerLabel}`);
        }

        sleepSync(25);
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
 * @param {ManagedPathMode} mode
 * @param {string} sourcePath
 * @param {string} targetPath
 * @param {{ ownerRoot: string }} options
 * @returns {void}
 */
export function installManagedPathRaw(mode, sourcePath, targetPath, options) {
  requireOwnedMutationOptions(options);

  if (
    fs.lstatSync(sourcePath).isDirectory() ||
    (exists(targetPath) && fs.lstatSync(targetPath).isDirectory())
  ) {
    assertAtomicDirectoryExchangeAvailable();
  }

  withAnchoredParent(options.ownerRoot, targetPath, true, (parent) => {
    publishStagedPathAtomically(parent, targetPath, (temporaryPath) => {
      if (mode === 'link') {
        fs.symlinkSync(path.resolve(sourcePath), temporaryPath);
        return;
      }

      copyPathToStaging(sourcePath, temporaryPath);
    });
  });
}

/**
 * @param {string} filePath
 * @param {string} content
 * @param {{ ownerRoot: string; finalNewline?: boolean; followFinalSymlink?: boolean }} options
 * @returns {void}
 */
export function writeTextFileRaw(filePath, content, options) {
  requireOwnedMutationOptions(options);
  const finalContent =
    options.finalNewline === true && !content.endsWith('\n') ? `${content}\n` : content;

  publishRegularFileAtomically(
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
    {
      followFinalSymlink: options.followFinalSymlink !== false,
      ownerRoot: options.ownerRoot,
      preserveTargetMode: true,
    }
  );
}

/**
 * @param {string} filePath
 * @param {Buffer} content
 * @param {{ ownerRoot: string }} options
 * @returns {void}
 */
export function writeBinaryFileRaw(filePath, content, options) {
  requireOwnedMutationOptions(options);
  publishRegularFileAtomically(
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
    { followFinalSymlink: true, ownerRoot: options.ownerRoot, preserveTargetMode: true }
  );
}

/**
 * Write an unpublished recovery candidate directly at its fixed path. The
 * candidate is not semantic state: callers must atomically publish it to the
 * authoritative journal, and recovery may always delete an unpublished
 * candidate. A hard crash therefore leaves one bounded, owner-known artifact
 * instead of an unscannable UUID temporary.
 *
 * @param {string} ownerRoot
 * @param {string} candidatePath
 * @param {string} content
 * @returns {void}
 */
export function writeOwnedRecoveryCandidateRaw(ownerRoot, candidatePath, content) {
  withAnchoredParent(ownerRoot, candidatePath, true, ({ anchoredPath, descriptor }) => {
    if (exists(anchoredPath)) {
      removePathIfReachable(anchoredPath);
    }

    const candidateDescriptor = fs.openSync(
      anchoredPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600
    );

    try {
      fs.writeFileSync(candidateDescriptor, content, 'utf8');
      fs.fsyncSync(candidateDescriptor);
    } finally {
      fs.closeSync(candidateDescriptor);
    }

    fsyncDirectoryDescriptor(descriptor);
  });
}

/**
 * Remove one owned path without re-resolving its admitted parent namespace.
 *
 * @param {string} ownerRoot
 * @param {string} targetPath
 * @returns {void}
 */
export function removeOwnedPathRaw(ownerRoot, targetPath) {
  recordOwnedMutationIntent(targetPath, 'absent');

  try {
    withAnchoredParent(ownerRoot, targetPath, false, (parent) => {
      removePathIfReachable(parent.anchoredPath);
      fsyncDirectoryDescriptor(parent.descriptor);
    });
  } catch (error) {
    if (error instanceof MissingOwnedParentError) return;
    throw error;
  }
}

/**
 * Atomically publish an already staged owned path. Source and destination are
 * resolved relative to held directory descriptors, so a parent rename cannot
 * redirect publication outside the owner.
 *
 * @param {string} ownerRoot
 * @param {string} stagedPath
 * @param {string} targetPath
 * @returns {void}
 */
export function publishStagedOwnedPathRaw(ownerRoot, stagedPath, targetPath) {
  withAnchoredParent(ownerRoot, stagedPath, false, (sourceParent) => {
    withAnchoredParent(ownerRoot, targetPath, true, (targetParent) => {
      const stagedGeneration = readStableAnchoredGeneration(sourceParent.anchoredPath);
      recordOwnedMutationIntent(targetPath, stagedGeneration);
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
      recordOwnedMutationIntent(stagedPath, 'absent');
      fsyncDirectoryDescriptor(sourceParent.descriptor);

      if (sourceParent.descriptor !== targetParent.descriptor) {
        fsyncDirectoryDescriptor(targetParent.descriptor);
      }
    });
  });
}

/**
 * Record the current complete generation for a containing transaction target.
 * This is reserved for directory construction whose individual children are
 * not themselves transaction leaves.
 *
 * @param {string} ownerRoot
 * @param {string} targetPath
 * @returns {void}
 */
export function recordOwnedPathGeneration(ownerRoot, targetPath) {
  recordOwnedMutationIntent(targetPath, readStablePathGeneration(ownerRoot, targetPath));
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
 * Snapshot a set of owned paths, including their absence, before mutation.
 * The returned receipt is the only authority for restoring that snapshot.
 *
 * @param {string[]} targetPaths
 * @param {string} backupRoot
 * @param {{ ownerRoot: string; snapshotId?: string }} options
 * @returns {{ backupRoot: string; snapshotId: string; targetPaths: string[]; discard: () => void; rollback: () => void; seal: () => void }}
 */
export function snapshotOwnedPaths(targetPaths, backupRoot, options) {
  requireOwnedMutationOptions(options);
  const ownerRoot = resolvePathIdentity(options.ownerRoot);
  const uniquePaths = [...new Set(targetPaths.map((targetPath) => path.resolve(targetPath)))];
  admitOwnedPaths(ownerRoot, uniquePaths, 'Owned filesystem snapshot');
  const snapshotId = options.snapshotId ?? randomUUID();
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
      existed,
      mutationGeneration: originalGeneration,
      originalGeneration,
      targetPath,
      type,
    };
  });

  if (entries.some(({ type }) => type === 'directory')) {
    assertAtomicDirectoryExchangeAvailable();
  }

  const snapshotState = {
    backupRoot: path.resolve(backupRoot),
    entries,
    missingBackupParents,
    ownerRoot,
    snapshotId,
  };
  let closed = false;

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
      removeOwnedPathRaw(ownerRoot, backupRoot);
      removeOwnedEmptyDirectoriesRaw(ownerRoot, missingBackupParents);
    } catch {
      // The snapshot error remains the useful failure when cleanup is impossible.
    }

    throw error;
  }

  activeOwnedSnapshots.add(snapshotState);

  return {
    backupRoot,
    snapshotId,
    targetPaths: uniquePaths,
    seal() {
      activeOwnedSnapshots.delete(snapshotState);
    },
    discard() {
      activeOwnedSnapshots.delete(snapshotState);
      removeOwnedPathRaw(ownerRoot, backupRoot);
      removeOwnedEmptyDirectoriesRaw(ownerRoot, missingBackupParents);

      syncPathsDurably([path.dirname(backupRoot)]);
      closed = true;
    },
    rollback() {
      if (closed) {
        return;
      }

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

      // Descendants are restored first so an ancestor snapshot is the final authority.
      for (const entry of entries.toSorted(
        (left, right) => right.targetPath.length - left.targetPath.length
      )) {
        try {
          restoreSnapshotEntry(entry, ownerRoot);
        } catch (error) {
          failures.push(error);
        }
      }

      if (failures.length > 0) {
        throw new AggregateError(failures, 'Could not restore the owned filesystem snapshot');
      }

      syncPathsDurably(entries.map(({ targetPath }) => targetPath));
      activeOwnedSnapshots.delete(snapshotState);
      removeOwnedPathRaw(ownerRoot, backupRoot);
      removeOwnedEmptyDirectoriesRaw(ownerRoot, missingBackupParents);
      syncPathsDurably([path.dirname(backupRoot)]);

      closed = true;
    },
  };
}

/**
 * Restore a persisted snapshot without deleting its backup. Retaining the
 * backup makes recovery repeatable until the transaction owner durably records
 * that rollback completed.
 *
 * @param {string} requestedBackupRoot
 * @param {{ allowedRoots: string[]; expectedTargetPaths: string[]; snapshotId: string }} options
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
  /** @type {unknown[]} */
  const failures = [];

  for (const entry of manifest.entries.toSorted(
    (left, right) => right.targetPath.length - left.targetPath.length
  )) {
    try {
      const targetOwner = options.allowedRoots
        .map(resolvePathIdentity)
        .find((root) => isSameOrDescendant(root, entry.targetPath));

      if (!targetOwner) {
        throw new Error(`Owned filesystem snapshot has no owner for ${entry.targetPath}`);
      }

      restoreSnapshotEntry(entry, targetOwner);
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
 * @param {{ allowedRoots: string[]; expectedTargetPaths: string[]; snapshotId: string }} options
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

  removeOwnedPathRaw(ownerRoot, backupRoot);
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
 * @param {{ allowedRoots: string[]; expectedTargetPaths: string[]; snapshotId: string }} options
 * @returns {{ entries: Array<{ targetPath: string; backupPath: string; existed: boolean; type?: 'file' | 'directory' | 'symlink'; originalGeneration: string; mutationGeneration: string }>; missingBackupParents: string[] }}
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
    /** @type {{ version?: unknown; snapshotId?: unknown; entries?: unknown; missingOwnedParents?: unknown; missingBackupParents?: unknown }} */ (
      JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    );

  if (candidate?.version !== 5) {
    throw new Error('Owned filesystem snapshot manifest must use version 5');
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
      /** @type {{ targetPath?: unknown; backupPath?: unknown; existed?: unknown; type?: unknown; originalGeneration?: unknown; mutationGeneration?: unknown }} */ (
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

    return {
      targetPath,
      backupPath,
      existed: entry.existed,
      originalGeneration: entry.originalGeneration,
      mutationGeneration: entry.mutationGeneration,
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
    entries,
    missingBackupParents: validateBackupParents(candidate.missingBackupParents),
  };
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
 * @param {string} ownerRoot
 * @param {string[]} directories
 * @returns {void}
 */
export function removeOwnedEmptyDirectoriesRaw(ownerRoot, directories) {
  const physicalOwnerRoot = resolvePathIdentity(ownerRoot);

  for (const directory of [...new Set(directories)].toSorted(
    (left, right) => right.length - left.length
  )) {
    if (path.resolve(directory) === physicalOwnerRoot) {
      continue;
    }

    try {
      withAnchoredParent(ownerRoot, directory, false, ({ anchoredPath, descriptor }) => {
        fs.rmdirSync(anchoredPath);
        fsyncDirectoryDescriptor(descriptor);
      });
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
 * @param {{ targetPath: string; backupPath: string; existed: boolean; type?: 'file' | 'directory' | 'symlink'; originalGeneration: string; mutationGeneration: string }} entry
 * @param {string} ownerRoot
 * @returns {void}
 */
function restoreSnapshotEntry(entry, ownerRoot) {
  const currentGeneration = readStablePathGeneration(ownerRoot, entry.targetPath);

  if (currentGeneration === entry.originalGeneration) {
    return;
  }

  if (currentGeneration !== entry.mutationGeneration) {
    throw new Error(`Owned filesystem snapshot found external drift at ${entry.targetPath}`);
  }

  if (!entry.existed) {
    removeOwnedPathRaw(ownerRoot, entry.targetPath);
    return;
  }

  withAnchoredParent(ownerRoot, entry.targetPath, true, (parent) => {
    publishStagedPathAtomically(
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
      false
    );
  });

  const restoredGeneration = readStablePathGeneration(ownerRoot, entry.targetPath);

  if (restoredGeneration !== entry.originalGeneration) {
    throw new Error(`Owned filesystem snapshot could not verify restore for ${entry.targetPath}`);
  }
}

/**
 * Publish a complete regular file with the filesystem's atomic rename
 * primitive. The temporary file lives beside the destination so replacement
 * cannot cross filesystems.
 *
 * @param {string} requestedPath
 * @param {(temporaryPath: string, mode: number | undefined) => void} populate
 * @param {{ ownerRoot: string; followFinalSymlink?: boolean; preserveTargetMode?: boolean }} options
 * @returns {void}
 */
function publishRegularFileAtomically(requestedPath, populate, options) {
  requireOwnedMutationOptions(options);
  const filePath = path.resolve(requestedPath);
  const publishPath = options.followFinalSymlink
    ? resolveFinalSymlinkTarget(filePath, options.ownerRoot)
    : filePath;

  withAnchoredParent(options.ownerRoot, publishPath, true, (parent) => {
    const targetStats = exists(parent.anchoredPath) ? fs.lstatSync(parent.anchoredPath) : undefined;
    const mode =
      options.preserveTargetMode && targetStats?.isFile() ? targetStats.mode & 0o7777 : undefined;

    publishStagedPathAtomically(parent, publishPath, (temporaryPath) => {
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
function requireOwnedMutationOptions(options) {
  if (!options || typeof options.ownerRoot !== 'string' || options.ownerRoot.length === 0) {
    throw new Error('Owned filesystem mutation requires an explicit owner root');
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
 * @param {{ descriptor: number; anchoredPath: string; leafName: string }} parent
 * @param {string} targetPath
 * @param {(temporaryPath: string) => void} populate
 * @param {boolean} [recordMutation]
 * @returns {void}
 */
function publishStagedPathAtomically(parent, targetPath, populate, recordMutation = true) {
  const temporaryLeaf = `.${parent.leafName}.${randomUUID()}.tmp`;
  const temporaryPath = `/proc/self/fd/${parent.descriptor}/${temporaryLeaf}`;

  try {
    populate(temporaryPath);
    const desiredGeneration = readStableAnchoredGeneration(temporaryPath);

    if (recordMutation) {
      recordOwnedMutationIntent(targetPath, desiredGeneration);
    }

    if (exists(parent.anchoredPath) && pathNeedsExchange(temporaryPath, parent.anchoredPath)) {
      exchangeAnchoredPaths(parent.descriptor, temporaryLeaf, parent.leafName);
      removePathIfReachable(temporaryPath);
    } else {
      fs.renameSync(temporaryPath, parent.anchoredPath);
    }

    fsyncDirectoryDescriptor(parent.descriptor);
  } finally {
    if (exists(temporaryPath)) {
      removePathIfReachable(temporaryPath);
      fsyncDirectoryDescriptor(parent.descriptor);
    }
  }
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

/**
 * @param {string} targetPath
 * @param {string} desiredGeneration
 * @returns {void}
 */
function recordOwnedMutationIntent(targetPath, desiredGeneration) {
  const resolvedTarget = path.resolve(targetPath);

  for (const snapshot of activeOwnedSnapshots) {
    const entry = snapshot.entries.find(
      /** @param {{ targetPath: string }} candidate */ (candidate) =>
        candidate.targetPath === resolvedTarget
    );

    if (!entry) continue;
    entry.mutationGeneration = desiredGeneration;
    writeSnapshotManifest(snapshot);
  }
}

/**
 * @param {{ backupRoot: string; entries: Array<{ backupPath: string; existed: boolean; mutationGeneration: string; originalGeneration: string; targetPath: string; type?: 'file' | 'directory' | 'symlink' }>; missingBackupParents: string[]; ownerRoot: string; snapshotId: string }} snapshot
 * @returns {void}
 */
function writeSnapshotManifest(snapshot) {
  const manifestPath = path.join(snapshot.backupRoot, 'snapshot.json');
  const content = `${JSON.stringify(
    {
      version: 5,
      snapshotId: snapshot.snapshotId,
      entries: snapshot.entries.map(
        ({ backupPath, existed, mutationGeneration, originalGeneration, targetPath, type }) => ({
          backupPath: path.relative(snapshot.backupRoot, backupPath),
          existed,
          mutationGeneration,
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
    {
      followFinalSymlink: false,
      ownerRoot: snapshot.ownerRoot,
      preserveTargetMode: true,
    }
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
    const descriptor = fs.openSync(temporaryPath, 'wx', 0o600);

    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }

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
function fsyncDirectory(directory) {
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
