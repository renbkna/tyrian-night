import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test } from 'bun:test';

import {
  runIslandPackageAccessRestore,
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
  const chmodPath = await writeExecutable('chmod');
  const chownPath = await writeExecutable('chown');
  const pkexecPath = await writeExecutable('pkexec');

  await expect(
    readIslandWriteAccessStatus({
      chmodPath,
      chownPath,
      pkexecPath,
    })
  ).resolves.toEqual({
    available: true,
    chmodPath,
    chownPath,
    pkexecPath,
  });
});

test('write-access discovery reports missing system tools without requiring Tyrian broker install', async () => {
  await expect(
    readIslandWriteAccessStatus({
      chmodPath: await writeExecutable('chmod'),
      chownPath: await writeExecutable('chown'),
      pkexecPath: path.join(testRoot, 'missing-pkexec'),
    })
  ).resolves.toEqual({
    available: false,
    reason: 'System privilege prompt is unavailable: pkexec was not found.',
  });

  await expect(
    readIslandWriteAccessStatus({
      chmodPath: await writeExecutable('chmod-2'),
      chownPath: path.join(testRoot, 'missing-chown'),
      pkexecPath: await writeExecutable('pkexec-2'),
    })
  ).resolves.toEqual({
    available: false,
    reason: 'System ownership tool is unavailable: chown was not found.',
  });

  await expect(
    readIslandWriteAccessStatus({
      chmodPath: path.join(testRoot, 'missing-chmod'),
      chownPath: await writeExecutable('chown-3'),
      pkexecPath: await writeExecutable('pkexec-3'),
    })
  ).resolves.toEqual({
    available: false,
    reason: 'System mode tool is unavailable: chmod was not found.',
  });
});

test('standalone write-access unlock rejects caller-owned app roots before privilege prompt', async () => {
  const appRoot = await createAppRoot('unlock-insecure-app-root');
  const paths = buildIslandPatchPaths(appRoot);
  const html = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const pkexecPath = await writePkexecRecorder('pkexec-insecure-unlock.log');

  await expect(
    runIslandWriteAccessUnlock({
      appRoot,
      callerGid: typeof process.getgid === 'function' ? process.getgid() : 1000,
      callerUid: typeof process.getuid === 'function' ? process.getuid() : 1000,
      expectedProductWorkbenchChecksum: sha256Base64(html),
      expectedWorkbenchChecksum: sha256Base64(html),
      writeAccess: {
        available: true,
        chmodPath: '/usr/bin/chmod',
        chownPath: '/usr/bin/chown',
        pkexecPath,
      },
    })
  ).rejects.toThrow('Tyrian rejected write-access change: VS Code app root');
  await expect(fs.stat(`${pkexecPath}.calls`)).rejects.toThrow();
});

test('package-access reset rejects caller-owned app roots before privilege prompt', async () => {
  const appRoot = await createAppRoot('restore-access-insecure-app-root');
  const paths = buildIslandPatchPaths(appRoot);
  const html = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const pkexecPath = await writePkexecRecorder('pkexec-insecure-restore.log');

  await expect(
    runIslandPackageAccessRestore({
      appRoot,
      expectedProductWorkbenchChecksum: sha256Base64(html),
      expectedWorkbenchChecksum: sha256Base64(html),
      writeAccess: {
        available: true,
        chmodPath: '/usr/bin/chmod',
        chownPath: '/usr/bin/chown',
        pkexecPath,
      },
    })
  ).rejects.toThrow('Tyrian rejected write-access change: VS Code app root');
  await expect(fs.stat(`${pkexecPath}.calls`)).rejects.toThrow();
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
