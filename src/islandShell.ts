import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const WORKBENCH_DIR_RELATIVE_PATH = path.join('out', 'vs', 'code', 'electron-browser', 'workbench');
const WORKBENCH_HTML_RELATIVE_PATH = path.join(WORKBENCH_DIR_RELATIVE_PATH, 'workbench.html');
const PRODUCT_JSON_RELATIVE_PATH = 'product.json';
const WORKBENCH_CHECKSUM_KEY = 'vs/code/electron-browser/workbench/workbench.html';
const WORKBENCH_CSS_LINK =
  '<link rel="stylesheet" href="../../../workbench/workbench.desktop.main.css">';

const ISLAND_CSS_FILE_NAME = 'tyrian-night.island.css';
const ISLAND_MANIFEST_FILE_NAME = 'tyrian-night.island.json';
const BACKUP_HTML_FILE_NAME = 'tyrian-night.workbench.backup.html';
const BACKUP_PRODUCT_FILE_NAME = 'tyrian-night.product.backup.json';
const MANAGED_ROOTS_DIR_NAME = '.tyrian-night';
const MANAGED_ROOTS_FILE_NAME = 'managed-app-roots.json';

const TYRIAN_MARKER_START = '<!-- Tyrian Night Island Start -->';
const TYRIAN_MARKER_END = '<!-- Tyrian Night Island End -->';
const TYRIAN_BLOCK_PATTERN = new RegExp(
  `${escapeRegExp(TYRIAN_MARKER_START)}[\\s\\S]*?${escapeRegExp(TYRIAN_MARKER_END)}\\s*`,
  'g'
);

type ProductJson = {
  checksums?: Record<string, string>;
};

type PatchPaths = {
  workbenchDirPath: string;
  workbenchHtmlPath: string;
  productJsonPath: string;
  islandCssPath: string;
  manifestPath: string;
  backupHtmlPath: string;
  backupProductJsonPath: string;
};

type IslandManifest = {
  version: 1;
  themeVersion: string;
  installedAt: string;
  checksum: string;
};

export type IslandShellStatus = {
  appRoot: string;
  active: boolean;
  managed: boolean;
  classification:
    | 'clean'
    | 'patched'
    | 'managed-only'
    | 'permission-denied'
    | 'broken-backup'
    | 'checksum-mismatch';
  verificationPassed: boolean;
  canSelfHeal: boolean;
  issues: string[];
};

export type IslandShellResult = {
  changed: boolean;
  active: boolean;
};

export type IslandShellCleanupSummary = {
  changed: boolean;
  restoredAppRoots: string[];
  failedAppRoots: Array<{ appRoot: string; reason: string }>;
};

type ManagedRootsRegistry = {
  version: 1;
  appRoots: string[];
};

export async function applyIslandShell(options: {
  appRoot: string;
  cssSourcePath: string;
  themeVersion: string;
}): Promise<IslandShellResult> {
  const paths = getPatchPaths(options.appRoot);
  const currentHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const currentProductJson = await fs.readFile(paths.productJsonPath, 'utf8');
  const cssSource = await fs.readFile(options.cssSourcePath, 'utf8');
  const existingManifest = parseManifest(await readTextFileIfExists(paths.manifestPath));

  const baseHtml = stripTyrianBlock(currentHtml);
  const baseProductJson = setWorkbenchChecksum(currentProductJson, baseHtml);
  const cssHash = sha256Base64(cssSource).substring(0, 12);
  const patchedHtml = injectIslandStylesheet(baseHtml, cssHash);
  const patchedProductJson = setWorkbenchChecksum(baseProductJson, patchedHtml);
  const manifest = serializeManifest({
    version: 1,
    themeVersion: options.themeVersion,
    installedAt: existingManifest?.installedAt ?? new Date().toISOString(),
    checksum: sha256Base64(patchedHtml),
  });

  let changed = false;

  await fs.mkdir(paths.workbenchDirPath, { recursive: true });
  changed = (await writeIfChanged(paths.backupHtmlPath, baseHtml)) || changed;
  changed = (await writeIfChanged(paths.backupProductJsonPath, baseProductJson)) || changed;
  changed = (await writeIfChanged(paths.islandCssPath, cssSource)) || changed;
  changed = (await writeIfChanged(paths.workbenchHtmlPath, patchedHtml)) || changed;
  changed = (await writeIfChanged(paths.productJsonPath, patchedProductJson)) || changed;
  changed = (await writeIfChanged(paths.manifestPath, manifest)) || changed;
  changed = (await addManagedAppRoot(options.appRoot)) || changed;
  await verifyAppliedShell(paths);

  return {
    changed,
    active: true,
  };
}

export async function restoreIslandShell(options: { appRoot: string }): Promise<IslandShellResult> {
  const paths = getPatchPaths(options.appRoot);
  const currentHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const currentProductJson = await fs.readFile(paths.productJsonPath, 'utf8');

  const backupHtml = await readTextFileIfExists(paths.backupHtmlPath);
  const backupProductJson = await readTextFileIfExists(paths.backupProductJsonPath);

  const restoredHtml = backupHtml ?? stripTyrianBlock(currentHtml);
  const restoredProductJson =
    backupProductJson ?? setWorkbenchChecksum(currentProductJson, restoredHtml);

  let changed = false;

  changed = (await writeIfChanged(paths.workbenchHtmlPath, restoredHtml)) || changed;
  changed = (await writeIfChanged(paths.productJsonPath, restoredProductJson)) || changed;

  changed = (await deleteIfExists(paths.islandCssPath)) || changed;
  changed = (await deleteIfExists(paths.manifestPath)) || changed;
  changed = (await deleteIfExists(paths.backupHtmlPath)) || changed;
  changed = (await deleteIfExists(paths.backupProductJsonPath)) || changed;
  await verifyRestoredShell(paths);
  changed = (await removeManagedAppRoot(options.appRoot)) || changed;

  return {
    changed,
    active: false,
  };
}

export async function restoreAllIslandShells(options?: {
  preferredAppRoots?: string[];
}): Promise<IslandShellCleanupSummary> {
  const appRoots = await listManagedAppRoots(options);
  let changed = false;
  const restoredAppRoots: string[] = [];
  const failedAppRoots: Array<{ appRoot: string; reason: string }> = [];

  for (const appRoot of appRoots) {
    try {
      const result = await restoreIslandShell({ appRoot });

      if (result.changed) {
        changed = true;
      }

      restoredAppRoots.push(appRoot);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        changed = (await removeManagedAppRoot(appRoot)) || changed;
        continue;
      }

      failedAppRoots.push({
        appRoot,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    changed,
    restoredAppRoots,
    failedAppRoots,
  };
}

export async function bestEffortRestoreAllIslandShells(options?: {
  preferredAppRoots?: string[];
}): Promise<IslandShellCleanupSummary> {
  const appRoots = await listManagedAppRoots(options);
  let changed = false;
  const restoredAppRoots: string[] = [];
  const failedAppRoots: Array<{ appRoot: string; reason: string }> = [];

  for (const appRoot of appRoots) {
    try {
      const result = await bestEffortRestoreIslandShell({ appRoot });

      if (result.changed) {
        changed = true;
      }

      restoredAppRoots.push(appRoot);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        changed = (await removeManagedAppRoot(appRoot)) || changed;
        continue;
      }

      failedAppRoots.push({
        appRoot,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    changed,
    restoredAppRoots,
    failedAppRoots,
  };
}

export async function readIslandShellStatus(options: {
  appRoot: string;
}): Promise<IslandShellStatus> {
  const paths = getPatchPaths(options.appRoot);

  try {
    const currentHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
    const currentProductJson = await fs.readFile(paths.productJsonPath, 'utf8');
    const active = currentHtml.includes(TYRIAN_MARKER_START);
    const cssExists = await pathExists(paths.islandCssPath);
    const manifestContent = await readTextFileIfExists(paths.manifestPath);
    const manifestExists = manifestContent !== undefined;
    const manifestValid = manifestExists && parseManifest(manifestContent) !== undefined;
    const backupHtmlExists = await pathExists(paths.backupHtmlPath);
    const backupProductExists = await pathExists(paths.backupProductJsonPath);
    const managed = cssExists || manifestExists || backupHtmlExists || backupProductExists;
    const issues: string[] = [];
    const checksumMatches = doesWorkbenchChecksumMatch(currentProductJson, currentHtml);
    const backupMismatch = backupHtmlExists !== backupProductExists;
    const brokenBackup =
      backupMismatch ||
      (manifestExists && !manifestValid) ||
      (active && (!cssExists || !manifestExists));

    if (active) {
      issues.push('Tyrian workbench marker is present.');
    }

    if (managed) {
      issues.push('Tyrian-managed sidecar files are present.');
    }

    if (!checksumMatches) {
      issues.push('product.json checksum does not match the current workbench HTML.');
    }

    if (backupMismatch) {
      issues.push('Tyrian backup files are incomplete.');
    }

    if (manifestExists && !manifestValid) {
      issues.push('Tyrian manifest exists but is invalid.');
    }

    if (active && !cssExists) {
      issues.push('Tyrian marker is present but the injected CSS file is missing.');
    }

    if (active && !manifestExists) {
      issues.push('Tyrian marker is present but the manifest file is missing.');
    }

    let classification: IslandShellStatus['classification'] = 'clean';

    if (brokenBackup) {
      classification = 'broken-backup';
    } else if (!checksumMatches) {
      classification = 'checksum-mismatch';
    } else if (active) {
      classification = 'patched';
    } else if (managed) {
      classification = 'managed-only';
    }

    const verificationPassed = classification === 'clean' || classification === 'patched';

    return {
      appRoot: options.appRoot,
      active,
      managed,
      classification,
      verificationPassed,
      canSelfHeal:
        classification === 'managed-only' ||
        classification === 'broken-backup' ||
        classification === 'checksum-mismatch',
      issues,
    };
  } catch (error) {
    if (isPermissionError(error)) {
      return {
        appRoot: options.appRoot,
        active: false,
        managed: false,
        classification: 'permission-denied',
        verificationPassed: false,
        canSelfHeal: false,
        issues: ['Tyrian could not read the VS Code installation files due to permissions.'],
      };
    }

    throw error;
  }
}

export async function readAllIslandShellStatuses(options?: {
  preferredAppRoots?: string[];
}): Promise<IslandShellStatus[]> {
  const appRoots = await listManagedAppRoots(options);
  const statuses: IslandShellStatus[] = [];

  for (const appRoot of appRoots) {
    statuses.push(await readIslandShellStatus({ appRoot }));
  }

  return statuses;
}

export async function findInstalledAppRoots(): Promise<string[]> {
  const candidates = new Set<string>();
  const executableDir = path.dirname(process.execPath);

  if (process.env.VSCODE_APP_ROOT) {
    candidates.add(process.env.VSCODE_APP_ROOT);
  }

  if (process.env.APPIMAGE) {
    candidates.add(path.join(path.dirname(process.env.APPIMAGE), 'resources', 'app'));
  }

  candidates.add(path.join(executableDir, 'resources', 'app'));
  candidates.add(path.join(executableDir, '..', 'resources', 'app'));
  candidates.add(path.join(executableDir, '..', '..', 'resources', 'app'));

  switch (process.platform) {
    case 'win32':
      if (process.env.LOCALAPPDATA) {
        candidates.add(
          path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'resources', 'app')
        );
      }
      if (process.env['ProgramFiles']) {
        candidates.add(
          path.join(process.env['ProgramFiles'], 'Microsoft VS Code', 'resources', 'app')
        );
      }
      if (process.env['ProgramFiles(x86)']) {
        candidates.add(
          path.join(process.env['ProgramFiles(x86)'], 'Microsoft VS Code', 'resources', 'app')
        );
      }
      break;
    case 'darwin':
      candidates.add('/Applications/Visual Studio Code.app/Contents/Resources/app');
      break;
    default:
      candidates.add('/opt/visual-studio-code/resources/app');
      candidates.add('/usr/share/code/resources/app');
      break;
  }

  const existingRoots: string[] = [];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const workbenchHtmlPath = path.join(candidate, WORKBENCH_HTML_RELATIVE_PATH);
    const productJsonPath = path.join(candidate, PRODUCT_JSON_RELATIVE_PATH);

    if ((await pathExists(workbenchHtmlPath)) && (await pathExists(productJsonPath))) {
      existingRoots.push(candidate);
    }
  }

  return existingRoots;
}

export async function listManagedAppRoots(options?: {
  preferredAppRoots?: string[];
}): Promise<string[]> {
  const candidates = new Set<string>();

  for (const appRoot of options?.preferredAppRoots ?? []) {
    candidates.add(appRoot);
  }

  for (const appRoot of await findInstalledAppRoots()) {
    candidates.add(appRoot);
  }

  for (const appRoot of await readManagedAppRootsRegistry()) {
    candidates.add(appRoot);
  }

  const existingRoots: string[] = [];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const workbenchHtmlPath = path.join(candidate, WORKBENCH_HTML_RELATIVE_PATH);
    const productJsonPath = path.join(candidate, PRODUCT_JSON_RELATIVE_PATH);

    if ((await pathExists(workbenchHtmlPath)) && (await pathExists(productJsonPath))) {
      existingRoots.push(candidate);
      continue;
    }

    await removeManagedAppRoot(candidate);
  }

  return existingRoots;
}

function getPatchPaths(appRoot: string): PatchPaths {
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

function getManagedRootsRegistryPath(): string {
  return path.join(os.homedir(), MANAGED_ROOTS_DIR_NAME, MANAGED_ROOTS_FILE_NAME);
}

async function verifyAppliedShell(paths: PatchPaths): Promise<void> {
  const currentHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const currentProductJson = await fs.readFile(paths.productJsonPath, 'utf8');

  if (!currentHtml.includes(TYRIAN_MARKER_START)) {
    throw new Error(
      'Tyrian Night verification failed: workbench.html is missing the Island UI marker after apply.'
    );
  }

  if (!(await pathExists(paths.islandCssPath))) {
    throw new Error('Tyrian Night verification failed: island CSS file is missing after apply.');
  }

  if (!(await pathExists(paths.manifestPath))) {
    throw new Error('Tyrian Night verification failed: island manifest is missing after apply.');
  }

  if (setWorkbenchChecksum(currentProductJson, currentHtml) !== currentProductJson) {
    throw new Error(
      'Tyrian Night verification failed: product.json checksum does not match the patched workbench after apply.'
    );
  }
}

async function bestEffortRestoreIslandShell(options: {
  appRoot: string;
}): Promise<IslandShellResult> {
  const paths = getPatchPaths(options.appRoot);
  const currentHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const currentProductJson = await fs.readFile(paths.productJsonPath, 'utf8');
  const restoredHtml = stripTyrianBlock(currentHtml);
  const restoredProductJson = setWorkbenchChecksum(currentProductJson, restoredHtml);

  let changed = false;

  changed = (await writeIfChanged(paths.workbenchHtmlPath, restoredHtml)) || changed;
  changed = (await writeIfChanged(paths.productJsonPath, restoredProductJson)) || changed;
  changed = (await deleteIfExists(paths.islandCssPath)) || changed;
  changed = (await deleteIfExists(paths.manifestPath)) || changed;
  changed = (await deleteIfExists(paths.backupHtmlPath)) || changed;
  changed = (await deleteIfExists(paths.backupProductJsonPath)) || changed;

  if ((await fs.readFile(paths.workbenchHtmlPath, 'utf8')).includes(TYRIAN_MARKER_START)) {
    throw new Error('Tyrian marker block still exists after best-effort restore.');
  }

  if (!doesWorkbenchChecksumMatch(await fs.readFile(paths.productJsonPath, 'utf8'), restoredHtml)) {
    throw new Error('product.json checksum still does not match after best-effort restore.');
  }

  changed = (await removeManagedAppRoot(options.appRoot)) || changed;

  return {
    changed,
    active: false,
  };
}

async function verifyRestoredShell(paths: PatchPaths): Promise<void> {
  const currentHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const currentProductJson = await fs.readFile(paths.productJsonPath, 'utf8');

  if (currentHtml.includes(TYRIAN_MARKER_START)) {
    throw new Error(
      'Tyrian Night verification failed: workbench.html still contains the Island UI marker after restore.'
    );
  }

  for (const filePath of [
    paths.islandCssPath,
    paths.manifestPath,
    paths.backupHtmlPath,
    paths.backupProductJsonPath,
  ]) {
    if (await pathExists(filePath)) {
      throw new Error(
        `Tyrian Night verification failed: '${path.basename(filePath)}' still exists after restore.`
      );
    }
  }

  if (setWorkbenchChecksum(currentProductJson, currentHtml) !== currentProductJson) {
    throw new Error(
      'Tyrian Night verification failed: product.json checksum does not match the restored workbench after restore.'
    );
  }
}

function stripTyrianBlock(html: string): string {
  return html.replace(TYRIAN_BLOCK_PATTERN, '').trimEnd().concat('\n');
}

function injectIslandStylesheet(html: string, cacheBuster: string): string {
  if (!html.includes(WORKBENCH_CSS_LINK)) {
    throw new Error(
      'Unsupported VS Code workbench HTML layout. Could not locate the stylesheet anchor.'
    );
  }

  const islandBlock =
    `${TYRIAN_MARKER_START}\n` +
    `\t\t<link rel="stylesheet" href="./tyrian-night.island.css?v=${cacheBuster}">\n` +
    `\t\t${TYRIAN_MARKER_END}\n\t\t`;

  return html.replace(WORKBENCH_CSS_LINK, `${islandBlock}${WORKBENCH_CSS_LINK}`);
}

function setWorkbenchChecksum(productJsonContent: string, workbenchHtml: string): string {
  const parsed = JSON.parse(productJsonContent) as ProductJson;

  if (!parsed.checksums) {
    throw new Error('Unsupported product.json layout. Missing checksums object.');
  }

  if (!(WORKBENCH_CHECKSUM_KEY in parsed.checksums)) {
    throw new Error(
      `Unsupported product.json layout. Missing checksum key '${WORKBENCH_CHECKSUM_KEY}'.`
    );
  }

  parsed.checksums[WORKBENCH_CHECKSUM_KEY] = sha256Base64(workbenchHtml);
  return JSON.stringify(parsed, null, '\t').concat('\n');
}

function doesWorkbenchChecksumMatch(productJsonContent: string, workbenchHtml: string): boolean {
  try {
    return setWorkbenchChecksum(productJsonContent, workbenchHtml) === productJsonContent;
  } catch {
    return false;
  }
}

function serializeManifest(manifest: IslandManifest): string {
  return JSON.stringify(manifest, null, 2).concat('\n');
}

function parseManifest(content: string | undefined): IslandManifest | undefined {
  if (!content) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(content) as Partial<IslandManifest>;

    if (
      parsed.version !== 1 ||
      typeof parsed.themeVersion !== 'string' ||
      typeof parsed.installedAt !== 'string' ||
      typeof parsed.checksum !== 'string'
    ) {
      return undefined;
    }

    return {
      version: 1,
      themeVersion: parsed.themeVersion,
      installedAt: parsed.installedAt,
      checksum: parsed.checksum,
    };
  } catch {
    return undefined;
  }
}

function sha256Base64(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('base64').replace(/=+$/, '');
}

async function addManagedAppRoot(appRoot: string): Promise<boolean> {
  const appRoots = await readManagedAppRootsRegistry();

  if (appRoots.includes(appRoot)) {
    return false;
  }

  appRoots.push(appRoot);
  appRoots.sort();
  await writeManagedAppRootsRegistry(appRoots);
  return true;
}

async function removeManagedAppRoot(appRoot: string): Promise<boolean> {
  const appRoots = await readManagedAppRootsRegistry();
  const nextAppRoots = appRoots.filter((entry) => entry !== appRoot);

  if (nextAppRoots.length === appRoots.length) {
    return false;
  }

  await writeManagedAppRootsRegistry(nextAppRoots);
  return true;
}

async function readManagedAppRootsRegistry(): Promise<string[]> {
  const registryPath = getManagedRootsRegistryPath();
  const content = await readTextFileIfExists(registryPath);

  if (!content) {
    return [];
  }

  try {
    const parsed = JSON.parse(content) as Partial<ManagedRootsRegistry>;

    if (parsed.version !== 1 || !Array.isArray(parsed.appRoots)) {
      return [];
    }

    return parsed.appRoots.filter((appRoot): appRoot is string => typeof appRoot === 'string');
  } catch {
    return [];
  }
}

async function writeManagedAppRootsRegistry(appRoots: string[]): Promise<void> {
  const registryPath = getManagedRootsRegistryPath();

  if (appRoots.length === 0) {
    await deleteIfExists(registryPath);

    try {
      await fs.rmdir(path.dirname(registryPath));
    } catch (error) {
      if (isFileNotFoundError(error) || isDirectoryNotEmptyError(error)) {
        return;
      }

      throw error;
    }

    return;
  }

  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  const registry: ManagedRootsRegistry = {
    version: 1,
    appRoots,
  };

  await writeIfChanged(registryPath, JSON.stringify(registry, null, 2).concat('\n'));
}

async function writeIfChanged(filePath: string, content: string): Promise<boolean> {
  const currentContent = await readTextFileIfExists(filePath);

  if (currentContent === content) {
    return false;
  }

  const tempPath = path.join(
    path.dirname(filePath),
    `.tyrian-night-${process.pid}-${Date.now()}-${path.basename(filePath)}.tmp`
  );

  await fs.writeFile(tempPath, content, 'utf8');
  await fs.rename(tempPath, filePath);
  return true;
}

async function deleteIfExists(filePath: string): Promise<boolean> {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

async function readTextFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT';
}

function isDirectoryNotEmptyError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOTEMPTY';
}

function isPermissionError(error: unknown): boolean {
  return isNodeError(error) && (error.code === 'EACCES' || error.code === 'EPERM');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
