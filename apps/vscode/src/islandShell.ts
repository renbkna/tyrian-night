import crypto from 'node:crypto';
import { constants as fsConstants, type Dirent } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
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
  buildManagedRootRecordPath,
  buildManagedRootsDirectoryPath,
  buildQuarantinedRootsDirectoryPath,
  isIslandManifestV3Shape,
  type IslandManifestV3,
  type IslandPatchPaths,
} from './islandPatchContract.js';
import { rollbackFailedFileTransactionCore } from './islandFileTransactionCore.js';
import { readIslandApplyPlatformSupport } from './islandPlatform.js';
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
const ANY_FILE_GENERATION = Symbol('any-file-generation');
const MANAGED_ROOT_RECORD_VERSION = 2 as const;
type RegularFileGeneration =
  | { kind: 'absent' }
  | {
      kind: 'present';
      device: string;
      inode: string;
      mode: number;
      content: string;
    };
class IslandDurablePublicationFailure extends Error {
  readonly publicationChanged = true;

  constructor(filePath: string, cause: unknown) {
    super(`Tyrian published a new durable generation at '${filePath}' before a later failure.`, {
      cause,
    });
    this.name = 'IslandDurablePublicationFailure';
  }
}
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
  registrationState: 'absent' | 'valid' | 'corrupt' | 'unsupported';
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
      version: 4;
      phase: 'preparing' | 'prepared' | 'committing' | 'verified';
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

type ManagedRootRecord = {
  version: typeof MANAGED_ROOT_RECORD_VERSION;
  appRoot: string;
  desiredThemeId: string | null;
};

type ManagedRootRegistration =
  | { kind: 'absent' }
  | { kind: 'valid'; record: ManagedRootRecord }
  | { kind: 'corrupt'; reason: string }
  | { kind: 'unsupported'; reason: string };

type RestorableManagedRootRegistration = Exclude<ManagedRootRegistration, { kind: 'unsupported' }>;

type IslandShellEnvironment = {
  registryHome?: string;
};

type RegistryRecordGeneration = {
  recordPath: string;
  dev: number | bigint;
  ino: number | bigint;
  mode: number;
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
  originalDevice: string | undefined;
  originalInode: string | undefined;
  originalContent: string | undefined;
  retiredPath: string;
  stagedPath: string | undefined;
};

type FileTransactionJournal = {
  version: 4;
  id: string;
  appRoot: string;
  phase: 'preparing' | 'prepared' | 'committing' | 'verified';
  entries: Array<{
    filePath: string;
    backupPath: string;
    stagedPath: string | undefined;
    existed: boolean;
    originalChecksum: string | null;
    desiredChecksum: string | null;
    originalMode: number | undefined;
    originalDevice: string | undefined;
    originalInode: string | undefined;
    retiredPath: string;
  }>;
};

type IslandPatchFileSystem = {
  appRoot: string;
  paths: IslandPatchPaths;
  appRootHandle: FileHandle;
  workbenchHandle: FileHandle;
  pathFor(filePath: string): string;
  assertNamespaceCurrent(): Promise<void>;
  close(): Promise<void>;
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
  return applyIslandShellForPlatform(options, process.platform);
}

export async function applyIslandShellForPlatform(
  options: {
    appRoot: string;
    cssSourcePath: string;
    themeVersion: string;
    registryHome?: string;
  },
  platform: NodeJS.Platform
): Promise<IslandShellResult> {
  assertIslandApplyPlatformSupported(platform);
  const appRoot = await canonicalizeAppRoot(options.appRoot);
  const canonicalOptions = { ...options, appRoot };
  await assertPatchPathAncestorsOwned(appRoot);
  await fs.access(getPatchPaths(appRoot).workbenchDirPath);

  return withIslandRootLock(
    appRoot,
    canonicalOptions,
    async (initializationChanged, recoveryPhysicalChanged, fileSystem) => {
      await readManagedAppRootsForMutationStrict(canonicalOptions);
      const registration = await readManagedAppRootRegistration(appRoot, canonicalOptions);
      if (registration.kind === 'corrupt' || registration.kind === 'unsupported') {
        throw new IslandShellFailure('corrupt', registration.reason);
      }
      const payload = await buildApplyPayload(canonicalOptions, fileSystem);
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
            await verifyAppliedShell(paths, appRoot, payload.desiredThemeId, fileSystem);
            const registration = await readManagedAppRootRegistration(appRoot, canonicalOptions);

            if (
              registration.kind !== 'valid' ||
              registration.record.desiredThemeId !== payload.desiredThemeId
            ) {
              throw new Error(
                'Tyrian Night verification failed: app root was not registered after apply.'
              );
            }
          },
          fileSystem
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

      await fileSystem?.assertNamespaceCurrent();
      const status = await readIslandShellStatusUnlocked(canonicalOptions, fileSystem);
      await fileSystem?.assertNamespaceCurrent();

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
  return readIslandShellApplyReadinessForPlatform(options, process.platform);
}

export async function readIslandShellApplyReadinessForPlatform(
  options: {
    appRoot: string;
    cssSourcePath: string;
    themeVersion: string;
    registryHome?: string;
  },
  platform: NodeJS.Platform
): Promise<IslandShellApplyReadiness> {
  const platformSupport = readIslandApplyPlatformSupport(platform);
  if (!platformSupport.supported) {
    return {
      kind: 'unsupported',
      appRoot: options.appRoot,
      status: undefined,
      writeAccess: undefined,
      reason: platformSupport.reason,
    };
  }

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
    await assertPatchPathAncestorsOwned(appRoot);
    await readManagedAppRootsReadOnly(options, {
      roots: [],
      registryDiagnostics: [],
      tolerateDiagnostics: false,
    });
    status = await readIslandShellStatusUnlocked(options);
    writeAccess = await readIslandShellWriteAccess(options);
    if (
      status.transaction.kind === 'corrupt' ||
      status.transaction.kind === 'external-drift' ||
      status.transaction.kind === 'unavailable'
    ) {
      return {
        kind: 'blocked',
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
  await assertPatchPathAncestorsOwned(appRoot);
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
  await assertPatchPathAncestorsOwned(appRoot);
  await fs.access(getPatchPaths(appRoot).workbenchDirPath);

  return withIslandRootLock(
    appRoot,
    canonicalOptions,
    async (initializationChanged, recoveryPhysicalChanged, fileSystem) => {
      const registration = await readRestorableManagedRootRegistration(appRoot, canonicalOptions);
      const state = await inspectIslandRoot(appRoot, registration, undefined, fileSystem);
      const plan = buildRestorePlan(state);
      const recordChanged = await publishManagedRootRecord(appRoot, null, canonicalOptions);
      let physicalChanged: boolean;
      try {
        physicalChanged = await commitRestorePlan(state, plan, canonicalOptions, fileSystem);
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

      await fileSystem?.assertNamespaceCurrent();
      const status = await readIslandShellStatusUnlocked(canonicalOptions, fileSystem);
      await fileSystem?.assertNamespaceCurrent();

      return {
        ...islandMutationFacts({
          desiredStateChanged: recordChanged,
          registryChanged: recordChanged || initializationChanged,
          physicalChanged: physicalChanged || recoveryPhysicalChanged,
        }),
        active: false,
        status,
      };
    },
    async () => {
      await readRestorableManagedRootRegistration(appRoot, canonicalOptions);
    }
  );
}

function assertIslandApplyPlatformSupported(platform: NodeJS.Platform): void {
  const support = readIslandApplyPlatformSupport(platform);
  if (!support.supported) {
    throw new IslandShellFailure('unsupported', support.reason);
  }
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
  await assertPatchPathAncestorsOwned(appRoot);
  return readIslandShellStatusUnlocked({ ...options, appRoot });
}

async function readIslandShellStatusUnlocked(
  options: {
    appRoot: string;
    registryHome?: string;
  },
  fileSystem?: IslandPatchFileSystem
): Promise<IslandShellStatus> {
  let registration: ManagedRootRegistration = { kind: 'absent' };
  let transaction: IslandTransactionHealth | undefined;

  try {
    registration = await readManagedAppRootRegistration(options.appRoot, options);
    const journalPath = getPatchPaths(options.appRoot).transactionJournalPath;
    transaction = await inspectIslandTransactionHealth(journalPath, options.appRoot, fileSystem);
    return (await inspectIslandRoot(options.appRoot, registration, transaction, fileSystem)).status;
  } catch (error) {
    const registered = isCurrentManagedRootRegistration(registration);

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
  knownTransaction?: IslandTransactionHealth,
  fileSystem?: IslandPatchFileSystem
): Promise<IslandRootState> {
  const registered = isCurrentManagedRootRegistration(registration);
  const desiredThemeId = readDesiredThemeId(registration);
  const paths = getPatchPaths(appRoot);
  const transaction =
    knownTransaction ??
    (await inspectIslandTransactionHealth(paths.transactionJournalPath, appRoot));
  const currentHtml = await fs.readFile(
    fileSystem?.pathFor(paths.workbenchHtmlPath) ?? paths.workbenchHtmlPath,
    'utf8'
  );
  const currentProductJson = await fs.readFile(
    fileSystem?.pathFor(paths.productJsonPath) ?? paths.productJsonPath,
    'utf8'
  );
  const backupHtml = await readTextFileIfExists(
    fileSystem?.pathFor(paths.backupHtmlPath) ?? paths.backupHtmlPath
  );
  const backupProductJson = await readTextFileIfExists(
    fileSystem?.pathFor(paths.backupProductJsonPath) ?? paths.backupProductJsonPath
  );
  const blockState = readTyrianBlockState(currentHtml);
  const active = blockState !== 'absent';
  const cssContent = await readTextFileIfExists(
    fileSystem?.pathFor(paths.islandCssPath) ?? paths.islandCssPath
  );
  const cssExists = cssContent !== undefined;
  const manifestContent = await readTextFileIfExists(
    fileSystem?.pathFor(paths.manifestPath) ?? paths.manifestPath
  );
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

async function buildApplyPayload(
  options: {
    appRoot: string;
    cssSourcePath: string;
    themeVersion: string;
    registryHome?: string;
  },
  fileSystem?: IslandPatchFileSystem
): Promise<ApplyPayload> {
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
    fs.readFile(fileSystem?.pathFor(paths.workbenchHtmlPath) ?? paths.workbenchHtmlPath, 'utf8'),
    fs.readFile(fileSystem?.pathFor(paths.productJsonPath) ?? paths.productJsonPath, 'utf8'),
    fs.readFile(options.cssSourcePath, 'utf8'),
    readTextFileIfExists(fileSystem?.pathFor(paths.backupHtmlPath) ?? paths.backupHtmlPath),
    readTextFileIfExists(
      fileSystem?.pathFor(paths.backupProductJsonPath) ?? paths.backupProductJsonPath
    ),
    readTextFileIfExists(fileSystem?.pathFor(paths.islandCssPath) ?? paths.islandCssPath),
    readTextFileIfExists(fileSystem?.pathFor(paths.manifestPath) ?? paths.manifestPath),
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
  environment: IslandShellEnvironment,
  fileSystem?: IslandPatchFileSystem
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
        await verifyManagedStateRemoved(state.paths, fileSystem);
      } else {
        await verifyRestoredShell(state.paths, fileSystem);
      }

      const registration = await readManagedAppRootRegistration(state.status.appRoot, environment);
      if (registration.kind !== 'valid' || registration.record.desiredThemeId !== null) {
        throw new Error(
          'Tyrian Night verification failed: restored app root is not durably disabled.'
        );
      }
    },
    fileSystem
  );
}

async function verifyAppliedShell(
  paths: IslandPatchPaths,
  appRoot: string,
  desiredThemeId: string,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  const currentHtml = await fs.readFile(
    fileSystem?.pathFor(paths.workbenchHtmlPath) ?? paths.workbenchHtmlPath,
    'utf8'
  );
  const currentProductJson = await fs.readFile(
    fileSystem?.pathFor(paths.productJsonPath) ?? paths.productJsonPath,
    'utf8'
  );
  const cssContent = await fs.readFile(
    fileSystem?.pathFor(paths.islandCssPath) ?? paths.islandCssPath,
    'utf8'
  );
  const backupHtml = await fs.readFile(
    fileSystem?.pathFor(paths.backupHtmlPath) ?? paths.backupHtmlPath,
    'utf8'
  );
  const backupProductJson = await fs.readFile(
    fileSystem?.pathFor(paths.backupProductJsonPath) ?? paths.backupProductJsonPath,
    'utf8'
  );

  if (readTyrianBlockState(currentHtml) !== 'valid') {
    throw new Error(
      'Tyrian Night verification failed: workbench.html does not contain one valid Island UI block after apply.'
    );
  }

  const manifest = parseManifest(
    await fs.readFile(fileSystem?.pathFor(paths.manifestPath) ?? paths.manifestPath, 'utf8')
  );

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

async function verifyRestoredShell(
  paths: IslandPatchPaths,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  const currentHtml = await fs.readFile(
    fileSystem?.pathFor(paths.workbenchHtmlPath) ?? paths.workbenchHtmlPath,
    'utf8'
  );
  const currentProductJson = await fs.readFile(
    fileSystem?.pathFor(paths.productJsonPath) ?? paths.productJsonPath,
    'utf8'
  );

  if (readTyrianBlockState(currentHtml) !== 'absent') {
    throw new Error(
      'Tyrian Night verification failed: workbench.html still contains Island UI patch evidence after restore.'
    );
  }

  await verifyManagedStateRemoved(paths, fileSystem);

  if (!doesWorkbenchChecksumValueMatch(currentProductJson, currentHtml)) {
    throw new Error(
      'Tyrian Night verification failed: product.json checksum does not match the restored workbench after restore.'
    );
  }
}

async function verifyManagedStateRemoved(
  paths: IslandPatchPaths,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  for (const filePath of [
    paths.islandCssPath,
    paths.manifestPath,
    paths.backupHtmlPath,
    paths.backupProductJsonPath,
  ]) {
    if (await pathExists(fileSystem?.pathFor(filePath) ?? filePath)) {
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
  let generation: RegularFileGeneration;
  try {
    generation = await readRegularFileGeneration(recordPath, 'managed app root record');
  } catch (error) {
    if (isPermissionError(error)) throw error;
    return {
      kind: 'corrupt',
      reason: `${recordPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (generation.kind === 'absent') return { kind: 'absent' };
  const { content } = generation;

  try {
    const record = parseManagedRootRecord(content, recordPath);
    if (record.appRoot !== appRoot) {
      throw new Error(`Tyrian managed app root record does not own '${appRoot}'.`);
    }
    return { kind: 'valid', record };
  } catch (error) {
    return {
      kind: isUnsupportedManagedRootRecord(content) ? 'unsupported' : 'corrupt',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readRestorableManagedRootRegistration(
  appRoot: string,
  environment?: IslandShellEnvironment
): Promise<RestorableManagedRootRegistration> {
  const registration = await readManagedAppRootRegistration(appRoot, environment);
  if (registration.kind === 'unsupported') {
    throw new IslandShellFailure('corrupt', registration.reason);
  }
  return registration;
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

  await fs.mkdir(directoryPath, { recursive: true });
  return directoryStats === undefined;
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
      if (isUnsupportedManagedRootRecord(content)) {
        if (mode === 'diagnostic') {
          accumulator.registryDiagnostics.push(reason);
          continue;
        }
        throw new IslandShellFailure('corrupt', reason);
      }
      if (mode === 'diagnostic') {
        accumulator.registryDiagnostics.push(reason);
        continue;
      }
      if (mode === 'restore') {
        const generation = await readRegistryRecordGeneration(recordPath, true);
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
      const reason = error instanceof Error ? error.message : String(error);
      if (isUnsupportedManagedRootRecord(content)) {
        if (mode === 'diagnostic') {
          accumulator.registryDiagnostics.push(reason);
          continue;
        }
        throw new IslandShellFailure('corrupt', reason);
      }
      corrupt = true;
      if (mode === 'diagnostic') {
        accumulator.registryDiagnostics.push(reason);
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
      recordGeneration: await readRegistryRecordGeneration(recordPath, corrupt),
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
  corrupt: boolean,
  identityPath = recordPath
): Promise<RegistryRecordGeneration> {
  const before = await fs.lstat(recordPath);
  const content =
    before.isFile() && !before.isSymbolicLink()
      ? await fs.readFile(recordPath, 'utf8').catch(() => undefined)
      : undefined;
  const after = await lstatIfExists(recordPath);
  if (
    after === undefined ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    Number(before.mode) !== Number(after.mode)
  ) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian managed app root record changed during generation inspection at '${recordPath}'.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  return registryRecordGenerationFromStats(identityPath, after, content, corrupt);
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
    mode: Number(stats.mode),
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
    left.mode === right.mode &&
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
  const current = await readRegistryRecordGeneration(recordPath, expected.corrupt);
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
    verifyMovedGeneration: async () => {
      const movedGeneration = await readRegistryRecordGeneration(
        quarantinePath,
        expected.corrupt,
        recordPath
      );
      if (sameRegistryRecordGeneration(movedGeneration, expected)) return;

      const restored = await restoreRetiredGeneration(quarantinePath, recordPath);
      throw new IslandShellFailure(
        'blocked',
        `Tyrian managed app root record changed across quarantine at '${recordPath}'${restored ? '.' : `; the moved generation remains at '${quarantinePath}'.`}`,
        { mutation: { externalDrift: true, incompleteRecovery: !restored } }
      );
    },
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

function parseManagedRootRecord(content: string, recordPath: string): ManagedRootRecord {
  let parsed: { version?: unknown; appRoot?: unknown; desiredThemeId?: unknown };

  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch {
    throw new Error(`Tyrian managed app root record is invalid JSON at '${recordPath}'.`);
  }

  if (
    parsed.version !== MANAGED_ROOT_RECORD_VERSION ||
    typeof parsed.appRoot !== 'string' ||
    parsed.appRoot.trim().length === 0 ||
    !path.isAbsolute(parsed.appRoot)
  ) {
    throw new Error(
      `Tyrian managed app root record is invalid: expected version ${MANAGED_ROOT_RECORD_VERSION} with an absolute appRoot at '${recordPath}'.`
    );
  }

  if (
    parsed.desiredThemeId !== null &&
    (typeof parsed.desiredThemeId !== 'string' ||
      !/^[a-z0-9][a-z0-9-]*\.css$/u.test(parsed.desiredThemeId))
  ) {
    throw new Error(
      `Tyrian managed app root record is invalid: version ${MANAGED_ROOT_RECORD_VERSION} requires a CSS asset desiredThemeId at '${recordPath}'.`
    );
  }

  return parsed as ManagedRootRecord;
}

function isUnsupportedManagedRootRecord(content: string): boolean {
  try {
    return (JSON.parse(content) as { version?: unknown }).version !== MANAGED_ROOT_RECORD_VERSION;
  } catch {
    return false;
  }
}

function isCurrentManagedRootRegistration(registration: ManagedRootRegistration): boolean {
  return registration.kind === 'valid' || registration.kind === 'corrupt';
}

function serializeManagedRootRecord(appRoot: string, desiredThemeId: string | null): string {
  const record: ManagedRootRecord = {
    version: MANAGED_ROOT_RECORD_VERSION,
    appRoot,
    desiredThemeId,
  };
  return JSON.stringify(record, null, 2).concat('\n');
}

async function commitFileTransaction(
  journalPath: string,
  appRoot: string,
  mutations: FileMutation[],
  verify: () => Promise<void>,
  admittedFileSystem?: IslandPatchFileSystem
): Promise<boolean> {
  if (admittedFileSystem !== undefined) {
    return commitFileTransactionWithFileSystem(
      journalPath,
      appRoot,
      mutations,
      verify,
      admittedFileSystem
    );
  }
  if (process.platform !== 'linux') {
    return commitFileTransactionWithFileSystem(journalPath, appRoot, mutations, verify, undefined);
  }
  const fileSystem = await openIslandPatchFileSystem(appRoot);
  try {
    return await commitFileTransactionWithFileSystem(
      journalPath,
      appRoot,
      mutations,
      verify,
      fileSystem
    );
  } finally {
    await fileSystem.close();
  }
}

async function commitFileTransactionWithFileSystem(
  journalPath: string,
  appRoot: string,
  mutations: FileMutation[],
  verify: () => Promise<void>,
  fileSystem: IslandPatchFileSystem | undefined
): Promise<boolean> {
  const targets = new Set<string>();
  const prepared: PreparedFileMutation[] = [];
  const transactionId = crypto.randomUUID();

  await assertPatchPathAncestorsOwned(appRoot);

  for (const mutation of mutations) {
    if (targets.has(mutation.filePath)) {
      throw new Error(`Tyrian file transaction contains duplicate target '${mutation.filePath}'.`);
    }
    targets.add(mutation.filePath);

    const operationPath = fileSystem?.pathFor(mutation.filePath) ?? mutation.filePath;
    const stats = await lstatIfExists(operationPath);

    if (stats?.isDirectory()) {
      throw new Error(`Tyrian file transaction target is a directory at '${mutation.filePath}'.`);
    }

    if (stats?.isSymbolicLink()) {
      throw new Error(
        `Tyrian file transaction target is a symbolic link at '${mutation.filePath}'.`
      );
    }

    const currentContent =
      stats === undefined ? undefined : await fs.readFile(operationPath, 'utf8');

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
      originalDevice: stats === undefined ? undefined : String(stats.dev),
      originalInode: stats === undefined ? undefined : String(stats.ino),
      originalContent: currentContent,
      retiredPath: transactionSiblingPath(mutation.filePath, transactionId, 'retired'),
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
  let durableJournalGeneration: RegularFileGeneration = { kind: 'absent' };
  let physicalMutationAttempted = false;
  durableJournalGeneration = await writeDurableJsonFile(
    fileSystem?.pathFor(journalPath) ?? journalPath,
    journal,
    durableJournalGeneration
  );

  try {
    for (const mutation of changedMutations) {
      if (mutation.existed) {
        await fs.copyFile(
          fileSystem?.pathFor(mutation.filePath) ?? mutation.filePath,
          fileSystem?.pathFor(mutation.backupPath) ?? mutation.backupPath,
          fsConstants.COPYFILE_EXCL
        );
        await syncFile(fileSystem?.pathFor(mutation.backupPath) ?? mutation.backupPath);
      }

      if (mutation.stagedPath !== undefined) {
        const stagedOperationPath = fileSystem?.pathFor(mutation.stagedPath) ?? mutation.stagedPath;
        await writeDurableFileExclusive(stagedOperationPath, mutation.content!);

        if (mutation.originalMode !== undefined) {
          await fs.chmod(stagedOperationPath, mutation.originalMode);
          await syncFile(stagedOperationPath);
        }
      }
    }

    await syncPatchMutationDirectories(
      fileSystem,
      changedMutations.map(({ filePath }) => filePath)
    );

    journal = { ...journal, phase: 'prepared' };
    durableJournalGeneration = await writeDurableJsonFile(
      fileSystem?.pathFor(journalPath) ?? journalPath,
      journal,
      durableJournalGeneration
    );

    for (const mutation of changedMutations) {
      await assertPreparedMutationGeneration(mutation, fileSystem);
    }

    journal = { ...journal, phase: 'committing' };
    durableJournalGeneration = await writeDurableJsonFile(
      fileSystem?.pathFor(journalPath) ?? journalPath,
      journal,
      durableJournalGeneration
    );

    physicalMutationAttempted = true;
    for (const mutation of changedMutations) {
      await publishPreparedMutation(mutation, fileSystem);
    }

    await syncPatchMutationDirectories(
      fileSystem,
      changedMutations.map(({ filePath }) => filePath)
    );

    await fileSystem?.assertNamespaceCurrent();
    await verify();
    await fileSystem?.assertNamespaceCurrent();
    journal = { ...journal, phase: 'verified' };
    await writeDurableJsonFile(
      fileSystem?.pathFor(journalPath) ?? journalPath,
      journal,
      durableJournalGeneration
    );
  } catch (error) {
    const durableJournal = await tryReadFileTransactionJournal(
      journalPath,
      targets,
      appRoot,
      fileSystem
    );

    await rollbackFailedFileTransactionCore({
      transactionError: error,
      physicalMutationAttempted,
      rollback: async () => {
        if (durableJournal !== undefined) {
          await rollbackFileTransaction(journalPath, durableJournal, fileSystem);
        }
      },
    });
  }

  try {
    await finishVerifiedFileTransaction(journalPath, journal, fileSystem);
  } catch (error) {
    throw new IslandPartialMutationError(
      `Tyrian file transaction verified its app-file changes, but cleanup remains incomplete: ${error instanceof Error ? error.message : String(error)}`,
      { physicalChanged: true, incompleteRecovery: true },
      { cause: error }
    );
  }
  return true;
}

function buildFileTransactionJournal(
  appRoot: string,
  id: string,
  phase: FileTransactionJournal['phase'],
  mutations: PreparedFileMutation[]
): FileTransactionJournal {
  return {
    version: 4,
    id,
    appRoot,
    phase,
    entries: mutations.map(
      ({
        filePath,
        backupPath,
        stagedPath,
        existed,
        originalContent,
        content,
        originalMode,
        originalDevice,
        originalInode,
        retiredPath,
      }) => ({
        filePath,
        backupPath,
        stagedPath,
        existed,
        originalChecksum: checksumOrNull(originalContent),
        desiredChecksum: checksumOrNull(content),
        originalMode,
        originalDevice,
        originalInode,
        retiredPath,
      })
    ),
  };
}

async function assertPreparedMutationGeneration(
  mutation: PreparedFileMutation,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  const operationPath = fileSystem?.pathFor(mutation.filePath) ?? mutation.filePath;
  const currentContent = await readTransactionTarget(operationPath, mutation.filePath);
  const currentStats = await lstatIfExists(operationPath);

  if (
    currentContent !== mutation.originalContent ||
    (currentStats === undefined ? undefined : String(currentStats.dev)) !==
      mutation.originalDevice ||
    (currentStats === undefined ? undefined : String(currentStats.ino)) !==
      mutation.originalInode ||
    (currentStats === undefined ? undefined : Number(currentStats.mode)) !== mutation.originalMode
  ) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian transaction input changed before replacement at '${mutation.filePath}'.`
    );
  }
}

async function publishPreparedMutation(
  mutation: PreparedFileMutation,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  await assertPreparedMutationGeneration(mutation, fileSystem);
  const targetPath = fileSystem?.pathFor(mutation.filePath) ?? mutation.filePath;
  const retiredPublicPath = mutation.retiredPath;
  const retiredPath = fileSystem?.pathFor(retiredPublicPath) ?? retiredPublicPath;

  if (mutation.existed) {
    await fs.rename(targetPath, retiredPath);
    const [retiredContent, retiredStats] = await Promise.all([
      readTransactionTarget(retiredPath, mutation.filePath),
      fs.lstat(retiredPath),
    ]);
    if (
      retiredContent !== mutation.originalContent ||
      String(retiredStats.dev) !== mutation.originalDevice ||
      String(retiredStats.ino) !== mutation.originalInode ||
      Number(retiredStats.mode) !== mutation.originalMode
    ) {
      await restoreRetiredGeneration(retiredPath, targetPath);
      throw new IslandShellFailure(
        'blocked',
        `Tyrian transaction target changed across the retirement boundary at '${mutation.filePath}'.`,
        { mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
  }

  if (mutation.stagedPath !== undefined) {
    const stagedPath = fileSystem?.pathFor(mutation.stagedPath) ?? mutation.stagedPath;
    try {
      await fs.link(stagedPath, targetPath);
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      throw new IslandShellFailure(
        'blocked',
        `Tyrian transaction observed a replacement generation before publication at '${mutation.filePath}'.`,
        { cause: error, mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
  }
}

async function restoreRetiredGeneration(retiredPath: string, targetPath: string): Promise<boolean> {
  try {
    await fs.link(retiredPath, targetPath);
    await fs.unlink(retiredPath);
    return true;
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    return false;
  }
}

async function syncPatchMutationDirectories(
  fileSystem: IslandPatchFileSystem | undefined,
  filePaths: string[]
): Promise<void> {
  if (fileSystem === undefined) {
    await syncDirectories(filePaths.map((filePath) => path.dirname(filePath)));
    return;
  }
  const directories = new Set(filePaths.map((filePath) => path.dirname(filePath)));
  if (directories.has(fileSystem.appRoot)) await fileSystem.appRootHandle.sync();
  if (directories.has(fileSystem.paths.workbenchDirPath)) await fileSystem.workbenchHandle.sync();
}

async function rollbackFileTransaction(
  journalPath: string,
  journal: FileTransactionJournal,
  fileSystem?: IslandPatchFileSystem
): Promise<boolean> {
  if (journal.phase === 'preparing' || journal.phase === 'prepared') {
    await removeTemporaryFilesBeforeJournal(journalPath, journal, fileSystem);
    return false;
  }

  return rollbackVersion4FileTransaction(journalPath, journal, fileSystem);
}

async function rollbackVersion4FileTransaction(
  journalPath: string,
  journal: FileTransactionJournal,
  fileSystem?: IslandPatchFileSystem
): Promise<boolean> {
  const failures: unknown[] = [];
  let physicalChanged = false;

  for (const entry of journal.entries.toReversed()) {
    try {
      const targetPath = fileSystem?.pathFor(entry.filePath) ?? entry.filePath;
      const retiredPath = fileSystem?.pathFor(entry.retiredPath) ?? entry.retiredPath;
      const stagedPath =
        entry.stagedPath === undefined
          ? undefined
          : (fileSystem?.pathFor(entry.stagedPath) ?? entry.stagedPath);
      const retiredStats = await lstatIfExists(retiredPath);
      const currentChecksum = checksumOrNull(
        await readTransactionTarget(targetPath, entry.filePath)
      );
      const currentStats = await lstatIfExists(targetPath);

      if (retiredStats !== undefined) {
        const retiredChecksum = checksumOrNull(
          await readTransactionTarget(retiredPath, entry.retiredPath)
        );
        if (
          !retiredStats.isFile() ||
          retiredStats.isSymbolicLink() ||
          retiredChecksum !== entry.originalChecksum ||
          String(retiredStats.dev) !== entry.originalDevice ||
          String(retiredStats.ino) !== entry.originalInode ||
          Number(retiredStats.mode) !== entry.originalMode
        ) {
          throw new IslandShellFailure(
            'corrupt',
            `Tyrian transaction retired generation changed at '${entry.retiredPath}'.`,
            { mutation: { incompleteRecovery: true } }
          );
        }

        if (currentChecksum === entry.originalChecksum) {
          if (
            currentStats !== undefined &&
            currentStats.dev === retiredStats.dev &&
            currentStats.ino === retiredStats.ino
          ) {
            continue;
          }
          throw new IslandShellFailure(
            'blocked',
            `Tyrian transaction recovery found a same-content replacement generation at '${entry.filePath}' and left it untouched.`,
            { mutation: { externalDrift: true, incompleteRecovery: true } }
          );
        }
        if (currentChecksum === null) {
          try {
            await fs.link(retiredPath, targetPath);
          } catch (error) {
            if (isAlreadyExistsError(error)) {
              throw new IslandShellFailure(
                'blocked',
                `Tyrian transaction recovery observed a replacement generation at '${entry.filePath}' and left it untouched.`,
                { cause: error, mutation: { externalDrift: true, incompleteRecovery: true } }
              );
            }
            throw error;
          }
          physicalChanged = true;
          continue;
        }
        if (currentChecksum !== entry.desiredChecksum) {
          throw new IslandShellFailure(
            'blocked',
            `Tyrian transaction recovery found external drift at '${entry.filePath}' and left every generation untouched.`,
            { mutation: { externalDrift: true, incompleteRecovery: true } }
          );
        }
        if (currentChecksum !== null) {
          if (stagedPath === undefined)
            throw new IslandShellFailure(
              'corrupt',
              `Tyrian transaction has no staged generation for '${entry.filePath}'.`
            );
          await retireDesiredGeneration(entry, journal.id, targetPath, stagedPath, fileSystem);
        }
        try {
          await fs.link(retiredPath, targetPath);
        } catch (error) {
          if (isAlreadyExistsError(error)) {
            throw new IslandShellFailure(
              'blocked',
              `Tyrian transaction recovery observed a replacement generation at '${entry.filePath}' and left it untouched.`,
              { cause: error, mutation: { externalDrift: true, incompleteRecovery: true } }
            );
          }
          throw error;
        }
        physicalChanged = true;
        continue;
      }

      if (currentChecksum === entry.originalChecksum) {
        if (
          (currentStats === undefined ? undefined : String(currentStats.dev)) ===
            entry.originalDevice &&
          (currentStats === undefined ? undefined : String(currentStats.ino)) ===
            entry.originalInode &&
          (currentStats === undefined ? undefined : Number(currentStats.mode)) ===
            entry.originalMode
        ) {
          continue;
        }
        throw new IslandShellFailure(
          'blocked',
          `Tyrian transaction recovery found a same-content replacement generation at '${entry.filePath}' and left it untouched.`,
          { mutation: { externalDrift: true, incompleteRecovery: true } }
        );
      }
      if (!entry.existed && currentChecksum === entry.desiredChecksum && currentChecksum !== null) {
        if (stagedPath === undefined)
          throw new IslandShellFailure(
            'corrupt',
            `Tyrian transaction has no staged generation for '${entry.filePath}'.`
          );
        await retireDesiredGeneration(entry, journal.id, targetPath, stagedPath, fileSystem);
        physicalChanged = true;
        continue;
      }
      throw new IslandShellFailure(
        'blocked',
        `Tyrian transaction recovery found external drift at '${entry.filePath}' and left it untouched.`,
        { mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    } catch (error) {
      failures.push(error);
    }
  }

  try {
    await syncPatchMutationDirectories(
      fileSystem,
      journal.entries.map(({ filePath }) => filePath)
    );
  } catch (error) {
    failures.push(error);
  }

  if (failures.length > 0) {
    throw new IslandShellFailure(
      combineIslandFailureCodes(failures),
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

  await removeTemporaryFilesBeforeJournal(journalPath, journal, fileSystem);
  return physicalChanged;
}

async function retireDesiredGeneration(
  entry: FileTransactionJournal['entries'][number],
  transactionId: string,
  targetPath: string,
  stagedPath: string,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  const rollbackPublicPath = transactionSiblingPath(entry.filePath, transactionId, 'rollback');
  const rollbackPath = fileSystem?.pathFor(rollbackPublicPath) ?? rollbackPublicPath;
  await fs.rename(targetPath, rollbackPath);
  const [movedStats, stagedStats] = await Promise.all([
    fs.lstat(rollbackPath),
    fs.lstat(stagedPath),
  ]);
  if (movedStats.dev !== stagedStats.dev || movedStats.ino !== stagedStats.ino) {
    await restoreRetiredGeneration(rollbackPath, targetPath);
    throw new IslandShellFailure(
      'blocked',
      `Tyrian transaction target changed across the recovery retirement boundary at '${entry.filePath}'.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  await fs.unlink(rollbackPath);
}

function combineIslandFailureCodes(failures: unknown[]): IslandShellFailureCode {
  const codes = failures.map((failure) => describeIslandShellFailure(failure).code);

  if (codes.every((code) => code === 'permission-required')) return 'permission-required';
  if (codes.includes('corrupt')) return 'corrupt';
  if (codes.includes('blocked')) return 'blocked';
  return 'unsupported';
}

async function readTransactionTarget(
  filePath: string,
  displayPath = filePath
): Promise<string | undefined> {
  const stats = await lstatIfExists(filePath);

  if (stats === undefined) return undefined;
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian transaction target generation is not a regular file at '${displayPath}'.`
    );
  }

  return fs.readFile(filePath, 'utf8');
}

function checksumOrNull(content: string | undefined): string | null {
  return content === undefined ? null : sha256Base64(content);
}

async function removeTemporaryFilesBeforeJournal(
  journalPath: string,
  journal: FileTransactionJournal,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  const temporaryDirectories = new Set<string>();

  for (const entry of journal.entries) {
    for (const [kind, temporaryPath] of [
      ['stage', entry.stagedPath],
      ['backup', entry.backupPath],
      ['retired', entry.retiredPath],
      ['rollback', transactionSiblingPath(entry.filePath, journal.id, 'rollback')],
    ] as const) {
      if (temporaryPath !== undefined) {
        const operationPath = transactionCleanupOperationPath(
          entry.filePath,
          temporaryPath,
          fileSystem
        );
        await removeOwnedTransactionTemporary(operationPath, temporaryPath, entry, kind);
        temporaryDirectories.add(path.dirname(temporaryPath));
      }
    }
  }

  const patchDirectories = [...temporaryDirectories].filter(
    (directory) =>
      fileSystem === undefined ||
      directory === fileSystem.appRoot ||
      directory === fileSystem.paths.workbenchDirPath
  );
  await syncPatchMutationDirectories(
    fileSystem,
    patchDirectories.map((directory) => path.join(directory, '.'))
  );
  const journalOperationPath = fileSystem?.pathFor(journalPath) ?? journalPath;
  const journalGeneration = await readOwnedTransactionTemporaryGeneration(
    journalOperationPath,
    journalPath,
    sha256Base64(serializeDurableJson(journal))
  );
  await removeFileDurably(journalOperationPath, { incompleteRecovery: true }, journalGeneration);
}

async function finishVerifiedFileTransaction(
  journalPath: string,
  journal: FileTransactionJournal,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  await removeTemporaryFilesBeforeJournal(journalPath, journal, fileSystem);
}

function transactionCleanupOperationPath(
  targetPath: string,
  temporaryPath: string,
  fileSystem: IslandPatchFileSystem | undefined
): string {
  if (fileSystem === undefined) return temporaryPath;
  const targetParent = path.dirname(targetPath);
  const belongsToPatchSession =
    targetParent === fileSystem.appRoot || targetParent === fileSystem.paths.workbenchDirPath;
  if (belongsToPatchSession) return fileSystem.pathFor(temporaryPath);
  throw new IslandShellFailure(
    'corrupt',
    `Tyrian v4 transaction cleanup target escapes its admitted filesystem at '${targetPath}'.`,
    { mutation: { incompleteRecovery: true } }
  );
}

async function removeOwnedTransactionTemporary(
  operationPath: string,
  displayPath: string,
  entry: FileTransactionJournal['entries'][number],
  kind: 'stage' | 'backup' | 'retired' | 'rollback'
): Promise<void> {
  const expectedChecksum =
    kind === 'stage' || kind === 'rollback' ? entry.desiredChecksum : entry.originalChecksum;
  const generation = await readOwnedTransactionTemporaryGeneration(
    operationPath,
    displayPath,
    expectedChecksum
  );
  if (generation.kind === 'absent') return;
  if (
    kind === 'retired' &&
    (generation.device !== entry.originalDevice ||
      generation.inode !== entry.originalInode ||
      generation.mode !== entry.originalMode)
  ) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian transaction cleanup found a replacement retired generation at '${displayPath}' and left it untouched.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  await removeFileDurably(operationPath, { incompleteRecovery: true }, generation);
}

async function readOwnedTransactionTemporaryGeneration(
  operationPath: string,
  displayPath: string,
  expectedChecksum: string | null | undefined
): Promise<RegularFileGeneration> {
  const generation = await readRegularFileGeneration(
    operationPath,
    `transaction cleanup evidence '${displayPath}'`
  );
  if (generation.kind === 'present' && checksumOrNull(generation.content) !== expectedChecksum) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian transaction cleanup found replacement evidence at '${displayPath}' and left it untouched.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  return generation;
}

function transactionSiblingPath(
  filePath: string,
  transactionId: string,
  kind: 'backup' | 'stage' | 'restore' | 'retired' | 'rollback'
): string {
  return path.join(
    path.dirname(filePath),
    `.tyrian-night-${transactionId}-${kind}-${path.basename(filePath)}.tmp`
  );
}

async function withIslandRootLock<T>(
  appRoot: string,
  environment: IslandShellEnvironment,
  action: (
    initializationChanged: boolean,
    recoveryPhysicalChanged: boolean,
    fileSystem: IslandPatchFileSystem | undefined
  ) => Promise<T>,
  readinessGate?: () => Promise<void>
): Promise<T> {
  await assertPatchPathAncestorsOwned(appRoot);
  const fileSystem =
    process.platform === 'linux' ? await openIslandPatchFileSystem(appRoot) : undefined;

  try {
    const claimPath =
      fileSystem?.pathFor(buildIslandRootLockPath(appRoot)) ?? buildIslandRootLockPath(appRoot);
    return await withIslandProcessLock(claimPath, async () => {
      let initializationChanged = false;
      let recoveryPhysicalChanged = false;
      try {
        const initialization = await withRegistryLock(environment, async () => {
          await readinessGate?.();
          await fileSystem?.assertNamespaceCurrent();
          const changed = await initializeManagedRootsForMutationUnlocked(environment);
          return islandMutationFacts({ registryChanged: changed });
        });
        initializationChanged = initialization.registryChanged;
        recoveryPhysicalChanged = await recoverRootFileTransactions(appRoot, fileSystem);
        await fileSystem?.assertNamespaceCurrent();
        return await action(initializationChanged, recoveryPhysicalChanged, fileSystem);
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
  } finally {
    await fileSystem?.close();
  }
}

async function recoverRootFileTransactions(
  appRoot: string,
  fileSystem?: IslandPatchFileSystem
): Promise<boolean> {
  const paths = getPatchPaths(appRoot);
  return recoverFileTransaction(
    paths.transactionJournalPath,
    islandTransactionAllowedTargets(appRoot),
    appRoot,
    fileSystem
  );
}

function islandTransactionAllowedTargets(appRoot: string): Set<string> {
  const paths = getPatchPaths(appRoot);
  return new Set([
    paths.workbenchHtmlPath,
    paths.productJsonPath,
    paths.islandCssPath,
    paths.manifestPath,
    paths.backupHtmlPath,
    paths.backupProductJsonPath,
  ]);
}

async function recoverFileTransaction(
  journalPath: string,
  allowedTargets: Set<string>,
  appRoot: string,
  fileSystem?: IslandPatchFileSystem
): Promise<boolean> {
  const journalOperationPath = fileSystem?.pathFor(journalPath) ?? journalPath;
  const journalStats = await lstatIfExists(journalOperationPath);
  if (journalStats !== undefined && (!journalStats.isFile() || journalStats.isSymbolicLink())) {
    throw new IslandShellFailure(
      'corrupt',
      `Tyrian file transaction journal is not a regular file at '${journalPath}'.`,
      { mutation: { incompleteRecovery: true } }
    );
  }
  const content = await readTextFileIfExists(journalOperationPath);

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

  if (journal.phase === 'verified') {
    await finishVerifiedFileTransaction(journalPath, journal, fileSystem);
    return false;
  }

  return rollbackFileTransaction(journalPath, journal, fileSystem);
}

async function inspectIslandTransactionHealth(
  journalPath: string,
  appRoot: string,
  fileSystem?: IslandPatchFileSystem
): Promise<IslandTransactionHealth> {
  const journalOperationPath = fileSystem?.pathFor(journalPath) ?? journalPath;
  const journalStats = await lstatIfExists(journalOperationPath);
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
    journal = parseFileTransactionJournal(
      await fs.readFile(journalOperationPath, 'utf8'),
      journalPath,
      islandTransactionAllowedTargets(appRoot),
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
    version: journal.version,
    phase: journal.phase,
    reason: `Tyrian transaction journal is pending automatic ${journal.phase === 'verified' ? 'cleanup' : 'recovery'} at '${journalPath}'.`,
  };
}

async function tryReadFileTransactionJournal(
  journalPath: string,
  allowedTargets: ReadonlySet<string>,
  appRoot: string,
  fileSystem?: IslandPatchFileSystem
): Promise<FileTransactionJournal | undefined> {
  const journalOperationPath = fileSystem?.pathFor(journalPath) ?? journalPath;
  const journalStats = await lstatIfExists(journalOperationPath);
  if (journalStats !== undefined && (!journalStats.isFile() || journalStats.isSymbolicLink())) {
    throw new IslandShellFailure(
      'corrupt',
      `Tyrian file transaction journal is not a regular file at '${journalPath}'.`,
      { mutation: { incompleteRecovery: true } }
    );
  }
  const content = await readTextFileIfExists(journalOperationPath);
  if (content === undefined) {
    return undefined;
  }

  try {
    return parseFileTransactionJournal(content, journalPath, allowedTargets, appRoot);
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
  allowedTargets: ReadonlySet<string>,
  expectedAppRoot?: string
): FileTransactionJournal {
  let parsed: Partial<FileTransactionJournal>;

  try {
    parsed = JSON.parse(content) as Partial<FileTransactionJournal>;
  } catch {
    throw new Error(`Tyrian file transaction journal is invalid JSON at '${journalPath}'.`);
  }

  if (
    parsed.version !== 4 ||
    typeof parsed.id !== 'string' ||
    !/^[0-9a-f-]{36}$/iu.test(parsed.id) ||
    !['preparing', 'prepared', 'committing', 'verified'].includes(parsed.phase ?? '') ||
    !Array.isArray(parsed.entries) ||
    parsed.entries.length === 0
  ) {
    throw new Error(`Tyrian file transaction journal is invalid at '${journalPath}'.`);
  }

  if (
    typeof parsed.appRoot !== 'string' ||
    !path.isAbsolute(parsed.appRoot) ||
    parsed.appRoot !== path.resolve(parsed.appRoot) ||
    (expectedAppRoot !== undefined && parsed.appRoot !== expectedAppRoot)
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
      (entry.originalChecksum !== null &&
        (typeof entry.originalChecksum !== 'string' ||
          !/^[A-Za-z0-9+/]+$/u.test(entry.originalChecksum))) ||
      (entry.desiredChecksum !== null &&
        (typeof entry.desiredChecksum !== 'string' ||
          !/^[A-Za-z0-9+/]+$/u.test(entry.desiredChecksum))) ||
      (entry.existed &&
        (!Number.isInteger(entry.originalMode) ||
          typeof entry.originalDevice !== 'string' ||
          !/^\d+$/u.test(entry.originalDevice) ||
          typeof entry.originalInode !== 'string' ||
          !/^\d+$/u.test(entry.originalInode))) ||
      (!entry.existed &&
        (entry.originalMode !== undefined ||
          entry.originalDevice !== undefined ||
          entry.originalInode !== undefined)) ||
      typeof entry.retiredPath !== 'string' ||
      !path.isAbsolute(entry.filePath) ||
      targets.has(entry.filePath) ||
      !allowedTargets.has(entry.filePath) ||
      entry.backupPath !== transactionSiblingPath(entry.filePath, parsed.id, 'backup') ||
      entry.retiredPath !== transactionSiblingPath(entry.filePath, parsed.id, 'retired') ||
      (entry.stagedPath !== undefined &&
        entry.stagedPath !== transactionSiblingPath(entry.filePath, parsed.id, 'stage'))
    ) {
      throw new Error(
        `Tyrian file transaction journal contains an invalid entry at '${journalPath}'.`
      );
    }

    targets.add(entry.filePath);
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

async function assertPatchPathAncestorsOwned(appRoot: string): Promise<void> {
  const paths = getPatchPaths(appRoot);
  const targetPaths = [
    paths.workbenchHtmlPath,
    paths.productJsonPath,
    paths.islandCssPath,
    paths.manifestPath,
    paths.backupHtmlPath,
    paths.backupProductJsonPath,
    paths.transactionJournalPath,
  ];
  const ancestors = new Set<string>();

  for (const targetPath of targetPaths) {
    let ancestor = path.dirname(targetPath);
    while (ancestor !== appRoot) {
      const relative = path.relative(appRoot, ancestor);
      if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
        throw new IslandShellFailure(
          'blocked',
          `Tyrian patch target escapes the canonical app root at '${targetPath}'.`
        );
      }
      ancestors.add(ancestor);
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }

  const orderedAncestors = [...ancestors].sort(
    (left, right) => left.split(path.sep).length - right.split(path.sep).length
  );

  for (const ancestor of orderedAncestors) {
    const stats = await lstatIfExists(ancestor);
    if (stats === undefined) continue;
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian patch ancestor is not an owned regular directory at '${ancestor}'.`
      );
    }
  }

  for (const targetPath of targetPaths) {
    const stats = await lstatIfExists(targetPath);
    if (stats !== undefined && (!stats.isFile() || stats.isSymbolicLink())) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian patch target is not an owned regular file at '${targetPath}'.`
      );
    }
  }
}

async function openIslandPatchFileSystem(appRoot: string): Promise<IslandPatchFileSystem> {
  if (process.platform !== 'linux') {
    throw new IslandShellFailure(
      'unsupported',
      'Descriptor-anchored Island filesystem mutation is supported only on Linux.'
    );
  }

  try {
    await fs.access('/proc/self/fd');
  } catch (error) {
    throw new IslandShellFailure(
      'unsupported',
      'Descriptor-anchored Island filesystem mutation requires Linux procfs.',
      { cause: error }
    );
  }

  await assertPatchPathAncestorsOwned(appRoot);
  const paths = getPatchPaths(appRoot);
  const directoryFlags = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
  const appRootHandle = await fs.open(appRoot, directoryFlags);
  let currentHandle: FileHandle | undefined;

  try {
    const expectedRoot = await fs.lstat(appRoot);
    const openedRoot = await appRootHandle.stat();
    if (
      !expectedRoot.isDirectory() ||
      expectedRoot.isSymbolicLink() ||
      expectedRoot.dev !== openedRoot.dev ||
      expectedRoot.ino !== openedRoot.ino
    ) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian app root changed during filesystem admission at '${appRoot}'.`
      );
    }

    currentHandle = appRootHandle;
    for (const segment of path.relative(appRoot, paths.workbenchDirPath).split(path.sep)) {
      const childHandle = await fs.open(
        `/proc/self/fd/${currentHandle.fd}/${segment}`,
        directoryFlags
      );
      if (currentHandle !== appRootHandle) await currentHandle.close();
      currentHandle = childHandle;
    }
    const workbenchHandle = currentHandle;
    currentHandle = undefined;

    const fileSystem: IslandPatchFileSystem = {
      appRoot,
      paths,
      appRootHandle,
      workbenchHandle,
      pathFor(filePath: string): string {
        const resolved = path.resolve(filePath);
        const parent = path.dirname(resolved);
        if (parent === appRoot)
          return `/proc/self/fd/${appRootHandle.fd}/${path.basename(resolved)}`;
        if (parent === paths.workbenchDirPath) {
          return `/proc/self/fd/${workbenchHandle.fd}/${path.basename(resolved)}`;
        }
        throw new IslandShellFailure(
          'blocked',
          `Tyrian patch mutation escapes its admitted directories at '${filePath}'.`
        );
      },
      async assertNamespaceCurrent(): Promise<void> {
        const [visibleRoot, heldRoot, visibleWorkbench, heldWorkbench] = await Promise.all([
          fs.lstat(appRoot),
          appRootHandle.stat(),
          fs.lstat(paths.workbenchDirPath),
          workbenchHandle.stat(),
        ]);
        if (
          !visibleRoot.isDirectory() ||
          visibleRoot.isSymbolicLink() ||
          visibleRoot.dev !== heldRoot.dev ||
          visibleRoot.ino !== heldRoot.ino ||
          !visibleWorkbench.isDirectory() ||
          visibleWorkbench.isSymbolicLink() ||
          visibleWorkbench.dev !== heldWorkbench.dev ||
          visibleWorkbench.ino !== heldWorkbench.ino
        ) {
          throw new IslandShellFailure(
            'blocked',
            `Tyrian patch namespace changed during mutation under '${appRoot}'.`
          );
        }
      },
      async close(): Promise<void> {
        await Promise.allSettled([workbenchHandle.close(), appRootHandle.close()]);
      },
    };

    await fileSystem.assertNamespaceCurrent();
    for (const targetPath of [
      paths.workbenchHtmlPath,
      paths.productJsonPath,
      paths.islandCssPath,
      paths.manifestPath,
      paths.backupHtmlPath,
      paths.backupProductJsonPath,
      paths.transactionJournalPath,
    ]) {
      const stats = await lstatIfExists(fileSystem.pathFor(targetPath));
      if (stats !== undefined && (!stats.isFile() || stats.isSymbolicLink())) {
        throw new IslandShellFailure(
          'blocked',
          `Tyrian patch target is not an owned regular file at '${targetPath}'.`
        );
      }
    }
    return fileSystem;
  } catch (error) {
    if (currentHandle !== undefined && currentHandle !== appRootHandle) {
      await currentHandle.close().catch(() => undefined);
    }
    await appRootHandle.close().catch(() => undefined);
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

async function writeDurableJsonFile(
  filePath: string,
  value: unknown,
  expectedGeneration: RegularFileGeneration | typeof ANY_FILE_GENERATION = ANY_FILE_GENERATION
): Promise<RegularFileGeneration> {
  return writeDurableTextFile(filePath, serializeDurableJson(value), expectedGeneration);
}

function serializeDurableJson(value: unknown): string {
  return JSON.stringify(value, null, 2).concat('\n');
}

async function readRegularFileGeneration(
  filePath: string,
  description = 'durable publication target'
): Promise<RegularFileGeneration> {
  const before = await lstatIfExists(filePath);
  if (before === undefined) return { kind: 'absent' };
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian ${description} is not an owned regular file at '${filePath}'.`
    );
  }
  const content = await fs.readFile(filePath, 'utf8');
  const after = await lstatIfExists(filePath);
  if (
    after === undefined ||
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    Number(before.mode) !== Number(after.mode)
  ) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian ${description} changed during inspection at '${filePath}'.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  return {
    kind: 'present',
    device: String(after.dev),
    inode: String(after.ino),
    mode: Number(after.mode),
    content,
  };
}

function sameRegularFileGeneration(
  left: RegularFileGeneration,
  right: RegularFileGeneration
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === 'absent' ||
      (right.kind === 'present' &&
        left.device === right.device &&
        left.inode === right.inode &&
        left.mode === right.mode &&
        left.content === right.content))
  );
}

async function writeDurableTextFile(
  filePath: string,
  content: string,
  expectedGeneration: RegularFileGeneration | typeof ANY_FILE_GENERATION = ANY_FILE_GENERATION
): Promise<RegularFileGeneration> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const retiredPath = path.join(
    path.dirname(filePath),
    `.tyrian-night-retired-${path.basename(filePath)}.tmp`
  );
  if ((await lstatIfExists(retiredPath)) !== undefined) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian durable publication has pending retired evidence at '${retiredPath}'.`,
      { mutation: { incompleteRecovery: true } }
    );
  }
  const initialGeneration = await readRegularFileGeneration(filePath);
  if (
    expectedGeneration !== ANY_FILE_GENERATION &&
    !sameRegularFileGeneration(initialGeneration, expectedGeneration)
  ) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian durable publication target changed before staging at '${filePath}'.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  const tempPath = path.join(
    path.dirname(filePath),
    `.tyrian-night-${crypto.randomUUID()}-${path.basename(filePath)}.tmp`
  );

  let published = false;
  let retired = false;
  let primaryFailure: unknown;

  try {
    await writeDurableFileExclusive(tempPath, content);
    if (initialGeneration.kind === 'present') {
      await fs.rename(filePath, retiredPath);
      retired = true;
      const movedGeneration = await readRegularFileGeneration(retiredPath);
      if (!sameRegularFileGeneration(movedGeneration, initialGeneration)) {
        retired = !(await restoreRetiredGeneration(retiredPath, filePath));
        throw new IslandShellFailure(
          'blocked',
          `Tyrian durable publication target changed across retirement at '${filePath}'.`,
          { mutation: { externalDrift: true, incompleteRecovery: true } }
        );
      }
    }
    try {
      await fs.link(tempPath, filePath);
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      throw new IslandShellFailure(
        'blocked',
        `Tyrian durable publication observed a replacement generation at '${filePath}' and preserved it.`,
        { cause: error, mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
    published = true;
    await fs.unlink(tempPath);
    if (retired) {
      await fs.unlink(retiredPath);
      retired = false;
    }
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    if (published) {
      const failure = describeIslandShellFailure(error);
      primaryFailure = new IslandDurablePublicationFailure(
        filePath,
        new IslandShellFailure(failure.code, failure.reason, {
          cause: error,
          mutation: { incompleteRecovery: true },
        })
      );
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

    if (published) {
      const failure = describeIslandShellFailure(cleanupFailure);
      throw new IslandDurablePublicationFailure(
        filePath,
        new IslandShellFailure(failure.code, failure.reason, {
          cause: cleanupFailure,
          mutation: { incompleteRecovery: true },
        })
      );
    }

    throw cleanupFailure;
  }

  if (retired && primaryFailure !== undefined) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian durable publication preserved its prior generation at '${retiredPath}'.`,
      { cause: primaryFailure, mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  return readRegularFileGeneration(filePath);
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
  mutation: Partial<IslandMutationFacts> = {},
  expectedGeneration: RegularFileGeneration | typeof ANY_FILE_GENERATION = ANY_FILE_GENERATION
): Promise<boolean> {
  const initialGeneration = await readRegularFileGeneration(filePath, 'removal target');
  if (
    expectedGeneration !== ANY_FILE_GENERATION &&
    !sameRegularFileGeneration(initialGeneration, expectedGeneration)
  ) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian removal target changed before retirement at '${filePath}'.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  if (initialGeneration.kind === 'absent') return false;
  const retiredPath = path.join(
    path.dirname(filePath),
    `.tyrian-night-${crypto.randomUUID()}-retired-${path.basename(filePath)}.tmp`
  );
  await fs.rename(filePath, retiredPath);
  const movedGeneration = await readRegularFileGeneration(retiredPath, 'retired removal target');
  if (!sameRegularFileGeneration(movedGeneration, initialGeneration)) {
    const restored = await restoreRetiredGeneration(retiredPath, filePath);
    throw new IslandShellFailure(
      'blocked',
      `Tyrian removal target changed across retirement at '${filePath}'${restored ? '.' : `; the moved generation remains at '${retiredPath}'.`}`,
      { mutation: { externalDrift: true, incompleteRecovery: !restored } }
    );
  }
  await fs.unlink(retiredPath);

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
  mutation: Partial<IslandMutationFacts> = {},
  expectedGeneration: RegularFileGeneration | typeof ANY_FILE_GENERATION = ANY_FILE_GENERATION
): Promise<boolean> {
  const currentGeneration = await readRegularFileGeneration(filePath);
  if (
    expectedGeneration !== ANY_FILE_GENERATION &&
    !sameRegularFileGeneration(currentGeneration, expectedGeneration)
  ) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian durable publication target changed before comparison at '${filePath}'.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  const currentContent =
    currentGeneration.kind === 'present' ? currentGeneration.content : undefined;

  if (currentContent === content) {
    const confirmedGeneration = await readRegularFileGeneration(filePath);
    if (!sameRegularFileGeneration(confirmedGeneration, currentGeneration)) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian durable publication target changed during no-op comparison at '${filePath}'.`,
        { mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
    return false;
  }

  try {
    await writeDurableTextFile(filePath, content, currentGeneration);
  } catch (error) {
    if (!didDurablePublicationChange(error)) throw error;
    throw new IslandPartialMutationError(
      `Tyrian durable publication changed '${filePath}' but did not complete cleanly.`,
      mutation,
      { cause: error }
    );
  }
  return true;
}

function didDurablePublicationChange(value: unknown): boolean {
  const pending = [value];
  const visited = new Set<unknown>();

  while (pending.length > 0) {
    const candidate = pending.shift();
    if (candidate === undefined || visited.has(candidate)) continue;
    visited.add(candidate);
    if (candidate instanceof IslandDurablePublicationFailure) return true;
    if (candidate instanceof AggregateError) pending.push(...candidate.errors);
    if (candidate instanceof Error && candidate.cause !== undefined) pending.push(candidate.cause);
  }

  return false;
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

function isAlreadyExistsError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'EEXIST';
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
