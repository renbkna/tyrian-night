import {
  ISLAND_CSS_FILE_NAME,
  type IslandPatchPaths,
  buildIslandPatchPaths,
  type IslandSidecar,
  islandSidecarPathMap,
  islandSidecarPaths,
  TYRIAN_MARKER_START,
  TYRIAN_MARKER_END,
  WORKBENCH_CSS_LINK,
  WORKBENCH_CHECKSUM_KEY,
  type IslandManifest,
  isIslandCssAssetName,
  isIslandManifestShape,
} from './islandPatchContract.js';
import { type IslandShellStatus, IslandShellFailure } from './islandShellContract.js';
import { desiredStateOf, type ManagedRootRegistration } from './islandRegistry.js';
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

type ProductJson = Record<string, unknown> & {
  checksums: Record<string, unknown> & { [WORKBENCH_CHECKSUM_KEY]: string };
};

type IslandRootState = {
  paths: IslandPatchPaths;
  currentHtml: string;
  currentProductJson: string;
  /** Each sidecar path with its content, `undefined` when absent. */
  sidecars: ReadonlyMap<string, string | undefined>;
  restore: RestoreDecision;
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

/** The restore decision; the stripped content is built only when restore runs. */
type RestoreDecision =
  | Exclude<RestorePlan, { kind: 'strip-tyrian-block' }>
  | { kind: 'strip-tyrian-block' };

/**
 * Classify one app root. A missing workbench file is a VS Code layout Island UI
 * cannot inspect and throws; a product.json without a readable workbench
 * checksum is classified unsupported, and a restore that must rewrite it fails.
 */

export async function inspectIslandRoot(
  appRoot: string,
  registration: ManagedRootRegistration
): Promise<IslandRootState> {
  const registered = registration.kind !== 'absent';
  const desired = desiredStateOf(registration);
  // The style a sound record names, `null` when it disables Island UI.
  const recordedCssFile =
    desired.kind === 'enabled' ? desired.cssFile : desired.kind === 'disabled' ? null : undefined;
  const paths = buildIslandPatchPaths(appRoot);
  const currentHtml = await readLayoutFile(paths.workbenchHtmlPath);
  const currentProductJson = await readLayoutFile(paths.productJsonPath);
  const productLayout = readProductLayout(currentProductJson);
  const productWorkbenchChecksum =
    productLayout.kind === 'supported' ? productLayout.checksum : undefined;
  const sidecars = await readSidecars(paths);
  const cssContent = sidecars.get(paths.islandCssPath);
  const manifestContent = sidecars.get(paths.manifestPath);
  const backupHtml = sidecars.get(paths.backupHtmlPath);
  const backupProductJson = sidecars.get(paths.backupProductJsonPath);
  const blockState = readTyrianBlockState(currentHtml);
  const active = blockState !== 'absent';
  const cssExists = cssContent !== undefined;
  const manifest = parseManifest(manifestContent);
  const manifestExists = manifestContent !== undefined;
  const manifestShapeValid = manifestExists && manifest !== undefined;
  const backupHtmlExists = backupHtml !== undefined;
  const backupProductExists = backupProductJson !== undefined;
  const hasTyrianSidecars = [...sidecars.values()].some((content) => content !== undefined);
  const managed = desired.kind === 'enabled' || hasTyrianSidecars;
  const workbenchChecksum = sha256Base64(currentHtml);
  const checksumMatches = productWorkbenchChecksum === workbenchChecksum;
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
  // Each condition that makes the Tyrian evidence untrustworthy, with the issue it reports.
  const brokenBackupIssues = [
    blockState === 'malformed' &&
      'Tyrian workbench patch markers or stylesheet link are malformed.',
    registration.kind === 'corrupt' && registration.reason,
    active &&
      !registered &&
      'Tyrian patch evidence exists without its required desired-state record.',
    manifest !== undefined &&
      recordedCssFile !== undefined &&
      manifest.desiredCssFile !== recordedCssFile &&
      'Tyrian manifest style does not match the desired-state record.',
    backupMismatch && 'Tyrian backup files are incomplete.',
    backupPairInvalid && 'Tyrian backup checksum does not match the backup workbench HTML.',
    manifestExists && !manifestShapeValid && 'Tyrian manifest exists but is invalid.',
    ...manifestProofIssues,
    active && !manifestExists && 'Tyrian marker is present but the manifest file is missing.',
    active && !cssExists && 'Tyrian marker is present but the stylesheet is missing.',
  ].filter((issue) => typeof issue === 'string');
  const brokenBackup = brokenBackupIssues.length > 0;
  const issues = [
    ...(active ? ['Tyrian workbench patch evidence is present.'] : []),
    ...(hasTyrianSidecars ? ['Tyrian-managed sidecar files are present.'] : []),
    ...(registered ? ['Tyrian registry contains this app root.'] : []),
    ...(productLayout.kind === 'unsupported'
      ? [productLayout.reason]
      : checksumMatches
        ? []
        : ['product.json checksum does not match the current workbench HTML.']),
    ...brokenBackupIssues,
  ];

  let classification: IslandShellStatus['classification'] = 'clean';

  if (productLayout.kind === 'unsupported') {
    classification = 'unsupported-layout';
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
  // Restore must not leave a Tyrian-evidenced root in checksum-mismatch state,
  // even when a higher-priority classification reports broken sidecars.
  const restore: RestoreDecision =
    !active && !hasTyrianSidecars
      ? { kind: 'noop' }
      : active && trustedBackup !== undefined
        ? { kind: 'restore-from-backup', ...trustedBackup }
        : active || !checksumMatches
          ? { kind: 'strip-tyrian-block' }
          : { kind: 'remove-managed-state' };
  const receipt =
    manifest === undefined
      ? undefined
      : {
          installedAt: manifest.installedAt,
          desiredCssFile: manifest.desiredCssFile,
          themeVersion: manifest.themeVersion,
          cssChecksum: manifest.cssChecksum,
        };

  return {
    paths,
    currentHtml,
    currentProductJson,
    sidecars,
    restore,
    status: {
      appRoot,
      desired,
      active,
      managed,
      classification,
      verificationPassed,
      restorePlan: restore.kind,
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
  const sidecarPaths = islandSidecarPathMap(paths);
  const [currentHtml, currentProductJson, cssSource, currentSidecars] = await Promise.all([
    fs.readFile(paths.workbenchHtmlPath, 'utf8'),
    fs.readFile(paths.productJsonPath, 'utf8'),
    fs.readFile(options.cssSourcePath, 'utf8'),
    readSidecars(paths),
  ]);
  const desiredCssFile = path.basename(options.cssSourcePath);

  if (!isIslandCssAssetName(desiredCssFile)) {
    throw new IslandShellFailure(
      'unsupported',
      `Unsupported Tyrian Island CSS asset name '${desiredCssFile}'.`
    );
  }
  const existingManifest = parseManifest(currentSidecars.get(sidecarPaths.manifest));

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
  });
  const sidecarContent: Record<IslandSidecar, string> = {
    workbenchBackup: baseHtml,
    productBackup: baseProductJson,
    stylesheet: cssSource,
    manifest,
  };
  const mutations: FileMutation[] = [
    ...(Object.keys(sidecarPaths) as IslandSidecar[]).map((sidecar) => ({
      filePath: sidecarPaths[sidecar],
      content: sidecarContent[sidecar],
      expectedContent: currentSidecars.get(sidecarPaths[sidecar]),
    })),
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
    verify: () =>
      verifyIslandClassification(options.appRoot, { kind: 'valid', desiredCssFile }, 'patched'),
  };
}

export function buildRestorePlan(state: IslandRootState): RestorePlan {
  if (state.restore.kind !== 'strip-tyrian-block') return state.restore;
  const html = stripTyrianBlock(state.currentHtml);
  return {
    kind: 'strip-tyrian-block',
    html,
    productJson: setWorkbenchChecksum(state.currentProductJson, html),
  };
}

/** Verify a converged root with the classifier Doctor reports. */
export async function verifyIslandClassification(
  appRoot: string,
  registration: ManagedRootRegistration,
  expected: 'patched' | 'clean'
): Promise<void> {
  const { status } = await inspectIslandRoot(appRoot, registration);
  if (status.classification !== expected) {
    throw new Error(
      `Tyrian Night verification failed: expected a ${expected} installation, found ${status.classification}. ${status.issues.join(' ')}`
    );
  }
}

/** Each sidecar path with its content, `undefined` when absent. */
async function readSidecars(paths: IslandPatchPaths): Promise<Map<string, string | undefined>> {
  return new Map(
    await Promise.all(
      islandSidecarPaths(paths).map(
        async (filePath) => [filePath, await readTextFileIfExists(filePath)] as const
      )
    )
  );
}

async function readLayoutFile(filePath: string): Promise<string> {
  const content = await readTextFileIfExists(filePath);
  if (content === undefined) {
    throw new IslandShellFailure(
      'unsupported',
      `Unsupported VS Code layout. Missing '${filePath}'.`
    );
  }
  return content;
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
    startIndexes[0] < stylesheetIndexes[0] &&
    stylesheetIndexes[0] < endIndexes[0]
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
    `\t\t<link rel="stylesheet" href="./${ISLAND_CSS_FILE_NAME}?v=${cacheBuster}">\n` +
    `\t\t${TYRIAN_MARKER_END}\n\t\t`;

  return html.replace(WORKBENCH_CSS_LINK, `${islandBlock}${WORKBENCH_CSS_LINK}`);
}

function setWorkbenchChecksum(productJsonContent: string, workbenchHtml: string): string {
  const parsed = parseProductJson(productJsonContent);

  parsed.checksums[WORKBENCH_CHECKSUM_KEY] = sha256Base64(workbenchHtml);
  return JSON.stringify(parsed, null, '\t').concat('\n');
}

/** Whether a product.json of a supported layout names this workbench HTML's checksum. */
function doesWorkbenchChecksumValueMatch(
  productJsonContent: string,
  workbenchHtml: string
): boolean {
  const layout = readProductLayout(productJsonContent);
  return layout.kind === 'supported' && layout.checksum === sha256Base64(workbenchHtml);
}

function readProductLayout(
  productJsonContent: string
): { kind: 'supported'; checksum: string } | { kind: 'unsupported'; reason: string } {
  try {
    return {
      kind: 'supported',
      checksum: parseProductJson(productJsonContent).checksums[WORKBENCH_CHECKSUM_KEY],
    };
  } catch (error) {
    if (!(error instanceof IslandShellFailure)) throw error;
    return { kind: 'unsupported', reason: error.message };
  }
}

/** product.json must hold a string checksum for the workbench HTML. */
function parseProductJson(productJsonContent: string): ProductJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(productJsonContent);
  } catch {
    throw new IslandShellFailure('unsupported', 'Unsupported product.json layout. Invalid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new IslandShellFailure('unsupported', 'Unsupported product.json layout. Not an object.');
  }
  const { checksums } = parsed as { checksums?: unknown };
  if (typeof checksums !== 'object' || checksums === null || Array.isArray(checksums)) {
    throw new IslandShellFailure(
      'unsupported',
      'Unsupported product.json layout. Missing checksums object.'
    );
  }
  if (typeof (checksums as Record<string, unknown>)[WORKBENCH_CHECKSUM_KEY] !== 'string') {
    throw new IslandShellFailure(
      'unsupported',
      `Unsupported product.json layout. Missing checksum key '${WORKBENCH_CHECKSUM_KEY}'.`
    );
  }
  return parsed as ProductJson;
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
    const parsed: unknown = JSON.parse(content);
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
  const sidecarRemovals = [...state.sidecars].map(([filePath, expectedContent]) => ({
    filePath,
    content: undefined,
    expectedContent,
  }));
  if (plan.kind !== 'restore-from-backup' && plan.kind !== 'strip-tyrian-block') {
    return sidecarRemovals;
  }
  return [
    {
      filePath: state.paths.workbenchHtmlPath,
      content: plan.html,
      expectedContent: state.currentHtml,
    },
    {
      filePath: state.paths.productJsonPath,
      content: plan.productJson,
      expectedContent: state.currentProductJson,
    },
    ...sidecarRemovals,
  ];
}
