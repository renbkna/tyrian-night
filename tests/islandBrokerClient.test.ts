import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test } from 'bun:test';

import {
  buildIslandBrokerApplyCommand,
  buildIslandBrokerRestoreCommand,
  readIslandBrokerStatus,
} from '../apps/vscode/src/islandBrokerClient';

let testRoot: string;

beforeEach(async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-night-broker-client-test-'));
});

afterEach(async () => {
  await fs.rm(testRoot, { force: true, recursive: true });
});

test('broker discovery rejects user-owned broker paths instead of treating them as trusted', async () => {
  const pkexecPath = await writeExecutable('pkexec');
  const nodePath = await writeExecutable('node');
  const brokerPath = await writeExecutable('islandBroker.js');
  await fs.chmod(brokerPath, 0o777);
  const assetRoot = path.join(testRoot, 'assets');
  await fs.mkdir(assetRoot);
  await fs.chmod(assetRoot, 0o755);

  await expect(
    readIslandBrokerStatus({
      assetRoots: [assetRoot],
      brokerPaths: [brokerPath],
      nodePath,
      pkexecPath,
    })
  ).resolves.toEqual({
    available: false,
    reason: 'Tyrian Night system Island UI broker is not installed.',
  });
});

test('broker discovery reports missing pkexec before probing helper paths', async () => {
  await expect(
    readIslandBrokerStatus({
      assetRoots: [path.join(testRoot, 'missing-assets')],
      nodePath: await writeExecutable('node'),
      pkexecPath: path.join(testRoot, 'missing-pkexec'),
    })
  ).resolves.toEqual({
    available: false,
    reason: 'System privilege prompt is unavailable: pkexec was not found.',
  });
});

test('broker apply and restore commands carry caller ownership for user registry repair', () => {
  const broker = {
    available: true,
    assetRoot: '/usr/local/share/tyrian-night/vscode/island',
    brokerPath: '/usr/local/lib/tyrian-night/islandBroker.js',
    nodePath: '/usr/bin/node',
    pkexecPath: '/usr/bin/pkexec',
  } as const;

  expect(
    buildIslandBrokerApplyCommand({
      appRoot: '/usr/share/code/resources/app',
      broker,
      callerGid: 1000,
      callerUid: 1000,
      expectedProductWorkbenchChecksum: 'product-hash',
      expectedWorkbenchChecksum: 'workbench-hash',
      registryHome: '/home/ren',
      theme: 'Tyrian Night',
      themeVersion: 'test',
    })
  ).toEqual([
    '/usr/bin/pkexec',
    '/usr/bin/node',
    '/usr/local/lib/tyrian-night/islandBroker.js',
    'apply',
    '--app-root',
    '/usr/share/code/resources/app',
    '--asset-root',
    '/usr/local/share/tyrian-night/vscode/island',
    '--registry-home',
    '/home/ren',
    '--expected-workbench-checksum',
    'workbench-hash',
    '--expected-product-workbench-checksum',
    'product-hash',
    '--theme',
    'Tyrian Night',
    '--theme-version',
    'test',
    '--caller-uid',
    '1000',
    '--caller-gid',
    '1000',
  ]);

  expect(
    buildIslandBrokerRestoreCommand({
      appRoot: '/usr/share/code/resources/app',
      broker,
      callerGid: 1000,
      callerUid: 1000,
      registryHome: '/home/ren',
    })
  ).toEqual([
    '/usr/bin/pkexec',
    '/usr/bin/node',
    '/usr/local/lib/tyrian-night/islandBroker.js',
    'restore',
    '--app-root',
    '/usr/share/code/resources/app',
    '--registry-home',
    '/home/ren',
    '--caller-uid',
    '1000',
    '--caller-gid',
    '1000',
  ]);
});

async function writeExecutable(fileName: string): Promise<string> {
  const filePath = path.join(testRoot, fileName);
  await fs.writeFile(filePath, '#!/usr/bin/env sh\nexit 0\n', 'utf8');
  await fs.chmod(filePath, 0o755);
  return filePath;
}
