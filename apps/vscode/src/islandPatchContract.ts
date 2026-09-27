import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

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
export const TYRIAN_STATE_DIR_NAME = '.tyrian-night';
export const MANAGED_ROOTS_DIRECTORY_NAME = 'managed-app-roots';
export const QUARANTINED_ROOTS_DIRECTORY_NAME = 'quarantined-managed-app-roots';
export const ISLAND_LOCK_FILE_NAME = 'island.lock';

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
};

export type IslandManifest = {
  desiredCssFile: string;
  themeVersion: string;
  installedAt: string;
  appRoot: string;
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
  };
}

export function buildManagedRootsDirectoryPath(registryHome = os.homedir()): string {
  return path.join(registryHome, TYRIAN_STATE_DIR_NAME, MANAGED_ROOTS_DIRECTORY_NAME);
}

export function buildQuarantinedRootsDirectoryPath(registryHome = os.homedir()): string {
  return path.join(registryHome, TYRIAN_STATE_DIR_NAME, QUARANTINED_ROOTS_DIRECTORY_NAME);
}

export function buildManagedRootRecordPath(appRoot: string, registryHome = os.homedir()): string {
  const recordName = crypto.hash('sha256', appRoot, 'hex');

  return path.join(buildManagedRootsDirectoryPath(registryHome), `${recordName}.json`);
}

/** The kernel lock that serializes every Island mutation of one user. */
export function buildIslandLockPath(registryHome = os.homedir()): string {
  return path.join(registryHome, TYRIAN_STATE_DIR_NAME, ISLAND_LOCK_FILE_NAME);
}

/** Desired styles name a bundled Island CSS asset; this is also the persisted desiredCssFile format. */
export function isIslandCssAssetName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.css$/u.test(name);
}

const ISLAND_MANIFEST_FIELDS = [
  'appRoot',
  'cssChecksum',
  'desiredCssFile',
  'installedAt',
  'ownedFiles',
  'patchedProductChecksum',
  'patchedWorkbenchChecksum',
  'themeVersion',
  'upstreamProductChecksum',
  'upstreamWorkbenchChecksum',
].join(',');

export function isIslandManifestShape(
  manifest: Partial<IslandManifest>
): manifest is IslandManifest {
  return (
    typeof manifest === 'object' &&
    manifest !== null &&
    Object.keys(manifest).toSorted().join(',') === ISLAND_MANIFEST_FIELDS &&
    typeof manifest.desiredCssFile === 'string' &&
    manifest.desiredCssFile.length > 0 &&
    typeof manifest.themeVersion === 'string' &&
    typeof manifest.installedAt === 'string' &&
    typeof manifest.appRoot === 'string' &&
    typeof manifest.upstreamWorkbenchChecksum === 'string' &&
    typeof manifest.upstreamProductChecksum === 'string' &&
    typeof manifest.cssChecksum === 'string' &&
    typeof manifest.patchedWorkbenchChecksum === 'string' &&
    typeof manifest.patchedProductChecksum === 'string' &&
    typeof manifest.ownedFiles === 'object' &&
    manifest.ownedFiles !== null &&
    typeof manifest.ownedFiles.stylesheet === 'string' &&
    typeof manifest.ownedFiles.manifest === 'string' &&
    typeof manifest.ownedFiles.workbenchBackup === 'string' &&
    typeof manifest.ownedFiles.productBackup === 'string'
  );
}
