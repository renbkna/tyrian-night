import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';

import {
  DEFAULT_ISLAND_BROKER_ASSET_ROOTS,
  DEFAULT_ISLAND_BROKER_PATHS,
  ISLAND_BROKER_NODE_PATH,
  ISLAND_BROKER_PKEXEC_PATH,
} from './generated/islandBrokerInstallContract.js';
import { getSecureSystemPathIssue } from './islandPathSecurity.js';
import { buildCallerOwnershipArgs } from './islandProcessIdentity.js';

export type IslandBrokerStatus =
  | {
      available: true;
      assetRoot: string;
      brokerPath: string;
      nodePath: string;
      pkexecPath: string;
    }
  | {
      available: false;
      reason: string;
    };

export type IslandBrokerApplyResult = {
  action: 'apply';
  changed: boolean;
};

export type IslandBrokerRestoreResult = {
  action: 'restore';
  changed: boolean;
};

export async function readIslandBrokerStatus(options?: {
  assetRoots?: string[];
  brokerPaths?: string[];
  nodePath?: string;
  pkexecPath?: string;
}): Promise<IslandBrokerStatus> {
  const pkexecPath = options?.pkexecPath ?? ISLAND_BROKER_PKEXEC_PATH;
  const nodePath = options?.nodePath ?? ISLAND_BROKER_NODE_PATH;

  if (!(await isExecutable(pkexecPath))) {
    return {
      available: false,
      reason: 'System privilege prompt is unavailable: pkexec was not found.',
    };
  }

  if (!(await isExecutable(nodePath))) {
    return {
      available: false,
      reason: 'Tyrian Night system broker runtime is unavailable: node was not found.',
    };
  }

  const brokerPath = await findSecurePath([
    ...(options?.brokerPaths ?? DEFAULT_ISLAND_BROKER_PATHS),
  ]);

  if (!brokerPath) {
    return {
      available: false,
      reason: 'Tyrian Night system Island UI broker is not installed.',
    };
  }

  const assetRoot = await findSecurePath([
    ...(options?.assetRoots ?? DEFAULT_ISLAND_BROKER_ASSET_ROOTS),
  ]);

  if (!assetRoot) {
    return {
      available: false,
      reason: 'Tyrian Night system Island UI assets are not installed.',
    };
  }

  return {
    available: true,
    assetRoot,
    brokerPath,
    nodePath,
    pkexecPath,
  };
}

export async function runIslandBrokerApply(options: {
  appRoot: string;
  broker: Extract<IslandBrokerStatus, { available: true }>;
  expectedProductWorkbenchChecksum: string;
  expectedWorkbenchChecksum: string;
  theme: string;
  themeVersion: string;
}): Promise<IslandBrokerApplyResult> {
  return runBrokerCommand<IslandBrokerApplyResult>(buildIslandBrokerApplyCommand(options));
}

export async function runIslandBrokerRestore(options: {
  appRoot: string;
  broker: Extract<IslandBrokerStatus, { available: true }>;
}): Promise<IslandBrokerRestoreResult> {
  return runBrokerCommand<IslandBrokerRestoreResult>(buildIslandBrokerRestoreCommand(options));
}

export function buildIslandBrokerApplyCommand(options: {
  appRoot: string;
  broker: Extract<IslandBrokerStatus, { available: true }>;
  callerGid?: number;
  callerUid?: number;
  expectedProductWorkbenchChecksum: string;
  expectedWorkbenchChecksum: string;
  registryHome?: string;
  theme: string;
  themeVersion: string;
}): string[] {
  return [
    options.broker.pkexecPath,
    options.broker.nodePath,
    options.broker.brokerPath,
    'apply',
    '--app-root',
    options.appRoot,
    '--asset-root',
    options.broker.assetRoot,
    '--registry-home',
    options.registryHome ?? os.homedir(),
    '--expected-workbench-checksum',
    options.expectedWorkbenchChecksum,
    '--expected-product-workbench-checksum',
    options.expectedProductWorkbenchChecksum,
    '--theme',
    options.theme,
    '--theme-version',
    options.themeVersion,
    ...buildCallerOwnershipArgs(options),
  ];
}

export function buildIslandBrokerRestoreCommand(options: {
  appRoot: string;
  broker: Extract<IslandBrokerStatus, { available: true }>;
  callerGid?: number;
  callerUid?: number;
  registryHome?: string;
}): string[] {
  return [
    options.broker.pkexecPath,
    options.broker.nodePath,
    options.broker.brokerPath,
    'restore',
    '--app-root',
    options.appRoot,
    '--registry-home',
    options.registryHome ?? os.homedir(),
    ...buildCallerOwnershipArgs(options),
  ];
}

async function runBrokerCommand<T>(command: string[]): Promise<T> {
  const [executable, ...args] = command;

  return new Promise((resolve, reject) => {
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
        reject(new Error((stderr || stdout).trim() || 'Tyrian Night broker failed.'));
        return;
      }

      try {
        resolve(JSON.parse(stdout) as T);
      } catch (error) {
        reject(
          new Error(
            `Tyrian Night broker returned invalid output: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
      }
    });
  });
}

async function findSecurePath(paths: string[]): Promise<string | undefined> {
  for (const filePath of paths) {
    if (await isSecureSystemPath(filePath)) {
      return filePath;
    }
  }

  return undefined;
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isSecureSystemPath(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);

    return getSecureSystemPathIssue(stats, filePath) === undefined;
  } catch {
    return false;
  }
}
