import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import {
  applyIslandShell,
  applyIslandShellForPlatform,
  readIslandShellApplyReadinessForPlatform,
} from '../apps/vscode/src/islandShell';
import {
  ISLAND_APPLY_SUPPORTED_PLATFORMS,
  readIslandApplyPlatformSupport,
} from '../apps/vscode/src/islandPlatform';
import {
  buildIslandPatchPaths,
  buildManagedRootRecordPath,
  WORKBENCH_CHECKSUM_KEY,
  WORKBENCH_CSS_LINK,
} from '../apps/vscode/src/islandPatchContract';

test('Island apply support has one explicit platform authority', () => {
  expect(ISLAND_APPLY_SUPPORTED_PLATFORMS).toEqual(['linux']);
  expect(readIslandApplyPlatformSupport('linux')).toEqual({
    supported: true,
    platform: 'linux',
  });

  for (const platform of ['darwin', 'win32'] as const) {
    expect(readIslandApplyPlatformSupport(platform)).toMatchObject({
      supported: false,
      platform,
      reason: expect.stringContaining('only patches VS Code on Linux'),
    });
    expect(readIslandApplyPlatformSupport(platform).reason).toContain(
      'current managed installations'
    );
  }
});

test('unsupported apply fails before filesystem admission', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-island-platform-'));
  const appRoot = path.join(root, 'missing-app-root');
  const cssSourcePath = path.join(root, 'missing.css');
  const registryHome = path.join(root, 'registry');

  try {
    await expect(
      readIslandShellApplyReadinessForPlatform(
        { appRoot, cssSourcePath, themeVersion: 'test', registryHome },
        'win32'
      )
    ).resolves.toMatchObject({
      kind: 'unsupported',
      appRoot,
    });
    await expect(
      applyIslandShellForPlatform(
        { appRoot, cssSourcePath, themeVersion: 'test', registryHome },
        'win32'
      )
    ).rejects.toMatchObject({
      code: 'unsupported',
      changed: false,
    });
    await expect(fs.readdir(root)).resolves.toEqual([]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const [name, platform] of [
  ['classic restore dispatches through the portable v4 transaction path', 'darwin'],
  ['classic restore selects v4 on Linux when GNU mv lacks exchange', 'linux'],
] as const) {
  test.skipIf(process.platform !== 'linux')(name, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-island-no-exchange-restore-'));
    const appRoot = path.join(root, 'app');
    const registryHome = path.join(root, 'registry');
    const paths = buildIslandPatchPaths(appRoot);
    const originalHtml = `<html>\n\t<head>\n\t\t${WORKBENCH_CSS_LINK}\n\t</head>\n</html>\n`;
    const originalProduct = JSON.stringify(
      {
        checksums: {
          [WORKBENCH_CHECKSUM_KEY]: crypto
            .createHash('sha256')
            .update(originalHtml)
            .digest('base64')
            .replace(/=+$/u, ''),
        },
      },
      null,
      '\t'
    ).concat('\n');
    const cssSourcePath = path.join(root, 'island.css');
    const fakeBin = path.join(root, 'fake-bin');
    const fakeMvPath = path.join(fakeBin, 'mv');
    const fakeMvCallPath = path.join(root, 'unexpected-mv-call');

    try {
      await fs.mkdir(paths.workbenchDirPath, { recursive: true });
      await fs.mkdir(registryHome, { recursive: true });
      await fs.mkdir(fakeBin);
      await fs.writeFile(paths.workbenchHtmlPath, originalHtml, 'utf8');
      await fs.writeFile(paths.productJsonPath, originalProduct, 'utf8');
      await fs.writeFile(cssSourcePath, '.monaco-workbench { color: steelblue; }\n', 'utf8');
      await fs.writeFile(
        fakeMvPath,
        [
          '#!/bin/sh',
          'if [ "$1" = "--help" ]; then',
          "  printf 'usage: mv\\n'",
          '  exit 0',
          'fi',
          'printf "%s\\n" "$@" > "$TYRIAN_TEST_MV_CALL_PATH"',
          'exit 97',
          '',
        ].join('\n'),
        'utf8'
      );
      await fs.chmod(fakeMvPath, 0o755);

      await applyIslandShell({ appRoot, cssSourcePath, themeVersion: 'test', registryHome });
      expect(await fs.readFile(paths.workbenchHtmlPath, 'utf8')).not.toBe(originalHtml);

      const restoreProgram = [
        `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });`,
        `const island = await import(${JSON.stringify(path.resolve('apps/vscode/src/islandShell.ts'))});`,
        `const result = await island.restoreIslandShell(${JSON.stringify({ appRoot, registryHome })});`,
        'process.stdout.write(JSON.stringify(result));',
      ].join(' ');
      const child = Bun.spawn([process.execPath, '-e', restoreProgram], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: [fakeBin, process.env.PATH].filter(Boolean).join(path.delimiter),
          TYRIAN_TEST_MV_CALL_PATH: fakeMvCallPath,
        },
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(JSON.parse(stdout)).toMatchObject({
        active: false,
        status: { classification: 'clean', transaction: { kind: 'clean' } },
      });
      await expect(fs.readFile(paths.workbenchHtmlPath, 'utf8')).resolves.toBe(originalHtml);
      await expect(fs.readFile(paths.productJsonPath, 'utf8')).resolves.toBe(originalProduct);
      await expect(fs.readdir(paths.workbenchDirPath)).resolves.toEqual(['workbench.html']);
      await expect(fs.access(fakeMvCallPath)).rejects.toThrow();
      await expect(fs.access(paths.transactionJournalPath)).rejects.toThrow();
      expect(
        JSON.parse(await fs.readFile(buildManagedRootRecordPath(appRoot, registryHome), 'utf8'))
      ).toMatchObject({ appRoot, desiredThemeId: null });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
