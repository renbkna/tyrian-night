// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ISLAND_BROKER_INSTALL_CONTRACT } from './islandBrokerInstallContract.mjs';
import { SOURCE_THEMES } from './themeSources.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ISLAND_BROKER_LIB_ROOT = ISLAND_BROKER_INSTALL_CONTRACT.defaultBrokerLibRoot;
export const ISLAND_BROKER_ASSET_ROOT = ISLAND_BROKER_INSTALL_CONTRACT.defaultAssetRoot;
export const ISLAND_BROKER_SCRIPT_NAME = ISLAND_BROKER_INSTALL_CONTRACT.brokerScriptName;
export const ISLAND_BROKER_CSS_FILES = SOURCE_THEMES.map((theme) => theme.islandCssFile);

/**
 * @typedef {{ source: string; target: string; mode: number }} InstallFile
 * @typedef {{
 *   apply: boolean;
 *   repoRoot: string;
 *   brokerPath: string;
 *   assetRoot: string;
 *   files: InstallFile[];
 * }} IslandBrokerInstallPlan
 */

/**
 * @param {{ repoRoot?: string; apply?: boolean; brokerLibRoot?: string; assetRoot?: string }} [options]
 * @returns {IslandBrokerInstallPlan}
 */
export function buildIslandBrokerInstallPlan(options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const brokerLibRoot = options.brokerLibRoot ?? ISLAND_BROKER_LIB_ROOT;
  const assetRoot = options.assetRoot ?? ISLAND_BROKER_ASSET_ROOT;
  const brokerPath = path.join(brokerLibRoot, ISLAND_BROKER_SCRIPT_NAME);

  return {
    apply: options.apply ?? false,
    repoRoot: root,
    brokerPath,
    assetRoot,
    files: [
      {
        source: path.join(root, 'out', ISLAND_BROKER_SCRIPT_NAME),
        target: brokerPath,
        mode: 0o644,
      },
      ...ISLAND_BROKER_CSS_FILES.map((fileName) => ({
        source: path.join(root, 'apps/vscode/island', fileName),
        target: path.join(assetRoot, fileName),
        mode: 0o644,
      })),
    ],
  };
}

/**
 * @param {{ repoRoot?: string; apply?: boolean; brokerLibRoot?: string; assetRoot?: string }} [options]
 * @returns {void}
 */
export function installIslandBroker(options = {}) {
  const plan = buildIslandBrokerInstallPlan(options);

  validateSources(plan);

  if (!plan.apply) {
    console.log(
      `Dry run complete. Re-run with --apply as root to install the Tyrian Night Island UI broker at ${plan.brokerPath}.`
    );
    return;
  }

  requireRoot();
  fs.mkdirSync(path.dirname(plan.brokerPath), { recursive: true, mode: 0o755 });
  fs.mkdirSync(plan.assetRoot, { recursive: true, mode: 0o755 });

  for (const file of plan.files) {
    fs.copyFileSync(file.source, file.target);
    fs.chmodSync(file.target, file.mode);
    fs.chownSync(file.target, 0, 0);
  }

  fs.chmodSync(path.dirname(plan.brokerPath), 0o755);
  fs.chmodSync(plan.assetRoot, 0o755);
  fs.chownSync(path.dirname(plan.brokerPath), 0, 0);
  fs.chownSync(plan.assetRoot, 0, 0);

  console.log(`Tyrian Night Island UI broker installed at ${plan.brokerPath}.`);
}

/**
 * @param {IslandBrokerInstallPlan} plan
 * @returns {void}
 */
function validateSources(plan) {
  for (const file of plan.files) {
    if (!fs.existsSync(file.source)) {
      throw new Error(`Missing Tyrian Island broker install source: ${file.source}`);
    }
  }
}

function requireRoot() {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    throw new Error('Tyrian Night Island broker install must run as root.');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  installIslandBroker({
    apply: process.argv.includes('--apply'),
    repoRoot: process.cwd(),
    brokerLibRoot: readFlag('--broker-lib-root') ?? ISLAND_BROKER_LIB_ROOT,
    assetRoot: readFlag('--asset-root') ?? ISLAND_BROKER_ASSET_ROOT,
  });
}

/**
 * @param {string} name
 * @returns {string | undefined}
 */
function readFlag(name) {
  const index = process.argv.indexOf(name);

  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}
