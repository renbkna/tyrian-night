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

test('a directory snapshot rejects incremental child mutation before creating any paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-directory-snapshot-boundary-'));
  const target = path.join(root, 'published');
  const backup = path.join(root, 'backup');

  try {
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'original'), 'original');
    const receipt = snapshotOwnedPaths([target], backup, { ownerRoot: root });
    try {
      expect(() =>
        writeTextFileRaw(path.join(target, 'new/child'), 'partial', { ownerRoot: root })
      ).toThrow('complete-generation replacement');
      expect(fs.readdirSync(target)).toEqual(['original']);
      expect(fs.readFileSync(path.join(target, 'original'), 'utf8')).toBe('original');
    } finally {
      receipt.discard();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('directory recovery fences orphaned original and recovery exchanges before observing targets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-directory-exchange-recovery-'));
  const targetPath = path.join(root, 'owned-directory');
  const replacementPath = path.join(root, 'replacement-directory');
  const backupRoot = path.join(root, 'backups/recovery');
  const recoveryTargetPath = path.join(root, 'recovery-owned-directory');
  const recoveryReplacementPath = path.join(root, 'recovery-replacement-directory');
  const recoveryBackupRoot = path.join(root, 'backups/interrupted-recovery');
  const fakeBin = path.join(root, 'fake-bin');
  const snapshotId = '11111111-1111-4111-8111-111111111111';
  const recoverySnapshotId = '33333333-3333-4333-8333-333333333333';
  const snapshotScratchPath = (identity: string, ownedPath: string): string =>
    path.join(root, `.tyrian-night-${identity}-${path.basename(ownedPath)}.tmp`);
  const scratchPath = snapshotScratchPath(snapshotId, targetPath);
  const retiredScratchPath = `${scratchPath}.retired`;
  const legacyUnknownScratchPath = path.join(
    root,
    `.${path.basename(targetPath)}.22222222-2222-4222-8222-222222222222.tmp`
  );
  const originalLstat = fs.lstatSync;
  const originalRename = fs.renameSync;
  const owners = new Set<ReturnType<typeof Bun.spawn>>();
  const releasePaths = new Set<string>();
  const wrapperPids = new Set<number>();

  const waitForPath = async (filePath: string, timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!fs.existsSync(filePath) && Date.now() < deadline) {
      await Bun.sleep(5);
    }
    expect(fs.existsSync(filePath)).toBe(true);
  };
  const processIsAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const restoreProcessEnvironment = (name: string, value: string | undefined): void => {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  };

  try {
    fs.mkdirSync(targetPath);
    fs.writeFileSync(path.join(targetPath, 'generation'), 'A\n');
    fs.mkdirSync(replacementPath);
    fs.writeFileSync(path.join(replacementPath, 'generation'), 'B\n');
    fs.mkdirSync(fakeBin);
    const fakeMv = path.join(fakeBin, 'mv');
    fs.writeFileSync(
      fakeMv,
      [
        '#!/bin/sh',
        'if [ "$1" = "--help" ]; then',
        '  printf "%s\\n" "--exchange"',
        '  exit 0',
        'fi',
        'publish_result() {',
        '  printf "%s\\n" "$1" > "$TYRIAN_RESULT_PATH.next"',
        '  /usr/bin/mv -f "$TYRIAN_RESULT_PATH.next" "$TYRIAN_RESULT_PATH"',
        '}',
        'if [ "$TYRIAN_BLOCK_EXCHANGE" = "1" ]; then',
        '  printf "%s\\n" "$$" > "$TYRIAN_WRAPPER_PID_PATH"',
        '  : > "$TYRIAN_READY_PATH"',
        '  attempts=0',
        '  while [ ! -f "$TYRIAN_RELEASE_PATH" ] && [ "$attempts" -lt 400 ]; do',
        '    sleep 0.01',
        '    attempts=$((attempts + 1))',
        '  done',
        '  if [ ! -f "$TYRIAN_RELEASE_PATH" ]; then',
        '    publish_result "timeout"',
        '    exit 70',
        '  fi',
        'fi',
        'if [ -n "$TYRIAN_MV_ARGUMENTS_PATH" ]; then',
        '  printf "%s\\n" "$@" > "$TYRIAN_MV_ARGUMENTS_PATH"',
        'fi',
        'if [ -n "$TYRIAN_ERROR_PATH" ]; then',
        '  /usr/bin/mv "$@" 2> "$TYRIAN_ERROR_PATH"',
        'else',
        '  /usr/bin/mv "$@"',
        'fi',
        'status=$?',
        'if [ "$TYRIAN_BLOCK_EXCHANGE" = "1" ]; then',
        '  publish_result "$status"',
        'fi',
        'exit "$status"',
        '',
      ].join('\n')
    );
    fs.chmodSync(fakeMv, 0o755);

    const startBlockedExchange = async (
      name: string,
      program: string,
      environment: Record<string, string>
    ) => {
      const exchangeRoot = path.join(root, 'exchanges', name);
      const readyPath = path.join(exchangeRoot, 'ready');
      const releasePath = path.join(exchangeRoot, 'release');
      const errorPath = path.join(exchangeRoot, 'error');
      const resultPath = path.join(exchangeRoot, 'result');
      const wrapperPidPath = path.join(exchangeRoot, 'wrapper-pid');
      fs.mkdirSync(exchangeRoot, { recursive: true });
      releasePaths.add(releasePath);

      const owner = Bun.spawn({
        cmd: [process.execPath, '-e', program],
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...environment,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          TYRIAN_BLOCK_EXCHANGE: '1',
          TYRIAN_ERROR_PATH: errorPath,
          TYRIAN_READY_PATH: readyPath,
          TYRIAN_RELEASE_PATH: releasePath,
          TYRIAN_RESULT_PATH: resultPath,
          TYRIAN_WRAPPER_PID_PATH: wrapperPidPath,
        },
        stdout: 'ignore',
        stderr: 'ignore',
      });
      owners.add(owner);

      await waitForPath(readyPath, 1_000);
      const wrapperPid = Number(fs.readFileSync(wrapperPidPath, 'utf8').trim());
      expect(Number.isSafeInteger(wrapperPid)).toBe(true);
      expect(processIsAlive(wrapperPid)).toBe(true);
      wrapperPids.add(wrapperPid);

      return { errorPath, owner, releasePath, resultPath, wrapperPid };
    };
    const assertOrphanRejected = async (resultPath: string, errorPath: string): Promise<void> => {
      await waitForPath(resultPath, 1_000);
      const exchangeResult = fs.readFileSync(resultPath, 'utf8').trim();
      expect(exchangeResult).not.toBe('timeout');
      expect(Number(exchangeResult)).not.toBe(0);
      expect(fs.readFileSync(errorPath, 'utf8')).toMatch(/no such file|enoent/i);
    };
    const restoreAfterFencing = (
      requestedBackupRoot: string,
      recoveryTargetPath: string,
      recoverySnapshotId: string,
      blockedScratchPath: string,
      releasePath: string
    ): void => {
      const retiredBlockedScratchPath = `${blockedScratchPath}.retired`;
      let fenceObserved = false;
      let targetObservedAfterFence = false;
      fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
        if (
          resolveMutationPath(oldPath) === blockedScratchPath &&
          resolveMutationPath(newPath) === retiredBlockedScratchPath
        ) {
          const result = originalRename(oldPath, newPath);
          fenceObserved = true;
          fs.writeFileSync(releasePath, 'release\n');
          return result;
        }

        return originalRename(oldPath, newPath);
      }) as typeof fs.renameSync;
      fs.lstatSync = ((filePath: fs.PathLike) => {
        if (resolveMutationPath(filePath) === recoveryTargetPath) {
          expect(fenceObserved).toBe(true);
          targetObservedAfterFence = true;
        }

        return originalLstat(filePath);
      }) as typeof fs.lstatSync;

      try {
        restoreOwnedPathSnapshot(requestedBackupRoot, {
          allowedRoots: [root],
          expectedTargetPaths: [recoveryTargetPath],
          snapshotId: recoverySnapshotId,
        });
      } finally {
        fs.lstatSync = originalLstat;
        fs.renameSync = originalRename;
      }

      expect(fenceObserved).toBe(true);
      expect(targetObservedAfterFence).toBe(true);
    };
    const withLoggedFakeMv = (argumentsPath: string, action: () => void): void => {
      const originalPath = process.env.PATH;
      const originalBlockExchange = process.env.TYRIAN_BLOCK_EXCHANGE;
      const originalArgumentsPath = process.env.TYRIAN_MV_ARGUMENTS_PATH;
      const originalErrorPath = process.env.TYRIAN_ERROR_PATH;
      process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;
      process.env.TYRIAN_BLOCK_EXCHANGE = '0';
      process.env.TYRIAN_MV_ARGUMENTS_PATH = argumentsPath;
      delete process.env.TYRIAN_ERROR_PATH;

      try {
        action();
      } finally {
        restoreProcessEnvironment('PATH', originalPath);
        restoreProcessEnvironment('TYRIAN_BLOCK_EXCHANGE', originalBlockExchange);
        restoreProcessEnvironment('TYRIAN_MV_ARGUMENTS_PATH', originalArgumentsPath);
        restoreProcessEnvironment('TYRIAN_ERROR_PATH', originalErrorPath);
      }
    };

    const originalPublisher = await startBlockedExchange(
      'original-publisher',
      [
        "const module = await import('./scripts/installOps.mjs');",
        'module.snapshotOwnedPaths([process.env.TARGET_PATH], process.env.BACKUP_ROOT, {',
        '  ownerRoot: process.env.OWNER_ROOT,',
        '  snapshotId: process.env.SNAPSHOT_ID,',
        '});',
        "module.installManagedPathRaw('copy', process.env.REPLACEMENT_PATH, process.env.TARGET_PATH, {",
        '  ownerRoot: process.env.OWNER_ROOT,',
        '});',
        'process.exit(42);',
      ].join(' '),
      {
        BACKUP_ROOT: backupRoot,
        OWNER_ROOT: root,
        REPLACEMENT_PATH: replacementPath,
        SNAPSHOT_ID: snapshotId,
        TARGET_PATH: targetPath,
      }
    );

    expect(fs.readFileSync(path.join(scratchPath, 'generation'), 'utf8')).toBe('B\n');

    originalPublisher.owner.kill('SIGKILL');
    expect(await originalPublisher.owner.exited).not.toBe(0);
    owners.delete(originalPublisher.owner);
    expect(processIsAlive(originalPublisher.wrapperPid)).toBe(true);
    expect(fs.readFileSync(path.join(targetPath, 'generation'), 'utf8')).toBe('A\n');
    restoreAfterFencing(
      backupRoot,
      targetPath,
      snapshotId,
      scratchPath,
      originalPublisher.releasePath
    );

    await assertOrphanRejected(originalPublisher.resultPath, originalPublisher.errorPath);
    wrapperPids.delete(originalPublisher.wrapperPid);
    expect(fs.readFileSync(path.join(targetPath, 'generation'), 'utf8')).toBe('A\n');
    expect(fs.existsSync(scratchPath)).toBe(false);
    expect(fs.existsSync(retiredScratchPath)).toBe(false);
    expect(fs.existsSync(backupRoot)).toBe(true);

    fs.mkdirSync(recoveryTargetPath);
    fs.writeFileSync(path.join(recoveryTargetPath, 'generation'), 'A\n');
    fs.mkdirSync(recoveryReplacementPath);
    fs.writeFileSync(path.join(recoveryReplacementPath, 'generation'), 'B\n');
    const recoveryReceipt = snapshotOwnedPaths([recoveryTargetPath], recoveryBackupRoot, {
      ownerRoot: root,
      snapshotId: recoverySnapshotId,
    });
    installManagedPathRaw('copy', recoveryReplacementPath, recoveryTargetPath, { ownerRoot: root });
    recoveryReceipt.seal();
    expect(fs.readFileSync(path.join(recoveryTargetPath, 'generation'), 'utf8')).toBe('B\n');

    const interruptedRecovery = await startBlockedExchange(
      'interrupted-recovery',
      [
        "const module = await import('./scripts/installOps.mjs');",
        'module.restoreOwnedPathSnapshot(process.env.BACKUP_ROOT, {',
        '  allowedRoots: [process.env.OWNER_ROOT],',
        '  expectedTargetPaths: [process.env.TARGET_PATH],',
        '  snapshotId: process.env.SNAPSHOT_ID,',
        '});',
      ].join(' '),
      {
        BACKUP_ROOT: recoveryBackupRoot,
        OWNER_ROOT: root,
        SNAPSHOT_ID: recoverySnapshotId,
        TARGET_PATH: recoveryTargetPath,
      }
    );
    const recoveryManifestPath = path.join(recoveryBackupRoot, 'snapshot.json');
    const interruptedRecoveryManifest = JSON.parse(fs.readFileSync(recoveryManifestPath, 'utf8'));
    const interruptedRecoveryId = interruptedRecoveryManifest.recoveryId;
    expect(typeof interruptedRecoveryId).toBe('string');
    const interruptedRecoveryScratchPath = snapshotScratchPath(
      `${recoverySnapshotId}-recovery-${interruptedRecoveryId}`,
      recoveryTargetPath
    );
    expect(fs.readFileSync(path.join(interruptedRecoveryScratchPath, 'generation'), 'utf8')).toBe(
      'A\n'
    );

    interruptedRecovery.owner.kill('SIGKILL');
    expect(await interruptedRecovery.owner.exited).not.toBe(0);
    owners.delete(interruptedRecovery.owner);
    expect(processIsAlive(interruptedRecovery.wrapperPid)).toBe(true);
    expect(fs.readFileSync(path.join(recoveryTargetPath, 'generation'), 'utf8')).toBe('B\n');

    const freshRecoveryArgumentsPath = path.join(root, 'fresh-recovery-mv-arguments');
    withLoggedFakeMv(freshRecoveryArgumentsPath, () => {
      restoreAfterFencing(
        recoveryBackupRoot,
        recoveryTargetPath,
        recoverySnapshotId,
        interruptedRecoveryScratchPath,
        interruptedRecovery.releasePath
      );
    });

    await assertOrphanRejected(interruptedRecovery.resultPath, interruptedRecovery.errorPath);
    wrapperPids.delete(interruptedRecovery.wrapperPid);
    const freshRecoveryManifest = JSON.parse(fs.readFileSync(recoveryManifestPath, 'utf8'));
    const freshRecoveryId = freshRecoveryManifest.recoveryId;
    expect(typeof freshRecoveryId).toBe('string');
    expect(freshRecoveryId).not.toBe(interruptedRecoveryId);
    const freshRecoveryScratchPath = snapshotScratchPath(
      `${recoverySnapshotId}-recovery-${freshRecoveryId}`,
      recoveryTargetPath
    );
    const freshRecoveryArguments = fs.readFileSync(freshRecoveryArgumentsPath, 'utf8');
    expect(freshRecoveryArguments).toContain(path.basename(freshRecoveryScratchPath));
    expect(freshRecoveryArguments).not.toContain(path.basename(interruptedRecoveryScratchPath));
    expect(fs.readFileSync(path.join(recoveryTargetPath, 'generation'), 'utf8')).toBe('A\n');
    expect(fs.readdirSync(root).filter((name) => name.startsWith('.tyrian-night-'))).toEqual([]);
    expect(fs.existsSync(recoveryBackupRoot)).toBe(true);

    const manifestPath = path.join(backupRoot, 'snapshot.json');
    const legacyManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    legacyManifest.version = 5;
    delete legacyManifest.recoveryId;
    for (const entry of legacyManifest.entries) {
      delete entry.disposable;
      delete entry.publishedGeneration;
    }
    fs.writeFileSync(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`);
    fs.mkdirSync(legacyUnknownScratchPath);
    fs.writeFileSync(path.join(legacyUnknownScratchPath, 'generation'), 'unknown B\n');

    expect(() =>
      restoreOwnedPathSnapshot(backupRoot, {
        allowedRoots: [root],
        expectedTargetPaths: [targetPath],
        snapshotId,
      })
    ).toThrow('Legacy snapshot has unrecorded publication evidence');

    expect(fs.readFileSync(path.join(legacyUnknownScratchPath, 'generation'), 'utf8')).toBe(
      'unknown B\n'
    );
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version).toBe(5);
    expect(fs.readFileSync(path.join(targetPath, 'generation'), 'utf8')).toBe('A\n');
  } finally {
    fs.lstatSync = originalLstat;
    fs.renameSync = originalRename;
    for (const releasePath of releasePaths) {
      if (!fs.existsSync(releasePath)) fs.writeFileSync(releasePath, 'release\n');
    }
    for (const owner of owners) {
      owner.kill('SIGKILL');
    }
    for (const owner of owners) {
      await Promise.race([owner.exited, Bun.sleep(250)]);
    }
    for (const wrapperPid of wrapperPids) {
      if (processIsAlive(wrapperPid)) process.kill(wrapperPid, 'SIGKILL');
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SIGKILL during snapshot-owned directory deletion leaves absence and recoverable whole A', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-directory-delete-recovery-'));
  const targetPath = path.join(root, 'owned-directory');
  const backupRoot = path.join(root, 'backups/recovery');
  const readyPath = path.join(root, 'deletion-ready');
  const snapshotId = '44444444-4444-4444-8444-444444444444';
  const scratchPath = path.join(
    root,
    `.tyrian-night-${snapshotId}-${path.basename(targetPath)}.tmp`
  );
  let remover: ReturnType<typeof Bun.spawn> | undefined;

  const waitForPath = async (filePath: string, timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!fs.existsSync(filePath) && Date.now() < deadline) {
      await Bun.sleep(5);
    }
    expect(fs.existsSync(filePath)).toBe(true);
  };

  try {
    fs.mkdirSync(path.join(targetPath, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(targetPath, 'first'), 'first from A\n');
    fs.writeFileSync(path.join(targetPath, 'nested/second'), 'second from A\n');

    remover = Bun.spawn({
      cmd: [
        process.execPath,
        '-e',
        [
          "const fs = (await import('node:fs')).default;",
          "const path = (await import('node:path')).default;",
          "const module = await import('./scripts/installOps.mjs');",
          'module.snapshotOwnedPaths([process.env.TARGET_PATH], process.env.BACKUP_ROOT, {',
          '  ownerRoot: process.env.OWNER_ROOT,',
          '  snapshotId: process.env.SNAPSHOT_ID,',
          '});',
          'const originalRm = fs.rmSync;',
          'fs.rmSync = (requestedPath, options) => {',
          '  const basename = path.basename(String(requestedPath));',
          '  if (basename === process.env.TARGET_BASENAME || basename === process.env.SCRATCH_BASENAME) {',
          "    fs.unlinkSync(path.join(String(requestedPath), 'first'));",
          '    fs.writeFileSync(process.env.READY_PATH, basename);',
          "    process.kill(process.pid, 'SIGKILL');",
          '  }',
          '  return originalRm(requestedPath, options);',
          '};',
          'module.removeOwnedPathRaw(process.env.OWNER_ROOT, process.env.TARGET_PATH);',
        ].join(' '),
      ],
      cwd: process.cwd(),
      env: {
        ...process.env,
        BACKUP_ROOT: backupRoot,
        OWNER_ROOT: root,
        READY_PATH: readyPath,
        SCRATCH_BASENAME: path.basename(scratchPath),
        SNAPSHOT_ID: snapshotId,
        TARGET_BASENAME: path.basename(targetPath),
        TARGET_PATH: targetPath,
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    await waitForPath(readyPath, 1_000);
    expect(await remover.exited).not.toBe(0);
    remover = undefined;
    expect(fs.readFileSync(readyPath, 'utf8')).toBe(path.basename(scratchPath));
    expect(fs.existsSync(targetPath)).toBe(false);
    expect(fs.existsSync(path.join(scratchPath, 'first'))).toBe(false);
    expect(fs.readFileSync(path.join(scratchPath, 'nested/second'), 'utf8')).toBe(
      'second from A\n'
    );

    restoreOwnedPathSnapshot(backupRoot, {
      allowedRoots: [root],
      expectedTargetPaths: [targetPath],
      snapshotId,
    });

    expect(fs.readFileSync(path.join(targetPath, 'first'), 'utf8')).toBe('first from A\n');
    expect(fs.readFileSync(path.join(targetPath, 'nested/second'), 'utf8')).toBe('second from A\n');
    expect(fs.existsSync(scratchPath)).toBe(false);
    expect(fs.existsSync(`${scratchPath}.retired`)).toBe(false);
    expect(fs.existsSync(backupRoot)).toBe(true);
  } finally {
    remover?.kill('SIGKILL');
    if (remover) await Promise.race([remover.exited, Bun.sleep(250)]);
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

test('persisted recovery rejects v4 snapshot metadata without mutation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-atomic-v4-parent-'));
  const targetPath = path.join(root, 'owned.conf');

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
    manifest.missingOwnedParents = [path.join(root, 'external-empty-parent')];
    const retiredManifest = `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(manifestPath, retiredManifest);

    expect(() =>
      restoreOwnedPathSnapshot(receipt.backupRoot, {
        allowedRoots: [root],
        expectedTargetPaths: receipt.targetPaths,
        snapshotId: receipt.snapshotId,
      })
    ).toThrow('must use version 5');

    expect(fs.readFileSync(targetPath, 'utf8')).toBe('interrupted generation\n');
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(retiredManifest);
    expect(fs.existsSync(receipt.backupRoot)).toBe(true);
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
  const originalWrite = fs.writeFileSync;
  const durableWrites = new Map<string, fs.WriteFileOptions>();
  let ownerPublicationObserved = false;

  fs.writeFileSync = ((filePath: fs.PathLike | number, data, options) => {
    const result = originalWrite(filePath, data, options);

    if (
      typeof filePath !== 'number' &&
      typeof options === 'object' &&
      options !== null &&
      options.flag === 'wx' &&
      options.flush === true
    ) {
      const stats = fs.statSync(filePath);
      durableWrites.set(`${stats.dev}:${stats.ino}`, options);
    }

    return result;
  }) as typeof fs.writeFileSync;

  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    if (String(newPath).includes('.owner-')) {
      const sourceStats = fs.statSync(existingPath);
      const writeOptions = durableWrites.get(`${sourceStats.dev}:${sourceStats.ino}`);
      expect(writeOptions).toMatchObject({
        encoding: 'utf8',
        flag: 'wx',
        flush: true,
        mode: 0o600,
      });
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
    fs.writeFileSync = originalWrite;
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
