import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test } from 'bun:test';

import {
  ISLAND_BROKER_ASSET_ROOT,
  ISLAND_BROKER_CSS_FILES,
  ISLAND_BROKER_LIB_ROOT,
  ISLAND_BROKER_SCRIPT_NAME,
  buildIslandBrokerInstallPlan,
} from '../scripts/installIslandBroker.mjs';
import { ISLAND_BROKER_INSTALL_CONTRACT } from '../scripts/islandBrokerInstallContract.mjs';

let testRoot: string;

beforeEach(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-night-broker-install-test-'));
});

afterEach(() => {
  fs.rmSync(testRoot, { force: true, recursive: true });
});

test('Island broker installer owns the root-owned system helper and asset targets', () => {
  writeBrokerSources(testRoot);

  const plan = buildIslandBrokerInstallPlan({ repoRoot: testRoot });

  expect(plan.apply).toBe(false);
  expect(plan.brokerPath).toBe(path.join(ISLAND_BROKER_LIB_ROOT, ISLAND_BROKER_SCRIPT_NAME));
  expect(plan.assetRoot).toBe(ISLAND_BROKER_ASSET_ROOT);
  expect(plan.files).toEqual([
    {
      source: path.join(testRoot, 'out', ISLAND_BROKER_SCRIPT_NAME),
      target: path.join(ISLAND_BROKER_LIB_ROOT, ISLAND_BROKER_SCRIPT_NAME),
      mode: 0o644,
    },
    ...ISLAND_BROKER_CSS_FILES.map((fileName) => ({
      source: path.join(testRoot, 'apps/vscode/island', fileName),
      target: path.join(ISLAND_BROKER_ASSET_ROOT, fileName),
      mode: 0o644,
    })),
  ]);
});

test('Island broker installer supports explicit package-manager target roots', () => {
  writeBrokerSources(testRoot);

  const plan = buildIslandBrokerInstallPlan({
    assetRoot: '/pkg/share/tyrian-night/vscode/island',
    brokerLibRoot: '/pkg/lib/tyrian-night',
    repoRoot: testRoot,
  });

  expect(plan.brokerPath).toBe(`/pkg/lib/tyrian-night/${ISLAND_BROKER_SCRIPT_NAME}`);
  expect(plan.files.map(({ target }) => target)).toContain(
    '/pkg/share/tyrian-night/vscode/island/tyrian-night.css'
  );
});

test('README broker install guidance stays aligned with the system install contract', () => {
  const readme = fs.readFileSync('README.md', 'utf8');

  for (const brokerLibRoot of ISLAND_BROKER_INSTALL_CONTRACT.brokerLibRoots) {
    expect(readme).toContain(path.join(brokerLibRoot, ISLAND_BROKER_SCRIPT_NAME));
  }

  for (const assetRoot of ISLAND_BROKER_INSTALL_CONTRACT.assetRoots) {
    expect(readme).toContain(assetRoot);
  }

  expect(readme).toContain('node scripts/installIslandBroker.mjs --apply');
  expect(readme).toContain('[apps/vscode/src/islandBroker.ts](apps/vscode/src/islandBroker.ts)');
});

function writeBrokerSources(root: string): void {
  fs.mkdirSync(path.join(root, 'out'), { recursive: true });
  fs.mkdirSync(path.join(root, 'apps/vscode/island'), { recursive: true });
  fs.writeFileSync(path.join(root, 'out', ISLAND_BROKER_SCRIPT_NAME), 'broker\n');

  for (const cssFile of ISLAND_BROKER_CSS_FILES) {
    fs.writeFileSync(path.join(root, 'apps/vscode/island', cssFile), 'css\n');
  }
}
