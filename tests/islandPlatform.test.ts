import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import {
  applyIslandShellForPlatform,
  readIslandShellApplyReadinessForPlatform,
} from '../apps/vscode/src/islandShell';
import {
  ISLAND_APPLY_SUPPORTED_PLATFORMS,
  readIslandApplyPlatformSupport,
} from '../apps/vscode/src/islandPlatform';

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
