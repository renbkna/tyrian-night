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

/** The manifest receipt: exactly these fields, every one a string. */
const ISLAND_MANIFEST_FIELDS = [
  'desiredCssFile',
  'themeVersion',
  'installedAt',
  'appRoot',
  'upstreamWorkbenchChecksum',
  'upstreamProductChecksum',
  'cssChecksum',
  'patchedWorkbenchChecksum',
  'patchedProductChecksum',
] as const;

export type IslandManifest = Record<(typeof ISLAND_MANIFEST_FIELDS)[number], string>;

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

export type IslandSidecar = 'workbenchBackup' | 'productBackup' | 'stylesheet' | 'manifest';

/**
 * Every file Tyrian adds beside the workbench, in the order Apply writes them;
 * Restore removes exactly these.
 */
export function islandSidecarPathMap(
  paths: IslandPatchPaths
): Readonly<Record<IslandSidecar, string>> {
  return {
    workbenchBackup: paths.backupHtmlPath,
    productBackup: paths.backupProductJsonPath,
    stylesheet: paths.islandCssPath,
    manifest: paths.manifestPath,
  };
}

export function islandSidecarPaths(paths: IslandPatchPaths): string[] {
  return Object.values(islandSidecarPathMap(paths));
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

export function isIslandManifestShape(manifest: unknown): manifest is IslandManifest {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return false;
  const keys = Object.keys(manifest);
  return (
    keys.length === ISLAND_MANIFEST_FIELDS.length &&
    ISLAND_MANIFEST_FIELDS.every(
      (field) => typeof (manifest as Record<string, unknown>)[field] === 'string'
    ) &&
    isIslandCssAssetName((manifest as IslandManifest).desiredCssFile)
  );
}
