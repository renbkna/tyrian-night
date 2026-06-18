import os from 'node:os';
import path from 'node:path';

export const ISLAND_PATCH_CONTRACT_VERSION = 2;
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
export const MANAGED_ROOTS_DIR_NAME = '.tyrian-night';
export const MANAGED_ROOTS_FILE_NAME = 'managed-app-roots.json';

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

export type IslandManifestV2 = {
  version: 2;
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
  };
}

export function buildManagedRootsRegistryPath(registryHome = os.homedir()): string {
  return path.join(registryHome, MANAGED_ROOTS_DIR_NAME, MANAGED_ROOTS_FILE_NAME);
}

export function isIslandManifestV2(
  manifest: Partial<IslandManifestV2>
): manifest is IslandManifestV2 {
  return (
    manifest.version === ISLAND_PATCH_CONTRACT_VERSION &&
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
