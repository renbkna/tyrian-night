import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  installManagedPathRaw,
  restoreOwnedPathSnapshot,
  snapshotOwnedPaths,
  withTokenFileLock,
  writeBinaryFileRaw,
  writeOwnedRecoveryCandidateRaw,
  writeTextFileRaw,
} from '../scripts/installOps.mjs';

test('text and binary writes publish complete files and preserve replacement permissions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-atomic-write-'));
  const textPath = path.join(root, 'scheme.json');
  const binaryPath = path.join(root, 'asset.bin');

  try {
    fs.writeFileSync(textPath, 'old generation\n');
    fs.chmodSync(textPath, 0o660);

    traceAtomicReplacement(textPath, 'old generation\n', 'new generation\n', () => {
      writeTextFileRaw(textPath, 'new generation', { finalNewline: true, ownerRoot: root });
    });

    expect(fs.statSync(textPath).mode & 0o7777).toBe(0o660);
    writeBinaryFileRaw(binaryPath, Buffer.from([0, 1, 2, 255]), { ownerRoot: root });
    expect(fs.readFileSync(binaryPath)).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(temporaryFilesBeside(textPath)).toEqual([]);
    expect(temporaryFilesBeside(binaryPath)).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recovery candidates have one fixed crash-recoverable name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-recovery-candidate-'));
  const candidatePath = path.join(root, 'journal.json.next');

  try {
    writeOwnedRecoveryCandidateRaw(root, candidatePath, 'first candidate\n');
    expect(fs.readdirSync(root)).toEqual(['journal.json.next']);
    expect(fs.readFileSync(candidatePath, 'utf8')).toBe('first candidate\n');

    writeOwnedRecoveryCandidateRaw(root, candidatePath, 'replacement candidate\n');
    expect(fs.readdirSync(root)).toEqual(['journal.json.next']);
    expect(fs.readFileSync(candidatePath, 'utf8')).toBe('replacement candidate\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('managed regular-file copies atomically replace the old generation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-atomic-copy-'));
  const sourcePath = path.join(root, 'source');
  const targetPath = path.join(root, 'target');

  try {
    fs.writeFileSync(sourcePath, 'complete copied generation\n');
    fs.chmodSync(sourcePath, 0o751);
    fs.writeFileSync(targetPath, 'old copied generation\n');

    traceAtomicReplacement(
      targetPath,
      'old copied generation\n',
      'complete copied generation\n',
      () => installManagedPathRaw('copy', sourcePath, targetPath, { ownerRoot: root })
    );

    expect(fs.statSync(targetPath).mode & 0o7777).toBe(0o751);
    expect(temporaryFilesBeside(targetPath)).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed publication retains the old generation and removes its staging file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-atomic-failure-'));
  const targetPath = path.join(root, 'watched.json');
  const originalRename = fs.renameSync;

  try {
    fs.writeFileSync(targetPath, 'old valid generation\n');
    fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (resolveMutationPath(newPath) === targetPath) {
        throw new Error('injected publication failure');
      }

      return originalRename(oldPath, newPath);
    }) as typeof fs.renameSync;

    expect(() =>
      writeTextFileRaw(targetPath, 'unpublished generation\n', { ownerRoot: root })
    ).toThrow('injected publication failure');
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('old valid generation\n');
    expect(temporaryFilesBeside(targetPath)).toEqual([]);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('regular-file rollback and persisted recovery atomically restore their snapshots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-atomic-restore-'));
  const targetPath = path.join(root, 'owned.conf');

  try {
    fs.writeFileSync(targetPath, 'snapshot generation\n');
    fs.chmodSync(targetPath, 0o600);
    const rollbackReceipt = snapshotOwnedPaths([targetPath], path.join(root, 'backups/rollback'), {
      ownerRoot: root,
    });
    writeTextFileRaw(targetPath, 'mutated generation\n', { ownerRoot: root });

    traceAtomicReplacement(targetPath, 'mutated generation\n', 'snapshot generation\n', () =>
      rollbackReceipt.rollback()
    );
    expect(fs.statSync(targetPath).mode & 0o7777).toBe(0o600);

    const recoveryReceipt = snapshotOwnedPaths([targetPath], path.join(root, 'backups/recovery'), {
      ownerRoot: root,
    });
    writeTextFileRaw(targetPath, 'interrupted generation\n', { ownerRoot: root });

    traceAtomicReplacement(targetPath, 'interrupted generation\n', 'snapshot generation\n', () =>
      restoreOwnedPathSnapshot(recoveryReceipt.backupRoot, {
        allowedRoots: [root],
        expectedTargetPaths: recoveryReceipt.targetPaths,
        snapshotId: recoveryReceipt.snapshotId,
      })
    );
    expect(fs.existsSync(recoveryReceipt.backupRoot)).toBe(true);
    expect(fs.statSync(targetPath).mode & 0o7777).toBe(0o600);
    recoveryReceipt.discard();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rollback refuses external drift and retains its recovery evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-atomic-drift-'));
  const targetPath = path.join(root, 'owned.conf');
  const backupRoot = path.join(root, 'backups/recovery');

  try {
    fs.writeFileSync(targetPath, 'original generation\n');
    const receipt = snapshotOwnedPaths([targetPath], backupRoot, { ownerRoot: root });
    writeTextFileRaw(targetPath, 'owned mutation\n', { ownerRoot: root });
    fs.writeFileSync(targetPath, 'external generation\n');

    let failure: unknown;
    try {
      receipt.rollback();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map(String).join('\n')).toContain('external drift');
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('external generation\n');
    expect(fs.existsSync(backupRoot)).toBe(true);
    receipt.seal();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('persisted recovery restores declared target absence without claiming parent directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-atomic-absence-'));
  const targetPath = path.join(root, '.config/tyrian/nested/owned.conf');
  const absentParent = path.join(root, '.config');

  try {
    const receipt = snapshotOwnedPaths([targetPath], path.join(root, 'backups/recovery'), {
      ownerRoot: root,
    });
    writeTextFileRaw(targetPath, 'interrupted generation\n', { ownerRoot: root });
    receipt.seal();

    restoreOwnedPathSnapshot(receipt.backupRoot, {
      allowedRoots: [root],
      expectedTargetPaths: receipt.targetPaths,
      snapshotId: receipt.snapshotId,
    });

    expect(fs.existsSync(targetPath)).toBe(false);
    expect(fs.existsSync(absentParent)).toBe(true);
    expect(fs.existsSync(receipt.backupRoot)).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('persisted recovery accepts v4 parent metadata without granting deletion authority', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-atomic-v4-parent-'));
  const targetPath = path.join(root, 'owned.conf');
  const unrelatedParent = path.join(root, 'external-empty-parent');

  try {
    fs.writeFileSync(targetPath, 'snapshot generation\n');
    const receipt = snapshotOwnedPaths([targetPath], path.join(root, 'backups/recovery'), {
      ownerRoot: root,
    });
    writeTextFileRaw(targetPath, 'interrupted generation\n', { ownerRoot: root });
    receipt.seal();

    const manifestPath = path.join(receipt.backupRoot, 'snapshot.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.version = 4;
    manifest.missingOwnedParents = [unrelatedParent];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.mkdirSync(unrelatedParent);

    restoreOwnedPathSnapshot(receipt.backupRoot, {
      allowedRoots: [root],
      expectedTargetPaths: receipt.targetPaths,
      snapshotId: receipt.snapshotId,
    });

    expect(fs.readFileSync(targetPath, 'utf8')).toBe('snapshot generation\n');
    expect(fs.existsSync(unrelatedParent)).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release-failed token locks reject later same-process acquisition', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-token-lock-release-failed-'));
  const lockPath = path.join(root, 'owner.lock');
  const originalRmSync = fs.rmSync;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  let secondActionEntered = false;

  try {
    console.warn = (message) => warnings.push(String(message));
    fs.rmSync = ((filePath, options) => {
      if (path.basename(String(filePath)) === path.basename(lockPath)) {
        throw new Error('injected persistent release failure');
      }

      return originalRmSync(filePath, options);
    }) as typeof fs.rmSync;

    expect(
      withTokenFileLock(lockPath, () => 42, {
        ownerRoot: root,
      })
    ).toBe(42);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(warnings).toHaveLength(1);

    fs.rmSync = originalRmSync;

    expect(() =>
      withTokenFileLock(
        lockPath,
        () => {
          secondActionEntered = true;
        },
        { ownerRoot: root }
      )
    ).toThrow('release previously failed');
    expect(secondActionEntered).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
  } finally {
    fs.rmSync = originalRmSync;
    console.warn = originalWarn;
    originalRmSync(root, { recursive: true, force: true });
  }
});

test('unsupported and failed directory exchange retain complete target and recovery evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-atomic-directory-failure-'));
  const targetPath = path.join(root, 'managed-directory');
  const replacementPath = path.join(root, 'replacement-directory');
  const fakeBin = path.join(root, 'fake-bin');
  const backupRoot = path.join(root, 'backups/recovery');

  try {
    fs.mkdirSync(path.join(targetPath, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(targetPath, 'old-only'), 'old generation\n');
    fs.writeFileSync(path.join(targetPath, 'nested/value'), 'old nested value\n');
    const receipt = snapshotOwnedPaths([targetPath], backupRoot, { ownerRoot: root });

    fs.mkdirSync(path.join(replacementPath, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(replacementPath, 'new-only'), 'new generation\n');
    fs.writeFileSync(path.join(replacementPath, 'nested/value'), 'new nested value\n');
    installManagedPathRaw('copy', replacementPath, targetPath, { ownerRoot: root });

    fs.mkdirSync(fakeBin);
    const fakeMv = path.join(fakeBin, 'mv');
    fs.writeFileSync(
      fakeMv,
      [
        '#!/bin/sh',
        'if [ "$1" = "--help" ]; then',
        '  if [ "$TYRIAN_FAKE_MV_MODE" = "supported" ]; then echo "--exchange"; fi',
        '  exit 0',
        'fi',
        'echo injected exchange failure >&2',
        'exit 72',
        '',
      ].join('\n')
    );
    fs.chmodSync(fakeMv, 0o755);
    receipt.seal();

    for (const [mode, expectedFailure] of [
      ['unsupported', 'mv --exchange is unavailable'],
      ['supported', 'injected exchange failure'],
    ] as const) {
      const recovery = Bun.spawn({
        cmd: [
          process.execPath,
          '-e',
          [
            "const module = await import('./scripts/installOps.mjs');",
            'const flatten = (error) => error instanceof AggregateError ? error.errors.flatMap(flatten) : [String(error)];',
            'try {',
            '  module.restoreOwnedPathSnapshot(process.env.BACKUP_ROOT, {',
            '    allowedRoots: [process.env.OWNER_ROOT],',
            '    expectedTargetPaths: [process.env.TARGET_PATH],',
            '    snapshotId: process.env.SNAPSHOT_ID,',
            '  });',
            '  process.exit(2);',
            '} catch (error) {',
            '  if (!flatten(error).join("\\n").includes(process.env.EXPECTED_FAILURE)) process.exit(3);',
            '}',
          ].join(' '),
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: fakeBin,
          TYRIAN_FAKE_MV_MODE: mode,
          BACKUP_ROOT: backupRoot,
          OWNER_ROOT: root,
          TARGET_PATH: targetPath,
          SNAPSHOT_ID: receipt.snapshotId,
          EXPECTED_FAILURE: expectedFailure,
        },
        stdout: 'ignore',
        stderr: 'ignore',
      });

      expect(await recovery.exited).toBe(0);
      expect(fs.readFileSync(path.join(targetPath, 'new-only'), 'utf8')).toBe('new generation\n');
      expect(fs.readFileSync(path.join(targetPath, 'nested/value'), 'utf8')).toBe(
        'new nested value\n'
      );
      expect(fs.existsSync(path.join(targetPath, 'old-only'))).toBe(false);
      expect(fs.existsSync(backupRoot)).toBe(true);
      expect(fs.readFileSync(path.join(backupRoot, 'snapshot/0/old-only'), 'utf8')).toBe(
        'old generation\n'
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('descriptor-anchored publication cannot be redirected by a parent swap', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-atomic-anchor-'));
  const admittedParent = path.join(root, 'managed');
  const movedParent = path.join(root, 'admitted-parent');
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-atomic-anchor-external-'));
  const targetPath = path.join(admittedParent, 'owned.conf');
  const externalTarget = path.join(externalRoot, 'owned.conf');
  const originalRename = fs.renameSync;
  let parentSwapped = false;

  try {
    fs.mkdirSync(admittedParent);
    fs.writeFileSync(targetPath, 'old owned generation\n');
    fs.writeFileSync(externalTarget, 'external generation\n');
    fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (!parentSwapped && resolveMutationPath(newPath) === targetPath) {
        parentSwapped = true;
        originalRename(admittedParent, movedParent);
        fs.symlinkSync(externalRoot, admittedParent);
      }

      return originalRename(oldPath, newPath);
    }) as typeof fs.renameSync;

    writeTextFileRaw(targetPath, 'new owned generation\n', { ownerRoot: root });

    expect(parentSwapped).toBe(true);
    expect(fs.readFileSync(path.join(movedParent, 'owned.conf'), 'utf8')).toBe(
      'new owned generation\n'
    );
    expect(fs.readFileSync(externalTarget, 'utf8')).toBe('external generation\n');
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

test('symbolic-link and directory installation semantics remain unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-atomic-types-'));
  const referentPath = path.join(root, 'referent.conf');
  const writeLinkPath = path.join(root, 'write-link.conf');
  const replaceLinkPath = path.join(root, 'replace-link.conf');
  const installLinkPath = path.join(root, 'installed-link');
  const sourceDirectory = path.join(root, 'source-directory');
  const targetDirectory = path.join(root, 'target-directory');

  try {
    fs.writeFileSync(referentPath, 'old referent\n');
    fs.symlinkSync(path.basename(referentPath), writeLinkPath);
    traceAtomicReplacement(referentPath, 'old referent\n', 'new referent\n', () => {
      writeTextFileRaw(writeLinkPath, 'new referent\n', { ownerRoot: root });
    });
    expect(fs.lstatSync(writeLinkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(writeLinkPath)).toBe(path.basename(referentPath));

    fs.symlinkSync(path.basename(referentPath), replaceLinkPath);
    writeTextFileRaw(replaceLinkPath, 'owned leaf generation\n', {
      followFinalSymlink: false,
      ownerRoot: root,
    });
    expect(fs.readFileSync(referentPath, 'utf8')).toBe('new referent\n');
    expect(fs.lstatSync(replaceLinkPath).isFile()).toBe(true);
    expect(fs.readFileSync(replaceLinkPath, 'utf8')).toBe('owned leaf generation\n');

    fs.mkdirSync(installLinkPath);
    installManagedPathRaw('link', referentPath, installLinkPath, { ownerRoot: root });
    expect(fs.lstatSync(installLinkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(installLinkPath)).toBe(path.resolve(referentPath));

    fs.mkdirSync(sourceDirectory);
    fs.writeFileSync(path.join(sourceDirectory, 'theme.conf'), 'theme\n');
    fs.symlinkSync('theme.conf', path.join(sourceDirectory, 'current'));
    fs.mkdirSync(targetDirectory);
    fs.writeFileSync(path.join(targetDirectory, 'stale'), 'stale\n');
    installManagedPathRaw('copy', sourceDirectory, targetDirectory, { ownerRoot: root });
    expect(fs.existsSync(path.join(targetDirectory, 'stale'))).toBe(false);
    expect(fs.readFileSync(path.join(targetDirectory, 'theme.conf'), 'utf8')).toBe('theme\n');
    expect(fs.lstatSync(path.join(targetDirectory, 'current')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(targetDirectory, 'current'))).toBe('theme.conf');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('exclusive lock records are complete before their names become visible', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-atomic-exclusive-'));
  const lockPath = path.join(root, 'install.lock');
  const originalLink = fs.linkSync;
  const originalFsync = fs.fsyncSync;
  const syncedFiles = new Set<string>();
  let ownerPublicationObserved = false;

  fs.fsyncSync = ((descriptor: number) => {
    const stats = fs.fstatSync(descriptor);
    syncedFiles.add(`${stats.dev}:${stats.ino}`);
    return originalFsync(descriptor);
  }) as typeof fs.fsyncSync;

  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    if (String(newPath).includes('.owner-')) {
      const sourceStats = fs.statSync(existingPath);
      expect(syncedFiles.has(`${sourceStats.dev}:${sourceStats.ino}`)).toBe(true);
      expect(() => JSON.parse(fs.readFileSync(existingPath, 'utf8'))).not.toThrow();
      expect(fs.existsSync(newPath)).toBe(false);
      ownerPublicationObserved = true;
    }

    return originalLink(existingPath, newPath);
  }) as typeof fs.linkSync;

  try {
    withTokenFileLock(
      lockPath,
      () => {
        expect(() => JSON.parse(fs.readFileSync(lockPath, 'utf8'))).not.toThrow();
      },
      { ownerRoot: root }
    );
  } finally {
    fs.linkSync = originalLink;
    fs.fsyncSync = originalFsync;
    fs.rmSync(root, { recursive: true, force: true });
  }

  expect(ownerPublicationObserved).toBe(true);
});

test('token-lock publication and release remain bound to the admitted parent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-atomic-lock-anchor-'));
  const lockParent = path.join(root, 'locks');
  const movedParent = path.join(root, 'admitted-locks');
  const externalRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'tyrian-atomic-lock-anchor-external-')
  );
  const lockPath = path.join(lockParent, 'install.lock');
  const externalLock = path.join(externalRoot, 'install.lock');
  const originalLink = fs.linkSync;
  let parentSwapped = false;

  try {
    fs.mkdirSync(lockParent);
    fs.writeFileSync(externalLock, 'external sentinel\n');
    fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
      if (!parentSwapped && resolveMutationPath(newPath) === lockPath) {
        parentSwapped = true;
        fs.renameSync(lockParent, movedParent);
        fs.symlinkSync(externalRoot, lockParent);
      }

      return originalLink(existingPath, newPath);
    }) as typeof fs.linkSync;

    withTokenFileLock(
      lockPath,
      () => {
        expect(fs.existsSync(path.join(movedParent, 'install.lock'))).toBe(true);
        expect(fs.readFileSync(externalLock, 'utf8')).toBe('external sentinel\n');
      },
      { ownerRoot: root }
    );

    expect(parentSwapped).toBe(true);
    expect(fs.existsSync(path.join(movedParent, 'install.lock'))).toBe(false);
    expect(fs.readFileSync(externalLock, 'utf8')).toBe('external sentinel\n');
  } finally {
    fs.linkSync = originalLink;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

function traceAtomicReplacement(
  targetPath: string,
  oldContent: string,
  newContent: string,
  action: () => void
): void {
  const originalRename = fs.renameSync;
  const originalFsync = fs.fsyncSync;
  const syncedFiles = new Set<string>();
  const targetDirectoryStats = fs.statSync(path.dirname(targetPath));
  let replacementObserved = false;
  let directorySyncedAfterReplacement = false;

  fs.fsyncSync = ((descriptor: number) => {
    const stats = fs.fstatSync(descriptor);
    syncedFiles.add(`${stats.dev}:${stats.ino}`);

    if (
      replacementObserved &&
      stats.isDirectory() &&
      stats.dev === targetDirectoryStats.dev &&
      stats.ino === targetDirectoryStats.ino
    ) {
      directorySyncedAfterReplacement = true;
    }

    return originalFsync(descriptor);
  }) as typeof fs.fsyncSync;

  fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
    if (resolveMutationPath(newPath) !== path.resolve(targetPath)) {
      return originalRename(oldPath, newPath);
    }

    expect(fs.readFileSync(targetPath, 'utf8')).toBe(oldContent);
    expect(fs.readFileSync(oldPath, 'utf8')).toBe(newContent);
    const temporaryStats = fs.statSync(oldPath);
    expect(syncedFiles.has(`${temporaryStats.dev}:${temporaryStats.ino}`)).toBe(true);
    replacementObserved = true;
    const result = originalRename(oldPath, newPath);
    expect(fs.readFileSync(targetPath, 'utf8')).toBe(newContent);
    return result;
  }) as typeof fs.renameSync;

  try {
    action();
  } finally {
    fs.renameSync = originalRename;
    fs.fsyncSync = originalFsync;
  }

  expect(replacementObserved).toBe(true);
  expect(directorySyncedAfterReplacement).toBe(true);
}

function resolveMutationPath(filePath: fs.PathLike): string {
  const requestedPath = String(filePath);
  const parentPath = path.dirname(requestedPath);
  const physicalParent = parentPath.startsWith('/proc/self/fd/')
    ? fs.realpathSync(parentPath)
    : path.resolve(parentPath);

  return path.join(physicalParent, path.basename(requestedPath));
}

function temporaryFilesBeside(filePath: string): string[] {
  const prefix = `.${path.basename(filePath)}.`;
  return fs.readdirSync(path.dirname(filePath)).filter((entry) => entry.startsWith(prefix));
}
