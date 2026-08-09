// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { syncGeneratedAssets } from './generatedAssets.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const PACKAGE_ASSETS = [
  { source: 'LICENSE', target: 'apps/vscode/LICENSE' },
  { source: 'assets/icon.png', target: 'apps/vscode/assets/icon.png' },
];

/**
 * @param {string} [root]
 * @param {{ check?: boolean }} [options]
 * @returns {string[]}
 */
export function syncVscodePackageAssets(root = repoRoot, options = {}) {
  return syncGeneratedAssets(
    PACKAGE_ASSETS.map(({ source, target }) => ({
      path: target,
      content: fs.readFileSync(path.join(root, source)),
    })),
    root,
    { check: options.check }
  );
}

if (process.argv[1] === import.meta.filename) {
  const stale = syncVscodePackageAssets(repoRoot, {
    check: process.argv.includes('--check'),
  });

  if (process.argv.includes('--check') && stale.length > 0) {
    console.error(`VS Code package assets are stale: ${stale.join(', ')}`);
    process.exit(1);
  }
}
