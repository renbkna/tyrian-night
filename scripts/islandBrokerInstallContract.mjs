// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @typedef {{
 *   brokerScriptName: string;
 *   defaultAssetRoot: string;
 *   defaultBrokerLibRoot: string;
 *   assetRoots: string[];
 *   brokerLibRoots: string[];
 *   chownPath: string;
 *   nodePath: string;
 *   packageSlug: string;
 *   pkexecPath: string;
 * }} IslandBrokerInstallContract
 */

export const ISLAND_BROKER_INSTALL_CONTRACT = /** @type {IslandBrokerInstallContract} */ (
  JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'source/islandBrokerInstallContract.json'), 'utf8')
  )
);
