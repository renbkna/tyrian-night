import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test } from 'bun:test';

import {
  buildIslandPackageAccessRestoreCommands,
  buildIslandWriteAccessUnlockCommands,
  runIslandWriteAccessUnlock,
  readIslandWriteAccessStatus,
} from '../apps/vscode/src/islandWriteAccessClient';
import {
  WORKBENCH_CHECKSUM_KEY,
  WORKBENCH_CSS_LINK,
  buildIslandPatchPaths,
} from '../apps/vscode/src/islandPatchContract';

let testRoot: string;

beforeEach(async () => {
  testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-night-write-access-test-'));
});

afterEach(async () => {
  await fs.rm(testRoot, { force: true, recursive: true });
});

test('write-access discovery depends only on system privilege and ownership tools', async () => {
  const chownPath = await writeExecutable('chown');
  const pkexecPath = await writeExecutable('pkexec');

  await expect(
    readIslandWriteAccessStatus({
      chownPath,
      pkexecPath,
    })
  ).resolves.toEqual({
    available: true,
    chownPath,
    pkexecPath,
  });
});

test('write-access discovery reports missing system tools without requiring Tyrian broker install', async () => {
  await expect(
    readIslandWriteAccessStatus({
      chownPath: await writeExecutable('chown'),
      pkexecPath: path.join(testRoot, 'missing-pkexec'),
    })
  ).resolves.toEqual({
    available: false,
    reason: 'System privilege prompt is unavailable: pkexec was not found.',
  });

  await expect(
    readIslandWriteAccessStatus({
      chownPath: path.join(testRoot, 'missing-chown'),
      pkexecPath: await writeExecutable('pkexec-2'),
    })
  ).resolves.toEqual({
    available: false,
    reason: 'System ownership tool is unavailable: chown was not found.',
  });
});

test('standalone write-access unlock uses one pkexec ownership prompt', () => {
  const writeAccess = {
    available: true,
    chownPath: '/usr/bin/chown',
    pkexecPath: '/usr/bin/pkexec',
  } as const;

  expect(
    buildIslandWriteAccessUnlockCommands({
      appRoot: '/usr/share/code/resources/app',
      callerGid: 1000,
      callerUid: 1000,
      writeAccess,
    })
  ).toEqual([
    [
      '/usr/bin/pkexec',
      '/usr/bin/chown',
      '1000:1000',
      '/usr/share/code/resources/app/out/vs/code/electron-browser/workbench',
      '/usr/share/code/resources/app/out/vs/code/electron-browser/workbench/workbench.html',
      '/usr/share/code/resources/app/product.json',
    ],
  ]);
});

test('standalone write-access unlock applies chmod locally after ownership unlock', async () => {
  const localRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'tyrian-night-write-access-unlock-test-')
  );

  try {
    const appRoot = await createAppRoot('unlock-local-chmod', localRoot);
    const paths = buildIslandPatchPaths(appRoot);
    const pkexecPath = await writePkexecRecorder('pkexec-unlock.log', localRoot);
    const html = await fs.readFile(paths.workbenchHtmlPath, 'utf8');

    await fs.chmod(paths.workbenchDirPath, 0o500);
    await fs.chmod(paths.workbenchHtmlPath, 0o400);
    await fs.chmod(paths.productJsonPath, 0o400);

    await expect(
      runIslandWriteAccessUnlock({
        appRoot,
        callerGid: typeof process.getgid === 'function' ? process.getgid() : 1000,
        callerUid: typeof process.getuid === 'function' ? process.getuid() : 1000,
        expectedProductWorkbenchChecksum: sha256Base64(html),
        expectedWorkbenchChecksum: sha256Base64(html),
        writeAccess: {
          available: true,
          chownPath: '/usr/bin/chown',
          pkexecPath,
        },
      })
    ).resolves.toMatchObject({
      action: 'unlock',
      changed: true,
    });

    expect((await fs.stat(paths.workbenchDirPath)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(paths.workbenchHtmlPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(paths.productJsonPath)).mode & 0o777).toBe(0o600);
  } finally {
    await fs.rm(localRoot, { force: true, recursive: true });
  }
});

test('package-access reset uses one pkexec ownership prompt', () => {
  const writeAccess = {
    available: true,
    chownPath: '/usr/bin/chown',
    pkexecPath: '/usr/bin/pkexec',
  } as const;

  expect(
    buildIslandPackageAccessRestoreCommands({
      appRoot: '/usr/share/code/resources/app',
      writeAccess,
    })
  ).toEqual([
    [
      '/usr/bin/pkexec',
      '/usr/bin/chown',
      'root:root',
      '/usr/share/code/resources/app/out/vs/code/electron-browser/workbench',
      '/usr/share/code/resources/app/out/vs/code/electron-browser/workbench/workbench.html',
      '/usr/share/code/resources/app/product.json',
    ],
  ]);
});

async function createAppRoot(name: string, root = testRoot): Promise<string> {
  const appRoot = path.join(root, name);
  const paths = buildIslandPatchPaths(appRoot);
  const html = `<html>
\t<head>
\t\t${WORKBENCH_CSS_LINK}
\t</head>
</html>
`;

  await fs.mkdir(paths.workbenchDirPath, { recursive: true });
  await fs.writeFile(paths.workbenchHtmlPath, html, 'utf8');
  await fs.writeFile(
    paths.productJsonPath,
    JSON.stringify(
      {
        checksums: {
          [WORKBENCH_CHECKSUM_KEY]: sha256Base64(html),
        },
      },
      null,
      '\t'
    ).concat('\n'),
    'utf8'
  );

  return appRoot;
}

async function writeExecutable(fileName: string): Promise<string> {
  const filePath = path.join(testRoot, fileName);
  await fs.writeFile(filePath, '#!/usr/bin/env sh\nexit 0\n', 'utf8');
  await fs.chmod(filePath, 0o755);
  return filePath;
}

async function writePkexecRecorder(fileName: string, root = testRoot): Promise<string> {
  const filePath = path.join(root, fileName);

  await fs.writeFile(
    filePath,
    `#!/usr/bin/env sh
printf '%s\\n' "$*" >> "$0.calls"
exit 0
`,
    'utf8'
  );
  await fs.chmod(filePath, 0o755);
  return filePath;
}

function sha256Base64(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('base64').replace(/=+$/, '');
}
