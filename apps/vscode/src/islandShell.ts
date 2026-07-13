import crypto from 'node:crypto';
import { constants as fsConstants, type Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  BACKUP_HTML_FILE_NAME,
  BACKUP_PRODUCT_FILE_NAME,
  ISLAND_CSS_FILE_NAME,
  ISLAND_MANIFEST_FILE_NAME,
  ISLAND_PATCH_CONTRACT_VERSION,
  ISLAND_PATCH_STRATEGY,
  TYRIAN_MARKER_END,
  TYRIAN_MARKER_START,
  WORKBENCH_CHECKSUM_KEY,
  WORKBENCH_CSS_LINK,
  buildIslandRegistryLockPath,
  buildIslandRootLockPath,
  buildIslandPatchPaths,
  buildLegacyRetirementMarkerPath,
  buildLegacyManagedRootsRegistryPath,
  buildManagedRootRecordPath,
  buildManagedRootsDirectoryPath,
  buildQuarantinedRootsDirectoryPath,
  isIslandManifestV3Shape,
  type IslandManifestV3,
  type IslandPatchPaths,
} from './islandPatchContract.js';
import { rollbackFailedFileTransactionCore } from './islandFileTransactionCore.js';
import { isIslandLockLifecycleFailure, withIslandProcessLock } from './islandProcessLock.js';
import {
  IslandRegistryQuarantineError,
  moveRegistryRecordToQuarantineCore,
} from './islandRegistryMutationCore.js';
import {
  islandMutationFacts,
  mergeIslandMutationFacts,
  readIslandMutationFacts,
  type IslandMutationFacts,
} from './islandSupervisorCore.js';

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

export type IslandShellStatus = {
  appRoot: string;
  desiredThemeId: string | null | undefined;
  registrationState: 'absent' | 'valid' | 'legacy' | 'corrupt';
  active: boolean;
  managed: boolean;
  registered: boolean;
  classification:
    | 'clean'
    | 'patched'
    | 'managed-only'
    | 'transaction-pending'
    | 'transaction-blocked'
    | 'missing'
    | 'permission-denied'
    | 'broken-backup'
    | 'checksum-mismatch';
  verificationPassed: boolean;
  canSelfHeal: boolean;
  transaction: IslandTransactionHealth;
  restoreProof: 'none' | 'manifest-v3-backup-pair' | 'strip-tyrian-block';
  workbenchChecksum: string | undefined;
  productWorkbenchChecksum: string | undefined;
  receipt:
    | {
        installedAt: string;
        desiredThemeId: string;
        themeVersion: string;
        patchStrategy: typeof ISLAND_PATCH_STRATEGY;
        upstreamWorkbenchChecksum: string;
        patchedWorkbenchChecksum: string;
        cssChecksum: string;
      }
    | undefined;
  issues: string[];
};

export type IslandTransactionHealth =
  | {
      kind: 'clean';
      recoverability: 'none';
    }
  | {
      kind: 'recoverable';
      recoverability: 'automatic';
      journalPath: string;
      version: 3;
      phase: 'preparing' | 'prepared' | 'committing' | 'verified';
      reason: string;
    }
  | {
      kind: 'unsupported';
      recoverability: 'manual';
      journalPath: string;
      version: 1 | 2;
      reason: string;
    }
  | {
      kind: 'corrupt' | 'external-drift' | 'unavailable';
      recoverability: 'manual';
      journalPath: string;
      reason: string;
    };

export type IslandMutationResult = IslandMutationFacts & { changed: boolean };

export type IslandShellResult = IslandMutationResult & {
  active: boolean;
  status: IslandShellStatus;
};

export type IslandShellFailureCode = 'permission-required' | 'unsupported' | 'corrupt' | 'blocked';

export class IslandShellFailure extends Error {
  readonly code: IslandShellFailureCode;
  readonly changed: boolean;
  readonly desiredStateChanged: boolean;
  readonly registryChanged: boolean;
  readonly physicalChanged: boolean;
  readonly externalDrift: boolean;
  readonly incompleteRecovery: boolean;

  constructor(
    code: IslandShellFailureCode,
    message: string,
    options?: ErrorOptions & { mutation?: Partial<IslandMutationFacts> }
  ) {
    super(message, options);
    this.name = 'IslandShellFailure';
    this.code = code;
    const mutation = islandMutationFacts(options?.mutation);
    this.changed = mutation.changed;
    this.desiredStateChanged = mutation.desiredStateChanged;
    this.registryChanged = mutation.registryChanged;
    this.physicalChanged = mutation.physicalChanged;
    this.externalDrift = mutation.externalDrift;
    this.incompleteRecovery = mutation.incompleteRecovery;
  }
}

export class IslandShellTransitionFailure extends Error {
  readonly changed: boolean;
  readonly status: IslandShellStatus | undefined;
  readonly desiredStateChanged: boolean;
  readonly registryChanged: boolean;
  readonly physicalChanged: boolean;
  readonly externalDrift: boolean;
  readonly incompleteRecovery: boolean;

  constructor(error: unknown, status: IslandShellStatus | undefined) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = 'IslandShellTransitionFailure';
    const mutation = readIslandMutationFacts(error);
    this.changed = mutation.changed;
    this.desiredStateChanged = mutation.desiredStateChanged;
    this.registryChanged = mutation.registryChanged;
    this.physicalChanged = mutation.physicalChanged;
    this.externalDrift = mutation.externalDrift;
    this.incompleteRecovery = mutation.incompleteRecovery;
    this.status = status;
  }
}

export type IslandShellFailureDescription = {
  code: IslandShellFailureCode;
  changed: boolean;
  reason: string;
  desiredStateChanged: boolean;
  registryChanged: boolean;
  physicalChanged: boolean;
  externalDrift: boolean;
  incompleteRecovery: boolean;
  causes: Array<{ code: IslandShellFailureCode; reason: string }>;
};

export function describeIslandShellFailure(error: unknown): IslandShellFailureDescription {
  const typedFailure = findIslandShellFailure(error);
  const mutation = readIslandMutationFacts(error);
  const causes = collectIslandFailureCauses(error);
  const reason = causes.map((cause) => cause.reason).join(' | ');

  if (typedFailure !== undefined) {
    return {
      code: typedFailure.code,
      ...mutation,
      reason: reason || typedFailure.message,
      causes,
    };
  }

  const permissionError = findNodeError(error, new Set(['EACCES', 'EPERM']));

  return {
    code: permissionError === undefined ? 'blocked' : 'permission-required',
    ...mutation,
    reason: reason || (error instanceof Error ? error.message : String(error)),
    causes,
  };
}

export function readIslandShellFailureStatus(error: unknown): IslandShellStatus | undefined {
  return findNestedError(error, (candidate) =>
    candidate instanceof IslandShellTransitionFailure ? candidate.status : undefined
  );
}

export class IslandPartialMutationError extends Error {
  readonly changed: boolean;
  readonly desiredStateChanged: boolean;
  readonly registryChanged: boolean;
  readonly physicalChanged: boolean;
  readonly externalDrift: boolean;
  readonly incompleteRecovery: boolean;

  constructor(message: string, mutation: Partial<IslandMutationFacts>, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IslandPartialMutationError';
    const combined = mergeIslandMutationFacts(mutation, readIslandMutationFacts(options?.cause));
    this.changed = combined.changed;
    this.desiredStateChanged = combined.desiredStateChanged;
    this.registryChanged = combined.registryChanged;
    this.physicalChanged = combined.physicalChanged;
    this.externalDrift = combined.externalDrift;
    this.incompleteRecovery = combined.incompleteRecovery;
  }
}

export type IslandDesiredSeedResult = {
  kind: 'seeded' | 'existing';
  desiredThemeId: string | null;
} & IslandMutationResult;

export type IslandShellCleanupSummary = IslandMutationResult & {
  restoredAppRoots: string[];
  failedAppRoots: Array<{
    appRoot: string;
    code: IslandShellFailureCode;
    reason: string;
  }>;
  quarantinedRecords: string[];
  enumerationFailure?: IslandShellFailureDescription;
};

export type IslandShellWriteAccess = {
  writable: boolean;
  checkedPaths: string[];
  blockedPaths: Array<{ path: string; reason: string }>;
  issues: string[];
};

export type IslandShellApplyReadiness =
  | {
      kind: 'ready';
      appRoot: string;
      changed: boolean;
      status: IslandShellStatus;
      writeAccess: IslandShellWriteAccess;
    }
  | {
      kind: 'permission-required';
      appRoot: string;
      changed: boolean;
      status: IslandShellStatus;
      writeAccess: IslandShellWriteAccess;
      reason: string;
    }
  | {
      kind: 'unsupported';
      appRoot: string;
      status: IslandShellStatus | undefined;
      writeAccess: IslandShellWriteAccess | undefined;
      reason: string;
    }
  | {
      kind: 'blocked';
      appRoot: string;
      status: IslandShellStatus | undefined;
      writeAccess: IslandShellWriteAccess | undefined;
      reason: string;
    };

type LegacyManagedRootsRegistry = {
  version: 1;
  appRoots: string[];
};

type ManagedRootRecord = {
  version: 2;
  appRoot: string;
  desiredThemeId: string | null;
};

type LegacyManagedRootRecord = {
  version: 1;
  appRoot: string;
};

type ManagedRootRegistration =
  | { kind: 'absent' }
  | { kind: 'legacy'; appRoot: string }
  | { kind: 'valid'; record: ManagedRootRecord }
  | { kind: 'corrupt'; reason: string };

type IslandShellEnvironment = {
  registryHome?: string;
};

type RegistryRecordGeneration = {
  recordPath: string;
  dev: number | bigint;
  ino: number | bigint;
  contentHash: string | undefined;
  corrupt: boolean;
};

type RootCandidate = {
  appRoot: string;
  recordGeneration?: RegistryRecordGeneration;
};

type RootListing = {
  roots: RootCandidate[];
  registryDiagnostics: string[];
  registryChanged: boolean;
  quarantinedRecords: string[];
  enumerationFailure?: IslandShellFailureDescription;
};

type RegistryEnumerationAccumulator = {
  roots: RootCandidate[];
  registryDiagnostics: string[];
  quarantinedRecords?: string[];
};

export type IslandShellInventory = {
  statuses: IslandShellStatus[];
  registryDiagnostics: string[];
};

type FileMutation = {
  filePath: string;
  content: string | undefined;
  expectedContent: string | undefined;
};

type PreparedFileMutation = FileMutation & {
  backupPath: string;
  changed: boolean;
  existed: boolean;
  originalMode: number | undefined;
  originalContent: string | undefined;
  stagedPath: string | undefined;
};

type FileTransactionJournal = {
  version: 1 | 2 | 3;
  id: string;
  appRoot?: string;
  phase: 'preparing' | 'prepared' | 'committing' | 'verified';
  entries: Array<{
    filePath: string;
    backupPath: string;
    stagedPath: string | undefined;
    existed: boolean;
    originalChecksum?: string | null;
    desiredChecksum?: string | null;
  }>;
};

type IslandRootState = {
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

type RestorePlan =
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

export async function applyIslandShell(options: {
  appRoot: string;
  cssSourcePath: string;
  themeVersion: string;
  registryHome?: string;
}): Promise<IslandShellResult> {
  const appRoot = await canonicalizeAppRoot(options.appRoot);
  const canonicalOptions = { ...options, appRoot };
  await fs.access(getPatchPaths(appRoot).workbenchDirPath);

  return withIslandRootLock(
    appRoot,
    canonicalOptions,
    async (initializationChanged, recoveryPhysicalChanged) => {
      await readManagedAppRootsForMutationStrict(canonicalOptions);
      const registration = await readManagedAppRootRegistration(appRoot, canonicalOptions);
      if (registration.kind === 'corrupt') {
        throw new IslandShellFailure('corrupt', registration.reason);
      }
      const payload = await buildApplyPayload(canonicalOptions);
      const { paths } = payload;
      const recordChanged = await publishManagedRootRecord(
        appRoot,
        payload.desiredThemeId,
        canonicalOptions
      );

      let physicalChanged: boolean;
      try {
        physicalChanged = await commitFileTransaction(
          paths.transactionJournalPath,
          appRoot,
          [
            buildApplyMutation(payload, paths.backupHtmlPath, payload.baseHtml),
            buildApplyMutation(payload, paths.backupProductJsonPath, payload.baseProductJson),
            buildApplyMutation(payload, paths.islandCssPath, payload.cssSource),
            buildApplyMutation(payload, paths.manifestPath, payload.manifest),
            buildApplyMutation(payload, paths.workbenchHtmlPath, payload.patchedHtml),
            buildApplyMutation(payload, paths.productJsonPath, payload.patchedProductJson),
          ],
          async () => {
            await verifyAppliedShell(paths, appRoot, payload.desiredThemeId);
            const registration = await readManagedAppRootRegistration(appRoot, canonicalOptions);

            if (
              registration.kind !== 'valid' ||
              registration.record.desiredThemeId !== payload.desiredThemeId
            ) {
              throw new Error(
                'Tyrian Night verification failed: app root was not registered after apply.'
              );
            }
          }
        );
      } catch (error) {
        if (recordChanged || initializationChanged) {
          throw new IslandPartialMutationError(
            `Tyrian desired style was published, but physical apply failed: ${error instanceof Error ? error.message : String(error)}`,
            {
              desiredStateChanged: recordChanged,
              registryChanged: recordChanged || initializationChanged,
            },
            { cause: error }
          );
        }
        throw error;
      }

      const status = await readIslandShellStatusUnlocked(canonicalOptions);

      return {
        ...islandMutationFacts({
          desiredStateChanged: recordChanged,
          registryChanged: recordChanged || initializationChanged,
          physicalChanged: physicalChanged || recoveryPhysicalChanged,
        }),
        active: true,
        status,
      };
    },
    () => assertIslandApplyReady(canonicalOptions)
  );
}

export async function readIslandShellApplyReadiness(options: {
  appRoot: string;
  cssSourcePath: string;
  themeVersion: string;
  registryHome?: string;
}): Promise<IslandShellApplyReadiness> {
  const appRoot = await canonicalizeAppRoot(options.appRoot);
  const canonicalOptions = { ...options, appRoot };
  return readIslandShellApplyReadinessUnlocked(canonicalOptions);
}

async function readIslandShellApplyReadinessUnlocked(options: {
  appRoot: string;
  cssSourcePath: string;
  themeVersion: string;
  registryHome?: string;
}): Promise<IslandShellApplyReadiness> {
  const { appRoot } = options;
  let status: IslandShellStatus | undefined;
  let writeAccess: IslandShellWriteAccess | undefined;

  try {
    await readManagedAppRootsReadOnly(options, {
      roots: [],
      registryDiagnostics: [],
      tolerateDiagnostics: false,
    });
    status = await readIslandShellStatusUnlocked(options);
    writeAccess = await readIslandShellWriteAccess(options);
    if (
      status.transaction.kind === 'unsupported' ||
      status.transaction.kind === 'corrupt' ||
      status.transaction.kind === 'external-drift' ||
      status.transaction.kind === 'unavailable'
    ) {
      return {
        kind: status.transaction.kind === 'unsupported' ? 'unsupported' : 'blocked',
        appRoot,
        status,
        writeAccess,
        reason: status.transaction.reason,
      };
    }
    const payload = await buildApplyPayload(options);
    const changed =
      status.registrationState !== 'valid' ||
      status.desiredThemeId !== payload.desiredThemeId ||
      (await wouldApplyPayloadChange(payload));

    if (!writeAccess.writable && changed) {
      return {
        kind: 'permission-required',
        appRoot,
        changed,
        status,
        writeAccess,
        reason: 'Tyrian needs write access to the VS Code app files to manage Island UI.',
      };
    }

    return {
      kind: 'ready',
      appRoot,
      changed,
      status,
      writeAccess,
    };
  } catch (error) {
    if (isPermissionError(error)) {
      status ??= await readIslandShellStatusUnlocked(options);
      writeAccess ??= await readIslandShellWriteAccess(options);

      return {
        kind: 'permission-required',
        appRoot,
        changed: true,
        status,
        writeAccess,
        reason:
          'Tyrian needs write access to the VS Code app files to inspect or update Island UI.',
      };
    }

    const failure = describeIslandShellFailure(error);
    const kind = failure.code === 'unsupported' ? 'unsupported' : 'blocked';

    return {
      kind,
      appRoot,
      status,
      writeAccess,
      reason: failure.reason,
    };
  }
}

async function assertIslandApplyReady(options: {
  appRoot: string;
  cssSourcePath: string;
  themeVersion: string;
  registryHome?: string;
}): Promise<void> {
  const readiness = await readIslandShellApplyReadinessUnlocked(options);
  if (readiness.kind === 'ready') return;
  throw new IslandShellFailure(
    readiness.kind === 'permission-required'
      ? 'permission-required'
      : readiness.kind === 'unsupported'
        ? 'unsupported'
        : 'blocked',
    readiness.reason,
    {
      mutation: {
        externalDrift: readiness.status?.transaction.kind === 'external-drift',
        incompleteRecovery:
          readiness.status?.transaction.kind === 'unsupported' ||
          readiness.status?.transaction.kind === 'corrupt' ||
          readiness.status?.transaction.kind === 'external-drift' ||
          readiness.status?.transaction.kind === 'unavailable',
      },
    }
  );
}

export async function readIslandShellWriteAccess(options: {
  appRoot: string;
  cssSourcePath?: string;
  registryHome?: string;
}): Promise<IslandShellWriteAccess> {
  const appRoot = await canonicalizeAppRoot(options.appRoot);
  const paths = getPatchPaths(appRoot);
  const managedRootsDirectoryPath = getManagedRootsDirectoryPath(options);
  const stateDirectoryPath = path.dirname(managedRootsDirectoryPath);
  const requirements: Array<{
    path: string;
    existingMode: number;
    missingParentMode?: number;
    optional?: boolean;
  }> = [
    {
      path: paths.workbenchDirPath,
      existingMode: fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK,
    },
    {
      path: appRoot,
      existingMode: fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK,
    },
    { path: paths.workbenchHtmlPath, existingMode: fsConstants.R_OK },
    { path: paths.productJsonPath, existingMode: fsConstants.R_OK },
    ...(options.cssSourcePath
      ? [{ path: options.cssSourcePath, existingMode: fsConstants.R_OK }]
      : []),
    {
      path: stateDirectoryPath,
      existingMode: fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK,
      missingParentMode: fsConstants.W_OK | fsConstants.X_OK,
    },
    {
      path: managedRootsDirectoryPath,
      existingMode: fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK,
      missingParentMode: fsConstants.W_OK | fsConstants.X_OK,
    },
    ...[
      paths.islandCssPath,
      paths.manifestPath,
      paths.backupHtmlPath,
      paths.backupProductJsonPath,
      paths.transactionJournalPath,
      getManagedRootRecordPath(appRoot, options),
    ].map((filePath) => ({
      path: filePath,
      existingMode: fsConstants.R_OK,
      optional: true,
    })),
  ];
  const checkedPaths = requirements.map(({ path: checkedPath }) => checkedPath);
  const blockedPaths: IslandShellWriteAccess['blockedPaths'] = [];

  for (const requirement of requirements) {
    try {
      const stats = await lstatIfExists(requirement.path);
      if (stats !== undefined) await fs.access(requirement.path, requirement.existingMode);
      else if (requirement.optional) continue;
      else if (requirement.missingParentMode !== undefined)
        await assertExistingParentAccessible(requirement.path, requirement.missingParentMode);
      else await fs.access(requirement.path, requirement.existingMode);
    } catch (error) {
      blockedPaths.push({
        path: requirement.path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const issues = blockedPaths.map(({ path: filePath }) => `Tyrian cannot write '${filePath}'.`);

  return {
    writable: blockedPaths.length === 0,
    checkedPaths,
    blockedPaths,
    issues,
  };
}

async function assertExistingParentAccessible(filePath: string, mode: number): Promise<void> {
  let candidate = path.dirname(filePath);

  while ((await lstatIfExists(candidate)) === undefined) {
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }

  await fs.access(candidate, mode);
}

export async function restoreIslandShell(options: {
  appRoot: string;
  registryHome?: string;
}): Promise<IslandShellResult> {
  const appRoot = await canonicalizeAppRoot(options.appRoot);
  const canonicalOptions = { ...options, appRoot };
  await fs.access(getPatchPaths(appRoot).workbenchDirPath);

  return withIslandRootLock(
    appRoot,
    canonicalOptions,
    async (initializationChanged, recoveryPhysicalChanged) => {
      const registration = await readManagedAppRootRegistration(appRoot, canonicalOptions);
      const state = await inspectIslandRoot(appRoot, registration, canonicalOptions);
      const plan = buildRestorePlan(state);
      const recordChanged = await publishManagedRootRecord(appRoot, null, canonicalOptions);
      let physicalChanged: boolean;
      try {
        physicalChanged = await commitRestorePlan(state, plan, canonicalOptions);
      } catch (error) {
        if (recordChanged || initializationChanged) {
          throw new IslandPartialMutationError(
            `Tyrian disabled state was published, but physical restore failed: ${error instanceof Error ? error.message : String(error)}`,
            {
              desiredStateChanged: recordChanged,
              registryChanged: recordChanged || initializationChanged,
            },
            { cause: error }
          );
        }
        throw error;
      }

      const status = await readIslandShellStatusUnlocked(canonicalOptions);

      return {
        ...islandMutationFacts({
          desiredStateChanged: recordChanged,
          registryChanged: recordChanged || initializationChanged,
          physicalChanged: physicalChanged || recoveryPhysicalChanged,
        }),
        active: false,
        status,
      };
    }
  );
}

export async function seedIslandDesiredTheme(options: {
  appRoot: string;
  desiredThemeId: string;
  registryHome?: string;
}): Promise<IslandDesiredSeedResult> {
  if (!/^[a-z0-9][a-z0-9-]*\.css$/u.test(options.desiredThemeId)) {
    throw new IslandShellFailure(
      'unsupported',
      `Unsupported Tyrian Island CSS asset name '${options.desiredThemeId}'.`
    );
  }

  const appRoot = await canonicalizeAppRoot(options.appRoot);
  const canonicalOptions = { ...options, appRoot };
  await fs.access(getPatchPaths(appRoot).workbenchDirPath);

  return withIslandRootLock(
    appRoot,
    canonicalOptions,
    async (initializationChanged, recoveryPhysicalChanged) => {
      const registration = await readManagedAppRootRegistration(appRoot, canonicalOptions);

      if (registration.kind === 'valid') {
        return {
          kind: 'existing',
          desiredThemeId: registration.record.desiredThemeId,
          ...islandMutationFacts({
            registryChanged: initializationChanged,
            physicalChanged: recoveryPhysicalChanged,
          }),
        };
      }

      if (registration.kind === 'corrupt') {
        throw new IslandShellFailure('corrupt', registration.reason);
      }

      const recordChanged = await publishManagedRootRecord(
        appRoot,
        options.desiredThemeId,
        canonicalOptions
      );
      return {
        kind: 'seeded',
        desiredThemeId: options.desiredThemeId,
        ...islandMutationFacts({
          desiredStateChanged: recordChanged,
          registryChanged: recordChanged || initializationChanged,
          physicalChanged: recoveryPhysicalChanged,
        }),
      };
    }
  );
}

export async function restoreAllIslandShells(options?: {
  preferredAppRoots?: string[];
  registryHome?: string;
}): Promise<IslandShellCleanupSummary> {
  const listing = await listIslandShellRoots(options, { mode: 'restore' });
  let mutation = mergeIslandMutationFacts(
    islandMutationFacts({ registryChanged: listing.registryChanged }),
    listing.enumerationFailure
  );
  const restoredAppRoots: string[] = [];
  const failedAppRoots: IslandShellCleanupSummary['failedAppRoots'] = [];

  for (const appRoot of listing.roots) {
    try {
      const result = await restoreIslandShell({
        ...appRoot,
        registryHome: options?.registryHome,
      });

      mutation = mergeIslandMutationFacts(mutation, result);

      restoredAppRoots.push(appRoot.appRoot);
    } catch (error) {
      if (isIslandLockLifecycleFailure(error)) throw error;
      mutation = mergeIslandMutationFacts(mutation, readIslandMutationFacts(error));
      if (isFileNotFoundError(error)) {
        try {
          const cleanup = await removeMissingManagedAppRoot(appRoot, options);
          mutation = mergeIslandMutationFacts(
            mutation,
            islandMutationFacts({ registryChanged: cleanup.changed })
          );
          if (cleanup.quarantinePath !== undefined) {
            listing.quarantinedRecords.push(cleanup.quarantinePath);
          }
        } catch (cleanupError) {
          if (isIslandLockLifecycleFailure(cleanupError)) throw cleanupError;
          mutation = mergeIslandMutationFacts(mutation, readIslandMutationFacts(cleanupError));
          if (cleanupError instanceof IslandRegistryQuarantineError) {
            listing.quarantinedRecords.push(cleanupError.quarantinePath);
          }
          const failure = describeIslandShellFailure(cleanupError);
          failedAppRoots.push({
            appRoot: appRoot.appRoot,
            code: failure.code,
            reason: failure.reason,
          });
        }
        continue;
      }

      const failure = describeIslandShellFailure(error);
      failedAppRoots.push({
        appRoot: appRoot.appRoot,
        code: failure.code,
        reason: failure.reason,
      });
    }
  }

  return {
    ...mutation,
    restoredAppRoots,
    failedAppRoots,
    quarantinedRecords: listing.quarantinedRecords,
    ...(listing.enumerationFailure
      ? { enumerationFailure: listing.enumerationFailure }
      : undefined),
  };
}

async function removeMissingManagedAppRoot(
  candidate: RootCandidate,
  environment?: IslandShellEnvironment
): Promise<{ changed: boolean; quarantinePath?: string }> {
  return withRegistryLock(environment, async () => {
    const recordPath = getManagedRootRecordPath(candidate.appRoot, environment);
    const content = await readTextFileIfExists(recordPath);
    if (content === undefined) {
      return { changed: false };
    }

    if (candidate.recordGeneration !== undefined) {
      const current = await readRegistryRecordGeneration(
        recordPath,
        content,
        candidate.recordGeneration.corrupt
      );
      if (!sameRegistryRecordGeneration(current, candidate.recordGeneration)) {
        throw new Error(
          `Tyrian managed app root record changed during restore at '${recordPath}'.`
        );
      }

      if (candidate.recordGeneration.corrupt) {
        const quarantinePath = await quarantineManagedRootRecord(
          recordPath,
          environment,
          candidate.recordGeneration
        );
        return { changed: true, quarantinePath };
      } else {
        await removeFileDurably(recordPath, { registryChanged: true });
      }
      return { changed: true };
    }

    const record = parseManagedRootRecord(content, recordPath);
    if (record.appRoot !== candidate.appRoot) {
      throw new Error(`Tyrian managed app root record does not own '${candidate.appRoot}'.`);
    }
    await removeFileDurably(recordPath, { registryChanged: true });
    return { changed: true };
  });
}

export async function readIslandShellStatus(options: {
  appRoot: string;
  registryHome?: string;
}): Promise<IslandShellStatus> {
  const appRoot = await canonicalizeAppRoot(options.appRoot);
  return readIslandShellStatusUnlocked({ ...options, appRoot });
}

async function readIslandShellStatusUnlocked(options: {
  appRoot: string;
  registryHome?: string;
}): Promise<IslandShellStatus> {
  let registration: ManagedRootRegistration = { kind: 'absent' };
  let transaction: IslandTransactionHealth | undefined;

  try {
    registration = await readManagedAppRootRegistration(options.appRoot, options);
    const journalPath = getPatchPaths(options.appRoot).transactionJournalPath;
    transaction = await inspectIslandTransactionHealth(journalPath, options.appRoot, options);
    return (await inspectIslandRoot(options.appRoot, registration, options, transaction)).status;
  } catch (error) {
    const registered = registration.kind !== 'absent';

    if (isPermissionError(error)) {
      return {
        appRoot: options.appRoot,
        desiredThemeId: readDesiredThemeId(registration),
        registrationState: registration.kind,
        active: false,
        managed: false,
        registered,
        classification: 'permission-denied',
        verificationPassed: false,
        canSelfHeal: false,
        transaction: transaction ?? {
          kind: 'unavailable',
          recoverability: 'manual',
          journalPath: getPatchPaths(options.appRoot).transactionJournalPath,
          reason: 'Tyrian could not inspect transaction evidence due to permissions.',
        },
        restoreProof: 'none',
        workbenchChecksum: undefined,
        productWorkbenchChecksum: undefined,
        receipt: undefined,
        issues: ['Tyrian could not read the VS Code installation files due to permissions.'],
      };
    }

    if (isFileNotFoundError(error)) {
      const visibleTransaction: IslandTransactionHealth = transaction ?? {
        kind: 'clean',
        recoverability: 'none',
      };
      const transactionBlocked =
        visibleTransaction.kind === 'unsupported' ||
        visibleTransaction.kind === 'corrupt' ||
        visibleTransaction.kind === 'external-drift' ||
        visibleTransaction.kind === 'unavailable';
      return {
        appRoot: options.appRoot,
        desiredThemeId: readDesiredThemeId(registration),
        registrationState: registration.kind,
        active: false,
        managed: false,
        registered,
        classification: transactionBlocked
          ? 'transaction-blocked'
          : visibleTransaction.kind === 'recoverable'
            ? 'transaction-pending'
            : 'missing',
        verificationPassed: false,
        canSelfHeal: registered || visibleTransaction.kind === 'recoverable',
        transaction: visibleTransaction,
        restoreProof: 'none',
        workbenchChecksum: undefined,
        productWorkbenchChecksum: undefined,
        receipt: undefined,
        issues: [
          'Tyrian could not find the registered VS Code installation files.',
          ...(visibleTransaction.kind === 'clean' ? [] : [visibleTransaction.reason]),
        ],
      };
    }

    throw error;
  }
}

export async function readAllIslandShellStatuses(options?: {
  preferredAppRoots?: string[];
  registryHome?: string;
}): Promise<IslandShellStatus[]> {
  const { roots: appRoots } = await listIslandShellRoots(options);
  return readStatusesForRoots(appRoots, options);
}

export async function readAllIslandShellStatusesWithDiagnostics(options?: {
  preferredAppRoots?: string[];
  registryHome?: string;
}): Promise<IslandShellInventory> {
  const listing = await listIslandShellRoots(options, { mode: 'diagnostic-read' });
  return {
    statuses: await readStatusesForRoots(listing.roots, options),
    registryDiagnostics: listing.registryDiagnostics,
  };
}

async function readStatusesForRoots(
  appRoots: RootCandidate[],
  options?: { registryHome?: string }
): Promise<IslandShellStatus[]> {
  const statuses: IslandShellStatus[] = [];

  for (const appRoot of appRoots) {
    statuses.push(
      await readIslandShellStatus({
        appRoot: appRoot.appRoot,
        registryHome: options?.registryHome,
      })
    );
  }

  return statuses;
}

async function inspectIslandRoot(
  appRoot: string,
  registration: ManagedRootRegistration,
  environment?: IslandShellEnvironment,
  knownTransaction?: IslandTransactionHealth
): Promise<IslandRootState> {
  const registered = registration.kind !== 'absent';
  const desiredThemeId = readDesiredThemeId(registration);
  const paths = getPatchPaths(appRoot);
  const transaction =
    knownTransaction ??
    (await inspectIslandTransactionHealth(paths.transactionJournalPath, appRoot, environment));
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
  const desiredEnabled =
    registration.kind === 'valid' && registration.record.desiredThemeId !== null;
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
    registration.kind === 'legacy' ||
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

  if (registration.kind === 'corrupt') {
    issues.push(registration.reason);
  }

  if (registration.kind === 'legacy') {
    issues.push('Tyrian desired style is unknown and must be repaired or restored.');
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
    transaction.kind === 'unsupported' ||
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
      canSelfHeal:
        classification === 'transaction-pending' ||
        classification === 'managed-only' ||
        (hasTyrianEvidence &&
          (classification === 'broken-backup' || classification === 'checksum-mismatch')),
      restoreProof,
      transaction,
      workbenchChecksum,
      productWorkbenchChecksum,
      receipt,
      issues,
    },
  };
}

async function buildApplyPayload(options: {
  appRoot: string;
  cssSourcePath: string;
  themeVersion: string;
  registryHome?: string;
}): Promise<ApplyPayload> {
  const paths = getPatchPaths(options.appRoot);
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

async function wouldApplyPayloadChange(payload: ApplyPayload): Promise<boolean> {
  return (
    payload.expectedContents.get(payload.paths.backupHtmlPath) !== payload.baseHtml ||
    payload.expectedContents.get(payload.paths.backupProductJsonPath) !== payload.baseProductJson ||
    payload.expectedContents.get(payload.paths.islandCssPath) !== payload.cssSource ||
    payload.expectedContents.get(payload.paths.workbenchHtmlPath) !== payload.patchedHtml ||
    payload.expectedContents.get(payload.paths.productJsonPath) !== payload.patchedProductJson ||
    payload.expectedContents.get(payload.paths.manifestPath) !== payload.manifest
  );
}

async function listIslandShellRoots(
  options?: {
    preferredAppRoots?: string[];
    registryHome?: string;
  },
  behavior?: {
    mode?: 'strict-read' | 'diagnostic-read' | 'restore';
  }
): Promise<RootListing> {
  const candidates = new Map<string, RootCandidate>();
  const preferredAppRoots = options?.preferredAppRoots ?? [];
  const mode = behavior?.mode ?? 'strict-read';

  for (const candidateRoot of preferredAppRoots) {
    const appRoot = await canonicalizeAppRoot(candidateRoot);
    candidates.set(appRoot, { appRoot });
  }

  let enumerationFailure: IslandShellFailureDescription | undefined;
  const registryDiagnostics: string[] = [];
  const quarantinedRecords: string[] = [];
  const registeredRoots: RootCandidate[] = [];
  let initializationChanged = false;

  try {
    if (mode === 'restore') {
      initializationChanged = await initializeManagedRootsForMutation(options);
      await readManagedAppRootsForRestore(options, {
        roots: registeredRoots,
        registryDiagnostics,
        quarantinedRecords,
      });
    } else {
      await readManagedAppRootsReadOnly(options, {
        roots: registeredRoots,
        registryDiagnostics,
        tolerateDiagnostics: mode === 'diagnostic-read',
      });
    }
  } catch (error) {
    if (isIslandLockLifecycleFailure(error)) throw error;
    if (mode === 'restore') {
      enumerationFailure = describeIslandShellFailure(error);
    } else if (mode === 'diagnostic-read') {
      registryDiagnostics.push(error instanceof Error ? error.message : String(error));
    } else {
      throw error;
    }
  }

  for (const root of registeredRoots) {
    candidates.set(root.appRoot, root);
  }

  const existingRoots: RootCandidate[] = [];

  for (const candidate of candidates.values()) {
    if (!candidate.appRoot) {
      continue;
    }

    existingRoots.push(candidate);
  }

  return {
    roots: existingRoots,
    registryDiagnostics,
    registryChanged: initializationChanged || quarantinedRecords.length > 0,
    quarantinedRecords,
    ...(enumerationFailure !== undefined ? { enumerationFailure } : {}),
  };
}

function buildRestorePlan(state: IslandRootState): RestorePlan {
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

async function commitRestorePlan(
  state: IslandRootState,
  plan: RestorePlan,
  environment: IslandShellEnvironment
): Promise<boolean> {
  if (plan.kind === 'noop') {
    return false;
  }

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

  return commitFileTransaction(
    state.paths.transactionJournalPath,
    state.status.appRoot,
    mutations,
    async () => {
      if (plan.kind === 'remove-managed-state') {
        await verifyManagedStateRemoved(state.paths);
      } else {
        await verifyRestoredShell(state.paths);
      }

      const registration = await readManagedAppRootRegistration(state.status.appRoot, environment);
      if (registration.kind !== 'valid' || registration.record.desiredThemeId !== null) {
        throw new Error(
          'Tyrian Night verification failed: restored app root is not durably disabled.'
        );
      }
    }
  );
}

async function verifyAppliedShell(
  paths: IslandPatchPaths,
  appRoot: string,
  desiredThemeId: string
): Promise<void> {
  const currentHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const currentProductJson = await fs.readFile(paths.productJsonPath, 'utf8');
  const cssContent = await fs.readFile(paths.islandCssPath, 'utf8');
  const backupHtml = await fs.readFile(paths.backupHtmlPath, 'utf8');
  const backupProductJson = await fs.readFile(paths.backupProductJsonPath, 'utf8');

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

async function verifyRestoredShell(paths: IslandPatchPaths): Promise<void> {
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

async function verifyManagedStateRemoved(paths: IslandPatchPaths): Promise<void> {
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

function getPatchPaths(appRoot: string): IslandPatchPaths {
  return buildIslandPatchPaths(appRoot);
}

function getManagedRootsDirectoryPath(environment?: IslandShellEnvironment): string {
  return buildManagedRootsDirectoryPath(environment?.registryHome);
}

function getLegacyManagedRootsRegistryPath(environment?: IslandShellEnvironment): string {
  return buildLegacyManagedRootsRegistryPath(environment?.registryHome);
}

function getManagedRootRecordPath(appRoot: string, environment?: IslandShellEnvironment): string {
  return buildManagedRootRecordPath(appRoot, environment?.registryHome);
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
    .replace(markerEndPattern, '')
    .trimEnd()
    .concat('\n');
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

function sha256Base64(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('base64').replace(/=+$/, '');
}

async function readManagedAppRootRegistration(
  appRoot: string,
  environment?: IslandShellEnvironment
): Promise<ManagedRootRegistration> {
  const recordPath = getManagedRootRecordPath(appRoot, environment);
  let stats: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  try {
    stats = await lstatIfExists(recordPath);
  } catch (error) {
    if (isPermissionError(error)) throw error;
    return {
      kind: 'corrupt',
      reason: `${recordPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (stats === undefined) return { kind: 'absent' };
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return {
      kind: 'corrupt',
      reason: `Tyrian managed app root record is not a regular file at '${recordPath}'.`,
    };
  }

  let content: string;
  try {
    content = await fs.readFile(recordPath, 'utf8');
  } catch (error) {
    if (isPermissionError(error)) throw error;
    return {
      kind: 'corrupt',
      reason: `${recordPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    const record = parseManagedRootRecord(content, recordPath);
    if (record.appRoot !== appRoot) {
      throw new Error(`Tyrian managed app root record does not own '${appRoot}'.`);
    }
    return record.version === 1 ? { kind: 'legacy', appRoot } : { kind: 'valid', record };
  } catch (error) {
    return {
      kind: 'corrupt',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function publishManagedRootRecord(
  appRoot: string,
  desiredThemeId: string | null,
  environment?: IslandShellEnvironment
): Promise<boolean> {
  const publication = await withRegistryLock(environment, async () => {
    const recordPath = getManagedRootRecordPath(appRoot, environment);
    const content = serializeManagedRootRecord(appRoot, desiredThemeId);
    const changed = await writeIfChanged(recordPath, content, {
      desiredStateChanged: true,
      registryChanged: true,
    });
    return islandMutationFacts({
      desiredStateChanged: changed,
      registryChanged: changed,
    });
  });
  return publication.changed;
}

async function withRegistryLock<T>(
  environment: IslandShellEnvironment | undefined,
  action: () => Promise<T>
): Promise<T> {
  const directoryPath = getManagedRootsDirectoryPath(environment);
  const registryHome = await canonicalizeFuturePath(path.dirname(path.dirname(directoryPath)));
  return withIslandProcessLock(buildIslandRegistryLockPath(registryHome), action);
}

async function canonicalizeFuturePath(filePath: string): Promise<string> {
  let existingPath = path.resolve(filePath);
  const suffix: string[] = [];

  while ((await lstatIfExists(existingPath)) === undefined) {
    const parentPath = path.dirname(existingPath);
    if (parentPath === existingPath) break;
    suffix.unshift(path.basename(existingPath));
    existingPath = parentPath;
  }

  return path.join(await fs.realpath(existingPath), ...suffix);
}

async function initializeManagedRootsForMutation(
  environment?: IslandShellEnvironment
): Promise<boolean> {
  const initialization = await withRegistryLock(environment, async () => {
    const changed = await initializeManagedRootsForMutationUnlocked(environment);
    return islandMutationFacts({ registryChanged: changed });
  });
  return initialization.registryChanged;
}

async function initializeManagedRootsForMutationUnlocked(
  environment?: IslandShellEnvironment
): Promise<boolean> {
  const directoryPath = getManagedRootsDirectoryPath(environment);
  const directoryStats = await lstatIfExists(directoryPath);

  if (directoryStats !== undefined && !directoryStats.isDirectory()) {
    throw new Error(`Tyrian managed app roots path is not a directory at '${directoryPath}'.`);
  }

  const directoryExisted = directoryStats !== undefined;
  await fs.mkdir(directoryPath, { recursive: true });
  const retirementPath = buildLegacyRetirementMarkerPath(environment?.registryHome);
  const retiredContent = await readTextFileIfExists(retirementPath);
  if (retiredContent !== undefined) {
    validateLegacyRetirementMarker(retiredContent, retirementPath);
    return !directoryExisted;
  }
  const retired = await retireLegacyManagedRootsUnlocked(environment);
  return !directoryExisted || retired;
}

async function retireLegacyManagedRootsUnlocked(
  environment?: IslandShellEnvironment
): Promise<boolean> {
  const legacyPath = getLegacyManagedRootsRegistryPath(environment);
  const migrationPath = `${legacyPath}.migrating`;
  const retirementPath = buildLegacyRetirementMarkerPath(environment?.registryHome);
  const retiredContent = await readTextFileIfExists(retirementPath);
  let changed = false;

  if (retiredContent !== undefined) {
    validateLegacyRetirementMarker(retiredContent, retirementPath);
    for (const retiredPath of [legacyPath, migrationPath]) {
      changed = (await deleteIfExists(retiredPath)) || changed;
    }
    return changed;
  }

  const legacySnapshots = await Promise.all([
    readTextFileIfExists(legacyPath),
    readTextFileIfExists(migrationPath),
  ]);
  const legacyRoots = new Set<string>();

  for (const [index, content] of legacySnapshots.entries()) {
    if (content === undefined) {
      continue;
    }

    const sourcePath = index === 0 ? legacyPath : migrationPath;
    for (const appRoot of readLegacyManagedRootsRegistry(content, sourcePath)) {
      legacyRoots.add(await canonicalizeAppRoot(appRoot));
    }
  }

  for (const appRoot of legacyRoots) {
    const recordPath = getManagedRootRecordPath(appRoot, environment);
    const currentContent = await readTextFileIfExists(recordPath);

    if (currentContent === undefined) {
      changed =
        (await writeIfChanged(recordPath, serializeLegacyManagedRootRecord(appRoot), {
          registryChanged: true,
        })) || changed;
      continue;
    }

    const currentRecord = parseManagedRootRecord(currentContent, recordPath);
    if (currentRecord.appRoot !== appRoot) {
      throw new Error(`Tyrian managed app root record hash collision at '${recordPath}'.`);
    }
  }

  if (retiredContent === undefined) {
    await writeIfChanged(
      retirementPath,
      JSON.stringify({ version: 1, retiredAt: new Date().toISOString() }, null, 2).concat('\n'),
      { registryChanged: true }
    );
    changed = true;
  }
  for (const retiredPath of [legacyPath, migrationPath]) {
    changed = (await deleteIfExists(retiredPath)) || changed;
  }
  return changed;
}

async function readManagedAppRootsForMutationStrict(
  environment?: IslandShellEnvironment
): Promise<void> {
  const accumulator: RegistryEnumerationAccumulator = {
    roots: [],
    registryDiagnostics: [],
  };
  await withRegistryLock(environment, () =>
    readManagedRootRecordsFromDirectory(
      getManagedRootsDirectoryPath(environment),
      environment,
      'strict',
      accumulator
    )
  );
}

async function readManagedAppRootsForRestore(
  environment: IslandShellEnvironment | undefined,
  accumulator: RegistryEnumerationAccumulator & { quarantinedRecords: string[] }
): Promise<void> {
  await withRegistryLock(environment, () =>
    readManagedRootRecordsFromDirectory(
      getManagedRootsDirectoryPath(environment),
      environment,
      'restore',
      accumulator
    )
  );
}

async function readManagedAppRootsReadOnly(
  environment: IslandShellEnvironment | undefined,
  options: RegistryEnumerationAccumulator & { tolerateDiagnostics: boolean }
): Promise<void> {
  const directoryPath = getManagedRootsDirectoryPath(environment);
  const stats = await lstatIfExists(directoryPath);

  if (stats !== undefined) {
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      handleRegistryReadIssue(
        `Tyrian managed app roots path is not a directory at '${directoryPath}'.`,
        options
      );
    } else {
      try {
        await readManagedRootRecordsFromDirectory(
          directoryPath,
          environment,
          options.tolerateDiagnostics ? 'diagnostic' : 'strict',
          options
        );
      } catch (error) {
        handleRegistryReadIssue(error instanceof Error ? error.message : String(error), options);
      }
    }
  }

  await readLegacyManagedRootsReadOnly(environment, options);
}

async function readLegacyManagedRootsReadOnly(
  environment: IslandShellEnvironment | undefined,
  options: RegistryEnumerationAccumulator & { tolerateDiagnostics: boolean }
): Promise<void> {
  const retirementPath = buildLegacyRetirementMarkerPath(environment?.registryHome);
  const retirementStats = await lstatIfExists(retirementPath);

  if (retirementStats !== undefined) {
    if (!retirementStats.isFile() || retirementStats.isSymbolicLink()) {
      handleRegistryReadIssue(
        `Tyrian legacy retirement marker is not a regular file at '${retirementPath}'.`,
        options
      );
      return;
    }
    try {
      validateLegacyRetirementMarker(await fs.readFile(retirementPath, 'utf8'), retirementPath);
    } catch (error) {
      handleRegistryReadIssue(error instanceof Error ? error.message : String(error), options);
    }
    return;
  }

  for (const legacyPath of [
    getLegacyManagedRootsRegistryPath(environment),
    `${getLegacyManagedRootsRegistryPath(environment)}.migrating`,
  ]) {
    const legacyStats = await lstatIfExists(legacyPath);
    if (legacyStats === undefined) continue;
    if (!legacyStats.isFile() || legacyStats.isSymbolicLink()) {
      handleRegistryReadIssue(
        `Tyrian managed app roots registry is not a regular file at '${legacyPath}'.`,
        options
      );
      continue;
    }

    try {
      const content = await fs.readFile(legacyPath, 'utf8');
      for (const appRootValue of readLegacyManagedRootsRegistry(content, legacyPath)) {
        const appRoot = await canonicalizeAppRoot(appRootValue);
        if (!options.roots.some((candidate) => candidate.appRoot === appRoot)) {
          options.roots.push({ appRoot });
        }
      }
    } catch (error) {
      handleRegistryReadIssue(
        `${legacyPath}: ${error instanceof Error ? error.message : String(error)}`,
        options
      );
    }
  }
}

async function readManagedRootRecordsFromDirectory(
  directoryPath: string,
  environment: IslandShellEnvironment | undefined,
  mode: 'strict' | 'diagnostic' | 'restore',
  accumulator: RegistryEnumerationAccumulator
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (mode === 'diagnostic') {
      accumulator.registryDiagnostics.push(
        `${directoryPath}: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.tyrian-night-') && entry.name.endsWith('.tmp')) continue;
    if (/^\.tyrian-night-journal-[0-9a-f]{64}\.json$/u.test(entry.name)) {
      const reason = `Tyrian found an unsupported legacy registry transaction journal at '${path.join(directoryPath, entry.name)}' and left it untouched for manual recovery.`;
      if (mode === 'diagnostic') {
        accumulator.registryDiagnostics.push(reason);
        continue;
      }
      throw new IslandShellFailure('unsupported', reason, {
        mutation: { incompleteRecovery: true },
      });
    }

    const recordPath = path.join(directoryPath, entry.name);
    const validRecordName = /^[0-9a-f]{64}\.json$/u.test(entry.name);
    const stats = await lstatIfExists(recordPath);
    if (stats === undefined) continue;

    if (!validRecordName || !stats.isFile() || stats.isSymbolicLink()) {
      const reason = `Tyrian managed app root record is invalid at '${recordPath}'.`;
      if (mode === 'diagnostic') {
        accumulator.registryDiagnostics.push(reason);
        continue;
      }
      if (mode === 'restore' && (stats.isFile() || stats.isSymbolicLink())) {
        const generation = registryRecordGenerationFromStats(recordPath, stats, undefined, true);
        await quarantineManagedRootRecordAndRecord(
          recordPath,
          environment,
          generation,
          accumulator
        );
        continue;
      }
      throw new Error(reason);
    }

    let content: string;
    try {
      content = await fs.readFile(recordPath, 'utf8');
    } catch (error) {
      const reason = `${recordPath}: ${error instanceof Error ? error.message : String(error)}`;
      if (mode === 'diagnostic') {
        accumulator.registryDiagnostics.push(reason);
        continue;
      }
      if (mode === 'restore') {
        const generation = registryRecordGenerationFromStats(recordPath, stats, undefined, true);
        await quarantineManagedRootRecordAndRecord(
          recordPath,
          environment,
          generation,
          accumulator
        );
        continue;
      }
      throw error;
    }

    let appRoot: string;
    try {
      appRoot = await identifyManagedRootRecord(content, recordPath, environment);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (mode === 'diagnostic') {
        accumulator.registryDiagnostics.push(reason);
        continue;
      }
      if (mode === 'restore') {
        const generation = await readRegistryRecordGeneration(recordPath, content, true);
        await quarantineManagedRootRecordAndRecord(
          recordPath,
          environment,
          generation,
          accumulator
        );
        continue;
      }
      throw error;
    }

    let corrupt = false;
    try {
      const record = parseManagedRootRecord(content, recordPath);
      if (record.appRoot !== appRoot) {
        throw new Error(`Tyrian managed app root record does not own '${appRoot}'.`);
      }
    } catch (error) {
      corrupt = true;
      if (mode === 'diagnostic') {
        accumulator.registryDiagnostics.push(
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    if (accumulator.roots.some((candidate) => candidate.appRoot === appRoot)) {
      const reason = `Tyrian managed app root '${appRoot}' is registered more than once.`;
      if (mode === 'diagnostic') {
        accumulator.registryDiagnostics.push(reason);
        continue;
      }
      throw new Error(reason);
    }

    accumulator.roots.push({
      appRoot,
      recordGeneration: await readRegistryRecordGeneration(recordPath, content, corrupt),
    });
  }

  accumulator.roots.sort((left, right) => left.appRoot.localeCompare(right.appRoot));
}

function handleRegistryReadIssue(
  reason: string,
  options: RegistryEnumerationAccumulator & { tolerateDiagnostics: boolean }
): void {
  if (!options.tolerateDiagnostics) throw new Error(reason);
  options.registryDiagnostics.push(reason);
}

async function readRegistryRecordGeneration(
  recordPath: string,
  content: string | undefined,
  corrupt: boolean
): Promise<RegistryRecordGeneration> {
  const stats = await fs.lstat(recordPath);
  return registryRecordGenerationFromStats(recordPath, stats, content, corrupt);
}

function registryRecordGenerationFromStats(
  recordPath: string,
  stats: Awaited<ReturnType<typeof fs.lstat>>,
  content: string | undefined,
  corrupt: boolean
): RegistryRecordGeneration {
  return {
    recordPath,
    dev: stats.dev,
    ino: stats.ino,
    contentHash:
      content === undefined
        ? undefined
        : crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
    corrupt,
  };
}

function sameRegistryRecordGeneration(
  left: RegistryRecordGeneration,
  right: RegistryRecordGeneration
): boolean {
  return (
    left.recordPath === right.recordPath &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.contentHash === right.contentHash
  );
}

async function quarantineManagedRootRecordAndRecord(
  recordPath: string,
  environment: IslandShellEnvironment | undefined,
  expected: RegistryRecordGeneration,
  accumulator: RegistryEnumerationAccumulator
): Promise<void> {
  try {
    const quarantinePath = await quarantineManagedRootRecord(recordPath, environment, expected);
    accumulator.quarantinedRecords?.push(quarantinePath);
  } catch (error) {
    if (error instanceof IslandRegistryQuarantineError) {
      accumulator.quarantinedRecords?.push(error.quarantinePath);
    }
    throw error;
  }
}

async function quarantineManagedRootRecord(
  recordPath: string,
  environment: IslandShellEnvironment | undefined,
  expected: RegistryRecordGeneration
): Promise<string> {
  const stats = await fs.lstat(recordPath);
  let content: string | undefined;
  if (stats.isFile() && !stats.isSymbolicLink()) {
    try {
      content = await fs.readFile(recordPath, 'utf8');
    } catch {
      content = undefined;
    }
  }
  const current = registryRecordGenerationFromStats(recordPath, stats, content, expected.corrupt);
  if (!sameRegistryRecordGeneration(current, expected)) {
    throw new Error(`Tyrian managed app root record changed before quarantine at '${recordPath}'.`);
  }

  const quarantineDirectory = buildQuarantinedRootsDirectoryPath(environment?.registryHome);
  await fs.mkdir(quarantineDirectory, { recursive: true });
  const quarantinePath = path.join(
    quarantineDirectory,
    `${path.basename(recordPath, '.json')}-${crypto.randomUUID()}.json`
  );
  await moveRegistryRecordToQuarantineCore({
    recordPath,
    recordDirectory: path.dirname(recordPath),
    quarantinePath,
    quarantineDirectory,
    rename: fs.rename,
    syncDirectories,
  });
  return quarantinePath;
}

async function identifyManagedRootRecord(
  content: string,
  recordPath: string,
  environment?: IslandShellEnvironment
): Promise<string> {
  let parsed: { appRoot?: unknown };
  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch {
    throw new Error(`Tyrian managed app root record is invalid JSON at '${recordPath}'.`);
  }
  if (typeof parsed.appRoot !== 'string' || !path.isAbsolute(parsed.appRoot)) {
    throw new Error(
      `Tyrian managed app root record has no identifiable app root at '${recordPath}'.`
    );
  }
  const appRoot = await canonicalizeAppRoot(parsed.appRoot);
  if (appRoot !== parsed.appRoot || getManagedRootRecordPath(appRoot, environment) !== recordPath) {
    throw new Error(`Tyrian managed app root record identity is invalid at '${recordPath}'.`);
  }
  return appRoot;
}

function parseManagedRootRecord(
  content: string,
  recordPath: string
): ManagedRootRecord | LegacyManagedRootRecord {
  let parsed: { version?: unknown; appRoot?: unknown; desiredThemeId?: unknown };

  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch {
    throw new Error(`Tyrian managed app root record is invalid JSON at '${recordPath}'.`);
  }

  if (
    (parsed.version !== 1 && parsed.version !== 2) ||
    typeof parsed.appRoot !== 'string' ||
    parsed.appRoot.trim().length === 0 ||
    !path.isAbsolute(parsed.appRoot)
  ) {
    throw new Error(
      `Tyrian managed app root record is invalid: expected version 1 with an absolute appRoot at '${recordPath}'.`
    );
  }

  if (
    parsed.version === 2 &&
    parsed.desiredThemeId !== null &&
    (typeof parsed.desiredThemeId !== 'string' ||
      !/^[a-z0-9][a-z0-9-]*\.css$/u.test(parsed.desiredThemeId))
  ) {
    throw new Error(
      `Tyrian managed app root record is invalid: version 2 requires a CSS asset desiredThemeId at '${recordPath}'.`
    );
  }

  return parsed as ManagedRootRecord | LegacyManagedRootRecord;
}

function serializeManagedRootRecord(appRoot: string, desiredThemeId: string | null): string {
  const record: ManagedRootRecord = { version: 2, appRoot, desiredThemeId };
  return JSON.stringify(record, null, 2).concat('\n');
}

function serializeLegacyManagedRootRecord(appRoot: string): string {
  const record: LegacyManagedRootRecord = { version: 1, appRoot };
  return JSON.stringify(record, null, 2).concat('\n');
}

function validateLegacyRetirementMarker(content: string, markerPath: string): void {
  let parsed: { version?: unknown; retiredAt?: unknown };

  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch {
    throw new Error(`Tyrian legacy registry retirement marker is invalid JSON at '${markerPath}'.`);
  }

  if (parsed.version !== 1 || typeof parsed.retiredAt !== 'string') {
    throw new Error(`Tyrian legacy registry retirement marker is invalid at '${markerPath}'.`);
  }
}

function readLegacyManagedRootsRegistry(content: string, registryPath: string): string[] {
  let parsed: Partial<LegacyManagedRootsRegistry>;

  try {
    parsed = JSON.parse(content) as Partial<LegacyManagedRootsRegistry>;
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
    parsed.appRoots.some(
      (appRoot) =>
        typeof appRoot !== 'string' || appRoot.trim().length === 0 || !path.isAbsolute(appRoot)
    )
  ) {
    throw new Error(
      `Tyrian managed app roots registry is invalid: every app root must be an absolute non-empty string at '${registryPath}'.`
    );
  }

  return [...new Set(parsed.appRoots)].sort((left, right) => left.localeCompare(right));
}

async function commitFileTransaction(
  journalPath: string,
  appRoot: string,
  mutations: FileMutation[],
  verify: () => Promise<void>
): Promise<boolean> {
  const targets = new Set<string>();
  const prepared: PreparedFileMutation[] = [];
  const transactionId = crypto.randomUUID();

  for (const mutation of mutations) {
    if (targets.has(mutation.filePath)) {
      throw new Error(`Tyrian file transaction contains duplicate target '${mutation.filePath}'.`);
    }
    targets.add(mutation.filePath);

    const stats = await lstatIfExists(mutation.filePath);

    if (stats?.isDirectory()) {
      throw new Error(`Tyrian file transaction target is a directory at '${mutation.filePath}'.`);
    }

    if (stats?.isSymbolicLink()) {
      throw new Error(
        `Tyrian file transaction target is a symbolic link at '${mutation.filePath}'.`
      );
    }

    const currentContent =
      stats === undefined ? undefined : await fs.readFile(mutation.filePath, 'utf8');

    if (currentContent !== mutation.expectedContent) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian transaction input changed before preparation at '${mutation.filePath}'.`
      );
    }

    const changed = currentContent !== mutation.content;

    prepared.push({
      ...mutation,
      backupPath: transactionSiblingPath(mutation.filePath, transactionId, 'backup'),
      changed,
      existed: stats !== undefined,
      originalMode: stats === undefined ? undefined : Number(stats.mode),
      originalContent: currentContent,
      stagedPath:
        changed && mutation.content !== undefined
          ? transactionSiblingPath(mutation.filePath, transactionId, 'stage')
          : undefined,
    });
  }

  const changedMutations = prepared.filter(({ changed }) => changed);

  if (changedMutations.length === 0) {
    await verify();
    return false;
  }

  let journal = buildFileTransactionJournal(appRoot, transactionId, 'preparing', changedMutations);
  let physicalMutationAttempted = false;
  await writeDurableJsonFile(journalPath, journal);

  try {
    for (const mutation of changedMutations) {
      await fs.mkdir(path.dirname(mutation.filePath), { recursive: true });

      if (mutation.existed) {
        await fs.copyFile(mutation.filePath, mutation.backupPath, fsConstants.COPYFILE_EXCL);
        await syncFile(mutation.backupPath);
      }

      if (mutation.stagedPath !== undefined) {
        await writeDurableFileExclusive(mutation.stagedPath, mutation.content!);

        if (mutation.originalMode !== undefined) {
          await fs.chmod(mutation.stagedPath, mutation.originalMode);
          await syncFile(mutation.stagedPath);
        }
      }
    }

    await syncDirectories(
      changedMutations.flatMap(({ backupPath, stagedPath }) =>
        stagedPath === undefined
          ? [path.dirname(backupPath)]
          : [path.dirname(backupPath), path.dirname(stagedPath)]
      )
    );

    journal = { ...journal, phase: 'prepared' };
    await writeDurableJsonFile(journalPath, journal);

    for (const mutation of changedMutations) {
      await assertPreparedMutationGeneration(mutation);
    }

    journal = { ...journal, phase: 'committing' };
    await writeDurableJsonFile(journalPath, journal);

    physicalMutationAttempted = true;
    for (const mutation of changedMutations) {
      await assertPreparedMutationGeneration(mutation);

      if (mutation.stagedPath === undefined) {
        await fs.rm(mutation.filePath, { force: true });
      } else {
        await fs.rename(mutation.stagedPath, mutation.filePath);
      }
    }

    await syncDirectories(changedMutations.map(({ filePath }) => path.dirname(filePath)));

    await verify();
    journal = { ...journal, phase: 'verified' };
    await writeDurableJsonFile(journalPath, journal);
  } catch (error) {
    const durableJournal = await tryReadFileTransactionJournal(journalPath, appRoot);

    await rollbackFailedFileTransactionCore({
      transactionError: error,
      physicalMutationAttempted,
      rollback: async () => {
        if (durableJournal !== undefined) {
          await rollbackFileTransaction(journalPath, durableJournal);
        }
      },
    });
  }

  await finishVerifiedFileTransaction(journalPath, journal);
  return true;
}

function buildFileTransactionJournal(
  appRoot: string,
  id: string,
  phase: FileTransactionJournal['phase'],
  mutations: PreparedFileMutation[]
): FileTransactionJournal {
  return {
    version: 3,
    id,
    appRoot,
    phase,
    entries: mutations.map(
      ({ filePath, backupPath, stagedPath, existed, originalContent, content }) => ({
        filePath,
        backupPath,
        stagedPath,
        existed,
        originalChecksum: checksumOrNull(originalContent),
        desiredChecksum: checksumOrNull(content),
      })
    ),
  };
}

async function assertPreparedMutationGeneration(mutation: PreparedFileMutation): Promise<void> {
  const currentContent = await readTransactionTarget(mutation.filePath);

  if (currentContent !== mutation.originalContent) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian transaction input changed before replacement at '${mutation.filePath}'.`
    );
  }
}

async function rollbackFileTransaction(
  journalPath: string,
  journal: FileTransactionJournal
): Promise<boolean> {
  if (journal.version !== 3) {
    throw new IslandShellFailure(
      'unsupported',
      `Tyrian transaction journal version ${journal.version} lacks target-generation evidence and was left untouched at '${journalPath}'.`,
      { mutation: { incompleteRecovery: true } }
    );
  }

  if (journal.phase === 'preparing' || journal.phase === 'prepared') {
    await removeJournalBeforeTemporaryFiles(journalPath, journal);
    return false;
  }

  return rollbackVersion3FileTransaction(journalPath, journal);
}

async function rollbackVersion3FileTransaction(
  journalPath: string,
  journal: FileTransactionJournal
): Promise<boolean> {
  const failures: unknown[] = [];
  let physicalChanged = false;

  for (const entry of journal.entries.toReversed()) {
    try {
      const currentChecksum = checksumOrNull(await readTransactionTarget(entry.filePath));

      if (currentChecksum === entry.originalChecksum) continue;
      if (currentChecksum !== entry.desiredChecksum) {
        throw new IslandShellFailure(
          'blocked',
          `Tyrian transaction recovery found external drift at '${entry.filePath}' and left it untouched.`,
          { mutation: { externalDrift: true, incompleteRecovery: true } }
        );
      }

      if (entry.existed) {
        const backupStats = await lstatIfExists(entry.backupPath);
        if (backupStats === undefined || !backupStats.isFile() || backupStats.isSymbolicLink()) {
          throw new IslandShellFailure(
            'corrupt',
            `Tyrian file transaction recovery has no trustworthy backup at '${entry.backupPath}'.`
          );
        }
        if (
          checksumOrNull(await fs.readFile(entry.backupPath, 'utf8')) !== entry.originalChecksum
        ) {
          throw new IslandShellFailure(
            'corrupt',
            `Tyrian file transaction recovery backup changed at '${entry.backupPath}'.`
          );
        }

        const restorePath = transactionSiblingPath(entry.filePath, journal.id, 'restore');
        await fs.copyFile(entry.backupPath, restorePath);
        await syncFile(restorePath);
        await assertRecoveryTargetGeneration(entry);
        await fs.rename(restorePath, entry.filePath);
        physicalChanged = true;
      } else {
        await assertRecoveryTargetGeneration(entry);
        await fs.rm(entry.filePath, { force: true });
        physicalChanged = true;
      }
    } catch (error) {
      failures.push(error);
    }
  }

  try {
    await syncDirectories(journal.entries.map(({ filePath }) => path.dirname(filePath)));
  } catch (error) {
    failures.push(error);
  }

  if (failures.length > 0) {
    const failureCode = combineIslandFailureCodes(failures);
    throw new IslandShellFailure(
      failureCode,
      `Tyrian transaction recovery could not safely restore every target: ${failures
        .map((failure) => (failure instanceof Error ? failure.message : String(failure)))
        .join(' ')}`,
      {
        cause: new AggregateError(failures),
        mutation: mergeIslandMutationFacts(
          ...failures.map((failure) => readIslandMutationFacts(failure)),
          { physicalChanged, incompleteRecovery: true }
        ),
      }
    );
  }

  try {
    await removeJournalBeforeTemporaryFiles(journalPath, journal);
  } catch (cleanupError) {
    const cleanupFailure = describeIslandShellFailure(cleanupError);
    throw new IslandShellFailure(cleanupFailure.code, cleanupFailure.reason, {
      cause: cleanupError,
      mutation: mergeIslandMutationFacts(readIslandMutationFacts(cleanupError), {
        physicalChanged,
        incompleteRecovery: true,
      }),
    });
  }
  return physicalChanged;
}

async function assertRecoveryTargetGeneration(
  entry: FileTransactionJournal['entries'][number]
): Promise<void> {
  const currentChecksum = checksumOrNull(await readTransactionTarget(entry.filePath));

  if (currentChecksum !== entry.desiredChecksum) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian transaction recovery observed a replacement generation at '${entry.filePath}' and left it untouched.`
    );
  }
}

function combineIslandFailureCodes(failures: unknown[]): IslandShellFailureCode {
  const codes = failures.map((failure) => describeIslandShellFailure(failure).code);

  if (codes.every((code) => code === 'permission-required')) return 'permission-required';
  if (codes.includes('corrupt')) return 'corrupt';
  if (codes.includes('blocked')) return 'blocked';
  return 'unsupported';
}

async function readTransactionTarget(filePath: string): Promise<string | undefined> {
  const stats = await lstatIfExists(filePath);

  if (stats === undefined) return undefined;
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian transaction target generation is not a regular file at '${filePath}'.`
    );
  }

  return fs.readFile(filePath, 'utf8');
}

function checksumOrNull(content: string | undefined): string | null {
  return content === undefined ? null : sha256Base64(content);
}

async function removeJournalBeforeTemporaryFiles(
  journalPath: string,
  journal: FileTransactionJournal
): Promise<void> {
  await removeFileDurably(journalPath, { incompleteRecovery: true });

  for (const entry of journal.entries) {
    for (const temporaryPath of [entry.stagedPath, entry.backupPath]) {
      if (temporaryPath !== undefined) {
        await fs.rm(temporaryPath, { force: true });
      }
    }
  }
}

async function finishVerifiedFileTransaction(
  journalPath: string,
  journal: FileTransactionJournal
): Promise<void> {
  try {
    for (const entry of journal.entries) {
      for (const temporaryPath of [entry.stagedPath, entry.backupPath]) {
        if (temporaryPath !== undefined) {
          await fs.rm(temporaryPath, { force: true });
        }
      }
    }

    await fs.rm(journalPath, { force: true });
  } catch {
    // The verified state is authoritative. The journal makes cleanup retryable.
  }
}

function transactionSiblingPath(
  filePath: string,
  transactionId: string,
  kind: 'backup' | 'stage' | 'restore'
): string {
  return path.join(
    path.dirname(filePath),
    `.tyrian-night-${transactionId}-${kind}-${path.basename(filePath)}.tmp`
  );
}

async function withIslandRootLock<T>(
  appRoot: string,
  environment: IslandShellEnvironment,
  action: (initializationChanged: boolean, recoveryPhysicalChanged: boolean) => Promise<T>,
  readinessGate?: () => Promise<void>
): Promise<T> {
  return withIslandProcessLock(buildIslandRootLockPath(appRoot), async () => {
    await readinessGate?.();
    let initializationChanged = false;
    let recoveryPhysicalChanged = false;
    try {
      const initialization = await withRegistryLock(environment, async () => {
        await readinessGate?.();
        const changed = await initializeManagedRootsForMutationUnlocked(environment);
        return islandMutationFacts({ registryChanged: changed });
      });
      initializationChanged = initialization.registryChanged;
      recoveryPhysicalChanged = await recoverRootFileTransactions(appRoot, environment);
      return await action(initializationChanged, recoveryPhysicalChanged);
    } catch (error) {
      let status: IslandShellStatus | undefined;

      try {
        status = await readIslandShellStatusUnlocked({ ...environment, appRoot });
      } catch {
        status = undefined;
      }

      const transition = new IslandShellTransitionFailure(error, status);
      if (!initializationChanged && !recoveryPhysicalChanged) throw transition;
      throw new IslandPartialMutationError(
        `Tyrian durable state changed before the root transition failed: ${transition.message}`,
        {
          registryChanged: initializationChanged,
          physicalChanged: recoveryPhysicalChanged,
        },
        { cause: transition }
      );
    }
  });
}

async function recoverRootFileTransactions(
  appRoot: string,
  environment: IslandShellEnvironment
): Promise<boolean> {
  const paths = getPatchPaths(appRoot);
  const recordPath = getManagedRootRecordPath(appRoot, environment);
  const allowedTargets = new Set([
    paths.workbenchHtmlPath,
    paths.productJsonPath,
    paths.islandCssPath,
    paths.manifestPath,
    paths.backupHtmlPath,
    paths.backupProductJsonPath,
    recordPath,
  ]);

  return recoverFileTransaction(paths.transactionJournalPath, allowedTargets, appRoot);
}

async function recoverFileTransaction(
  journalPath: string,
  allowedTargets: Set<string>,
  appRoot: string
): Promise<boolean> {
  const journalStats = await lstatIfExists(journalPath);
  if (journalStats !== undefined && (!journalStats.isFile() || journalStats.isSymbolicLink())) {
    throw new IslandShellFailure(
      'corrupt',
      `Tyrian file transaction journal is not a regular file at '${journalPath}'.`,
      { mutation: { incompleteRecovery: true } }
    );
  }
  const content = await readTextFileIfExists(journalPath);

  if (content === undefined) {
    return false;
  }

  let journal: FileTransactionJournal;
  try {
    journal = parseFileTransactionJournal(content, journalPath, allowedTargets, appRoot);
  } catch (error) {
    throw new IslandShellFailure(
      'corrupt',
      error instanceof Error ? error.message : String(error),
      { cause: error, mutation: { incompleteRecovery: true } }
    );
  }

  if (journal.version !== 3) {
    throw new IslandShellFailure(
      'unsupported',
      `Tyrian transaction journal version ${journal.version} lacks target-generation evidence and was left untouched at '${journalPath}'.`,
      { mutation: { incompleteRecovery: true } }
    );
  }

  if (journal.phase === 'verified') {
    await finishVerifiedFileTransaction(journalPath, journal);
    return false;
  }

  return rollbackFileTransaction(journalPath, journal);
}

async function inspectIslandTransactionHealth(
  journalPath: string,
  appRoot: string,
  environment?: IslandShellEnvironment
): Promise<IslandTransactionHealth> {
  const journalStats = await lstatIfExists(journalPath);
  if (journalStats === undefined) return { kind: 'clean', recoverability: 'none' };
  if (!journalStats.isFile() || journalStats.isSymbolicLink()) {
    return {
      kind: 'corrupt',
      recoverability: 'manual',
      journalPath,
      reason: `Tyrian file transaction journal is not a regular file at '${journalPath}'.`,
    };
  }

  let journal: FileTransactionJournal;
  try {
    const paths = getPatchPaths(appRoot);
    journal = parseFileTransactionJournal(
      await fs.readFile(journalPath, 'utf8'),
      journalPath,
      new Set([
        paths.workbenchHtmlPath,
        paths.productJsonPath,
        paths.islandCssPath,
        paths.manifestPath,
        paths.backupHtmlPath,
        paths.backupProductJsonPath,
        getManagedRootRecordPath(appRoot, environment),
      ]),
      appRoot
    );
  } catch (error) {
    if (isPermissionError(error)) throw error;
    return {
      kind: 'corrupt',
      recoverability: 'manual',
      journalPath,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (journal.version !== 3) {
    return {
      kind: 'unsupported',
      recoverability: 'manual',
      journalPath,
      version: journal.version,
      reason: `Tyrian transaction journal version ${journal.version} lacks target-generation evidence and was left untouched at '${journalPath}'.`,
    };
  }

  if (journal.phase === 'committing') {
    for (const entry of journal.entries) {
      let currentChecksum: string | null;
      try {
        currentChecksum = checksumOrNull(await readTransactionTarget(entry.filePath));
      } catch (error) {
        return {
          kind: 'corrupt',
          recoverability: 'manual',
          journalPath,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (currentChecksum !== entry.originalChecksum && currentChecksum !== entry.desiredChecksum) {
        return {
          kind: 'external-drift',
          recoverability: 'manual',
          journalPath,
          reason: `Tyrian transaction recovery found external drift at '${entry.filePath}' and will leave it untouched.`,
        };
      }

      if (currentChecksum === entry.desiredChecksum && entry.existed) {
        const backupStats = await lstatIfExists(entry.backupPath);
        if (
          backupStats === undefined ||
          !backupStats.isFile() ||
          backupStats.isSymbolicLink() ||
          checksumOrNull(await fs.readFile(entry.backupPath, 'utf8')) !== entry.originalChecksum
        ) {
          return {
            kind: 'corrupt',
            recoverability: 'manual',
            journalPath,
            reason: `Tyrian file transaction recovery has no trustworthy backup at '${entry.backupPath}'.`,
          };
        }
      }
    }
  }

  return {
    kind: 'recoverable',
    recoverability: 'automatic',
    journalPath,
    version: 3,
    phase: journal.phase,
    reason: `Tyrian transaction journal is pending automatic ${journal.phase === 'verified' ? 'cleanup' : 'recovery'} at '${journalPath}'.`,
  };
}

async function tryReadFileTransactionJournal(
  journalPath: string,
  appRoot: string
): Promise<FileTransactionJournal | undefined> {
  const journalStats = await lstatIfExists(journalPath);
  if (journalStats !== undefined && (!journalStats.isFile() || journalStats.isSymbolicLink())) {
    throw new IslandShellFailure(
      'corrupt',
      `Tyrian file transaction journal is not a regular file at '${journalPath}'.`,
      { mutation: { incompleteRecovery: true } }
    );
  }
  const content = await readTextFileIfExists(journalPath);
  if (content === undefined) {
    return undefined;
  }

  try {
    return parseFileTransactionJournal(content, journalPath, undefined, appRoot);
  } catch (error) {
    throw new IslandShellFailure(
      'corrupt',
      error instanceof Error ? error.message : String(error),
      { cause: error, mutation: { incompleteRecovery: true } }
    );
  }
}

function parseFileTransactionJournal(
  content: string,
  journalPath: string,
  allowedTargets?: Set<string>,
  expectedAppRoot?: string
): FileTransactionJournal {
  let parsed: Partial<FileTransactionJournal>;

  try {
    parsed = JSON.parse(content) as Partial<FileTransactionJournal>;
  } catch {
    throw new Error(`Tyrian file transaction journal is invalid JSON at '${journalPath}'.`);
  }

  if (
    (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) ||
    typeof parsed.id !== 'string' ||
    !/^[0-9a-f-]{36}$/iu.test(parsed.id) ||
    !['preparing', 'prepared', 'committing', 'verified'].includes(parsed.phase ?? '') ||
    !Array.isArray(parsed.entries) ||
    parsed.entries.length === 0
  ) {
    throw new Error(`Tyrian file transaction journal is invalid at '${journalPath}'.`);
  }

  if (
    (parsed.version === 2 || parsed.version === 3) &&
    (typeof parsed.appRoot !== 'string' ||
      !path.isAbsolute(parsed.appRoot) ||
      parsed.appRoot !== path.resolve(parsed.appRoot) ||
      (expectedAppRoot !== undefined && parsed.appRoot !== expectedAppRoot))
  ) {
    throw new Error(`Tyrian file transaction journal has an invalid app root at '${journalPath}'.`);
  }

  const targets = new Set<string>();
  for (const entry of parsed.entries) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof entry.filePath !== 'string' ||
      typeof entry.backupPath !== 'string' ||
      (entry.stagedPath !== undefined && typeof entry.stagedPath !== 'string') ||
      typeof entry.existed !== 'boolean' ||
      (parsed.version === 3 &&
        ((entry.originalChecksum !== null &&
          (typeof entry.originalChecksum !== 'string' ||
            !/^[A-Za-z0-9+/]+$/u.test(entry.originalChecksum))) ||
          (entry.desiredChecksum !== null &&
            (typeof entry.desiredChecksum !== 'string' ||
              !/^[A-Za-z0-9+/]+$/u.test(entry.desiredChecksum))))) ||
      !path.isAbsolute(entry.filePath) ||
      targets.has(entry.filePath) ||
      (allowedTargets !== undefined && !allowedTargets.has(entry.filePath)) ||
      entry.backupPath !== transactionSiblingPath(entry.filePath, parsed.id, 'backup') ||
      (entry.stagedPath !== undefined &&
        entry.stagedPath !== transactionSiblingPath(entry.filePath, parsed.id, 'stage'))
    ) {
      throw new Error(
        `Tyrian file transaction journal contains an invalid entry at '${journalPath}'.`
      );
    }

    targets.add(entry.filePath);
  }

  if (parsed.phase === 'committing' && parsed.version !== 3) {
    throw new Error(`Tyrian file transaction journal has an invalid phase at '${journalPath}'.`);
  }

  return parsed as FileTransactionJournal;
}

function readDesiredThemeId(registration: ManagedRootRegistration): string | null | undefined {
  return registration.kind === 'valid' ? registration.record.desiredThemeId : undefined;
}

async function canonicalizeAppRoot(appRoot: string): Promise<string> {
  if (appRoot.trim().length === 0) {
    throw new Error('Tyrian VS Code app root must not be empty.');
  }

  const resolved = path.resolve(appRoot);

  try {
    return await fs.realpath(resolved);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return resolved;
    }

    throw error;
  }
}

async function writeDurableFileExclusive(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, 'wx');

  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurableJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeDurableTextFile(filePath, JSON.stringify(value, null, 2).concat('\n'));
}

async function writeDurableTextFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.tyrian-night-${crypto.randomUUID()}-${path.basename(filePath)}.tmp`
  );

  let renamed = false;
  let primaryFailure: unknown;

  try {
    await writeDurableFileExclusive(tempPath, content);
    await fs.rename(tempPath, filePath);
    renamed = true;
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    if (renamed) {
      const failure = describeIslandShellFailure(error);
      primaryFailure = new IslandShellFailure(failure.code, failure.reason, {
        cause: error,
        mutation: { incompleteRecovery: true },
      });
    } else {
      primaryFailure = error;
    }
  }

  try {
    await fs.rm(tempPath, { force: true });
  } catch (cleanupFailure) {
    if (primaryFailure !== undefined) {
      throw new AggregateError(
        [primaryFailure, cleanupFailure],
        `Tyrian durable write and temporary cleanup both failed at '${filePath}'.`
      );
    }

    if (renamed) {
      const failure = describeIslandShellFailure(cleanupFailure);
      throw new IslandShellFailure(failure.code, failure.reason, {
        cause: cleanupFailure,
        mutation: { incompleteRecovery: true },
      });
    }

    throw cleanupFailure;
  }

  if (primaryFailure !== undefined) throw primaryFailure;
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await fs.open(directoryPath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectories(directoryPaths: string[]): Promise<void> {
  for (const directoryPath of new Set(directoryPaths)) {
    await syncDirectory(directoryPath);
  }
}

async function removeFileDurably(
  filePath: string,
  mutation: Partial<IslandMutationFacts> = {}
): Promise<boolean> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (isFileNotFoundError(error)) return false;
    throw error;
  }

  try {
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    const failure = describeIslandShellFailure(error);
    throw new IslandShellFailure(failure.code, failure.reason, {
      cause: error,
      mutation: mergeIslandMutationFacts(mutation, { incompleteRecovery: true }),
    });
  }

  return true;
}

async function writeIfChanged(
  filePath: string,
  content: string,
  mutation: Partial<IslandMutationFacts> = {}
): Promise<boolean> {
  const currentContent = await readTextFileIfExists(filePath);

  if (currentContent === content) {
    return false;
  }

  try {
    await writeDurableTextFile(filePath, content);
  } catch (error) {
    if ((await readTextFileIfExists(filePath)) !== content) throw error;
    throw new IslandPartialMutationError(
      `Tyrian durable publication changed '${filePath}' but did not complete cleanly.`,
      mutation,
      { cause: error }
    );
  }
  return true;
}

async function deleteIfExists(filePath: string): Promise<boolean> {
  return removeFileDurably(filePath, { registryChanged: true });
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

async function lstatIfExists(
  filePath: string
): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(filePath);
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

function isPermissionError(error: unknown): boolean {
  return isNodeError(error) && (error.code === 'EACCES' || error.code === 'EPERM');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function findIslandShellFailure(error: unknown): IslandShellFailure | undefined {
  return findNestedError(error, (candidate) =>
    candidate instanceof IslandShellFailure ? candidate : undefined
  );
}

function findNodeError(
  error: unknown,
  codes: ReadonlySet<string>
): NodeJS.ErrnoException | undefined {
  return findNestedError(error, (candidate) =>
    isNodeError(candidate) && typeof candidate.code === 'string' && codes.has(candidate.code)
      ? candidate
      : undefined
  );
}

function collectIslandFailureCauses(
  error: unknown
): Array<{ code: IslandShellFailureCode; reason: string }> {
  const pending = [error];
  const visited = new Set<unknown>();
  const causes: Array<{ code: IslandShellFailureCode; reason: string }> = [];
  const seen = new Set<string>();

  while (pending.length > 0 && causes.length < 8) {
    const candidate = pending.shift();
    if (candidate === undefined || visited.has(candidate)) continue;
    visited.add(candidate);

    const children: unknown[] = [];
    if (candidate instanceof AggregateError) children.push(...candidate.errors);
    if (candidate instanceof Error && candidate.cause !== undefined) children.push(candidate.cause);
    pending.push(...children);

    if (!(candidate instanceof Error)) {
      if (children.length === 0) {
        const reason = String(candidate);
        if (!seen.has(reason)) {
          causes.push({ code: 'blocked', reason });
          seen.add(reason);
        }
      }
      continue;
    }

    const ownsActionableContext =
      candidate instanceof IslandShellFailure ||
      candidate instanceof IslandPartialMutationError ||
      candidate.name === 'IslandLockReleaseError' ||
      candidate.name === 'IslandLockActionReleaseError' ||
      children.length === 0;
    if (!ownsActionableContext || seen.has(candidate.message)) continue;

    const code =
      candidate instanceof IslandShellFailure
        ? candidate.code
        : isPermissionError(candidate)
          ? 'permission-required'
          : 'blocked';
    causes.push({ code, reason: candidate.message });
    seen.add(candidate.message);
  }

  return causes;
}

function findNestedError<T>(
  error: unknown,
  select: (candidate: unknown) => T | undefined
): T | undefined {
  const pending = [error];
  const visited = new Set<unknown>();

  while (pending.length > 0) {
    const candidate = pending.shift();
    if (candidate === undefined || visited.has(candidate)) continue;
    visited.add(candidate);

    const selected = select(candidate);
    if (selected !== undefined) return selected;

    if (candidate instanceof AggregateError) {
      pending.push(...candidate.errors);
    }

    if (candidate instanceof Error && candidate.cause !== undefined) {
      pending.push(candidate.cause);
    }
  }

  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
