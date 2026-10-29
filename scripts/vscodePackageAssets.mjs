// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { syncGeneratedAssets } from './generatedAssets.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const PACKAGE_ROOT = 'apps/vscode';
/** Repository files copied into the VS Code package, by path inside the package. */
export const VSCODE_PACKAGE_COPIED_FILES = Object.freeze({
  LICENSE: 'LICENSE',
  'assets/icon.png': 'assets/icon.png',
});
const PACKAGE_ASSETS = Object.entries(VSCODE_PACKAGE_COPIED_FILES).map(([target, source]) => ({
  source,
  target: `${PACKAGE_ROOT}/${target}`,
}));

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
    {
      check: options.check,
      ownership: PACKAGE_ASSETS.map(({ target }) => ({ file: target })),
    }
  );
}
