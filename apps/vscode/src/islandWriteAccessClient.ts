import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';

import {
  ISLAND_BROKER_CHOWN_PATH,
  ISLAND_BROKER_PKEXEC_PATH,
} from './generated/islandBrokerInstallContract.js';
import { buildIslandPatchPaths } from './islandPatchContract.js';
import { readCallerOwnership } from './islandProcessIdentity.js';
import { readIslandShellStatus, readIslandShellWriteAccess } from './islandShell.js';

export type IslandWriteAccessStatus =
  | {
      available: true;
      chownPath: string;
      pkexecPath: string;
    }
  | {
      available: false;
      reason: string;
    };

export type IslandWriteAccessUnlockResult = {
  action: 'unlock';
  changed: boolean;
  unlockedPaths: string[];
};

export type IslandPackageAccessRestoreResult = {
  action: 'restore-access';
  changed: boolean;
  restoredPaths: string[];
};

export async function readIslandWriteAccessStatus(options?: {
  chownPath?: string;
  pkexecPath?: string;
}): Promise<IslandWriteAccessStatus> {
  const pkexecPath = options?.pkexecPath ?? ISLAND_BROKER_PKEXEC_PATH;
  const chownPath = options?.chownPath ?? ISLAND_BROKER_CHOWN_PATH;

  if (!(await isExecutable(pkexecPath))) {
    return {
      available: false,
      reason: 'System privilege prompt is unavailable: pkexec was not found.',
    };
  }

  if (!(await isExecutable(chownPath))) {
    return {
      available: false,
      reason: 'System ownership tool is unavailable: chown was not found.',
    };
  }

  return {
    available: true,
    chownPath,
    pkexecPath,
  };
}

export async function runIslandWriteAccessUnlock(options: {
  appRoot: string;
  callerGid?: number;
  callerUid?: number;
  expectedProductWorkbenchChecksum: string;
  expectedWorkbenchChecksum: string;
  writeAccess: Extract<IslandWriteAccessStatus, { available: true }>;
}): Promise<IslandWriteAccessUnlockResult> {
  await assertIslandHashProof(options);
  const commands = buildIslandWriteAccessUnlockCommands(options);
  await runCommandSequence(commands, 'Tyrian Night write-access unlock failed.');
  await applyIslandWriteAccessModes(options.appRoot);
  await assertIslandHashProof(options);
  await verifyUnlocked(options.appRoot);

  return {
    action: 'unlock',
    changed: true,
    unlockedPaths: buildIslandWriteAccessTargetPaths(options.appRoot),
  };
}

export async function runIslandPackageAccessRestore(options: {
  appRoot: string;
  expectedProductWorkbenchChecksum: string;
  expectedWorkbenchChecksum: string;
  writeAccess: Extract<IslandWriteAccessStatus, { available: true }>;
}): Promise<IslandPackageAccessRestoreResult> {
  await assertIslandHashProof(options);
  await applyIslandPackageAccessModes(options.appRoot);
  const commands = buildIslandPackageAccessRestoreCommands(options);
  await runCommandSequence(commands, 'Tyrian Night package-access reset failed.');
  await assertIslandHashProof(options);
  await verifyPackageAccessRestored(options.appRoot);

  return {
    action: 'restore-access',
    changed: true,
    restoredPaths: buildIslandWriteAccessTargetPaths(options.appRoot),
  };
}

export function buildIslandWriteAccessUnlockCommands(options: {
  appRoot: string;
  callerGid?: number;
  callerUid?: number;
  writeAccess: Extract<IslandWriteAccessStatus, { available: true }>;
}): string[][] {
  const ownership = readCallerOwnership(options);

  if (!ownership) {
    throw new Error('Tyrian could not determine the current user for write-access unlock.');
  }

  const targets = buildIslandWriteAccessTargetPaths(options.appRoot);

  return [
    [
      options.writeAccess.pkexecPath,
      options.writeAccess.chownPath,
      `${ownership.callerUid}:${ownership.callerGid}`,
      ...targets,
    ],
  ];
}

export function buildIslandPackageAccessRestoreCommands(options: {
  appRoot: string;
  writeAccess: Extract<IslandWriteAccessStatus, { available: true }>;
}): string[][] {
  const targets = buildIslandWriteAccessTargetPaths(options.appRoot);

  return [[options.writeAccess.pkexecPath, options.writeAccess.chownPath, 'root:root', ...targets]];
}

function buildIslandWriteAccessTargetPaths(appRoot: string): string[] {
  const paths = buildIslandPatchPaths(appRoot);

  return [paths.workbenchDirPath, paths.workbenchHtmlPath, paths.productJsonPath];
}

async function assertIslandHashProof(options: {
  appRoot: string;
  expectedProductWorkbenchChecksum: string;
  expectedWorkbenchChecksum: string;
}): Promise<void> {
  const status = await readIslandShellStatus({
    appRoot: options.appRoot,
    registered: false,
  });

  if (status.workbenchChecksum !== options.expectedWorkbenchChecksum) {
    throw new Error('Tyrian rejected write-access change: workbench hash changed after preflight.');
  }

  if (status.productWorkbenchChecksum !== options.expectedProductWorkbenchChecksum) {
    throw new Error(
      'Tyrian rejected write-access change: product checksum changed after preflight.'
    );
  }
}

async function verifyUnlocked(appRoot: string): Promise<void> {
  const writeAccess = await readIslandShellWriteAccess({ appRoot });

  if (!writeAccess.writable) {
    throw new Error('Tyrian failed to unlock VS Code app file write access.');
  }
}

async function applyIslandWriteAccessModes(appRoot: string): Promise<void> {
  const paths = buildIslandPatchPaths(appRoot);

  await fs.chmod(paths.workbenchDirPath, 0o700);
  await fs.chmod(paths.workbenchHtmlPath, 0o600);
  await fs.chmod(paths.productJsonPath, 0o600);
}

async function applyIslandPackageAccessModes(appRoot: string): Promise<void> {
  const paths = buildIslandPatchPaths(appRoot);

  await fs.chmod(paths.workbenchDirPath, 0o755);
  await fs.chmod(paths.workbenchHtmlPath, 0o644);
  await fs.chmod(paths.productJsonPath, 0o644);
}

async function verifyPackageAccessRestored(appRoot: string): Promise<void> {
  const paths = buildIslandPatchPaths(appRoot);
  const targets = [
    { filePath: paths.workbenchDirPath, mode: 0o755 },
    { filePath: paths.workbenchHtmlPath, mode: 0o644 },
    { filePath: paths.productJsonPath, mode: 0o644 },
  ];

  for (const target of targets) {
    const stats = await fs.stat(target.filePath);

    if (stats.uid !== 0 || stats.gid !== 0 || (stats.mode & 0o777) !== target.mode) {
      throw new Error('Tyrian failed to reset VS Code app file package access.');
    }
  }
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function runCommandSequence(commands: string[][], fallbackMessage: string): Promise<void> {
  for (const command of commands) {
    await runCommand(command, fallbackMessage);
  }
}

async function runCommand(command: string[], fallbackMessage: string): Promise<void> {
  const [executable, ...args] = command;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error((stderr || stdout).trim() || fallbackMessage));
        return;
      }

      resolve();
    });
  });
}
