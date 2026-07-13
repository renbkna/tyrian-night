import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const ISLAND_PATCH_CONTRACT_VERSION = 3;
export const ISLAND_PATCH_STRATEGY = 'stylesheet-link-v1';

export const WORKBENCH_DIR_RELATIVE_PATH = path.join(
  'out',
  'vs',
  'code',
  'electron-browser',
  'workbench'
);
export const WORKBENCH_HTML_RELATIVE_PATH = path.join(
  WORKBENCH_DIR_RELATIVE_PATH,
  'workbench.html'
);
export const PRODUCT_JSON_RELATIVE_PATH = 'product.json';
export const WORKBENCH_CHECKSUM_KEY = 'vs/code/electron-browser/workbench/workbench.html';
export const WORKBENCH_CSS_LINK =
  '<link rel="stylesheet" href="../../../workbench/workbench.desktop.main.css">';

export const ISLAND_CSS_FILE_NAME = 'tyrian-night.island.css';
export const ISLAND_MANIFEST_FILE_NAME = 'tyrian-night.island.json';
export const BACKUP_HTML_FILE_NAME = 'tyrian-night.workbench.backup.html';
export const BACKUP_PRODUCT_FILE_NAME = 'tyrian-night.product.backup.json';
export const ISLAND_TRANSACTION_FILE_NAME = 'tyrian-night.transaction.json';
export const TYRIAN_STATE_DIR_NAME = '.tyrian-night';
export const MANAGED_ROOTS_DIRECTORY_NAME = 'managed-app-roots';
export const QUARANTINED_ROOTS_DIRECTORY_NAME = 'quarantined-managed-app-roots';
export const LEGACY_RETIREMENT_FILE_NAME = 'managed-app-roots.retired.json';
export const LEGACY_MANAGED_ROOTS_FILE_NAME = 'managed-app-roots.json';
export const ISLAND_ROOT_LOCK_NAME = '.tyrian-night.lock';
export const ISLAND_REGISTRY_LOCK_NAME = 'tyrian-night-managed-app-roots';

export const TYRIAN_MARKER_START = '<!-- Tyrian Night Island Start -->';
export const TYRIAN_MARKER_END = '<!-- Tyrian Night Island End -->';

export type IslandPatchPaths = {
  workbenchDirPath: string;
  workbenchHtmlPath: string;
  productJsonPath: string;
  islandCssPath: string;
  manifestPath: string;
  backupHtmlPath: string;
  backupProductJsonPath: string;
  transactionJournalPath: string;
};

export type IslandManifestV3 = {
  version: 3;
  desiredThemeId: string;
  themeVersion: string;
  installedAt: string;
  appRoot: string;
  patchStrategy: typeof ISLAND_PATCH_STRATEGY;
  upstreamWorkbenchChecksum: string;
  upstreamProductChecksum: string;
  cssChecksum: string;
  patchedWorkbenchChecksum: string;
  patchedProductChecksum: string;
  ownedFiles: {
    stylesheet: string;
    manifest: string;
    workbenchBackup: string;
    productBackup: string;
  };
};

export function buildIslandPatchPaths(appRoot: string): IslandPatchPaths {
  const workbenchDirPath = path.join(appRoot, WORKBENCH_DIR_RELATIVE_PATH);

  return {
    workbenchDirPath,
    workbenchHtmlPath: path.join(appRoot, WORKBENCH_HTML_RELATIVE_PATH),
    productJsonPath: path.join(appRoot, PRODUCT_JSON_RELATIVE_PATH),
    islandCssPath: path.join(workbenchDirPath, ISLAND_CSS_FILE_NAME),
    manifestPath: path.join(workbenchDirPath, ISLAND_MANIFEST_FILE_NAME),
    backupHtmlPath: path.join(workbenchDirPath, BACKUP_HTML_FILE_NAME),
    backupProductJsonPath: path.join(workbenchDirPath, BACKUP_PRODUCT_FILE_NAME),
    transactionJournalPath: path.join(workbenchDirPath, ISLAND_TRANSACTION_FILE_NAME),
  };
}

export function buildManagedRootsDirectoryPath(registryHome = os.homedir()): string {
  return path.join(registryHome, TYRIAN_STATE_DIR_NAME, MANAGED_ROOTS_DIRECTORY_NAME);
}

export function buildQuarantinedRootsDirectoryPath(registryHome = os.homedir()): string {
  return path.join(registryHome, TYRIAN_STATE_DIR_NAME, QUARANTINED_ROOTS_DIRECTORY_NAME);
}

export function buildLegacyRetirementMarkerPath(registryHome = os.homedir()): string {
  return path.join(registryHome, TYRIAN_STATE_DIR_NAME, LEGACY_RETIREMENT_FILE_NAME);
}

export function buildLegacyManagedRootsRegistryPath(registryHome = os.homedir()): string {
  return path.join(registryHome, TYRIAN_STATE_DIR_NAME, LEGACY_MANAGED_ROOTS_FILE_NAME);
}

export function buildManagedRootRecordPath(appRoot: string, registryHome = os.homedir()): string {
  const recordName = crypto.createHash('sha256').update(appRoot, 'utf8').digest('hex');

  return path.join(buildManagedRootsDirectoryPath(registryHome), `${recordName}.json`);
}

export function buildIslandRootLockPath(appRoot: string): string {
  return path.join(appRoot, WORKBENCH_DIR_RELATIVE_PATH, ISLAND_ROOT_LOCK_NAME);
}

export function buildIslandRegistryLockPath(registryHome = os.homedir()): string {
  const identity = crypto.createHash('sha256').update(registryHome, 'utf8').digest('hex');
  return path.join(os.tmpdir(), `.${ISLAND_REGISTRY_LOCK_NAME}-${identity}.lock`);
}

export function isIslandManifestV3Shape(
  manifest: Partial<IslandManifestV3>
): manifest is IslandManifestV3 {
  return (
    manifest.version === ISLAND_PATCH_CONTRACT_VERSION &&
    typeof manifest.desiredThemeId === 'string' &&
    manifest.desiredThemeId.length > 0 &&
    typeof manifest.themeVersion === 'string' &&
    typeof manifest.installedAt === 'string' &&
    typeof manifest.appRoot === 'string' &&
    manifest.patchStrategy === ISLAND_PATCH_STRATEGY &&
    typeof manifest.upstreamWorkbenchChecksum === 'string' &&
    typeof manifest.upstreamProductChecksum === 'string' &&
    typeof manifest.cssChecksum === 'string' &&
    typeof manifest.patchedWorkbenchChecksum === 'string' &&
    typeof manifest.patchedProductChecksum === 'string' &&
    typeof manifest.ownedFiles?.stylesheet === 'string' &&
    typeof manifest.ownedFiles.manifest === 'string' &&
    typeof manifest.ownedFiles.workbenchBackup === 'string' &&
    typeof manifest.ownedFiles.productBackup === 'string'
  );
}
