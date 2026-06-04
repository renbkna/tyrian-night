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
  String.raw`${escapeRegExp(TYRIAN_MARKER_START)}[\s\S]*?${escapeRegExp(TYRIAN_MARKER_END)}\s*`,
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
  registered: boolean;
  classification:
    | 'clean'
    | 'patched'
    | 'managed-only'
    | 'missing'
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

type IslandShellEnvironment = {
  registryHome?: string;
};

type RootCandidate = {
  appRoot: string;
  registered: boolean;
};

type IslandRootState = {
  paths: PatchPaths;
  currentHtml: string;
  currentProductJson: string;
  backupHtml: string | undefined;
  backupProductJson: string | undefined;
  hasTyrianSidecars: boolean;
  checksumMatches: boolean;
  status: IslandShellStatus;
};

type RestorePlan =
  | {
      kind: 'noop';
      removeRegistry: boolean;
    }
  | {
      kind: 'remove-managed-state';
      removeRegistry: boolean;
    }
  | {
      kind: 'restore-from-backup';
      html: string;
      productJson: string;
      removeRegistry: boolean;
    }
  | {
      kind: 'strip-tyrian-block';
      html: string;
      productJson: string;
      removeRegistry: boolean;
    };

export async function applyIslandShell(options: {
  appRoot: string;
  cssSourcePath: string;
  themeVersion: string;
  registryHome?: string;
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
  changed = (await addManagedAppRoot(options.appRoot, options)) || changed;
  await verifyAppliedShell(paths);

  return {
    changed,
    active: true,
  };
}

export async function restoreIslandShell(options: {
  appRoot: string;
  registered?: boolean;
  registryHome?: string;
}): Promise<IslandShellResult> {
  const registered =
    options.registered ?? (await tryReadManagedAppRootRegistration(options.appRoot, options));
  const state = await inspectIslandRoot(options.appRoot, registered);
  const plan = buildRestorePlan(state);
  const changed = await commitRestorePlan(state, plan, options);

  return {
    changed,
    active: false,
  };
}

export async function restoreAllIslandShells(options?: {
  preferredAppRoots?: string[];
  registryHome?: string;
}): Promise<IslandShellCleanupSummary> {
  const appRoots = await listIslandShellRoots(options, {
    tolerateRegistryFailureWithPreferredRoots: true,
  });
  let changed = false;
  const restoredAppRoots: string[] = [];
  const failedAppRoots: Array<{ appRoot: string; reason: string }> = [];

  for (const appRoot of appRoots) {
    try {
      const result = await restoreIslandShell({
        ...appRoot,
        registryHome: options?.registryHome,
      });

      if (result.changed) {
        changed = true;
      }

      restoredAppRoots.push(appRoot.appRoot);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        changed = (await removeManagedAppRoot(appRoot.appRoot, options)) || changed;
        continue;
      }

      failedAppRoots.push({
        appRoot: appRoot.appRoot,
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
  registered?: boolean;
  registryHome?: string;
}): Promise<IslandShellStatus> {
  const registered =
    options.registered ?? (await isManagedAppRootRegistered(options.appRoot, options));

  try {
    return (await inspectIslandRoot(options.appRoot, registered)).status;
  } catch (error) {
    if (isPermissionError(error)) {
      return {
        appRoot: options.appRoot,
        active: false,
        managed: registered,
        registered,
        classification: 'permission-denied',
        verificationPassed: false,
        canSelfHeal: false,
        issues: ['Tyrian could not read the VS Code installation files due to permissions.'],
      };
    }

    if (isFileNotFoundError(error)) {
      return {
        appRoot: options.appRoot,
        active: false,
        managed: registered,
        registered,
        classification: 'missing',
        verificationPassed: false,
        canSelfHeal: registered,
        issues: ['Tyrian could not find the registered VS Code installation files.'],
      };
    }

    throw error;
  }
}

export async function readAllIslandShellStatuses(options?: {
  preferredAppRoots?: string[];
  registryHome?: string;
}): Promise<IslandShellStatus[]> {
  const appRoots = await listIslandShellRoots(options);
  const statuses: IslandShellStatus[] = [];

  for (const appRoot of appRoots) {
    statuses.push(
      await readIslandShellStatus({
        appRoot: appRoot.appRoot,
        registered: appRoot.registered,
        registryHome: options?.registryHome,
      })
    );
  }

  return statuses;
}

async function inspectIslandRoot(appRoot: string, registered: boolean): Promise<IslandRootState> {
  const paths = getPatchPaths(appRoot);
  const currentHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const currentProductJson = await fs.readFile(paths.productJsonPath, 'utf8');
  const backupHtml = await readTextFileIfExists(paths.backupHtmlPath);
  const backupProductJson = await readTextFileIfExists(paths.backupProductJsonPath);
  const active = currentHtml.includes(TYRIAN_MARKER_START);
  const cssExists = await pathExists(paths.islandCssPath);
  const manifestContent = await readTextFileIfExists(paths.manifestPath);
  const manifest = parseManifest(manifestContent);
  const manifestExists = manifestContent !== undefined;
  const manifestValid = manifestExists && manifest !== undefined;
  const manifestChecksumMismatch =
    manifest !== undefined && manifest.checksum !== sha256Base64(currentHtml);
  const backupHtmlExists = backupHtml !== undefined;
  const backupProductExists = backupProductJson !== undefined;
  const hasTyrianSidecars = cssExists || manifestExists || backupHtmlExists || backupProductExists;
  const managed = registered || hasTyrianSidecars;
  const issues: string[] = [];
  const checksumMatches = doesWorkbenchChecksumValueMatch(currentProductJson, currentHtml);
  const backupMismatch = backupHtmlExists !== backupProductExists;
  const backupPairInvalid =
    backupHtml !== undefined &&
    backupProductJson !== undefined &&
    !doesWorkbenchChecksumValueMatch(backupProductJson, backupHtml);
  const brokenBackup =
    backupMismatch ||
    backupPairInvalid ||
    (manifestExists && !manifestValid) ||
    manifestChecksumMismatch ||
    (active && (!cssExists || !manifestExists));
  const hasTyrianEvidence = active || managed;

  if (active) {
    issues.push('Tyrian workbench marker is present.');
  }

  if (hasTyrianSidecars) {
    issues.push('Tyrian-managed sidecar files are present.');
  }

  if (registered) {
    issues.push('Tyrian registry contains this app root.');
  }

  if (!checksumMatches) {
    issues.push('product.json checksum does not match the current workbench HTML.');
  }

  if (backupMismatch) {
    issues.push('Tyrian backup files are incomplete.');
  }

  if (backupPairInvalid) {
    issues.push('Tyrian backup checksum does not match the backup workbench HTML.');
  }

  if (manifestExists && !manifestValid) {
    issues.push('Tyrian manifest exists but is invalid.');
  }

  if (manifestChecksumMismatch) {
    issues.push('Tyrian manifest checksum does not match the current workbench HTML.');
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
    paths,
    currentHtml,
    currentProductJson,
    backupHtml,
    backupProductJson,
    hasTyrianSidecars,
    checksumMatches,
    status: {
      appRoot,
      active,
      managed,
      registered,
      classification,
      verificationPassed,
      canSelfHeal:
        classification === 'managed-only' ||
        (hasTyrianEvidence &&
          (classification === 'broken-backup' || classification === 'checksum-mismatch')),
      issues,
    },
  };
}

async function listIslandShellRoots(
  options?: {
    preferredAppRoots?: string[];
    registryHome?: string;
  },
  behavior?: {
    tolerateRegistryFailureWithPreferredRoots?: boolean;
  }
): Promise<RootCandidate[]> {
  const candidates = new Map<string, RootCandidate>();
  const preferredAppRoots = options?.preferredAppRoots ?? [];

  for (const appRoot of preferredAppRoots) {
    candidates.set(appRoot, { appRoot, registered: false });
  }

  let registeredAppRoots: string[];

  try {
    registeredAppRoots = await readManagedAppRootsRegistry(options);
  } catch (error) {
    if (behavior?.tolerateRegistryFailureWithPreferredRoots && preferredAppRoots.length > 0) {
      registeredAppRoots = [];
    } else {
      throw error;
    }
  }

  for (const appRoot of registeredAppRoots) {
    candidates.set(appRoot, { appRoot, registered: true });
  }

  const existingRoots: RootCandidate[] = [];

  for (const candidate of candidates.values()) {
    if (!candidate.appRoot) {
      continue;
    }

    existingRoots.push(candidate);
  }

  return existingRoots;
}

function buildRestorePlan(state: IslandRootState): RestorePlan {
  const removeRegistry = state.status.registered;
  const hasTyrianEvidence =
    state.status.active || state.hasTyrianSidecars || state.status.registered;

  if (!hasTyrianEvidence) {
    return {
      kind: 'noop',
      removeRegistry: false,
    };
  }

  if (state.status.active && hasValidBackupPair(state)) {
    return {
      kind: 'restore-from-backup',
      html: state.backupHtml,
      productJson: state.backupProductJson,
      removeRegistry,
    };
  }

  // Restore must not leave a Tyrian-evidenced root in checksum-mismatch state,
  // even when a higher-priority status classification reports broken sidecars.
  if (state.status.active || !state.checksumMatches) {
    const html = stripTyrianBlock(state.currentHtml);

    return {
      kind: 'strip-tyrian-block',
      html,
      productJson: setWorkbenchChecksum(state.currentProductJson, html),
      removeRegistry,
    };
  }

  return {
    kind: 'remove-managed-state',
    removeRegistry,
  };
}

async function commitRestorePlan(
  state: IslandRootState,
  plan: RestorePlan,
  environment: IslandShellEnvironment
): Promise<boolean> {
  let changed = false;

  switch (plan.kind) {
    case 'noop':
      return false;
    case 'remove-managed-state':
      changed = (await deleteSidecars(state.paths)) || changed;
      await verifyManagedStateRemoved(state.paths);
      break;
    case 'restore-from-backup':
    case 'strip-tyrian-block':
      changed = (await writeIfChanged(state.paths.workbenchHtmlPath, plan.html)) || changed;
      changed = (await writeIfChanged(state.paths.productJsonPath, plan.productJson)) || changed;
      changed = (await deleteSidecars(state.paths)) || changed;
      await verifyRestoredShell(state.paths);
      break;
  }

  if (plan.removeRegistry) {
    changed = (await removeManagedAppRoot(state.status.appRoot, environment)) || changed;
  }

  return changed;
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

  const manifest = parseManifest(await fs.readFile(paths.manifestPath, 'utf8'));

  if (!manifest || manifest.checksum !== sha256Base64(currentHtml)) {
    throw new Error(
      'Tyrian Night verification failed: island manifest checksum does not match the patched workbench after apply.'
    );
  }

  if (!doesWorkbenchChecksumValueMatch(currentProductJson, currentHtml)) {
    throw new Error(
      'Tyrian Night verification failed: product.json checksum does not match the patched workbench after apply.'
    );
  }
}

async function verifyRestoredShell(paths: PatchPaths): Promise<void> {
  const currentHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const currentProductJson = await fs.readFile(paths.productJsonPath, 'utf8');

  if (currentHtml.includes(TYRIAN_MARKER_START)) {
    throw new Error(
      'Tyrian Night verification failed: workbench.html still contains the Island UI marker after restore.'
    );
  }

  await verifyManagedStateRemoved(paths);

  if (!doesWorkbenchChecksumValueMatch(currentProductJson, currentHtml)) {
    throw new Error(
      'Tyrian Night verification failed: product.json checksum does not match the restored workbench after restore.'
    );
  }
}

async function verifyManagedStateRemoved(paths: PatchPaths): Promise<void> {
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
}

async function deleteSidecars(paths: PatchPaths): Promise<boolean> {
  let changed = false;

  changed = (await deleteIfExists(paths.islandCssPath)) || changed;
  changed = (await deleteIfExists(paths.manifestPath)) || changed;
  changed = (await deleteIfExists(paths.backupHtmlPath)) || changed;
  changed = (await deleteIfExists(paths.backupProductJsonPath)) || changed;

  return changed;
}

function hasValidBackupPair(state: IslandRootState): state is IslandRootState & {
  backupHtml: string;
  backupProductJson: string;
} {
  return (
    state.backupHtml !== undefined &&
    state.backupProductJson !== undefined &&
    doesWorkbenchChecksumValueMatch(state.backupProductJson, state.backupHtml)
  );
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

function getManagedRootsRegistryPath(environment?: IslandShellEnvironment): string {
  return path.join(
    environment?.registryHome ?? os.homedir(),
    MANAGED_ROOTS_DIR_NAME,
    MANAGED_ROOTS_FILE_NAME
  );
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
  const parsed = parseProductJson(productJsonContent);

  parsed.checksums[WORKBENCH_CHECKSUM_KEY] = sha256Base64(workbenchHtml);
  return JSON.stringify(parsed, null, '\t').concat('\n');
}

function doesWorkbenchChecksumValueMatch(
  productJsonContent: string,
  workbenchHtml: string
): boolean {
  try {
    return readWorkbenchChecksum(productJsonContent) === sha256Base64(workbenchHtml);
  } catch {
    return false;
  }
}

function readWorkbenchChecksum(productJsonContent: string): string {
  const parsed = parseProductJson(productJsonContent);
  return parsed.checksums[WORKBENCH_CHECKSUM_KEY];
}

function parseProductJson(productJsonContent: string): ProductJson & {
  checksums: Record<string, string>;
} {
  const parsed = JSON.parse(productJsonContent) as ProductJson;

  if (!parsed.checksums) {
    throw new Error('Unsupported product.json layout. Missing checksums object.');
  }

  if (!(WORKBENCH_CHECKSUM_KEY in parsed.checksums)) {
    throw new Error(
      `Unsupported product.json layout. Missing checksum key '${WORKBENCH_CHECKSUM_KEY}'.`
    );
  }

  return parsed as ProductJson & { checksums: Record<string, string> };
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

async function addManagedAppRoot(
  appRoot: string,
  environment?: IslandShellEnvironment
): Promise<boolean> {
  const appRoots = await readManagedAppRootsRegistry(environment);

  if (appRoots.includes(appRoot)) {
    return false;
  }

  appRoots.push(appRoot);
  appRoots.sort((left, right) => left.localeCompare(right));
  await writeManagedAppRootsRegistry(appRoots, environment);
  return true;
}

async function removeManagedAppRoot(
  appRoot: string,
  environment?: IslandShellEnvironment
): Promise<boolean> {
  const appRoots = await readManagedAppRootsRegistry(environment);
  const nextAppRoots = appRoots.filter((entry) => entry !== appRoot);

  if (nextAppRoots.length === appRoots.length) {
    return false;
  }

  await writeManagedAppRootsRegistry(nextAppRoots, environment);
  return true;
}

async function isManagedAppRootRegistered(
  appRoot: string,
  environment?: IslandShellEnvironment
): Promise<boolean> {
  return (await readManagedAppRootsRegistry(environment)).includes(appRoot);
}

async function tryReadManagedAppRootRegistration(
  appRoot: string,
  environment?: IslandShellEnvironment
): Promise<boolean> {
  try {
    return await isManagedAppRootRegistered(appRoot, environment);
  } catch {
    return false;
  }
}

async function readManagedAppRootsRegistry(
  environment?: IslandShellEnvironment
): Promise<string[]> {
  const registryPath = getManagedRootsRegistryPath(environment);
  const content = await readTextFileIfExists(registryPath);

  if (content === undefined) {
    return [];
  }

  let parsed: Partial<ManagedRootsRegistry>;

  try {
    parsed = JSON.parse(content) as Partial<ManagedRootsRegistry>;
  } catch {
    throw new Error(`Tyrian managed app roots registry is invalid JSON at '${registryPath}'.`);
  }

  if (parsed.version !== 1 || !Array.isArray(parsed.appRoots)) {
    throw new Error(
      `Tyrian managed app roots registry is invalid: expected version 1 with an appRoots array at '${registryPath}'.`
    );
  }

  if (parsed.appRoots.length === 0) {
    throw new Error(
      `Tyrian managed app roots registry is invalid: expected at least one app root or no registry file at '${registryPath}'.`
    );
  }

  if (
    parsed.appRoots.some((appRoot) => typeof appRoot !== 'string' || appRoot.trim().length === 0)
  ) {
    throw new Error(
      `Tyrian managed app roots registry is invalid: every app root must be a non-empty string at '${registryPath}'.`
    );
  }

  return [...new Set(parsed.appRoots)].sort((left, right) => left.localeCompare(right));
}

async function writeManagedAppRootsRegistry(
  appRoots: string[],
  environment?: IslandShellEnvironment
): Promise<void> {
  const registryPath = getManagedRootsRegistryPath(environment);

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
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return false;
    }

    throw error;
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
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
