// @ts-check

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { buildTyrianBackupRoot, TYRIAN_BACKUP_HOME, TYRIAN_STATE_HOME } from './installPaths.mjs';

/**
 * @typedef {'copy' | 'link'} ManagedPathMode
 * @typedef {{ target: string; existed: boolean }} BackupEntry
 * @typedef {{ owner: string; createdAt: string; entries: BackupEntry[]; details?: unknown }} BackupManifest
 */

const BACKUP_MANIFEST_NAME = 'manifest.json';
const TEMPORARY_NAME_PATTERN = /^\..+\.tyrian-[0-9a-f-]{36}\.tmp$/u;
const LOCK_HELD_ENV = 'TYRIAN_DESKTOP_LOCK_HELD';
const LOCK_WAIT_SECONDS = 60;
const LOCK_CONFLICT_EXIT_CODE = 75;

/** @type {boolean | undefined} */
let atomicExchangeSupport;

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
 * @param {string} ancestor
 * @param {string} candidate
 * @returns {boolean}
 */
export function isSameOrDescendant(ancestor, candidate) {
  const relativePath = path.relative(ancestor, candidate);

  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

/**
 * Resolve aliases through the deepest existing ancestor while retaining a
 * missing suffix, so overlap checks compare physical locations.
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
 * Admit exact mutation leaves under one physical owner root. Existing
 * ancestors must be ordinary directories.
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
 * Admit paths that will own descendants: existing leaves must be ordinary
 * directories.
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
 * Whether GNU mv can atomically exchange two paths, which directory
 * replacement requires.
 *
 * @returns {boolean}
 */
export function readAtomicExchangeSupport() {
  if (atomicExchangeSupport === undefined) {
    const help = spawnSync('mv', ['--help'], { encoding: 'utf8' });
    const usage = String(help.stdout);
    atomicExchangeSupport =
      help.status === 0 &&
      usage.includes('--exchange') &&
      usage.includes('--no-copy') &&
      usage.includes('--no-target-directory');
  }
  return atomicExchangeSupport;
}

/** @returns {void} */
export function assertAtomicDirectoryExchangeAvailable() {
  if (!readAtomicExchangeSupport()) {
    throw new Error('Atomic directory publication is unsupported: mv --exchange is unavailable');
  }
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

/**
 * @param {string} targetPath
 * @returns {string}
 */
function temporaryPathBeside(targetPath) {
  return path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.tyrian-${randomUUID()}.tmp`
  );
}

/**
 * Replace `targetPath` with the complete staged path. Files and links move
 * with one rename; directories are exchanged so the target is never absent.
 *
 * @param {string} stagedPath
 * @param {string} targetPath
 * @returns {void}
 */
export function publishStaged(stagedPath, targetPath) {
  const needsExchange =
    fs.lstatSync(stagedPath).isDirectory() ||
    (exists(targetPath) && fs.lstatSync(targetPath).isDirectory());

  if (needsExchange && exists(targetPath)) {
    assertAtomicDirectoryExchangeAvailable();
    const result = spawnSync(
      'mv',
      ['--exchange', '--no-copy', '--no-target-directory', stagedPath, targetPath],
      { encoding: 'utf8' }
    );
    if (result.status !== 0) {
      const detail = result.error?.message ?? String(result.stderr).trim();
      throw new Error(`Atomic directory publication failed: ${detail || 'mv exited nonzero'}`);
    }
    fs.rmSync(stagedPath, { recursive: true, force: true });
  } else {
    fs.renameSync(stagedPath, targetPath);
  }

  fsyncDirectory(path.dirname(targetPath));
}

/**
 * Create a directory and any missing ancestors so that each new entry is
 * durable in its parent before anything is published inside it.
 *
 * @param {string} directory
 * @returns {void}
 */
function makeDirectoryDurably(directory) {
  /** @type {string[]} */
  const missing = [];
  let current = path.resolve(directory);

  while (!exists(current)) {
    missing.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const created of missing) {
    fs.mkdirSync(created);
    fsyncDirectory(path.dirname(created));
  }
}

/**
 * Stage beside the target, populate, then publish atomically. A failure
 * removes the stage and leaves the previous target intact.
 *
 * @param {string} targetPath
 * @param {(stagedPath: string) => void} populate
 * @returns {void}
 */
function publishAtomically(targetPath, populate) {
  makeDirectoryDurably(path.dirname(targetPath));
  const stagedPath = temporaryPathBeside(targetPath);

  try {
    populate(stagedPath);
    publishStaged(stagedPath, targetPath);
  } finally {
    fs.rmSync(stagedPath, { recursive: true, force: true });
  }
}

/**
 * Atomically replace a file (a final symbolic link is replaced, not followed).
 * An existing regular file keeps its mode.
 *
 * @param {string} filePath
 * @param {string | Buffer} content
 * @returns {void}
 */
export function writeFileAtomic(filePath, content) {
  const existing = exists(filePath) ? fs.lstatSync(filePath) : undefined;
  const mode = existing?.isFile() ? existing.mode & 0o7777 : undefined;

  publishAtomically(filePath, (stagedPath) => {
    const descriptor = fs.openSync(stagedPath, 'wx', mode);

    try {
      if (mode !== undefined) fs.fchmodSync(descriptor, mode);
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  });
}

/**
 * Copy a file, directory tree, or symbolic link verbatim.
 *
 * @param {string} sourcePath
 * @param {string} destinationPath
 * @returns {void}
 */
function copyPathVerbatim(sourcePath, destinationPath) {
  const stats = fs.lstatSync(sourcePath);

  if (stats.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(sourcePath), destinationPath);
    return;
  }

  fs.cpSync(sourcePath, destinationPath, {
    recursive: stats.isDirectory(),
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  fsyncTree(destinationPath);
}

/**
 * Publish a copy of, or an absolute symbolic link to, `sourcePath`.
 *
 * @param {ManagedPathMode} mode
 * @param {string} sourcePath
 * @param {string} targetPath
 * @returns {void}
 */
export function installPath(mode, sourcePath, targetPath) {
  publishAtomically(targetPath, (stagedPath) => {
    if (mode === 'link') {
      fs.symlinkSync(path.resolve(sourcePath), stagedPath);
    } else {
      copyPathVerbatim(sourcePath, stagedPath);
    }
  });
}

/**
 * Remove a file, link, or directory tree; an absent path is not an error.
 *
 * @param {string} targetPath
 * @returns {void}
 */
export function removePath(targetPath) {
  if (!exists(targetPath)) return;
  fs.rmSync(targetPath, { recursive: true, force: true });
  fsyncDirectory(path.dirname(targetPath));
}

/**
 * Delete temporaries a crashed writer left beside these targets. Callers hold
 * the desktop lock, so no live writer owns them.
 *
 * @param {string[]} targetPaths
 * @returns {void}
 */
export function removeStaleTemporaries(targetPaths) {
  for (const directory of new Set(targetPaths.map((targetPath) => path.dirname(targetPath)))) {
    if (!exists(directory) || !fs.lstatSync(directory).isDirectory()) continue;
    for (const name of fs.readdirSync(directory)) {
      if (TEMPORARY_NAME_PATTERN.test(name)) {
        fs.rmSync(path.join(directory, name), { recursive: true, force: true });
      }
    }
  }
}

/**
 * Copy the current state of every target into a new backup. The manifest is
 * written last: a backup without one is incomplete and never restored.
 *
 * @param {string} userHome
 * @param {string} owner
 * @param {string[]} targetPaths
 * @param {unknown} [details]
 * @returns {string}
 */
export function createBackup(userHome, owner, targetPaths, details) {
  const backupRoot = buildTyrianBackupRoot(userHome, owner);
  const filesRoot = path.join(backupRoot, 'files');
  makeDirectoryDurably(filesRoot);
  /** @type {BackupEntry[]} */
  const entries = [];

  for (const targetPath of new Set(targetPaths)) {
    if (!isSameOrDescendant(userHome, targetPath)) {
      throw new Error(`Backup target is outside the destination home: ${targetPath}`);
    }
    const existed = exists(targetPath);
    if (existed) copyPathVerbatim(targetPath, path.join(filesRoot, String(entries.length)));
    entries.push({ target: path.relative(userHome, targetPath), existed });
  }

  fsyncDirectory(filesRoot);
  /** @type {BackupManifest} */
  const manifest = {
    owner,
    createdAt: new Date().toISOString(),
    entries,
    ...(details === undefined ? {} : { details }),
  };
  writeFileAtomic(
    path.join(backupRoot, BACKUP_MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return backupRoot;
}

/**
 * @param {string} userHome
 * @param {string} backupRoot
 * @returns {BackupManifest}
 */
export function readBackupManifest(userHome, backupRoot) {
  const manifest = /** @type {Partial<BackupManifest>} */ (
    JSON.parse(fs.readFileSync(path.join(backupRoot, BACKUP_MANIFEST_NAME), 'utf8'))
  );
  const fields =
    manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
      ? Object.keys(manifest).filter((field) => field !== 'details')
      : [];
  if (
    fields.toSorted().join(',') !== 'createdAt,entries,owner' ||
    typeof manifest.owner !== 'string' ||
    typeof manifest.createdAt !== 'string' ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.some(
      (entry) =>
        entry === null ||
        typeof entry !== 'object' ||
        Object.keys(entry).toSorted().join(',') !== 'existed,target' ||
        typeof entry.target !== 'string' ||
        typeof entry.existed !== 'boolean' ||
        path.isAbsolute(entry.target) ||
        !isSameOrDescendant(userHome, path.resolve(userHome, entry.target))
    )
  ) {
    throw new Error(`Tyrian backup manifest is invalid: ${backupRoot}`);
  }
  return /** @type {BackupManifest} */ (manifest);
}

/**
 * Return every target to its backed-up state. Restore is atomic per target and
 * keeps the backup, so a failed or interrupted restore is repeated from the
 * same backup; the caller discards it once everything that depends on it,
 * such as recorded runtime state, is restored too.
 *
 * @param {string} userHome
 * @param {string} backupRoot
 * @returns {BackupManifest}
 */
export function restoreBackup(userHome, backupRoot) {
  const manifest = readBackupManifest(userHome, backupRoot);

  manifest.entries.forEach((entry, index) => {
    const targetPath = path.resolve(userHome, entry.target);
    if (entry.existed) {
      installPath('copy', path.join(backupRoot, 'files', String(index)), targetPath);
    } else {
      removePath(targetPath);
    }
  });

  return manifest;
}

/**
 * Retire a consumed backup. Renaming it to a temporary name is the one atomic
 * step, so an interrupted discard never leaves a backup that still looks
 * complete after losing files; the retired tree, and any an earlier discard
 * left, is deleted afterwards. Callers hold the desktop lock.
 *
 * @param {string} backupRoot
 * @returns {void}
 */
export function discardBackup(backupRoot) {
  fs.renameSync(backupRoot, temporaryPathBeside(backupRoot));
  fsyncDirectory(path.dirname(backupRoot));
  removeStaleTemporaries([backupRoot]);
}

/**
 * The most recent complete backup, if any.
 *
 * @param {string} userHome
 * @returns {{ backupRoot: string; manifest: BackupManifest } | undefined}
 */
export function findLatestBackup(userHome) {
  const backupsRoot = path.join(userHome, TYRIAN_BACKUP_HOME);
  if (!exists(backupsRoot)) return undefined;

  /** @type {{ backupRoot: string; manifest: BackupManifest } | undefined} */
  let latest;
  for (const name of fs.readdirSync(backupsRoot)) {
    const backupRoot = path.join(backupsRoot, name);
    if (TEMPORARY_NAME_PATTERN.test(name)) continue;
    if (!exists(path.join(backupRoot, BACKUP_MANIFEST_NAME))) continue;
    const manifest = readBackupManifest(userHome, backupRoot);
    if (latest === undefined || manifest.createdAt > latest.manifest.createdAt) {
      latest = { backupRoot, manifest };
    }
  }
  return latest;
}

/**
 * Re-run this CLI under util-linux flock unless it already holds the desktop
 * lock. The kernel serializes every desktop mutation of the user and releases
 * the lock when the process exits, however it exits.
 *
 * @param {string} userHome
 * @returns {number | undefined} the locked run's exit code, or undefined when this process holds the lock
 */
export function reexecUnderDesktopLock(userHome) {
  if (process.env[LOCK_HELD_ENV] === '1') return undefined;

  const lockPath = path.join(userHome, TYRIAN_STATE_HOME, 'desktop.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const child = spawnSync(
    'flock',
    [
      '--exclusive',
      '--wait',
      String(LOCK_WAIT_SECONDS),
      '--conflict-exit-code',
      String(LOCK_CONFLICT_EXIT_CODE),
      lockPath,
      process.execPath,
      ...process.execArgv,
      ...process.argv.slice(1),
    ],
    { stdio: 'inherit', env: { ...process.env, [LOCK_HELD_ENV]: '1' } }
  );

  if (child.error) {
    throw new Error(`Tyrian desktop commands require util-linux flock: ${child.error.message}`);
  }
  if (child.status === LOCK_CONFLICT_EXIT_CODE) {
    throw new Error(
      `Another Tyrian desktop command held '${lockPath}' for ${LOCK_WAIT_SECONDS} seconds.`
    );
  }
  return child.status ?? 1;
}
