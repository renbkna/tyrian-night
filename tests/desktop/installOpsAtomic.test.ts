import { expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createBackup,
  discardBackup,
  findLatestBackup,
  installPath,
  removeStaleTemporaries,
  restoreBackup,
  writeFileAtomic,
} from '../../apps/desktop/src/installOps.mjs';

function withTempHome(prefix: string, action: (home: string) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    action(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('text and binary writes publish complete files durably and keep the target mode', () => {
  withTempHome('tyrian-atomic-write-', (home) => {
    const textPath = path.join(home, 'scheme.json');
    const binaryPath = path.join(home, 'nested/new/asset.bin');
    fs.writeFileSync(textPath, 'old generation\n');
    fs.chmodSync(textPath, 0o660);

    traceAtomicReplacement(textPath, 'old generation\n', 'new generation\n', () => {
      writeFileAtomic(textPath, 'new generation\n');
    });

    expect(fs.statSync(textPath).mode & 0o7777).toBe(0o660);
    writeFileAtomic(binaryPath, Buffer.from([0, 1, 2, 255]));
    expect(fs.readFileSync(binaryPath)).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(temporaryFilesBeside(textPath)).toEqual([]);
    expect(temporaryFilesBeside(binaryPath)).toEqual([]);
  });
});

test('a failed publication keeps the previous target and removes its stage', () => {
  withTempHome('tyrian-atomic-failure-', (home) => {
    const targetPath = path.join(home, 'config');
    fs.writeFileSync(targetPath, 'previous\n');
    const originalRename = fs.renameSync;
    fs.renameSync = (() => {
      throw new Error('injected rename failure');
    }) as typeof fs.renameSync;

    try {
      expect(() => writeFileAtomic(targetPath, 'next\n')).toThrow('injected rename failure');
    } finally {
      fs.renameSync = originalRename;
    }

    expect(fs.readFileSync(targetPath, 'utf8')).toBe('previous\n');
    expect(temporaryFilesBeside(targetPath)).toEqual([]);
  });
});

test('installation replaces links and directories as whole generations', () => {
  withTempHome('tyrian-atomic-types-', (home) => {
    const referentPath = path.join(home, 'referent.conf');
    const replacedLinkPath = path.join(home, 'replaced-link.conf');
    const installedLinkPath = path.join(home, 'installed-link');
    const sourceDirectory = path.join(home, 'source-directory');
    const targetDirectory = path.join(home, 'target-directory');
    fs.writeFileSync(referentPath, 'referent\n');

    fs.symlinkSync(path.basename(referentPath), replacedLinkPath);
    writeFileAtomic(replacedLinkPath, 'owned leaf\n');
    expect(fs.lstatSync(replacedLinkPath).isFile()).toBe(true);
    expect(fs.readFileSync(referentPath, 'utf8')).toBe('referent\n');

    fs.mkdirSync(installedLinkPath);
    installPath('link', referentPath, installedLinkPath);
    expect(fs.readlinkSync(installedLinkPath)).toBe(path.resolve(referentPath));

    fs.mkdirSync(sourceDirectory);
    fs.writeFileSync(path.join(sourceDirectory, 'theme.conf'), 'theme\n');
    fs.symlinkSync('theme.conf', path.join(sourceDirectory, 'current'));
    fs.mkdirSync(targetDirectory);
    fs.writeFileSync(path.join(targetDirectory, 'stale'), 'stale\n');
    installPath('copy', sourceDirectory, targetDirectory);
    expect(fs.readdirSync(targetDirectory).toSorted()).toEqual(['current', 'theme.conf']);
    expect(fs.readlinkSync(path.join(targetDirectory, 'current'))).toBe('theme.conf');
    expect(temporaryFilesBeside(targetDirectory)).toEqual([]);
  });
});

test('a backup restores files, links, directories, and absence exactly and repeatably', () => {
  withTempHome('tyrian-backup-roundtrip-', (home) => {
    const filePath = path.join(home, '.config/app/config');
    const linkPath = path.join(home, '.config/app/theme');
    const directoryPath = path.join(home, '.local/share/app');
    const absentPath = path.join(home, '.config/created-by-install');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'original\n');
    fs.symlinkSync('config', linkPath);
    fs.mkdirSync(directoryPath, { recursive: true });
    fs.writeFileSync(path.join(directoryPath, 'data'), 'original data\n');

    const backupRoot = createBackup(home, 'live-tyrian-apply', [
      filePath,
      linkPath,
      directoryPath,
      absentPath,
    ]);

    writeFileAtomic(filePath, 'installed\n');
    writeFileAtomic(linkPath, 'installed\n');
    installPath('copy', filePath, directoryPath);
    writeFileAtomic(absentPath, 'installed\n');

    expect(findLatestBackup(home)?.backupRoot).toBe(backupRoot);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      restoreBackup(home, backupRoot);

      expect(fs.readFileSync(filePath, 'utf8')).toBe('original\n');
      expect(fs.readlinkSync(linkPath)).toBe('config');
      expect(fs.readFileSync(path.join(directoryPath, 'data'), 'utf8')).toBe('original data\n');
      expect(fs.existsSync(absentPath)).toBe(false);
      expect(findLatestBackup(home)?.backupRoot).toBe(backupRoot);
    }

    discardBackup(backupRoot);
    expect(fs.readdirSync(path.dirname(backupRoot))).toEqual([]);
    expect(findLatestBackup(home)).toBeUndefined();
  });
});

test('a backup retired by an interrupted discard is never restorable and is swept later', () => {
  withTempHome('tyrian-backup-retired-', (home) => {
    const target = path.join(home, 'config');
    fs.writeFileSync(target, 'first\n');
    const retired = createBackup(home, 'live-tyrian-apply', [target]);
    const retiredName = `.${path.basename(retired)}.tyrian-${crypto.randomUUID()}.tmp`;
    fs.renameSync(retired, path.join(path.dirname(retired), retiredName));
    expect(findLatestBackup(home)).toBeUndefined();

    const current = createBackup(home, 'live-tyrian-apply', [target]);
    discardBackup(current);
    expect(fs.readdirSync(path.dirname(current))).toEqual([]);
  });
});

test('only complete backups are restorable and the newest one is latest', () => {
  withTempHome('tyrian-backup-latest-', (home) => {
    const target = path.join(home, 'config');
    fs.writeFileSync(target, 'first\n');
    const first = createBackup(home, 'live-tyrian-apply', [target]);
    writeFileAtomic(target, 'second\n');
    const second = createBackup(home, 'rice-layout-apply', [target]);
    fs.rmSync(path.join(second, 'manifest.json'));
    expect(findLatestBackup(home)?.backupRoot).toBe(first);

    const third = createBackup(home, 'rice-layout-apply', [target]);
    expect(findLatestBackup(home)).toMatchObject({
      backupRoot: third,
      manifest: { owner: 'rice-layout-apply' },
    });
  });
});

test('a backup manifest with fields outside its format is rejected', () => {
  withTempHome('tyrian-backup-format-', (home) => {
    const target = path.join(home, 'config');
    fs.writeFileSync(target, 'first\n');
    const backupRoot = createBackup(home, 'live-tyrian-apply', [target]);
    const manifestPath = path.join(backupRoot, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    fs.writeFileSync(manifestPath, `${JSON.stringify({ version: 1, ...manifest })}\n`);

    expect(() => findLatestBackup(home)).toThrow('Tyrian backup manifest is invalid');
  });
});

test('stale temporaries beside targets are removed and unrelated files kept', () => {
  withTempHome('tyrian-stale-temporaries-', (home) => {
    const target = path.join(home, '.config/foot/foot.ini');
    const stale = path.join(
      home,
      '.config/foot/.foot.ini.tyrian-0f0e0d0c-0b0a-4908-8706-050403020100.tmp'
    );
    const unrelated = path.join(home, '.config/foot/.foot.ini.bak');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(stale);
    fs.writeFileSync(unrelated, 'keep\n');

    removeStaleTemporaries([target]);

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('keep\n');
  });
});

test.skipIf(process.platform !== 'linux')(
  'desktop CLI mutations wait for the per-user lock while previews do not',
  async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-desktop-lock-'));
    const lockPath = path.join(home, '.local/state/tyrian-night/desktop.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    try {
      const holder = Bun.spawn(['flock', lockPath, 'sh', '-c', 'echo held; sleep 3'], {
        stdout: 'pipe',
      });
      await holder.stdout.getReader().read();
      const holderReleasedAt = holder.exited.then(() => Date.now());
      const cli = (args: string[]) =>
        Bun.spawn([process.execPath, 'apps/desktop/src/installLiveTyrian.mjs', ...args], {
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([name]) => !name.startsWith('XDG_'))
            ),
            HOME: home,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        });

      const preview = cli(['--target=caelestia', '--hyprland-mode=lua']);
      expect(await preview.exited).toBe(0);
      const previewFinishedAt = Date.now();

      const recover = cli(['--recover']);
      const [recoverExit, recoverOutput] = await Promise.all([
        recover.exited,
        new Response(recover.stdout).text(),
      ]);
      const recoverFinishedAt = Date.now();

      expect(previewFinishedAt).toBeLessThan(await holderReleasedAt);
      expect(recoverExit).toBe(0);
      expect(recoverOutput).toContain('No Tyrian backup to restore.');
      expect(recoverFinishedAt).toBeGreaterThanOrEqual(await holderReleasedAt);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
);

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
    if (path.resolve(String(newPath)) !== path.resolve(targetPath)) {
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

function temporaryFilesBeside(filePath: string): string[] {
  const prefix = `.${path.basename(filePath)}.`;
  return fs.readdirSync(path.dirname(filePath)).filter((entry) => entry.startsWith(prefix));
}
