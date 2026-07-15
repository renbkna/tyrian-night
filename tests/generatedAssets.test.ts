import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { syncGeneratedAssets } from '../scripts/generatedAssets.mjs';

test('generated asset sync owns an exact file set without deleting mixed-directory sources', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-generated-assets-'));

  try {
    fs.mkdirSync(path.join(repoRoot, 'generated/nested'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'mixed'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'generated/stale.txt'), 'stale');
    fs.writeFileSync(path.join(repoRoot, 'generated/nested/stale.txt'), 'stale');
    fs.writeFileSync(path.join(repoRoot, 'mixed/base.css'), 'manual');
    fs.writeFileSync(path.join(repoRoot, 'mixed/old.generated.css'), 'stale');

    const assets = [
      { path: 'generated/current.txt', content: 'current\n' },
      { path: 'mixed/current.generated.css', content: 'generated\n' },
    ];
    const ownership = [
      { directory: 'generated' },
      { directory: 'mixed', match: /^[^/]+\.generated\.css$/u },
    ];

    expect(syncGeneratedAssets(assets, repoRoot, { check: true, ownership })).toEqual([
      'generated/current.txt',
      'generated/nested/stale.txt',
      'generated/stale.txt',
      'mixed/current.generated.css',
      'mixed/old.generated.css',
    ]);

    syncGeneratedAssets(assets, repoRoot, { ownership });

    expect(syncGeneratedAssets(assets, repoRoot, { check: true, ownership })).toEqual([]);
    expect(fs.existsSync(path.join(repoRoot, 'generated/nested'))).toBe(false);
    expect(fs.readFileSync(path.join(repoRoot, 'mixed/base.css'), 'utf8')).toBe('manual');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('generated asset sync never follows owned paths through symlinks', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-generated-symlink-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-generated-outside-'));

  try {
    const outsideFile = path.join(outsideRoot, 'outside.txt');
    fs.writeFileSync(outsideFile, 'outside\n');
    fs.mkdirSync(path.join(repoRoot, 'generated'));
    fs.symlinkSync(outsideFile, path.join(repoRoot, 'generated/current.txt'));

    expect(() =>
      syncGeneratedAssets([{ path: 'generated/current.txt', content: 'generated\n' }], repoRoot, {
        ownership: [{ directory: 'generated' }],
      })
    ).toThrow('Generated path must not contain symlinks');
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('outside\n');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('VS Code lane generator entrypoints resolve the repository independently of cwd', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-generator-cwd-'));

  try {
    for (const script of ['scripts/islandCss.mjs', 'scripts/vscodeThemes.mjs']) {
      execFileSync('node', [path.resolve(script), '--check'], { cwd, stdio: 'pipe' });
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }

  const vscodeGenerator = fs.readFileSync('scripts/vscodeThemes.mjs', 'utf8');
  expect(vscodeGenerator).toContain(
    'fileURLToPath(import.meta.url) === path.resolve(process.argv[1])'
  );
  expect(vscodeGenerator).not.toContain('if (import.meta.main)');
});
