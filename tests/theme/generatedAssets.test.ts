import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { syncGeneratedAssets } from '../../scripts/generatedAssets.mjs';

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

test('generated asset sync rejects an asset outside its declared ownership before writing', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-generated-ownership-'));

  try {
    // The trailing slash names the same directory.
    const ownership = [
      { directory: 'mixed/', match: /^[^/]+\.generated\.css$/u },
      { file: 'LICENSE' },
    ];
    const owned = [
      { path: 'mixed/current.generated.css', content: 'generated\n' },
      { path: 'LICENSE', content: 'license\n' },
    ];

    for (const stray of ['mixed/base.css', 'elsewhere/file.txt', 'LICENSE.md']) {
      expect(() =>
        syncGeneratedAssets([...owned, { path: stray, content: 'x' }], repoRoot, { ownership })
      ).toThrow(`Generated asset '${stray}' is outside its generator's declared ownership`);
    }
    expect(fs.readdirSync(repoRoot)).toEqual([]);

    syncGeneratedAssets(owned, repoRoot, { ownership });
    expect(syncGeneratedAssets(owned, repoRoot, { check: true, ownership })).toEqual([]);
    expect(syncGeneratedAssets(owned.slice(0, 1), repoRoot, { check: true, ownership })).toEqual([
      'LICENSE',
    ]);

    fs.writeFileSync(path.join(repoRoot, 'mixed/old.generated.css'), 'stale\n');
    expect(() =>
      syncGeneratedAssets([...owned, { path: 'mixed/base.css', content: 'x' }], repoRoot, {
        ownership,
      })
    ).toThrow('outside its generator');
    expect(fs.existsSync(path.join(repoRoot, 'mixed/old.generated.css'))).toBe(true);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('an owned file path holding a directory fails before anything is removed or written', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-generated-owned-directory-'));

  try {
    fs.mkdirSync(path.join(repoRoot, 'LICENSE'));
    fs.writeFileSync(path.join(repoRoot, 'LICENSE/keep.txt'), 'keep\n');
    const ownership = [{ file: 'LICENSE' }];

    for (const assets of [[], [{ path: 'LICENSE', content: 'license\n' }]]) {
      expect(() => syncGeneratedAssets(assets, repoRoot, { ownership })).toThrow(
        "Generated path must be a regular file: 'LICENSE'"
      );
      expect(fs.readFileSync(path.join(repoRoot, 'LICENSE/keep.txt'), 'utf8')).toBe('keep\n');
    }
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('generated asset sync admits every expected path before publishing any file', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-generated-symlink-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-generated-outside-'));

  try {
    const outsideFile = path.join(outsideRoot, 'outside.txt');
    fs.writeFileSync(outsideFile, 'outside\n');
    fs.mkdirSync(path.join(repoRoot, 'generated'));
    fs.writeFileSync(path.join(repoRoot, 'generated/first.txt'), 'first generation\n');
    fs.symlinkSync(outsideFile, path.join(repoRoot, 'generated/current.txt'));

    expect(() =>
      syncGeneratedAssets(
        [
          { path: 'generated/first.txt', content: 'replacement\n' },
          { path: 'generated/current.txt', content: 'generated\n' },
        ],
        repoRoot,
        {
          ownership: [{ directory: 'generated' }],
        }
      )
    ).toThrow('Generated path must not contain symlinks');
    expect(fs.readFileSync(path.join(repoRoot, 'generated/first.txt'), 'utf8')).toBe(
      'first generation\n'
    );
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('outside\n');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('the generator runner resolves the repository independently of cwd', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-generator-cwd-'));

  try {
    execFileSync('node', [path.resolve('scripts/generate.mjs'), '--check', '--tracked'], {
      cwd,
      stdio: 'pipe',
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('script entry points run when invoked through a symbolic link to the checkout', () => {
  const linkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-entry-link-'));
  const linkedCheckout = path.join(linkRoot, 'checkout');
  const cssPath = path.join(linkRoot, 'entry.css');

  try {
    fs.symlinkSync(process.cwd(), linkedCheckout);
    fs.writeFileSync(cssPath, 'body { color: red; }\n');
    const output = execFileSync(
      'node',
      [path.join(linkedCheckout, 'scripts/union/flattenCss.mjs'), cssPath],
      { encoding: 'utf8' }
    );
    expect(output).toBe('body { color: red; }\n');
  } finally {
    fs.rmSync(linkRoot, { recursive: true, force: true });
  }
});
