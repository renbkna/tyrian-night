// @ts-check

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const heldTokenLocks = new Map();
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_CORRUPT_LOCK_STALE_MS = 2_000;

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
 * @param {{ timeoutMs?: number; corruptStaleMs?: number; testBeforeReap?: (() => void); testBeforeRelease?: (() => void) }} [options]
 * @returns {T}
 */
export function withTokenFileLock(requestedLockPath, action, options = {}) {
  const requestedAbsolutePath = path.resolve(requestedLockPath);
  const lockPath = path.join(
    resolvePathIdentity(path.dirname(requestedAbsolutePath)),
    path.basename(requestedAbsolutePath)
  );
  const heldLock = heldTokenLocks.get(lockPath);

  if (heldLock) {
    heldLock.depth += 1;

    try {
      return action();
    } finally {
      heldLock.depth -= 1;
    }
  }

  const missingParents = collectMissingParentDirectories([lockPath]);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
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

    heldTokenLocks.set(lockPath, { depth: 1, token });
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
      heldTokenLocks.delete(lockPath);
      removeEmptyDirectories(missingParents);
    } catch (error) {
      releaseFailure = error;

      try {
        if (readLockGeneration(lockPath).owner?.token === token) {
          heldTokenLocks.set(lockPath, { depth: 0, token });
        } else {
          heldTokenLocks.delete(lockPath);

          try {
            fs.rmSync(ownerPath, { force: true });
          } catch {
            // The release warning below remains the observable failure.
          }
        }
      } catch {
        heldTokenLocks.delete(lockPath);

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
        removeEmptyDirectories(missingParents);
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
 * @returns {void}
 */
export function installManagedPathRaw(mode, sourcePath, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.rmSync(targetPath, { recursive: true, force: true });

  if (mode === 'link') {
    fs.symlinkSync(path.resolve(sourcePath), targetPath);
    return;
  }

  copyPath(sourcePath, targetPath);
}

/**
 * @param {string} filePath
 * @param {string} content
 * @param {{ finalNewline?: boolean }} [options]
 * @returns {void}
 */
export function writeTextFileRaw(filePath, content, options = {}) {
  const finalContent =
    options.finalNewline === true && !content.endsWith('\n') ? `${content}\n` : content;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, finalContent, 'utf8');
}

/**
 * @param {string} filePath
 * @param {Buffer} content
 * @returns {void}
 */
export function writeBinaryFileRaw(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
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
 * @returns {{ backupRoot: string; snapshotId: string; targetPaths: string[]; discard: () => void; rollback: () => void }}
 */
export function snapshotOwnedPaths(targetPaths, backupRoot) {
  const uniquePaths = [...new Set(targetPaths.map((targetPath) => path.resolve(targetPath)))];
  const snapshotId = randomUUID();
  const missingOwnedParents = collectMissingParentDirectories(uniquePaths);
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

    return {
      backupPath: path.join(backupRoot, 'snapshot', String(index)),
      existed,
      targetPath,
      type,
    };
  });
  let closed = false;

  try {
    fs.mkdirSync(path.dirname(backupRoot), { recursive: true });
    fs.mkdirSync(backupRoot);

    for (const entry of entries) {
      if (!entry.existed) {
        continue;
      }

      fs.mkdirSync(path.dirname(entry.backupPath), { recursive: true });
      copyPath(entry.targetPath, entry.backupPath);
    }

    writeTextFileRaw(
      path.join(backupRoot, 'snapshot.json'),
      `${JSON.stringify(
        {
          version: 3,
          snapshotId,
          entries: entries.map(({ backupPath, existed: pathExisted, targetPath, type }) => ({
            backupPath: path.relative(backupRoot, backupPath),
            existed: pathExisted,
            targetPath,
            ...(type !== undefined ? { type } : {}),
          })),
          missingOwnedParents,
          missingBackupParents,
        },
        null,
        2
      )}\n`
    );
    syncPathsDurably([backupRoot, path.dirname(backupRoot)]);
  } catch (error) {
    try {
      fs.rmSync(backupRoot, { force: true, recursive: true });

      for (const missingParent of missingBackupParents) {
        try {
          fs.rmdirSync(missingParent);
        } catch {
          break;
        }
      }
    } catch {
      // The snapshot error remains the useful failure when cleanup is impossible.
    }

    throw error;
  }

  return {
    backupRoot,
    snapshotId,
    targetPaths: uniquePaths,
    discard() {
      fs.rmSync(backupRoot, { force: true, recursive: true });

      for (const missingParent of missingBackupParents) {
        try {
          fs.rmdirSync(missingParent);
        } catch {
          break;
        }
      }

      syncPathsDurably([path.dirname(backupRoot)]);
      closed = true;
    },
    rollback() {
      if (closed) {
        return;
      }

      /** @type {unknown[]} */
      const failures = [];

      // Descendants are restored first so an ancestor snapshot is the final authority.
      for (const entry of entries.toSorted(
        (left, right) => right.targetPath.length - left.targetPath.length
      )) {
        try {
          removePathIfReachable(entry.targetPath);

          if (entry.existed) {
            fs.mkdirSync(path.dirname(entry.targetPath), { recursive: true });
            copyPath(entry.backupPath, entry.targetPath);
          }
        } catch (error) {
          failures.push(error);
        }
      }

      if (failures.length > 0) {
        throw new AggregateError(failures, 'Could not restore the owned filesystem snapshot');
      }

      try {
        removeEmptyDirectories(missingOwnedParents);
        syncPathsDurably(entries.map(({ targetPath }) => targetPath));
        fs.rmSync(backupRoot, { force: true, recursive: true });
        removeEmptyDirectories(missingBackupParents);
        syncPathsDurably([path.dirname(backupRoot)]);
      } catch (error) {
        throw new AggregateError(
          [error],
          'Owned paths were restored but their initially absent parent directories were not'
        );
      }

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
  /** @type {unknown[]} */
  const failures = [];

  for (const entry of manifest.entries.toSorted(
    (left, right) => right.targetPath.length - left.targetPath.length
  )) {
    try {
      removePathIfReachable(entry.targetPath);

      if (entry.existed) {
        fs.mkdirSync(path.dirname(entry.targetPath), { recursive: true });
        copyPath(entry.backupPath, entry.targetPath);
      }
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
  fs.rmSync(backupRoot, { force: true, recursive: true });
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
 * @returns {{ entries: Array<{ targetPath: string; backupPath: string; existed: boolean; type?: 'file' | 'directory' | 'symlink' }>; missingOwnedParents: string[]; missingBackupParents: string[] }}
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

  if (
    candidate?.version !== 3 ||
    candidate.snapshotId !== options.snapshotId ||
    !Array.isArray(candidate.entries) ||
    candidate.entries.length !== expectedTargetPaths.length ||
    !Array.isArray(candidate.missingOwnedParents) ||
    !Array.isArray(candidate.missingBackupParents)
  ) {
    throw new Error('Owned filesystem snapshot manifest is corrupt');
  }

  const seenTargets = new Set();
  const seenBackups = new Set();
  const entries = candidate.entries.map((entryCandidate, index) => {
    const entry =
      /** @type {{ targetPath?: unknown; backupPath?: unknown; existed?: unknown; type?: unknown }} */ (
        entryCandidate
      );
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.targetPath !== 'string' ||
      typeof entry.backupPath !== 'string' ||
      typeof entry.existed !== 'boolean' ||
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
    } else if (exists(backupPath)) {
      throw new Error(`Owned filesystem snapshot contains an unexpected backup for ${targetPath}`);
    }

    return {
      targetPath,
      backupPath,
      existed: entry.existed,
      ...(entry.type !== undefined
        ? { type: /** @type {'file' | 'directory' | 'symlink'} */ (entry.type) }
        : {}),
    };
  });
  /**
   * @param {unknown[]} parents
   * @returns {string[]}
   */
  const validateParents = (parents) =>
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
    missingOwnedParents: validateParents(candidate.missingOwnedParents),
    missingBackupParents: validateParents(candidate.missingBackupParents),
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
 * Remove only directories that are still empty. A non-empty directory contains
 * state not owned by this snapshot and is deliberately retained.
 *
 * @param {string[]} directories
 * @returns {void}
 */
function removeEmptyDirectories(directories) {
  for (const directory of [...new Set(directories)].toSorted(
    (left, right) => right.length - left.length
  )) {
    try {
      fs.rmdirSync(directory);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTEMPTY' || error.code === 'EEXIST')
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
 * @param {string} filePath
 * @param {unknown} value
 * @returns {void}
 */
function writeExclusiveJson(filePath, value) {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);

  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }

  fsyncDirectory(path.dirname(filePath));
}

/**
 * @param {string} lockPath
 * @returns {{ stats: fs.Stats; owner?: { pid: number; token: string; ownerFileName: string; processIdentity?: string } }}
 */
function readLockGeneration(lockPath) {
  const stats = fs.lstatSync(lockPath);

  if (!stats.isFile() || stats.isSymbolicLink()) {
    return { stats };
  }

  try {
    const candidate = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

    if (
      (candidate?.version !== 1 && candidate?.version !== 2) ||
      !Number.isSafeInteger(candidate.pid) ||
      candidate.pid <= 0 ||
      typeof candidate.token !== 'string' ||
      candidate.token.length === 0 ||
      candidate.ownerFileName !== `${path.basename(lockPath)}.owner-${candidate.token}.json` ||
      (candidate.version === 2 &&
        (typeof candidate.processIdentity !== 'string' || candidate.processIdentity.length === 0))
    ) {
      return { stats };
    }

    return {
      stats,
      owner: {
        pid: candidate.pid,
        token: candidate.token,
        ownerFileName: candidate.ownerFileName,
        ...(candidate.version === 2 ? { processIdentity: candidate.processIdentity } : {}),
      },
    };
  } catch {
    return { stats };
  }
}

/**
 * @param {string} lockPath
 * @param {{ stats: fs.Stats; owner?: { pid: number; token: string; ownerFileName: string; processIdentity?: string } }} generation
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
 * @param {{ pid: number; processIdentity?: string }} owner
 * @returns {boolean}
 */
function isProcessAlive(owner) {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EPERM') return false;
  }

  if (owner.processIdentity === undefined) return true;
  const currentIdentity = readLinuxProcessIdentity(owner.pid);
  return currentIdentity === undefined || currentIdentity === owner.processIdentity;
}

/**
 * @param {string} ownerFileName
 * @param {string} token
 * @returns {{ version: 1 | 2; pid: number; token: string; ownerFileName: string; createdAtMs: number; processIdentity?: string }}
 */
function createTokenLockOwner(ownerFileName, token) {
  const processIdentity = readLinuxProcessIdentity(process.pid);

  return {
    version: processIdentity === undefined ? 1 : 2,
    pid: process.pid,
    token,
    ownerFileName,
    createdAtMs: Date.now(),
    ...(processIdentity !== undefined ? { processIdentity } : {}),
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

/**
 * @param {string} sourcePath
 * @param {string} targetPath
 * @returns {void}
 */
function copyPath(sourcePath, targetPath) {
  fs.cpSync(sourcePath, targetPath, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}
