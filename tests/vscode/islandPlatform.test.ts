import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { readIslandPlatformSupport } from '../../apps/vscode/src/islandPlatform.js';
import {
  applyIslandShell,
  readIslandShellApplyReadiness,
  restoreIslandShell,
} from '../../apps/vscode/src/islandShell.js';

async function withPlatform<T>(platform: NodeJS.Platform, action: () => Promise<T>): Promise<T> {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
  try {
    return await action();
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
  }
}

test('Island UI is supported on the desktop VS Code platforms only', async () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    expect(await withPlatform(platform, async () => readIslandPlatformSupport())).toEqual({
      supported: true,
    });
  }
  for (const platform of ['freebsd', 'aix'] as const) {
    const support = await withPlatform(platform, async () => readIslandPlatformSupport());
    if (support.supported) throw new Error(`${platform} must not support Island UI.`);
    expect(support.reason).toContain(`unsupported on '${platform}'`);
  }
});

test('every Island mutation is unsupported on other platforms before filesystem admission', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-island-platform-'));
  const appRoot = path.join(root, 'missing-app-root');
  const cssSourcePath = path.join(root, 'missing.css');
  const registryHome = path.join(root, 'registry');

  try {
    await withPlatform('freebsd', async () => {
      await expect(
        readIslandShellApplyReadiness({
          appRoot,
          cssSourcePath,
          themeVersion: 'test',
          registryHome,
        })
      ).resolves.toMatchObject({ kind: 'unsupported', appRoot });
      await expect(
        applyIslandShell({ appRoot, cssSourcePath, themeVersion: 'test', registryHome })
      ).rejects.toMatchObject({ code: 'unsupported', changed: false });
      await expect(restoreIslandShell({ appRoot, registryHome })).rejects.toMatchObject({
        code: 'unsupported',
        changed: false,
      });
    });
    await expect(fs.readdir(root)).resolves.toEqual([]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
