// @ts-check

import path from 'node:path';
import { parseArgs } from 'node:util';

import { syncDesktopThemeAssets } from './desktopThemes.mjs';
import { syncGeneratedContracts } from './generatedContracts.mjs';
import { syncIslandCss } from './islandCss.mjs';
import { syncTerminalThemeAssets } from './terminalThemes.mjs';
import { syncProductionFamilyPreview } from './themePreview.mjs';
import { syncVscodePackageAssets } from './vscodePackageAssets.mjs';
import { syncVscodeThemes } from './vscodeThemes.mjs';
import { syncZedThemeFamily } from './zedTheme.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

/**
 * The generator registry. `tracked` outputs are committed because consumers
 * read them from the repository; the rest are build products.
 *
 * @type {ReadonlyArray<{ name: string; product: 'vscode' | 'zed' | 'desktop'; tracked: boolean; sync: (root: string, options: { check: boolean }) => string[] }>}
 */
const GENERATORS = [
  { name: 'contracts', product: 'vscode', tracked: true, sync: syncGeneratedContracts },
  { name: 'vscode-themes', product: 'vscode', tracked: true, sync: syncVscodeThemes },
  { name: 'island-css', product: 'vscode', tracked: false, sync: syncIslandCss },
  {
    name: 'vscode-package-assets',
    product: 'vscode',
    tracked: false,
    sync: syncVscodePackageAssets,
  },
  { name: 'theme-preview', product: 'vscode', tracked: true, sync: syncProductionFamilyPreview },
  { name: 'zed-theme', product: 'zed', tracked: true, sync: syncZedThemeFamily },
  { name: 'terminal-themes', product: 'desktop', tracked: false, sync: syncTerminalThemeAssets },
  { name: 'desktop-themes', product: 'desktop', tracked: false, sync: syncDesktopThemeAssets },
];

const { values } = parseArgs({
  options: {
    check: { type: 'boolean', default: false },
    tracked: { type: 'boolean', default: false },
    untracked: { type: 'boolean', default: false },
    product: { type: 'string' },
  },
  strict: true,
});
const productNames = new Set(GENERATORS.map(({ product }) => product));
if (values.product !== undefined && !productNames.has(/** @type {any} */ (values.product))) {
  throw new Error(`Unknown product '${values.product}'. Use ${[...productNames].join(', ')}.`);
}

const selected = GENERATORS.filter(
  (generator) =>
    (values.product === undefined || generator.product === values.product) &&
    (!values.tracked || generator.tracked) &&
    (!values.untracked || !generator.tracked)
);
const stale = selected.flatMap(({ sync }) => sync(repoRoot, { check: values.check }));

if (stale.length > 0) {
  console.error(
    `Generated files are stale:\n${stale.map((file) => `  - ${file}`).join('\n')}\n` +
      'Run: bun run generate'
  );
  process.exitCode = 1;
}
