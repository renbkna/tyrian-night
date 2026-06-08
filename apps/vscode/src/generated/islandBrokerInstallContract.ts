export const ISLAND_BROKER_INSTALL_CONTRACT = {
  brokerScriptName: 'islandBroker.js',
  defaultAssetRoot: '/usr/local/share/tyrian-night/vscode/island',
  defaultBrokerLibRoot: '/usr/local/lib/tyrian-night',
  assetRoots: [
    '/usr/share/tyrian-night/vscode/island',
    '/usr/local/share/tyrian-night/vscode/island',
  ],
  brokerLibRoots: ['/usr/lib/tyrian-night', '/usr/local/lib/tyrian-night'],
  chownPath: '/usr/bin/chown',
  nodePath: '/usr/bin/node',
  packageSlug: 'tyrian-night',
  pkexecPath: '/usr/bin/pkexec',
} as const;

export const ISLAND_BROKER_SCRIPT_NAME = ISLAND_BROKER_INSTALL_CONTRACT.brokerScriptName;
export const DEFAULT_ISLAND_BROKER_ASSET_ROOT = ISLAND_BROKER_INSTALL_CONTRACT.defaultAssetRoot;
export const DEFAULT_ISLAND_BROKER_LIB_ROOT = ISLAND_BROKER_INSTALL_CONTRACT.defaultBrokerLibRoot;
export const DEFAULT_ISLAND_BROKER_PATHS = [
  '/usr/lib/tyrian-night/islandBroker.js',
  '/usr/local/lib/tyrian-night/islandBroker.js',
] as const;
export const DEFAULT_ISLAND_BROKER_ASSET_ROOTS = ISLAND_BROKER_INSTALL_CONTRACT.assetRoots;
export const ISLAND_BROKER_CHOWN_PATH = ISLAND_BROKER_INSTALL_CONTRACT.chownPath;
export const ISLAND_BROKER_NODE_PATH = ISLAND_BROKER_INSTALL_CONTRACT.nodePath;
export const ISLAND_BROKER_PKEXEC_PATH = ISLAND_BROKER_INSTALL_CONTRACT.pkexecPath;
