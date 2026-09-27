import {
  ISLAND_CSS_FILE_NAME,
  type IslandPatchPaths,
  buildIslandPatchPaths,
  ISLAND_MANIFEST_FILE_NAME,
  BACKUP_HTML_FILE_NAME,
  BACKUP_PRODUCT_FILE_NAME,
  TYRIAN_MARKER_START,
  TYRIAN_MARKER_END,
  WORKBENCH_CSS_LINK,
  WORKBENCH_CHECKSUM_KEY,
  type IslandManifest,
  isIslandCssAssetName,
  isIslandManifestShape,
} from './islandPatchContract.js';
import { type IslandShellStatus, IslandShellFailure } from './islandShellContract.js';
import { type ManagedRootRegistration, readDesiredCssFile } from './islandRegistry.js';
import {
  type FileMutation,
  escapeRegExp,
  readTextFileIfExists,
  sha256Base64,
} from './islandFileSystem.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const TYRIAN_STYLESHEET_HREF_SOURCE = String.raw`(?:["'](?:[^"']*\/)?${escapeRegExp(ISLAND_CSS_FILE_NAME)}(?:[?#][^"']*)?["']|(?:[^\s"'=<>\x60]*\/)?${escapeRegExp(ISLAND_CSS_FILE_NAME)}(?:[?#][^\s"'=<>\x60]*)?)`;

const TYRIAN_STYLESHEET_LINK_SOURCE = String.raw`<link\b[^>]*\bhref\s*=\s*${TYRIAN_STYLESHEET_HREF_SOURCE}[^>]*>`;

const TYRIAN_STYLESHEET_PATTERN = new RegExp(
  String.raw`(?:^[\t ]*${TYRIAN_STYLESHEET_LINK_SOURCE}[\t ]*\r?\n?|${TYRIAN_STYLESHEET_LINK_SOURCE})`,
  'gimu'
);

type ProductJson = {
  checksums?: Record<string, string>;
};

export type IslandRootState = {
  paths: IslandPatchPaths;
  currentHtml: string;
  currentProductJson: string;
  currentCss: string | undefined;
  currentManifest: string | undefined;
  backupHtml: string | undefined;
  backupProductJson: string | undefined;
  hasTyrianSidecars: boolean;
  trustedBackup: { html: string; productJson: string } | undefined;
  checksumMatches: boolean;
  status: IslandShellStatus;
};

export type RestorePlan =
  | {
      kind: 'noop';
    }
  | {
      kind: 'remove-managed-state';
    }
  | {
      kind: 'restore-from-backup';
      html: string;
      productJson: string;
    }
  | {
      kind: 'strip-tyrian-block';
      html: string;
      productJson: string;
    };

export async function inspectIslandRoot(
  appRoot: string,
  registration: ManagedRootRegistration
): Promise<IslandRootState> {
  const registered = registration.kind !== 'absent';
  const desiredCssFile = readDesiredCssFile(registration);
  const paths = buildIslandPatchPaths(appRoot);
  const currentHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const currentProductJson = await fs.readFile(paths.productJsonPath, 'utf8');
  const backupHtml = await readTextFileIfExists(paths.backupHtmlPath);
  const backupProductJson = await readTextFileIfExists(paths.backupProductJsonPath);
  const blockState = readTyrianBlockState(currentHtml);
  const active = blockState !== 'absent';
  const cssContent = await readTextFileIfExists(paths.islandCssPath);
  const cssExists = cssContent !== undefined;
  const manifestContent = await readTextFileIfExists(paths.manifestPath);
  const manifest = parseManifest(manifestContent);
  const manifestExists = manifestContent !== undefined;
  const manifestShapeValid = manifestExists && manifest !== undefined;
  const backupHtmlExists = backupHtml !== undefined;
  const backupProductExists = backupProductJson !== undefined;
  const hasTyrianSidecars = cssExists || manifestExists || backupHtmlExists || backupProductExists;
  const desiredEnabled = registration.kind === 'valid' && registration.desiredCssFile !== null;
  const managed = desiredEnabled || hasTyrianSidecars;
  const issues: string[] = [];
  const checksumMatches = doesWorkbenchChecksumValueMatch(currentProductJson, currentHtml);
  const backupMismatch = backupHtmlExists !== backupProductExists;
  const backupPairInvalid =
    backupHtml !== undefined &&
    backupProductJson !== undefined &&
    !doesWorkbenchChecksumValueMatch(backupProductJson, backupHtml);
  const manifestProofIssues =
    manifest === undefined
      ? []
      : collectManifestRestoreProofIssues({
          appRoot,
          manifest,
          currentHtml,
          currentProductJson,
          cssContent,
          backupHtml,
          backupProductJson,
        });
  const trustedBackup =
    manifest !== undefined &&
    manifestProofIssues.length === 0 &&
    !backupPairInvalid &&
    checksumMatches &&
    backupHtml !== undefined &&
    backupProductJson !== undefined
      ? { html: backupHtml, productJson: backupProductJson }
      : undefined;
  const brokenBackup =
    backupMismatch ||
    backupPairInvalid ||
    (manifestExists && !manifestShapeValid) ||
    manifestProofIssues.length > 0 ||
    (active && (!cssExists || !manifestExists)) ||
    blockState === 'malformed' ||
    (active && !registered) ||
    registration.kind === 'corrupt' ||
    (manifest !== undefined &&
      desiredCssFile !== undefined &&
      manifest.desiredCssFile !== desiredCssFile);
  const hasTyrianEvidence = active || hasTyrianSidecars;

  if (active) {
    issues.push('Tyrian workbench patch evidence is present.');
  }

  if (blockState === 'malformed') {
    issues.push('Tyrian workbench patch markers or stylesheet link are malformed.');
  }

  if (hasTyrianSidecars) {
    issues.push('Tyrian-managed sidecar files are present.');
  }

  if (registered) {
    issues.push('Tyrian registry contains this app root.');
  }

  if (registration.kind === 'corrupt') {
    issues.push(registration.reason);
  }

  if (active && !registered) {
    issues.push('Tyrian patch evidence exists without its required desired-state record.');
  }

  if (
    manifest !== undefined &&
    desiredCssFile !== undefined &&
    manifest.desiredCssFile !== desiredCssFile
  ) {
    issues.push('Tyrian manifest style does not match the desired-state record.');
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

  if (manifestExists && !manifestShapeValid) {
    issues.push('Tyrian manifest exists but is invalid.');
  }

  issues.push(...manifestProofIssues);

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
  const workbenchChecksum = sha256Base64(currentHtml);
  const productWorkbenchChecksum = tryReadWorkbenchChecksum(currentProductJson);
  const restoreProof =
    active && trustedBackup !== undefined
      ? 'manifest-backup-pair'
      : hasTyrianEvidence
        ? 'strip-tyrian-block'
        : 'none';
  const receipt =
    manifest === undefined
      ? undefined
      : {
          installedAt: manifest.installedAt,
          desiredCssFile: manifest.desiredCssFile,
          themeVersion: manifest.themeVersion,
          upstreamWorkbenchChecksum: manifest.upstreamWorkbenchChecksum,
          patchedWorkbenchChecksum: manifest.patchedWorkbenchChecksum,
          cssChecksum: manifest.cssChecksum,
        };

  return {
    paths,
    currentHtml,
    currentProductJson,
    currentCss: cssContent,
    currentManifest: manifestContent,
    backupHtml,
    backupProductJson,
    hasTyrianSidecars,
    trustedBackup,
    checksumMatches,
    status: {
      appRoot,
      desiredCssFile,
      registrationState: registration.kind,
      active,
      managed,
      registered,
      classification,
      verificationPassed,
      restoreProof,
      workbenchChecksum,
      productWorkbenchChecksum,
      receipt,
      issues,
    },
  };
}

/**
 * Plan an apply. Mutation order is part of the contract: the stylesheet and
 * manifest land before the workbench HTML that references them, so every
 * prefix of the plan leaves VS Code loadable and a rerun completes it.
 */
export async function buildIslandApplyPlan(options: {
  appRoot: string;
  cssSourcePath: string;
  themeVersion: string;
}): Promise<{
  desiredCssFile: string;
  mutations: FileMutation[];
  changed: boolean;
  verify: () => Promise<void>;
}> {
  const paths = buildIslandPatchPaths(options.appRoot);
  const [
    currentHtml,
    currentProductJson,
    cssSource,
    currentBackupHtml,
    currentBackupProductJson,
    currentIslandCss,
    currentManifest,
  ] = await Promise.all([
    fs.readFile(paths.workbenchHtmlPath, 'utf8'),
    fs.readFile(paths.productJsonPath, 'utf8'),
    fs.readFile(options.cssSourcePath, 'utf8'),
    readTextFileIfExists(paths.backupHtmlPath),
    readTextFileIfExists(paths.backupProductJsonPath),
    readTextFileIfExists(paths.islandCssPath),
    readTextFileIfExists(paths.manifestPath),
  ]);
  const desiredCssFile = path.basename(options.cssSourcePath);

  if (!isIslandCssAssetName(desiredCssFile)) {
    throw new IslandShellFailure(
      'unsupported',
      `Unsupported Tyrian Island CSS asset name '${desiredCssFile}'.`
    );
  }
  const existingManifest = parseManifest(currentManifest);

  const baseHtml = stripTyrianBlock(currentHtml);
  const baseProductJson = setWorkbenchChecksum(currentProductJson, baseHtml);
  const cssHash = sha256Base64(cssSource).substring(0, 12);
  const patchedHtml = injectIslandStylesheet(baseHtml, cssHash);
  const patchedProductJson = setWorkbenchChecksum(baseProductJson, patchedHtml);
  const manifest = serializeManifest({
    desiredCssFile,
    themeVersion: options.themeVersion,
    installedAt: existingManifest?.installedAt ?? new Date().toISOString(),
    appRoot: options.appRoot,
    upstreamWorkbenchChecksum: sha256Base64(baseHtml),
    upstreamProductChecksum: sha256Base64(baseProductJson),
    cssChecksum: sha256Base64(cssSource),
    patchedWorkbenchChecksum: sha256Base64(patchedHtml),
    patchedProductChecksum: sha256Base64(patchedProductJson),
    ownedFiles: {
      stylesheet: ISLAND_CSS_FILE_NAME,
      manifest: ISLAND_MANIFEST_FILE_NAME,
      workbenchBackup: BACKUP_HTML_FILE_NAME,
      productBackup: BACKUP_PRODUCT_FILE_NAME,
    },
  });
  const mutations: FileMutation[] = [
    { filePath: paths.backupHtmlPath, content: baseHtml, expectedContent: currentBackupHtml },
    {
      filePath: paths.backupProductJsonPath,
      content: baseProductJson,
      expectedContent: currentBackupProductJson,
    },
    { filePath: paths.islandCssPath, content: cssSource, expectedContent: currentIslandCss },
    { filePath: paths.manifestPath, content: manifest, expectedContent: currentManifest },
    { filePath: paths.workbenchHtmlPath, content: patchedHtml, expectedContent: currentHtml },
    {
      filePath: paths.productJsonPath,
      content: patchedProductJson,
      expectedContent: currentProductJson,
    },
  ];

  return {
    desiredCssFile,
    mutations,
    changed: mutations.some(({ content, expectedContent }) => content !== expectedContent),
    verify: () => verifyAppliedShell(paths, options.appRoot, desiredCssFile),
  };
}

export function buildRestorePlan(state: IslandRootState): RestorePlan {
  const hasTyrianEvidence = state.status.active || state.hasTyrianSidecars;

  if (!hasTyrianEvidence) {
    return {
      kind: 'noop',
    };
  }

  if (state.status.active && state.trustedBackup !== undefined) {
    return {
      kind: 'restore-from-backup',
      html: state.trustedBackup.html,
      productJson: state.trustedBackup.productJson,
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
    };
  }

  return {
    kind: 'remove-managed-state',
  };
}

async function verifyAppliedShell(
  paths: IslandPatchPaths,
  appRoot: string,
  desiredCssFile: string
): Promise<void> {
  const [currentHtml, currentProductJson, cssContent, backupHtml, backupProductJson] =
    await Promise.all(
      [
        paths.workbenchHtmlPath,
        paths.productJsonPath,
        paths.islandCssPath,
        paths.backupHtmlPath,
        paths.backupProductJsonPath,
      ].map((filePath) => fs.readFile(filePath, 'utf8'))
    );

  if (readTyrianBlockState(currentHtml) !== 'valid') {
    throw new Error(
      'Tyrian Night verification failed: workbench.html does not contain one valid Island UI block after apply.'
    );
  }

  const manifest = parseManifest(await fs.readFile(paths.manifestPath, 'utf8'));

  if (!manifest) {
    throw new Error(
      'Tyrian Night verification failed: island manifest is missing or invalid after apply.'
    );
  }

  if (manifest.desiredCssFile !== desiredCssFile) {
    throw new Error(
      'Tyrian Night verification failed: manifest style does not match desired style.'
    );
  }

  const manifestIssues = collectManifestRestoreProofIssues({
    appRoot,
    manifest,
    currentHtml,
    currentProductJson,
    cssContent,
    backupHtml,
    backupProductJson,
  });

  if (manifestIssues.length > 0) {
    throw new Error(`Tyrian Night verification failed: ${manifestIssues.join(' ')}`);
  }

  if (!doesWorkbenchChecksumValueMatch(currentProductJson, currentHtml)) {
    throw new Error(
      'Tyrian Night verification failed: product.json checksum does not match the patched workbench after apply.'
    );
  }
}

export async function verifyRestoredShell(paths: IslandPatchPaths): Promise<void> {
  const currentHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const currentProductJson = await fs.readFile(paths.productJsonPath, 'utf8');

  if (readTyrianBlockState(currentHtml) !== 'absent') {
    throw new Error(
      'Tyrian Night verification failed: workbench.html still contains Island UI patch evidence after restore.'
    );
  }

  await verifyManagedStateRemoved(paths);

  if (!doesWorkbenchChecksumValueMatch(currentProductJson, currentHtml)) {
    throw new Error(
      'Tyrian Night verification failed: product.json checksum does not match the restored workbench after restore.'
    );
  }
}

export async function verifyManagedStateRemoved(paths: IslandPatchPaths): Promise<void> {
  for (const filePath of [
    paths.islandCssPath,
    paths.manifestPath,
    paths.backupHtmlPath,
    paths.backupProductJsonPath,
  ]) {
    if ((await readTextFileIfExists(filePath)) !== undefined) {
      throw new Error(
        `Tyrian Night verification failed: '${path.basename(filePath)}' still exists after restore.`
      );
    }
  }
}

function stripTyrianBlock(html: string): string {
  const markerStartPattern = new RegExp(
    String.raw`^[\t ]*${escapeRegExp(TYRIAN_MARKER_START)}[\t ]*\r?\n?`,
    'gmu'
  );
  const markerEndPattern = new RegExp(
    String.raw`^[\t ]*${escapeRegExp(TYRIAN_MARKER_END)}[\t ]*\r?\n?`,
    'gmu'
  );

  return html
    .replace(markerStartPattern, '')
    .replace(TYRIAN_STYLESHEET_PATTERN, '')
    .replace(markerEndPattern, '');
}

function readTyrianBlockState(html: string): 'absent' | 'valid' | 'malformed' {
  const startIndexes = indexesOf(html, TYRIAN_MARKER_START);
  const endIndexes = indexesOf(html, TYRIAN_MARKER_END);
  const stylesheetIndexes = [...html.matchAll(TYRIAN_STYLESHEET_PATTERN)].map(
    (match) => match.index
  );

  if (startIndexes.length === 0 && endIndexes.length === 0 && stylesheetIndexes.length === 0) {
    return 'absent';
  }

  return startIndexes.length === 1 &&
    endIndexes.length === 1 &&
    stylesheetIndexes.length === 1 &&
    startIndexes[0]! < stylesheetIndexes[0]! &&
    stylesheetIndexes[0]! < endIndexes[0]!
    ? 'valid'
    : 'malformed';
}

function indexesOf(value: string, needle: string): number[] {
  const indexes: number[] = [];
  let offset = 0;

  while (true) {
    const index = value.indexOf(needle, offset);

    if (index === -1) {
      return indexes;
    }

    indexes.push(index);
    offset = index + needle.length;
  }
}

function injectIslandStylesheet(html: string, cacheBuster: string): string {
  if (!html.includes(WORKBENCH_CSS_LINK)) {
    throw new IslandShellFailure(
      'unsupported',
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

function tryReadWorkbenchChecksum(productJsonContent: string): string | undefined {
  try {
    return readWorkbenchChecksum(productJsonContent);
  } catch {
    return undefined;
  }
}

function parseProductJson(productJsonContent: string): ProductJson & {
  checksums: Record<string, string>;
} {
  const parsed = JSON.parse(productJsonContent) as ProductJson;

  if (!parsed.checksums) {
    throw new IslandShellFailure(
      'unsupported',
      'Unsupported product.json layout. Missing checksums object.'
    );
  }

  if (!(WORKBENCH_CHECKSUM_KEY in parsed.checksums)) {
    throw new IslandShellFailure(
      'unsupported',
      `Unsupported product.json layout. Missing checksum key '${WORKBENCH_CHECKSUM_KEY}'.`
    );
  }

  return parsed as ProductJson & { checksums: Record<string, string> };
}

function serializeManifest(manifest: IslandManifest): string {
  return JSON.stringify(manifest, null, 2).concat('\n');
}

function collectManifestRestoreProofIssues(options: {
  appRoot: string;
  manifest: IslandManifest;
  currentHtml: string;
  currentProductJson: string;
  cssContent: string | undefined;
  backupHtml: string | undefined;
  backupProductJson: string | undefined;
}): string[] {
  const issues: string[] = [];
  const { manifest } = options;

  if (manifest.appRoot !== options.appRoot) {
    issues.push('Tyrian manifest app root does not match this VS Code installation.');
  }

  if (
    manifest.ownedFiles.stylesheet !== ISLAND_CSS_FILE_NAME ||
    manifest.ownedFiles.manifest !== ISLAND_MANIFEST_FILE_NAME ||
    manifest.ownedFiles.workbenchBackup !== BACKUP_HTML_FILE_NAME ||
    manifest.ownedFiles.productBackup !== BACKUP_PRODUCT_FILE_NAME
  ) {
    issues.push('Tyrian manifest owned files do not match the Island patch contract.');
  }

  if (manifest.patchedWorkbenchChecksum !== sha256Base64(options.currentHtml)) {
    issues.push('Tyrian manifest checksum does not match the current workbench HTML.');
  }

  if (manifest.patchedProductChecksum !== sha256Base64(options.currentProductJson)) {
    issues.push('Tyrian manifest checksum does not match the current product.json.');
  }

  if (
    options.cssContent === undefined ||
    manifest.cssChecksum !== sha256Base64(options.cssContent)
  ) {
    issues.push('Tyrian manifest checksum does not match the injected CSS.');
  }

  if (
    options.backupHtml === undefined ||
    manifest.upstreamWorkbenchChecksum !== sha256Base64(options.backupHtml)
  ) {
    issues.push('Tyrian manifest checksum does not match the backup workbench HTML.');
  }

  if (
    options.backupProductJson === undefined ||
    manifest.upstreamProductChecksum !== sha256Base64(options.backupProductJson)
  ) {
    issues.push('Tyrian manifest checksum does not match the backup product.json.');
  }

  return issues;
}

function parseManifest(content: string | undefined): IslandManifest | undefined {
  if (!content) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(content) as Partial<IslandManifest>;
    return isIslandManifestShape(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Restore mutations. The workbench HTML and product.json are restored before
 * any sidecar is removed, so the HTML never references a missing stylesheet.
 */
export function buildRestoreMutations(state: IslandRootState, plan: RestorePlan): FileMutation[] {
  const mutations: FileMutation[] = [
    {
      filePath: state.paths.islandCssPath,
      content: undefined,
      expectedContent: state.currentCss,
    },
    {
      filePath: state.paths.manifestPath,
      content: undefined,
      expectedContent: state.currentManifest,
    },
    {
      filePath: state.paths.backupHtmlPath,
      content: undefined,
      expectedContent: state.backupHtml,
    },
    {
      filePath: state.paths.backupProductJsonPath,
      content: undefined,
      expectedContent: state.backupProductJson,
    },
  ];

  if (plan.kind === 'restore-from-backup' || plan.kind === 'strip-tyrian-block') {
    mutations.unshift(
      {
        filePath: state.paths.workbenchHtmlPath,
        content: plan.html,
        expectedContent: state.currentHtml,
      },
      {
        filePath: state.paths.productJsonPath,
        content: plan.productJson,
        expectedContent: state.currentProductJson,
      }
    );
  }

  return mutations;
}
