import {
  ISLAND_CSS_FILE_NAME,
  type IslandPatchPaths,
  buildIslandPatchPaths,
  ISLAND_PATCH_CONTRACT_VERSION,
  ISLAND_PATCH_STRATEGY,
  ISLAND_MANIFEST_FILE_NAME,
  BACKUP_HTML_FILE_NAME,
  BACKUP_PRODUCT_FILE_NAME,
  TYRIAN_MARKER_START,
  TYRIAN_MARKER_END,
  WORKBENCH_CSS_LINK,
  WORKBENCH_CHECKSUM_KEY,
  type IslandManifestV3,
  isIslandManifestV3Shape,
} from './islandPatchContract.js';
import {
  type IslandShellStatus,
  type IslandTransactionHealth,
  IslandShellFailure,
} from './islandShellContract.js';
import {
  type ManagedRootRegistration,
  isCurrentManagedRootRegistration,
  readDesiredThemeId,
} from './islandRegistry.js';
import { sha256Base64, escapeRegExp } from './islandFileSystem.js';
import {
  readIslandInstallationFiles,
  type IslandFileReader,
  type FileMutation,
} from './islandFileTransaction.js';
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

type ApplyPayload = {
  desiredThemeId: string;
  paths: IslandPatchPaths;
  expectedContents: ReadonlyMap<string, string | undefined>;
  baseHtml: string;
  baseProductJson: string;
  cssSource: string;
  patchedHtml: string;
  patchedProductJson: string;
  manifest: string;
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
  registration: ManagedRootRegistration,
  knownTransaction: IslandTransactionHealth | undefined,
  files: IslandFileReader = readIslandInstallationFiles(appRoot)
): Promise<IslandRootState> {
  const registered = isCurrentManagedRootRegistration(registration);
  const desiredThemeId = readDesiredThemeId(registration);
  const paths = buildIslandPatchPaths(appRoot);
  const transaction = knownTransaction ?? (await files.health());
  const currentHtml = await files.readRequired(paths.workbenchHtmlPath);
  const currentProductJson = await files.readRequired(paths.productJsonPath);
  const backupHtml = await files.read(paths.backupHtmlPath);
  const backupProductJson = await files.read(paths.backupProductJsonPath);
  const blockState = readTyrianBlockState(currentHtml);
  const active = blockState !== 'absent';
  const cssContent = await files.read(paths.islandCssPath);
  const cssExists = cssContent !== undefined;
  const manifestContent = await files.read(paths.manifestPath);
  const manifest = parseManifest(manifestContent);
  const manifestExists = manifestContent !== undefined;
  const manifestShapeValid = manifestExists && manifest !== undefined;
  const backupHtmlExists = backupHtml !== undefined;
  const backupProductExists = backupProductJson !== undefined;
  const hasTyrianSidecars = cssExists || manifestExists || backupHtmlExists || backupProductExists;
  const desiredEnabled = registration.kind === 'valid' && registration.desiredThemeId !== null;
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
    registration.kind === 'unsupported' ||
    (manifest !== undefined &&
      desiredThemeId !== undefined &&
      manifest.desiredThemeId !== desiredThemeId);
  const hasTyrianEvidence = active || hasTyrianSidecars;

  if (transaction.kind !== 'clean') {
    issues.push(transaction.reason);
  }

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

  if (registration.kind === 'corrupt' || registration.kind === 'unsupported') {
    issues.push(registration.reason);
  }

  if (active && !registered) {
    issues.push('Tyrian patch evidence exists without its required desired-state record.');
  }

  if (
    manifest !== undefined &&
    desiredThemeId !== undefined &&
    manifest.desiredThemeId !== desiredThemeId
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

  if (
    transaction.kind === 'corrupt' ||
    transaction.kind === 'external-drift' ||
    transaction.kind === 'unavailable'
  ) {
    classification = 'transaction-blocked';
  } else if (transaction.kind === 'recoverable') {
    classification = 'transaction-pending';
  } else if (brokenBackup) {
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
      ? 'manifest-v3-backup-pair'
      : hasTyrianEvidence
        ? 'strip-tyrian-block'
        : 'none';
  const receipt =
    manifest === undefined
      ? undefined
      : {
          installedAt: manifest.installedAt,
          desiredThemeId: manifest.desiredThemeId,
          themeVersion: manifest.themeVersion,
          patchStrategy: manifest.patchStrategy,
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
      desiredThemeId,
      registrationState: registration.kind,
      active,
      managed,
      registered,
      classification,
      verificationPassed,
      restoreProof,
      transaction,
      workbenchChecksum,
      productWorkbenchChecksum,
      receipt,
      issues,
    },
  };
}

async function buildApplyPayload(
  options: {
    appRoot: string;
    cssSourcePath: string;
    themeVersion: string;
    registryHome?: string;
  },
  files: IslandFileReader = readIslandInstallationFiles(options.appRoot)
): Promise<ApplyPayload> {
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
    files.readRequired(paths.workbenchHtmlPath),
    files.readRequired(paths.productJsonPath),
    fs.readFile(options.cssSourcePath, 'utf8'),
    files.read(paths.backupHtmlPath),
    files.read(paths.backupProductJsonPath),
    files.read(paths.islandCssPath),
    files.read(paths.manifestPath),
  ]);
  const desiredThemeId = path.basename(options.cssSourcePath);

  if (!/^[a-z0-9][a-z0-9-]*\.css$/u.test(desiredThemeId)) {
    throw new IslandShellFailure(
      'unsupported',
      `Unsupported Tyrian Island CSS asset name '${desiredThemeId}'.`
    );
  }
  const existingManifest = parseManifest(currentManifest);

  const baseHtml = stripTyrianBlock(currentHtml);
  const baseProductJson = setWorkbenchChecksum(currentProductJson, baseHtml);
  const cssHash = sha256Base64(cssSource).substring(0, 12);
  const patchedHtml = injectIslandStylesheet(baseHtml, cssHash);
  const patchedProductJson = setWorkbenchChecksum(baseProductJson, patchedHtml);
  const manifest = serializeManifest({
    version: ISLAND_PATCH_CONTRACT_VERSION,
    desiredThemeId,
    themeVersion: options.themeVersion,
    installedAt: existingManifest?.installedAt ?? new Date().toISOString(),
    appRoot: options.appRoot,
    patchStrategy: ISLAND_PATCH_STRATEGY,
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

  return {
    paths,
    desiredThemeId,
    expectedContents: new Map([
      [paths.backupHtmlPath, currentBackupHtml],
      [paths.backupProductJsonPath, currentBackupProductJson],
      [paths.islandCssPath, currentIslandCss],
      [paths.manifestPath, currentManifest],
      [paths.workbenchHtmlPath, currentHtml],
      [paths.productJsonPath, currentProductJson],
    ]),
    baseHtml,
    baseProductJson,
    cssSource,
    patchedHtml,
    patchedProductJson,
    manifest,
  };
}

function buildApplyMutation(
  payload: ApplyPayload,
  filePath: string,
  content: string | undefined
): FileMutation {
  if (!payload.expectedContents.has(filePath)) {
    throw new Error(`Missing expected Island transaction input for '${filePath}'.`);
  }

  return {
    filePath,
    content,
    expectedContent: payload.expectedContents.get(filePath),
  };
}

export async function buildIslandApplyPlan(
  options: { appRoot: string; cssSourcePath: string; themeVersion: string },
  files: IslandFileReader = readIslandInstallationFiles(options.appRoot)
) {
  const payload = await buildApplyPayload(options, files);
  const { paths, desiredThemeId } = payload;
  const mutations = [
    buildApplyMutation(payload, paths.backupHtmlPath, payload.baseHtml),
    buildApplyMutation(payload, paths.backupProductJsonPath, payload.baseProductJson),
    buildApplyMutation(payload, paths.islandCssPath, payload.cssSource),
    buildApplyMutation(payload, paths.manifestPath, payload.manifest),
    buildApplyMutation(payload, paths.workbenchHtmlPath, payload.patchedHtml),
    buildApplyMutation(payload, paths.productJsonPath, payload.patchedProductJson),
  ];
  return {
    desiredThemeId,
    mutations,
    changed: mutations.some(({ content, expectedContent }) => content !== expectedContent),
    verify: () => verifyAppliedShell(paths, options.appRoot, desiredThemeId, files),
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
  desiredThemeId: string,
  files: IslandFileReader
): Promise<void> {
  const currentHtml = await files.readRequired(paths.workbenchHtmlPath);
  const currentProductJson = await files.readRequired(paths.productJsonPath);
  const cssContent = await files.readRequired(paths.islandCssPath);
  const backupHtml = await files.readRequired(paths.backupHtmlPath);
  const backupProductJson = await files.readRequired(paths.backupProductJsonPath);

  if (readTyrianBlockState(currentHtml) !== 'valid') {
    throw new Error(
      'Tyrian Night verification failed: workbench.html does not contain one valid Island UI block after apply.'
    );
  }

  const manifest = parseManifest(await files.readRequired(paths.manifestPath));

  if (!manifest) {
    throw new Error(
      'Tyrian Night verification failed: island manifest is missing or invalid after apply.'
    );
  }

  if (manifest.desiredThemeId !== desiredThemeId) {
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

export async function verifyRestoredShell(
  paths: IslandPatchPaths,
  files: IslandFileReader
): Promise<void> {
  const currentHtml = await files.readRequired(paths.workbenchHtmlPath);
  const currentProductJson = await files.readRequired(paths.productJsonPath);

  if (readTyrianBlockState(currentHtml) !== 'absent') {
    throw new Error(
      'Tyrian Night verification failed: workbench.html still contains Island UI patch evidence after restore.'
    );
  }

  await verifyManagedStateRemoved(paths, files);

  if (!doesWorkbenchChecksumValueMatch(currentProductJson, currentHtml)) {
    throw new Error(
      'Tyrian Night verification failed: product.json checksum does not match the restored workbench after restore.'
    );
  }
}

export async function verifyManagedStateRemoved(
  paths: IslandPatchPaths,
  files: IslandFileReader
): Promise<void> {
  for (const filePath of [
    paths.islandCssPath,
    paths.manifestPath,
    paths.backupHtmlPath,
    paths.backupProductJsonPath,
  ]) {
    if (await files.exists(filePath)) {
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

function serializeManifest(manifest: IslandManifestV3): string {
  return JSON.stringify(manifest, null, 2).concat('\n');
}

function collectManifestRestoreProofIssues(options: {
  appRoot: string;
  manifest: IslandManifestV3;
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

function parseManifest(content: string | undefined): IslandManifestV3 | undefined {
  if (!content) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(content) as Partial<IslandManifestV3>;

    if (parsed.version !== ISLAND_PATCH_CONTRACT_VERSION) {
      return undefined;
    }

    if (!isIslandManifestV3Shape(parsed)) {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
}

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
