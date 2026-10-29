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
 * @type {ReadonlyArray<{ product: 'vscode' | 'zed' | 'desktop'; tracked: boolean; sync: (root: string, options: { check: boolean }) => string[] }>}
 */
const GENERATORS = [
  { product: 'vscode', tracked: true, sync: syncGeneratedContracts },
  { product: 'vscode', tracked: true, sync: syncVscodeThemes },
  { product: 'vscode', tracked: false, sync: syncIslandCss },
  { product: 'vscode', tracked: false, sync: syncVscodePackageAssets },
  { product: 'vscode', tracked: true, sync: syncProductionFamilyPreview },
  { product: 'zed', tracked: true, sync: syncZedThemeFamily },
  { product: 'desktop', tracked: true, sync: syncTerminalThemeAssets },
  { product: 'desktop', tracked: true, sync: syncDesktopThemeAssets },
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
/** @type {Set<string>} */
const productNames = new Set(GENERATORS.map(({ product }) => product));
if (values.product !== undefined && !productNames.has(values.product)) {
  throw new Error(`Unknown product '${values.product}'. Use ${[...productNames].join(', ')}.`);
}
if (values.tracked && values.untracked) {
  throw new Error('--tracked and --untracked select disjoint generators; pass at most one.');
}

const selected = GENERATORS.filter(
  (generator) =>
    (values.product === undefined || generator.product === values.product) &&
    (!values.tracked || generator.tracked) &&
    (!values.untracked || !generator.tracked)
);
// A filter that matches nothing would otherwise pass as "nothing stale".
if (selected.length === 0) {
  throw new Error('The selected product has no generators matching the tracked filter.');
}
const stale = selected.flatMap(({ sync }) => sync(repoRoot, { check: values.check }));

if (stale.length > 0) {
  console.error(
    `Generated files are stale:\n${stale.map((file) => `  - ${file}`).join('\n')}\n` +
      'Run: bun run generate'
  );
  process.exitCode = 1;
}
