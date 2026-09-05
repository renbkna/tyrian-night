import crypto from 'node:crypto';
import { type Dirent, constants as fsConstants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { rollbackFailedFileTransactionCore } from './islandFileTransactionCore.js';
import {
  BACKUP_HTML_FILE_NAME,
  BACKUP_PRODUCT_FILE_NAME,
  buildIslandPatchPaths,
  buildIslandRegistryLockPath,
  buildIslandRootLockPath,
  buildManagedRootRecordPath,
  buildManagedRootsDirectoryPath,
  buildQuarantinedRootsDirectoryPath,
  ISLAND_CSS_FILE_NAME,
  ISLAND_MANIFEST_FILE_NAME,
  ISLAND_PATCH_CONTRACT_VERSION,
  ISLAND_PATCH_STRATEGY,
  type IslandManifestV3,
  type IslandPatchPaths,
  isIslandManifestV3Shape,
  TYRIAN_MARKER_END,
  TYRIAN_MARKER_START,
  WORKBENCH_CHECKSUM_KEY,
  WORKBENCH_CSS_LINK,
} from './islandPatchContract.js';
import {
  exchangeIslandPaths,
  type IslandFileTransactionProtocol,
  readIslandApplyPlatformSupport,
  selectIslandFileTransactionProtocol,
} from './islandPlatform.js';
import { isIslandLockLifecycleFailure, withIslandProcessLock } from './islandProcessLock.js';
import {
  IslandRegistryQuarantineError,
  moveRegistryRecordToQuarantineCore,
} from './islandRegistryMutationCore.js';
import {
  type IslandMutationFacts,
  islandMutationFacts,
  mergeIslandMutationFacts,
  readIslandMutationFacts,
} from './islandSupervisorCore.js';

const TYRIAN_STYLESHEET_HREF_SOURCE = String.raw`(?:["'](?:[^"']*\/)?${escapeRegExp(ISLAND_CSS_FILE_NAME)}(?:[?#][^"']*)?["']|(?:[^\s"'=<>\x60]*\/)?${escapeRegExp(ISLAND_CSS_FILE_NAME)}(?:[?#][^\s"'=<>\x60]*)?)`;
const TYRIAN_STYLESHEET_LINK_SOURCE = String.raw`<link\b[^>]*\bhref\s*=\s*${TYRIAN_STYLESHEET_HREF_SOURCE}[^>]*>`;
const TYRIAN_STYLESHEET_PATTERN = new RegExp(
  String.raw`(?:^[\t ]*${TYRIAN_STYLESHEET_LINK_SOURCE}[\t ]*\r?\n?|${TYRIAN_STYLESHEET_LINK_SOURCE})`,
  'gimu'
);
const ANY_FILE_GENERATION = Symbol('any-file-generation');
const MANAGED_ROOT_RECORD_VERSION = 2 as const;
type RegularFileIdentity =
  | { kind: 'absent' }
  | { kind: 'present'; device: string; inode: string; mode: number };
type RegularFileGeneration =
  | { kind: 'absent' }
  | (Extract<RegularFileIdentity, { kind: 'present' }> & { content: string });
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
      version: 4 | 5;
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
  content: string | undefined;
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
  /** Existing files deleted by restore retain their original generation here. */
  retiredPath: string | undefined;
  /** Existing files replaced by apply exchange this desired candidate atomically. */
  publicationPath: string | undefined;
  stagedPath: string | undefined;
};

type FileTransactionEntryV4 = {
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
};

type FileTransactionEntryV5 = {
  filePath: string;
  backupPath: string;
  stagedPath: string | undefined;
  existed: boolean;
  originalChecksum: string | null;
  desiredChecksum: string | null;
  originalMode: number | undefined;
  originalDevice: string | undefined;
  originalInode: string | undefined;
  /**
   * Before exchange this is a hardlink of stagedPath (desired). After an
   * atomic exchange it is the retired original generation. It is deliberately
   * not renamed: its inode establishes which side of the exchange survived.
   */
  publicationPath: string | undefined;
  /** Only destructive sidecar removal uses a classic retired path. */
  retiredPath: string | undefined;
};

type FileTransactionJournalV4 = {
  version: 4;
  id: string;
  appRoot: string;
  phase: 'preparing' | 'prepared' | 'committing' | 'verified';
  entries: FileTransactionEntryV4[];
};

type FileTransactionJournalV5 = {
  version: 5;
  id: string;
  appRoot: string;
  phase: 'preparing' | 'prepared' | 'committing' | 'verified';
  recovery?: FileTransactionRecoveryAttempt;
  entries: FileTransactionEntryV5[];
};

type FileTransactionRecoveryAttempt = {
  id: string;
  previousId?: string;
  phase: 'fencing' | 'ready' | 'complete';
};

type FileTransactionJournal = FileTransactionJournalV4 | FileTransactionJournalV5;
type FileTransactionEntry = FileTransactionJournal['entries'][number];

type IslandPatchFileSystem = {
  appRoot: string;
  paths: IslandPatchPaths;
  appRootHandle: FileHandle;
  workbenchHandle: FileHandle;
  pathFor(filePath: string): string;
  parentDescriptorFor(filePath: string): number;
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
  const transactionProtocol = assertIslandApplyPlatformSupported(platform);
  const appRoot = await canonicalizeAppRoot(options.appRoot);
  const canonicalOptions = { ...options, appRoot };
  await assertPatchPathAncestorsOwned(appRoot);
  await fs.access(buildIslandPatchPaths(appRoot).workbenchDirPath);

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
          transactionProtocol,
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
  try {
    selectIslandFileTransactionProtocol('apply', platform);
  } catch (error) {
    return {
      kind: 'unsupported',
      appRoot: options.appRoot,
      status: undefined,
      writeAccess: undefined,
      reason: error instanceof Error ? error.message : String(error),
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
    // Recovery owns the interrupted generation. Payload construction must use
    // the recovered files, and is performed again inside the locked transition.
    const payload =
      status.transaction.kind === 'recoverable' ? undefined : await buildApplyPayload(options);
    const changed =
      payload === undefined ||
      status.registrationState !== 'valid' ||
      status.desiredThemeId !== payload.desiredThemeId ||
      wouldApplyPayloadChange(payload);

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
  const paths = buildIslandPatchPaths(appRoot);
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
    {
      path: paths.workbenchHtmlPath,
      existingMode: fsConstants.R_OK,
      missingParentMode: fsConstants.W_OK | fsConstants.X_OK,
    },
    {
      path: paths.productJsonPath,
      existingMode: fsConstants.R_OK,
      missingParentMode: fsConstants.W_OK | fsConstants.X_OK,
    },
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
  const transactionProtocol = selectIslandFileTransactionProtocol('restore');
  const appRoot = await canonicalizeAppRoot(options.appRoot);
  const canonicalOptions = { ...options, appRoot };
  await assertPatchPathAncestorsOwned(appRoot);
  await fs.access(buildIslandPatchPaths(appRoot).workbenchDirPath);

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
        physicalChanged = await commitRestorePlan(
          state,
          plan,
          canonicalOptions,
          transactionProtocol,
          fileSystem
        );
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
    async (fileSystem) => {
      await assertIslandRestoreTransactionProtocol(appRoot, transactionProtocol, fileSystem);
      await readRestorableManagedRootRegistration(appRoot, canonicalOptions);
    }
  );
}

function assertIslandApplyPlatformSupported(
  platform: NodeJS.Platform
): IslandFileTransactionProtocol {
  try {
    return selectIslandFileTransactionProtocol('apply', platform);
  } catch (error) {
    throw new IslandShellFailure(
      'unsupported',
      error instanceof Error ? error.message : String(error),
      { cause: error }
    );
  }
}

/**
 * A V4 Restore cannot safely take ownership of a V5 exchange journal. Check
 * the journal while holding the root lock, before durable desired state is
 * initialized or changed, so the user can install GNU mv and retry intact.
 */
async function assertIslandRestoreTransactionProtocol(
  appRoot: string,
  transactionProtocol: IslandFileTransactionProtocol,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  if (transactionProtocol === 'v5') return;

  await fileSystem?.assertNamespaceCurrent();
  const transaction = await inspectIslandTransactionHealth(
    buildIslandPatchPaths(appRoot).transactionJournalPath,
    appRoot,
    fileSystem
  );
  if (transaction.kind !== 'recoverable' || transaction.version !== 5) return;

  throw new IslandShellFailure(
    'unsupported',
    `Tyrian Classic UI restore found a pending v5 transaction at '${transaction.journalPath}'. A Linux host with GNU mv --exchange and --no-copy is required to recover it before restore can continue.`,
    { mutation: { incompleteRecovery: true } }
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
    let current: RegistryRecordGeneration;
    try {
      await settleDurableMetadataPublication(recordPath, 'managed app root record');
      current = await readRegistryRecordGeneration(
        recordPath,
        candidate.recordGeneration?.corrupt ?? false
      );
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return { changed: false };
      throw error;
    }

    if (candidate.recordGeneration !== undefined) {
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
        await removeFileDurably(
          recordPath,
          { registryChanged: true },
          regularFileGenerationFromRegistry(current)
        );
      }
      return { changed: true };
    }

    const content = current.content;
    if (content === undefined) {
      throw new Error(
        `Tyrian managed app root record is not a readable regular file at '${recordPath}'.`
      );
    }
    const record = parseManagedRootRecord(content, recordPath);
    if (record.appRoot !== candidate.appRoot) {
      throw new Error(`Tyrian managed app root record does not own '${candidate.appRoot}'.`);
    }
    await removeFileDurably(
      recordPath,
      { registryChanged: true },
      regularFileGenerationFromRegistry(current)
    );
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
    const journalPath = buildIslandPatchPaths(options.appRoot).transactionJournalPath;
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
        transaction: transaction ?? {
          kind: 'unavailable',
          recoverability: 'manual',
          journalPath: buildIslandPatchPaths(options.appRoot).transactionJournalPath,
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
  const paths = buildIslandPatchPaths(appRoot);
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

function wouldApplyPayloadChange(payload: ApplyPayload): boolean {
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

  return {
    roots: [...candidates.values()],
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
  transactionProtocol: IslandFileTransactionProtocol,
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
    transactionProtocol,
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

function sha256Base64(content: string): string {
  return crypto.hash('sha256', content, 'base64').replace(/=+$/, '');
}

async function readManagedAppRootRegistration(
  appRoot: string,
  environment?: IslandShellEnvironment
): Promise<ManagedRootRegistration> {
  const recordPath = getManagedRootRecordPath(appRoot, environment);
  let generation: RegularFileGeneration;
  try {
    generation = await readDurableMetadataGeneration(recordPath, 'managed app root record');
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

  const recordNames = new Set<string>();
  const temporaryNames = new Set<string>();
  for (const entry of entries) {
    if (/^[0-9a-f]{64}\.json$/u.test(entry.name)) recordNames.add(entry.name);
    const retiredRecord = /^\.tyrian-night-retired-([0-9a-f]{64}\.json)\.tmp$/u.exec(entry.name);
    if (retiredRecord?.[1] !== undefined) {
      recordNames.add(retiredRecord[1]);
      temporaryNames.add(entry.name);
    }
    const legacyRetiredRecord =
      /^\.tyrian-night-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}-retired-([0-9a-f]{64}\.json)\.tmp$/iu.exec(
        entry.name
      );
    if (legacyRetiredRecord?.[1] !== undefined) {
      recordNames.add(legacyRetiredRecord[1]);
      temporaryNames.add(entry.name);
    }
    if (entry.name.startsWith('.tyrian-night-') && entry.name.endsWith('.tmp')) {
      temporaryNames.add(entry.name);
    }
  }

  for (const recordName of [...recordNames].sort()) {
    const recordPath = path.join(directoryPath, recordName);
    let stats: Awaited<ReturnType<typeof fs.lstat>> | undefined;
    try {
      const corruptCanonical = await readCorruptCanonicalRegistryStats(recordPath);
      if (corruptCanonical !== undefined) {
        stats = corruptCanonical;
      } else {
        const sourcePath = await durableMetadataSourcePath(recordPath);
        if (sourcePath === undefined) continue;
        stats = await fs.lstat(sourcePath);
      }
    } catch (error) {
      const reason = `${recordPath}: ${error instanceof Error ? error.message : String(error)}`;
      if (mode === 'diagnostic') {
        accumulator.registryDiagnostics.push(reason);
        continue;
      }
      throw error;
    }

    if (stats === undefined) continue;
    if (!stats.isFile() || stats.isSymbolicLink()) {
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

    let recordGeneration: RegistryRecordGeneration;
    try {
      recordGeneration = await readRegistryRecordGeneration(recordPath, false);
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
    const content = recordGeneration.content;
    if (content === undefined) {
      throw new Error(`Tyrian managed app root record is not readable at '${recordPath}'.`);
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
        await quarantineManagedRootRecordAndRecord(
          recordPath,
          environment,
          { ...recordGeneration, corrupt: true },
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
      recordGeneration: { ...recordGeneration, corrupt },
    });
  }

  for (const entry of entries) {
    if (recordNames.has(entry.name) || temporaryNames.has(entry.name)) continue;
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
  const corruptCanonical = corrupt
    ? await readCorruptCanonicalRegistryStats(recordPath)
    : undefined;
  if (corruptCanonical !== undefined) {
    return registryRecordGenerationFromStats(identityPath, corruptCanonical, undefined, true);
  }
  const sourcePath =
    (await durableMetadataSourcePath(recordPath, 'managed app root record')) ?? recordPath;
  const before = await fs.lstat(sourcePath);
  let content: string | undefined;
  if (before.isFile() && !before.isSymbolicLink()) {
    try {
      content = await fs.readFile(sourcePath, 'utf8');
    } catch (error) {
      if (!corrupt) throw error;
    }
  }
  const after = await lstatIfExists(sourcePath);
  const afterSourcePath = await durableMetadataSourcePath(recordPath, 'managed app root record');
  if (
    after === undefined ||
    afterSourcePath !== sourcePath ||
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

/**
 * Registry quarantine moves corrupt symlink entries with rename and never
 * follows them. Metadata publication remains regular-file-only: this narrow
 * admission exists only when its fixed predecessor and candidate are absent,
 * so corrupt canonical data cannot hide durable publication evidence.
 */
async function readCorruptCanonicalRegistryStats(
  recordPath: string
): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  const paths = durableMetadataPaths(recordPath);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const before = await lstatIfExists(recordPath);
    if (before === undefined || !before.isSymbolicLink()) return undefined;

    await assertNoLegacyDurableRemovalEvidence(recordPath, 'managed app root record');
    const [retired, candidate, after] = await Promise.all([
      lstatIfExists(paths.retiredPath),
      lstatIfExists(paths.candidatePath),
      lstatIfExists(recordPath),
    ]);
    if (retired !== undefined || candidate !== undefined) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian managed app root record has durable publication evidence beside a corrupt canonical record at '${recordPath}'.`,
        { mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
    await assertNoLegacyDurableRemovalEvidence(recordPath, 'managed app root record');
    if (
      after !== undefined &&
      after.isSymbolicLink() &&
      before.dev === after.dev &&
      before.ino === after.ino &&
      Number(before.mode) === Number(after.mode)
    ) {
      return after;
    }
  }
  throw new IslandShellFailure(
    'blocked',
    `Tyrian corrupt managed app root record changed during no-follow inspection at '${recordPath}'.`,
    { mutation: { externalDrift: true, incompleteRecovery: true } }
  );
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
    content,
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
    left.content === right.content
  );
}

function regularFileGenerationFromRegistry(
  generation: RegistryRecordGeneration
): Extract<RegularFileGeneration, { kind: 'present' }> {
  if (generation.content === undefined) {
    throw new Error(
      `Tyrian managed app root record is not a readable regular file at '${generation.recordPath}'.`
    );
  }
  return {
    kind: 'present',
    device: String(generation.dev),
    inode: String(generation.ino),
    mode: generation.mode,
    content: generation.content,
  };
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
  const corruptCanonical = await readCorruptCanonicalRegistryStats(recordPath);
  let current: RegistryRecordGeneration;
  if (corruptCanonical === undefined) {
    await settleDurableMetadataPublication(recordPath, 'managed app root record');
    current = await readRegistryRecordGeneration(recordPath, expected.corrupt);
  } else {
    current = registryRecordGenerationFromStats(recordPath, corruptCanonical, undefined, true);
  }
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
  transactionProtocol: IslandFileTransactionProtocol,
  admittedFileSystem?: IslandPatchFileSystem
): Promise<boolean> {
  if (admittedFileSystem !== undefined) {
    return commitFileTransactionWithFileSystem(
      journalPath,
      appRoot,
      mutations,
      verify,
      transactionProtocol,
      admittedFileSystem
    );
  }
  if (process.platform !== 'linux') {
    return commitFileTransactionWithFileSystem(
      journalPath,
      appRoot,
      mutations,
      verify,
      transactionProtocol,
      undefined
    );
  }
  const fileSystem = await openIslandPatchFileSystem(appRoot);
  try {
    return await commitFileTransactionWithFileSystem(
      journalPath,
      appRoot,
      mutations,
      verify,
      transactionProtocol,
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
  transactionProtocol: IslandFileTransactionProtocol,
  fileSystem: IslandPatchFileSystem | undefined
): Promise<boolean> {
  if (transactionProtocol === 'v5' && fileSystem === undefined) {
    throw new IslandShellFailure(
      'unsupported',
      'Atomic Island app-file publication requires the Linux descriptor-anchored filesystem.'
    );
  }
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
      publicationPath:
        transactionProtocol === 'v5' &&
        changed &&
        stats !== undefined &&
        mutation.content !== undefined
          ? transactionSiblingPath(mutation.filePath, transactionId, 'publication')
          : undefined,
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

  let journal = buildFileTransactionJournal(
    appRoot,
    transactionId,
    'preparing',
    changedMutations,
    transactionProtocol
  );
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

      if (mutation.publicationPath !== undefined) {
        const stagedPath = fileSystem?.pathFor(mutation.stagedPath!) ?? mutation.stagedPath!;
        const publicationPath =
          fileSystem?.pathFor(mutation.publicationPath) ?? mutation.publicationPath;
        await fs.link(stagedPath, publicationPath);
        await assertPublicationCandidateGeneration(mutation, fileSystem);
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
    await removeTemporaryFilesBeforeJournal(journalPath, journal, fileSystem);
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
  mutations: PreparedFileMutation[],
  transactionProtocol: IslandFileTransactionProtocol
): FileTransactionJournal {
  if (transactionProtocol === 'v5') {
    return {
      version: 5,
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
          publicationPath,
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
          publicationPath,
          retiredPath: content === undefined ? retiredPath : undefined,
        })
      ),
    };
  }

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
        retiredPath: retiredPath!,
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

  if (mutation.publicationPath !== undefined) {
    if (fileSystem === undefined) {
      throw new IslandShellFailure(
        'unsupported',
        'Atomic Island app-file publication requires the Linux descriptor-anchored filesystem.'
      );
    }
    await assertPublicationCandidateGeneration(mutation, fileSystem);
    await fileSystem.assertNamespaceCurrent();
    exchangeIslandPaths({
      sourceParentDescriptor: fileSystem.parentDescriptorFor(mutation.publicationPath),
      sourceLeaf: path.basename(mutation.publicationPath),
      targetParentDescriptor: fileSystem.parentDescriptorFor(mutation.filePath),
      targetLeaf: path.basename(mutation.filePath),
    });
    await fileSystem.assertNamespaceCurrent();

    const [published, retired, staged] = await Promise.all([
      readRegularFileGeneration(targetPath, `published transaction target '${mutation.filePath}'`),
      readRegularFileGeneration(
        fileSystem.pathFor(mutation.publicationPath),
        `retired transaction generation '${mutation.publicationPath}'`
      ),
      readRegularFileGeneration(
        fileSystem.pathFor(mutation.stagedPath!),
        `staged transaction generation '${mutation.stagedPath}'`
      ),
    ]);
    if (
      !isOriginalPreparedMutationGeneration(retired, mutation) ||
      !sameRegularFileGeneration(published, staged)
    ) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian transaction target changed across the atomic publication boundary at '${mutation.filePath}'.`,
        { mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
    return;
  }

  if (mutation.existed) {
    const retiredPublicPath = mutation.retiredPath!;
    const retiredPath = fileSystem?.pathFor(retiredPublicPath) ?? retiredPublicPath;
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

function isOriginalPreparedMutationGeneration(
  generation: RegularFileGeneration,
  mutation: Pick<
    PreparedFileMutation,
    'existed' | 'originalContent' | 'originalDevice' | 'originalInode' | 'originalMode'
  >
): boolean {
  return generation.kind === 'absent'
    ? !mutation.existed
    : checksumOrNull(generation.content) === checksumOrNull(mutation.originalContent) &&
        generation.device === mutation.originalDevice &&
        generation.inode === mutation.originalInode &&
        generation.mode === mutation.originalMode;
}

async function assertPublicationCandidateGeneration(
  mutation: PreparedFileMutation,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  if (mutation.publicationPath === undefined || mutation.stagedPath === undefined) return;
  const [publication, staged] = await Promise.all([
    readRegularFileGeneration(
      fileSystem?.pathFor(mutation.publicationPath) ?? mutation.publicationPath,
      `publication candidate '${mutation.publicationPath}'`
    ),
    readRegularFileGeneration(
      fileSystem?.pathFor(mutation.stagedPath) ?? mutation.stagedPath,
      `staged transaction generation '${mutation.stagedPath}'`
    ),
  ]);
  if (!sameRegularFileGeneration(publication, staged)) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian transaction publication candidate changed before exchange at '${mutation.filePath}'.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
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

  return journal.version === 4
    ? rollbackVersion4FileTransaction(journalPath, journal, fileSystem)
    : rollbackVersion5FileTransaction(journalPath, journal, fileSystem);
}

// Inspection and execution use this same generation evidence. Checksums alone
// cannot distinguish our published inode from an external same-content replacement.
type Version4RecoveryPlan = 'unchanged' | 'restore' | 'replace' | 'remove';
type Version5RecoveryPlan = 'unchanged' | 'reverse-exchange' | 'restore-retired' | 'remove-created';

async function planFileTransactionEntryRecovery(
  version: FileTransactionJournal['version'],
  entry: FileTransactionEntry,
  fileSystem?: IslandPatchFileSystem
): Promise<Version4RecoveryPlan | Version5RecoveryPlan> {
  return version === 5
    ? planVersion5FileTransactionEntryRecovery(entry as FileTransactionEntryV5, fileSystem)
    : planVersion4FileTransactionEntryRecovery(entry as FileTransactionEntryV4, fileSystem);
}

async function planVersion4FileTransactionEntryRecovery(
  entry: FileTransactionEntryV4,
  fileSystem?: IslandPatchFileSystem
): Promise<Version4RecoveryPlan> {
  const targetPath = fileSystem?.pathFor(entry.filePath) ?? entry.filePath;
  const retiredPath = fileSystem?.pathFor(entry.retiredPath) ?? entry.retiredPath;
  const [current, retired] = await Promise.all([
    readRegularFileGeneration(targetPath, `transaction target '${entry.filePath}'`),
    readRegularFileGeneration(retiredPath, `transaction retired generation '${entry.retiredPath}'`),
  ]);
  if (retired.kind === 'present' && !isOriginalTransactionGeneration(retired, entry)) {
    throw new IslandShellFailure(
      'corrupt',
      `Tyrian transaction retired generation changed at '${entry.retiredPath}'.`,
      { mutation: { incompleteRecovery: true } }
    );
  }
  if (isOriginalTransactionGeneration(current, entry)) return 'unchanged';
  if (current.kind === 'absent' && retired.kind === 'present') return 'restore';
  if (
    current.kind === 'present' &&
    checksumOrNull(current.content) === entry.desiredChecksum &&
    (retired.kind === 'present' || !entry.existed)
  ) {
    if (entry.stagedPath === undefined) {
      throw new IslandShellFailure(
        'corrupt',
        `Tyrian transaction has no staged generation for '${entry.filePath}'.`
      );
    }
    const staged = await readRegularFileGeneration(
      fileSystem?.pathFor(entry.stagedPath) ?? entry.stagedPath,
      `transaction staged generation '${entry.stagedPath}'`
    );
    if (sameRegularFileGeneration(current, staged)) {
      return retired.kind === 'present' ? 'replace' : 'remove';
    }
  }
  throw new IslandShellFailure(
    'blocked',
    `Tyrian transaction recovery found external drift at '${entry.filePath}' and left it untouched.`,
    { mutation: { externalDrift: true, incompleteRecovery: true } }
  );
}

async function planVersion5FileTransactionEntryRecovery(
  entry: FileTransactionEntryV5,
  fileSystem?: IslandPatchFileSystem
): Promise<Version5RecoveryPlan> {
  const targetPath = fileSystem?.pathFor(entry.filePath) ?? entry.filePath;
  const target = await readRegularFileGeneration(
    targetPath,
    `transaction target '${entry.filePath}'`
  );

  if (entry.publicationPath !== undefined) {
    if (entry.stagedPath === undefined) {
      throw new IslandShellFailure(
        'corrupt',
        `Tyrian v5 transaction has no staged generation for '${entry.filePath}'.`,
        { mutation: { incompleteRecovery: true } }
      );
    }
    const [publication, staged] = await Promise.all([
      readRegularFileGeneration(
        fileSystem?.pathFor(entry.publicationPath) ?? entry.publicationPath,
        `publication candidate '${entry.publicationPath}'`
      ),
      readRegularFileGeneration(
        fileSystem?.pathFor(entry.stagedPath) ?? entry.stagedPath,
        `staged transaction generation '${entry.stagedPath}'`
      ),
    ]);
    if (!isDesiredTransactionGeneration(staged, entry)) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian v5 staged generation changed at '${entry.stagedPath}' and was left untouched.`,
        { mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
    if (
      isOriginalTransactionGeneration(target, entry) &&
      sameRegularFileGeneration(publication, staged)
    ) {
      return 'unchanged';
    }
    if (
      sameRegularFileGeneration(target, staged) &&
      isOriginalTransactionGeneration(publication, entry)
    ) {
      return 'reverse-exchange';
    }
    throw new IslandShellFailure(
      'blocked',
      `Tyrian v5 transaction recovery found external drift at '${entry.filePath}' and left every generation intact.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }

  if (entry.desiredChecksum !== null) {
    if (entry.stagedPath === undefined) {
      throw new IslandShellFailure(
        'corrupt',
        `Tyrian v5 transaction has no staged generation for '${entry.filePath}'.`,
        { mutation: { incompleteRecovery: true } }
      );
    }
    const staged = await readRegularFileGeneration(
      fileSystem?.pathFor(entry.stagedPath) ?? entry.stagedPath,
      `staged transaction generation '${entry.stagedPath}'`
    );
    if (!isDesiredTransactionGeneration(staged, entry)) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian v5 staged generation changed at '${entry.stagedPath}' and was left untouched.`,
        { mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
    if (target.kind === 'absent') return 'unchanged';
    if (sameRegularFileGeneration(target, staged)) return 'remove-created';
    throw new IslandShellFailure(
      'blocked',
      `Tyrian v5 transaction recovery found external drift at '${entry.filePath}' and left it untouched.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }

  if (entry.retiredPath === undefined) {
    throw new IslandShellFailure(
      'corrupt',
      `Tyrian v5 transaction has no retired generation path for '${entry.filePath}'.`,
      { mutation: { incompleteRecovery: true } }
    );
  }
  const retired = await readRegularFileGeneration(
    fileSystem?.pathFor(entry.retiredPath) ?? entry.retiredPath,
    `transaction retired generation '${entry.retiredPath}'`
  );
  if (retired.kind === 'present' && !isOriginalTransactionGeneration(retired, entry)) {
    throw new IslandShellFailure(
      'corrupt',
      `Tyrian transaction retired generation changed at '${entry.retiredPath}'.`,
      { mutation: { incompleteRecovery: true } }
    );
  }
  if (isOriginalTransactionGeneration(target, entry)) return 'unchanged';
  if (target.kind === 'absent' && retired.kind === 'present') return 'restore-retired';
  throw new IslandShellFailure(
    'blocked',
    `Tyrian v5 transaction recovery found external drift at '${entry.filePath}' and left it untouched.`,
    { mutation: { externalDrift: true, incompleteRecovery: true } }
  );
}

function isOriginalTransactionGeneration(
  generation: RegularFileGeneration,
  entry: Pick<
    FileTransactionEntry,
    'existed' | 'originalChecksum' | 'originalDevice' | 'originalInode' | 'originalMode'
  >
): boolean {
  return generation.kind === 'absent'
    ? !entry.existed
    : checksumOrNull(generation.content) === entry.originalChecksum &&
        generation.device === entry.originalDevice &&
        generation.inode === entry.originalInode &&
        generation.mode === entry.originalMode;
}

function isDesiredTransactionGeneration(
  generation: RegularFileGeneration,
  entry: Pick<FileTransactionEntry, 'desiredChecksum'>
): generation is Extract<RegularFileGeneration, { kind: 'present' }> {
  return (
    generation.kind === 'present' && checksumOrNull(generation.content) === entry.desiredChecksum
  );
}

async function rollbackVersion4FileTransaction(
  journalPath: string,
  journal: FileTransactionJournalV4,
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
      const recovery = await planVersion4FileTransactionEntryRecovery(entry, fileSystem);
      if (recovery === 'unchanged') continue;
      if (recovery === 'replace' || recovery === 'remove') {
        await retireDesiredGeneration(entry, journal.id, targetPath, stagedPath!, fileSystem);
        physicalChanged = true;
      }
      if (recovery === 'restore' || recovery === 'replace') {
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
      }
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

async function rollbackVersion5FileTransaction(
  journalPath: string,
  journal: FileTransactionJournalV5,
  fileSystem?: IslandPatchFileSystem
): Promise<boolean> {
  let recoveryJournal = journal;
  if (journal.recovery?.phase === 'complete') {
    await assertVersion5RecoveryComplete(journal, fileSystem);
    await removeVersion5RecoveryCandidates(journal, fileSystem);
    await removeTemporaryFilesBeforeJournal(journalPath, journal, fileSystem);
    return false;
  }

  if (journal.entries.some(({ publicationPath }) => publicationPath !== undefined)) {
    recoveryJournal = await beginVersion5RecoveryAttempt(journalPath, journal, fileSystem);
  }

  const failures: unknown[] = [];
  let physicalChanged = false;

  for (const entry of recoveryJournal.entries.toReversed()) {
    try {
      const recoveredEntry = version5RecoveryEntry(entry, recoveryJournal.recovery);
      const recovery = await planVersion5FileTransactionEntryRecovery(recoveredEntry, fileSystem);
      const targetPath = fileSystem?.pathFor(entry.filePath) ?? entry.filePath;
      if (recovery === 'reverse-exchange') {
        await reverseVersion5Publication(recoveredEntry, fileSystem);
        physicalChanged = true;
      } else if (recovery === 'remove-created') {
        const stagedPath = fileSystem?.pathFor(entry.stagedPath!) ?? entry.stagedPath!;
        await retireDesiredGeneration(entry, journal.id, targetPath, stagedPath, fileSystem);
        physicalChanged = true;
      } else if (recovery === 'restore-retired') {
        const retiredPath = fileSystem?.pathFor(entry.retiredPath!) ?? entry.retiredPath!;
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
      }
    } catch (error) {
      failures.push(error);
    }
  }

  try {
    await syncPatchMutationDirectories(
      fileSystem,
      recoveryJournal.entries.map(({ filePath }) => filePath)
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

  if (recoveryJournal.recovery !== undefined) {
    recoveryJournal = await persistVersion5RecoveryAttempt(
      journalPath,
      recoveryJournal,
      { ...recoveryJournal.recovery, phase: 'complete' },
      fileSystem
    );
    await assertVersion5RecoveryComplete(recoveryJournal, fileSystem);
    await removeVersion5RecoveryCandidates(recoveryJournal, fileSystem);
  }
  await removeTemporaryFilesBeforeJournal(journalPath, recoveryJournal, fileSystem);
  return physicalChanged;
}

function version5RecoveryCandidatePath(entry: FileTransactionEntryV5, recoveryId: string): string {
  return transactionSiblingPath(entry.filePath, recoveryId, 'recovery');
}

function version5RecoveryEntry(
  entry: FileTransactionEntryV5,
  recovery: FileTransactionRecoveryAttempt | undefined
): FileTransactionEntryV5 {
  if (entry.publicationPath === undefined) return entry;
  if (recovery === undefined || (recovery.phase !== 'ready' && recovery.phase !== 'complete')) {
    throw new IslandShellFailure(
      'corrupt',
      `Tyrian v5 transaction has no ready recovery source for '${entry.filePath}'.`,
      { mutation: { incompleteRecovery: true } }
    );
  }
  return { ...entry, publicationPath: version5RecoveryCandidatePath(entry, recovery.id) };
}

async function beginVersion5RecoveryAttempt(
  journalPath: string,
  journal: FileTransactionJournalV5,
  fileSystem?: IslandPatchFileSystem
): Promise<FileTransactionJournalV5> {
  if (fileSystem === undefined) {
    throw new IslandShellFailure(
      'unsupported',
      'Tyrian v5 transaction recovery requires Linux descriptor-anchored fencing.',
      { mutation: { incompleteRecovery: true } }
    );
  }

  let recoveryJournal = journal;
  const previousAttempt = journal.recovery;
  if (previousAttempt?.phase === 'ready') {
    await assertVersion5ReadyAttemptTopology(journal, fileSystem);
    recoveryJournal = await persistVersion5RecoveryAttempt(
      journalPath,
      journal,
      {
        id: crypto.randomUUID(),
        previousId: previousAttempt.id,
        phase: 'fencing',
      },
      fileSystem
    );
  } else if (previousAttempt === undefined) {
    recoveryJournal = await persistVersion5RecoveryAttempt(
      journalPath,
      journal,
      { id: crypto.randomUUID(), phase: 'fencing' },
      fileSystem
    );
  }

  if (recoveryJournal.recovery?.phase !== 'fencing') {
    throw new IslandShellFailure(
      'corrupt',
      `Tyrian v5 transaction has an invalid recovery phase at '${journalPath}'.`,
      { mutation: { incompleteRecovery: true } }
    );
  }

  await fenceVersion5RecoveryAttempt(recoveryJournal, fileSystem);
  await syncPatchMutationDirectories(
    fileSystem,
    recoveryJournal.entries.map(({ filePath }) => filePath)
  );
  return persistVersion5RecoveryAttempt(
    journalPath,
    recoveryJournal,
    { ...recoveryJournal.recovery, phase: 'ready' },
    fileSystem
  );
}

async function persistVersion5RecoveryAttempt(
  journalPath: string,
  journal: FileTransactionJournalV5,
  recovery: FileTransactionRecoveryAttempt,
  fileSystem?: IslandPatchFileSystem
): Promise<FileTransactionJournalV5> {
  const journalOperationPath = fileSystem?.pathFor(journalPath) ?? journalPath;
  const generation = await readDurableMetadataGeneration(
    journalOperationPath,
    `transaction journal '${journalPath}'`
  );
  if (generation.kind !== 'present' || generation.content !== serializeDurableJson(journal)) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian v5 transaction journal changed before recovery state publication at '${journalPath}'.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  const nextJournal: FileTransactionJournalV5 = { ...journal, recovery };
  await writeDurableJsonFile(journalOperationPath, nextJournal, generation);
  return nextJournal;
}

async function fenceVersion5RecoveryAttempt(
  journal: FileTransactionJournalV5,
  fileSystem: IslandPatchFileSystem
): Promise<void> {
  const recovery = journal.recovery;
  if (recovery?.phase !== 'fencing') {
    throw new IslandShellFailure(
      'corrupt',
      'Tyrian attempted to fence a v5 transaction without a fencing recovery state.',
      { mutation: { incompleteRecovery: true } }
    );
  }

  for (const entry of journal.entries) {
    if (entry.publicationPath === undefined) continue;
    const currentPublicPath = version5RecoveryCandidatePath(entry, recovery.id);
    const priorPublicPath =
      recovery.previousId === undefined
        ? entry.publicationPath
        : version5RecoveryCandidatePath(entry, recovery.previousId);
    const [current, prior] = await Promise.all([
      lstatIfExists(fileSystem.pathFor(currentPublicPath)),
      lstatIfExists(fileSystem.pathFor(priorPublicPath)),
    ]);

    if (current !== undefined && prior !== undefined) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian v5 recovery found competing source generations for '${entry.filePath}' and left both untouched.`,
        { mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
    if (current === undefined && prior === undefined) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian v5 recovery lost its fenced source for '${entry.filePath}'.`,
        { mutation: { incompleteRecovery: true } }
      );
    }
    if (current === undefined) {
      // Rename revokes the old helper source before this owner inspects a
      // candidate or plans a target. A delayed exchange now linearizes either
      // before this rename or fails because its source name stays absent.
      await fileSystem.assertNamespaceCurrent();
      await fs.rename(fileSystem.pathFor(priorPublicPath), fileSystem.pathFor(currentPublicPath));
      await fileSystem.assertNamespaceCurrent();
    }

    const [moved, retiredSource, originalSource] = await Promise.all([
      readRegularFileGeneration(
        fileSystem.pathFor(currentPublicPath),
        `v5 fenced recovery source '${currentPublicPath}'`
      ),
      readRegularFileGeneration(
        fileSystem.pathFor(priorPublicPath),
        `v5 revoked recovery source '${priorPublicPath}'`
      ),
      recovery.previousId === undefined
        ? Promise.resolve<RegularFileGeneration>({ kind: 'absent' })
        : readRegularFileGeneration(
            fileSystem.pathFor(entry.publicationPath),
            `revoked publication source '${entry.publicationPath}'`
          ),
    ]);
    if (retiredSource.kind !== 'absent' || originalSource.kind !== 'absent') {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian v5 recovery could not revoke a prior source for '${entry.filePath}'.`,
        { mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
    await assertVersion5RecoveryCandidate(entry, moved, currentPublicPath, fileSystem);
  }
}

async function assertVersion5RecoveryCandidate(
  entry: FileTransactionEntryV5,
  generation: RegularFileGeneration,
  displayPath: string,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  if (isOriginalTransactionGeneration(generation, entry)) return;
  if (entry.stagedPath !== undefined && isDesiredTransactionGeneration(generation, entry)) {
    const staged = await readRegularFileGeneration(
      fileSystem?.pathFor(entry.stagedPath) ?? entry.stagedPath,
      `staged transaction generation '${entry.stagedPath}'`
    );
    if (sameRegularFileGeneration(generation, staged)) return;
  }
  throw new IslandShellFailure(
    'blocked',
    `Tyrian v5 recovery source changed at '${displayPath}' and was left untouched.`,
    { mutation: { externalDrift: true, incompleteRecovery: true } }
  );
}

/**
 * Ready and complete attempts keep every older publisher name absent. Read
 * again after settlement before cleanup so a prior diagnostic read can never
 * authorize a later mutation.
 */
async function readVersion5RecoveryCandidateAfterRevocation(
  entry: FileTransactionEntryV5,
  recovery: FileTransactionRecoveryAttempt,
  readCandidate: typeof readRegularFileGeneration,
  fileSystem?: IslandPatchFileSystem
): Promise<RegularFileGeneration> {
  if (entry.publicationPath === undefined) return { kind: 'absent' };
  const currentPath = version5RecoveryCandidatePath(entry, recovery.id);
  const revokedPaths = [entry.publicationPath];
  if (recovery.previousId !== undefined) {
    revokedPaths.push(version5RecoveryCandidatePath(entry, recovery.previousId));
  }
  const [current, ...revoked] = await Promise.all([
    readCandidate(
      fileSystem?.pathFor(currentPath) ?? currentPath,
      `v5 recovery source '${currentPath}'`
    ),
    ...revokedPaths.map((candidatePath) =>
      readRegularFileGeneration(
        fileSystem?.pathFor(candidatePath) ?? candidatePath,
        `revoked publication source '${candidatePath}'`
      )
    ),
  ]);
  if (revoked.some((generation) => generation.kind !== 'absent')) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian v5 recovery found a resurrected source for '${entry.filePath}' and left it untouched.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  return current;
}

async function assertVersion5ReadyAttemptTopology(
  journal: FileTransactionJournalV5,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  const recovery = journal.recovery;
  if (recovery?.phase !== 'ready') {
    throw new IslandShellFailure('corrupt', 'Tyrian v5 recovery has no ready source topology.', {
      mutation: { incompleteRecovery: true },
    });
  }
  for (const entry of journal.entries) {
    if (entry.publicationPath === undefined) continue;
    const current = await readVersion5RecoveryCandidateAfterRevocation(
      entry,
      recovery,
      readRegularFileGeneration,
      fileSystem
    );
    await assertVersion5RecoveryCandidate(
      entry,
      current,
      version5RecoveryCandidatePath(entry, recovery.id),
      fileSystem
    );
  }
}

/**
 * A fencing record is durable before recovery reads any target. It admits
 * exactly one source per entry: either a prior helper has already exchanged
 * it, or the recovery rename has already revoked it. Doctor only inspects
 * this topology; an owner completes the rename before it plans targets.
 */
async function assertVersion5FencingAttemptTopology(
  journal: FileTransactionJournalV5,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  const recovery = journal.recovery;
  if (recovery?.phase !== 'fencing') {
    throw new IslandShellFailure('corrupt', 'Tyrian v5 recovery has no fencing source topology.', {
      mutation: { incompleteRecovery: true },
    });
  }

  for (const entry of journal.entries) {
    if (entry.publicationPath === undefined) continue;
    const currentPath = version5RecoveryCandidatePath(entry, recovery.id);
    const priorPath =
      recovery.previousId === undefined
        ? entry.publicationPath
        : version5RecoveryCandidatePath(entry, recovery.previousId);
    const [current, prior] = await Promise.all([
      readRegularFileGeneration(
        fileSystem?.pathFor(currentPath) ?? currentPath,
        `v5 recovery source '${currentPath}'`
      ),
      readRegularFileGeneration(
        fileSystem?.pathFor(priorPath) ?? priorPath,
        `v5 recovery predecessor '${priorPath}'`
      ),
    ]);
    if (current.kind !== 'absent' && prior.kind !== 'absent') {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian v5 recovery found competing source generations for '${entry.filePath}' and left both untouched.`,
        { mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
    if (current.kind === 'absent' && prior.kind === 'absent') {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian v5 recovery lost its fenced source for '${entry.filePath}'.`,
        { mutation: { incompleteRecovery: true } }
      );
    }
    await assertVersion5RecoveryCandidate(
      entry,
      current.kind === 'absent' ? prior : current,
      current.kind === 'absent' ? priorPath : currentPath,
      fileSystem
    );
    if (recovery.previousId !== undefined) {
      const original = await readRegularFileGeneration(
        fileSystem?.pathFor(entry.publicationPath) ?? entry.publicationPath,
        `revoked publication source '${entry.publicationPath}'`
      );
      if (original.kind !== 'absent') {
        throw new IslandShellFailure(
          'blocked',
          `Tyrian v5 recovery found a resurrected publication source at '${entry.publicationPath}'.`,
          { mutation: { externalDrift: true, incompleteRecovery: true } }
        );
      }
    }
  }
}

async function assertVersion5RecoveryComplete(
  journal: FileTransactionJournalV5,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  const recovery = journal.recovery;
  if (recovery?.phase !== 'complete') {
    throw new IslandShellFailure('corrupt', 'Tyrian v5 recovery is not marked complete.', {
      mutation: { incompleteRecovery: true },
    });
  }
  for (const entry of journal.entries) {
    const target = await readRegularFileGeneration(
      fileSystem?.pathFor(entry.filePath) ?? entry.filePath,
      `recovered transaction target '${entry.filePath}'`
    );
    if (!isOriginalTransactionGeneration(target, entry)) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian v5 recovery target changed after restoration at '${entry.filePath}'.`,
        { mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
    if (entry.publicationPath === undefined) continue;
    const currentPath = version5RecoveryCandidatePath(entry, recovery.id);
    const current = await readVersion5RecoveryCandidateAfterRevocation(
      entry,
      recovery,
      readDurableMetadataGeneration,
      fileSystem
    );
    if (current.kind !== 'absent') {
      await assertVersion5DesiredRecoveryCandidate(entry, current, currentPath, fileSystem);
    }
  }
}

async function assertVersion5DesiredRecoveryCandidate(
  entry: FileTransactionEntryV5,
  generation: RegularFileGeneration,
  displayPath: string,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  if (entry.stagedPath === undefined || !isDesiredTransactionGeneration(generation, entry)) {
    throwUnexpectedTransactionEvidence(displayPath);
  }
  const staged = await readRegularFileGeneration(
    fileSystem?.pathFor(entry.stagedPath) ?? entry.stagedPath,
    `staged transaction generation '${entry.stagedPath}'`
  );
  if (!sameRegularFileGeneration(generation, staged))
    throwUnexpectedTransactionEvidence(displayPath);
}

async function removeVersion5RecoveryCandidates(
  journal: FileTransactionJournalV5,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  const recovery = journal.recovery;
  if (recovery?.phase !== 'complete') return;
  for (const entry of journal.entries) {
    if (entry.publicationPath === undefined) continue;
    const sourcePath = version5RecoveryCandidatePath(entry, recovery.id);
    const sourceOperationPath = fileSystem?.pathFor(sourcePath) ?? sourcePath;
    await settleDurableMetadataPublication(
      sourceOperationPath,
      `v5 recovery source '${sourcePath}'`
    );
    const candidate = await readVersion5RecoveryCandidateAfterRevocation(
      entry,
      recovery,
      readRegularFileGeneration,
      fileSystem
    );
    if (candidate.kind === 'absent') continue;
    if (fileSystem === undefined) {
      throw new IslandShellFailure(
        'unsupported',
        `Tyrian v5 recovery cleanup requires Linux filesystem admission for '${entry.filePath}'.`,
        { mutation: { incompleteRecovery: true } }
      );
    }
    await assertVersion5DesiredRecoveryCandidate(entry, candidate, sourcePath, fileSystem);
    await removeFileDurably(sourceOperationPath, { incompleteRecovery: true }, candidate);
  }
}

async function reverseVersion5Publication(
  entry: FileTransactionEntryV5,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  if (
    fileSystem === undefined ||
    entry.publicationPath === undefined ||
    entry.stagedPath === undefined
  ) {
    throw new IslandShellFailure(
      'unsupported',
      `Tyrian v5 transaction recovery requires Linux atomic exchange for '${entry.filePath}'.`,
      { mutation: { incompleteRecovery: true } }
    );
  }
  await fileSystem.assertNamespaceCurrent();
  exchangeIslandPaths({
    sourceParentDescriptor: fileSystem.parentDescriptorFor(entry.publicationPath),
    sourceLeaf: path.basename(entry.publicationPath),
    targetParentDescriptor: fileSystem.parentDescriptorFor(entry.filePath),
    targetLeaf: path.basename(entry.filePath),
  });
  await fileSystem.assertNamespaceCurrent();
  const [target, publication, staged] = await Promise.all([
    readRegularFileGeneration(
      fileSystem.pathFor(entry.filePath),
      `restored transaction target '${entry.filePath}'`
    ),
    readRegularFileGeneration(
      fileSystem.pathFor(entry.publicationPath),
      `publication candidate '${entry.publicationPath}'`
    ),
    readRegularFileGeneration(
      fileSystem.pathFor(entry.stagedPath),
      `staged transaction generation '${entry.stagedPath}'`
    ),
  ]);
  if (
    !isOriginalTransactionGeneration(target, entry) ||
    !sameRegularFileGeneration(publication, staged)
  ) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian v5 transaction changed across atomic recovery at '${entry.filePath}' and preserved every generation.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
}

async function retireDesiredGeneration(
  entry: FileTransactionEntry,
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

async function inspectFileTransactionCleanup(
  journal: FileTransactionJournal,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  for (const entry of journal.entries) {
    for (const { kind, temporaryPath } of transactionTemporaryPaths(journal, entry)) {
      await inspectOwnedTransactionTemporary(
        transactionCleanupOperationPath(entry.filePath, temporaryPath, fileSystem),
        temporaryPath,
        journal,
        entry,
        kind,
        'inspect'
      );
    }
  }
}

async function removeTemporaryFilesBeforeJournal(
  journalPath: string,
  journal: FileTransactionJournal,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  const temporaryDirectories = new Set<string>();

  for (const entry of journal.entries) {
    for (const { kind, temporaryPath } of transactionTemporaryPaths(journal, entry)) {
      const operationPath = transactionCleanupOperationPath(
        entry.filePath,
        temporaryPath,
        fileSystem
      );
      await removeOwnedTransactionTemporary(operationPath, temporaryPath, journal, entry, kind);
      temporaryDirectories.add(path.dirname(temporaryPath));
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
  const journalGeneration = await settleDurableMetadataPublication(
    journalOperationPath,
    `transaction journal '${journalPath}'`
  );
  if (
    journalGeneration.kind === 'present' &&
    checksumOrNull(journalGeneration.content) !== sha256Base64(serializeDurableJson(journal))
  ) {
    throwUnexpectedTransactionEvidence(journalPath);
  }
  await removeFileDurably(journalOperationPath, { incompleteRecovery: true }, journalGeneration);
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
    `Tyrian transaction cleanup target escapes its admitted filesystem at '${targetPath}'.`,
    { mutation: { incompleteRecovery: true } }
  );
}

type TransactionTemporaryKind = 'stage' | 'backup' | 'retired' | 'publication' | 'rollback';
type TransactionTemporaryPolicy = 'disposable' | 'sealed' | 'impossible';

function transactionTemporaryPaths(
  journal: FileTransactionJournal,
  entry: FileTransactionEntry
): Array<{ kind: TransactionTemporaryKind; temporaryPath: string }> {
  const paths: Array<{ kind: TransactionTemporaryKind; temporaryPath: string }> = [];

  if (journal.version === 4) {
    paths.push({ kind: 'retired', temporaryPath: (entry as FileTransactionEntryV4).retiredPath });
  } else {
    const version5Entry = entry as FileTransactionEntryV5;
    // A prepared v5 publication is a hardlink to stage. Dispose it while
    // stage still exists so the proof survives recovery cleanup.
    if (version5Entry.publicationPath !== undefined) {
      paths.push({ kind: 'publication', temporaryPath: version5Entry.publicationPath });
    }
    if (version5Entry.retiredPath !== undefined) {
      paths.push({ kind: 'retired', temporaryPath: version5Entry.retiredPath });
    }
  }

  paths.push({
    kind: 'rollback',
    temporaryPath: transactionSiblingPath(entry.filePath, journal.id, 'rollback'),
  });
  if (entry.backupPath !== undefined) {
    paths.push({ kind: 'backup', temporaryPath: entry.backupPath });
  }
  if (entry.stagedPath !== undefined) {
    paths.push({ kind: 'stage', temporaryPath: entry.stagedPath });
  }

  return paths;
}

async function removeOwnedTransactionTemporary(
  operationPath: string,
  displayPath: string,
  journal: FileTransactionJournal,
  entry: FileTransactionEntry,
  kind: TransactionTemporaryKind
): Promise<void> {
  await settleDurableMetadataPublication(
    operationPath,
    `transaction cleanup evidence '${displayPath}'`
  );
  const generation = await inspectOwnedTransactionTemporary(
    operationPath,
    displayPath,
    journal,
    entry,
    kind,
    'remove'
  );
  if (generation.kind !== 'absent') {
    await removeFileDurably(operationPath, { incompleteRecovery: true }, generation);
  }
}

async function inspectOwnedTransactionTemporary(
  operationPath: string,
  displayPath: string,
  journal: FileTransactionJournal,
  entry: FileTransactionEntry,
  kind: TransactionTemporaryKind,
  purpose: 'inspect' | 'remove'
): Promise<RegularFileGeneration> {
  const generation = await readDurableMetadataGeneration(
    operationPath,
    `transaction cleanup evidence '${displayPath}'`
  );
  if (generation.kind === 'absent') return generation;

  const policy = transactionTemporaryPolicy(journal, kind);
  if (policy === 'disposable') return generation;
  if (policy === 'impossible') {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian transaction found impossible ${kind} evidence while its preparing phase owns no target mutation at '${displayPath}'.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }

  if (journal.version === 5 && kind === 'publication') {
    const version5Entry = entry as FileTransactionEntryV5;
    const expectsOriginal =
      journal.phase === 'verified' ||
      (purpose === 'inspect' &&
        journal.phase === 'committing' &&
        isOriginalTransactionGeneration(generation, version5Entry));
    if (expectsOriginal) {
      if (!isOriginalTransactionGeneration(generation, version5Entry)) {
        throwUnexpectedTransactionEvidence(displayPath);
      }
      return generation;
    }
    if (
      !isDesiredTransactionGeneration(generation, version5Entry) ||
      version5Entry.stagedPath === undefined
    ) {
      throwUnexpectedTransactionEvidence(displayPath);
    }
    const staged = await readDurableMetadataGeneration(
      path.join(path.dirname(operationPath), path.basename(version5Entry.stagedPath)),
      `staged transaction generation '${version5Entry.stagedPath}'`
    );
    if (!sameRegularFileGeneration(generation, staged))
      throwUnexpectedTransactionEvidence(displayPath);
    return generation;
  }

  const expectedChecksum =
    kind === 'stage' || kind === 'rollback' ? entry.desiredChecksum : entry.originalChecksum;
  if (checksumOrNull(generation.content) !== expectedChecksum) {
    throwUnexpectedTransactionEvidence(displayPath);
  }
  if (kind === 'retired' && !isOriginalTransactionGeneration(generation, entry)) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian transaction cleanup found a replacement retired generation at '${displayPath}' and left it untouched.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  return generation;
}

/**
 * A preparing journal is durable before any target mutation. Its UUID-named
 * staging files may therefore be incomplete if the writer died mid-write and
 * are disposable. Once prepared is durable, each artifact becomes evidence
 * that must still match the sealed transaction generation.
 */
function transactionTemporaryPolicy(
  journal: FileTransactionJournal,
  kind: TransactionTemporaryKind
): TransactionTemporaryPolicy {
  if (journal.phase !== 'preparing') return 'sealed';
  if (kind === 'retired' || kind === 'rollback') return 'impossible';
  return 'disposable';
}

function throwUnexpectedTransactionEvidence(displayPath: string): never {
  throw new IslandShellFailure(
    'blocked',
    `Tyrian transaction cleanup found replacement evidence at '${displayPath}' and left it untouched.`,
    { mutation: { externalDrift: true, incompleteRecovery: true } }
  );
}

function transactionSiblingPath(
  filePath: string,
  transactionId: string,
  kind: 'backup' | 'stage' | 'restore' | 'retired' | 'publication' | 'recovery' | 'rollback'
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
  readinessGate?: (fileSystem: IslandPatchFileSystem | undefined) => Promise<void>
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
          await readinessGate?.(fileSystem);
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
  const paths = buildIslandPatchPaths(appRoot);
  return recoverFileTransaction(
    paths.transactionJournalPath,
    islandTransactionAllowedTargets(appRoot),
    appRoot,
    fileSystem
  );
}

function islandTransactionAllowedTargets(appRoot: string): Set<string> {
  const paths = buildIslandPatchPaths(appRoot);
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
  const journalGeneration = await settleDurableMetadataPublication(
    journalOperationPath,
    `transaction journal '${journalPath}'`
  );
  if (journalGeneration.kind === 'absent') {
    return false;
  }
  const content = journalGeneration.content;

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
    await removeTemporaryFilesBeforeJournal(journalPath, journal, fileSystem);
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
  let journalGeneration: RegularFileGeneration;
  let journal: FileTransactionJournal;
  try {
    journalGeneration = await readDurableMetadataGeneration(
      journalOperationPath,
      `transaction journal '${journalPath}'`
    );
    if (journalGeneration.kind === 'absent') return { kind: 'clean', recoverability: 'none' };
    journal = parseFileTransactionJournal(
      journalGeneration.content,
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

  try {
    if (journal.phase === 'committing') {
      if (journal.version === 5 && journal.recovery !== undefined) {
        await inspectVersion5RecoveryAttempt(journal, fileSystem);
      } else {
        for (const entry of journal.entries) {
          await planFileTransactionEntryRecovery(journal.version, entry, fileSystem);
        }
      }
    }
    await inspectFileTransactionCleanup(journal, fileSystem);
  } catch (error) {
    if (isPermissionError(error)) throw error;
    const failure = describeIslandShellFailure(error);
    return {
      kind: failure.code === 'blocked' ? 'external-drift' : 'corrupt',
      recoverability: 'manual',
      journalPath,
      reason: failure.reason,
    };
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

/**
 * Read-only Doctor never revokes a publication source. A fencing record is
 * therefore advisory until a lock owner resumes it, while a ready record has
 * already revoked every helper source and can safely plan target recovery.
 */
async function inspectVersion5RecoveryAttempt(
  journal: FileTransactionJournalV5,
  fileSystem?: IslandPatchFileSystem
): Promise<void> {
  const recovery = journal.recovery;
  if (recovery === undefined) return;
  if (recovery.phase === 'fencing') {
    await assertVersion5FencingAttemptTopology(journal, fileSystem);
    return;
  }
  if (recovery.phase === 'ready') {
    await assertVersion5ReadyAttemptTopology(journal, fileSystem);
    for (const entry of journal.entries) {
      await planVersion5FileTransactionEntryRecovery(
        version5RecoveryEntry(entry, recovery),
        fileSystem
      );
    }
    return;
  }
  await assertVersion5RecoveryComplete(journal, fileSystem);
}

async function tryReadFileTransactionJournal(
  journalPath: string,
  allowedTargets: ReadonlySet<string>,
  appRoot: string,
  fileSystem?: IslandPatchFileSystem
): Promise<FileTransactionJournal | undefined> {
  const journalOperationPath = fileSystem?.pathFor(journalPath) ?? journalPath;
  const generation = await settleDurableMetadataPublication(
    journalOperationPath,
    `transaction journal '${journalPath}'`
  );
  if (generation.kind === 'absent') {
    return undefined;
  }

  try {
    return parseFileTransactionJournal(generation.content, journalPath, allowedTargets, appRoot);
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
  let parsed: Record<string, unknown>;

  try {
    const value: unknown = JSON.parse(content);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('not an object');
    }
    parsed = value as Record<string, unknown>;
  } catch {
    throw new Error(`Tyrian file transaction journal is invalid JSON at '${journalPath}'.`);
  }

  if (
    (parsed.version !== 4 && parsed.version !== 5) ||
    typeof parsed.id !== 'string' ||
    !/^[0-9a-f-]{36}$/iu.test(parsed.id) ||
    typeof parsed.phase !== 'string' ||
    !['preparing', 'prepared', 'committing', 'verified'].includes(parsed.phase) ||
    !Array.isArray(parsed.entries) ||
    parsed.entries.length === 0
  ) {
    throw new Error(`Tyrian file transaction journal is invalid at '${journalPath}'.`);
  }
  if (
    parsed.version === 5 &&
    !isValidVersion5RecoveryAttempt(
      parsed.recovery,
      parsed.phase as FileTransactionJournal['phase']
    )
  ) {
    throw new Error(
      `Tyrian file transaction journal has invalid recovery state at '${journalPath}'.`
    );
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
      Array.isArray(entry) ||
      !isValidTransactionEntryCommon(entry, parsed.id, allowedTargets, targets)
    ) {
      throw new Error(
        `Tyrian file transaction journal contains an invalid entry at '${journalPath}'.`
      );
    }

    const record = entry as Record<string, unknown>;
    const validVersionSpecificEntry =
      parsed.version === 4
        ? isValidVersion4TransactionEntry(record, parsed.id)
        : isValidVersion5TransactionEntry(record, parsed.id);
    if (!validVersionSpecificEntry) {
      throw new Error(
        `Tyrian file transaction journal contains an invalid entry at '${journalPath}'.`
      );
    }

    targets.add(record.filePath as string);
  }

  return parsed as FileTransactionJournal;
}

function isValidTransactionEntryCommon(
  entry: object,
  transactionId: string,
  allowedTargets: ReadonlySet<string>,
  targets: ReadonlySet<string>
): boolean {
  const record = entry as Record<string, unknown>;
  const filePath = record.filePath;
  const backupPath = record.backupPath;
  const stagedPath = record.stagedPath;
  const originalChecksum = record.originalChecksum;
  const desiredChecksum = record.desiredChecksum;
  if (
    typeof filePath !== 'string' ||
    typeof backupPath !== 'string' ||
    (stagedPath !== undefined && typeof stagedPath !== 'string') ||
    typeof record.existed !== 'boolean' ||
    !isTransactionChecksum(originalChecksum) ||
    !isTransactionChecksum(desiredChecksum) ||
    !path.isAbsolute(filePath) ||
    targets.has(filePath) ||
    !allowedTargets.has(filePath) ||
    backupPath !== transactionSiblingPath(filePath, transactionId, 'backup') ||
    (stagedPath !== undefined &&
      stagedPath !== transactionSiblingPath(filePath, transactionId, 'stage'))
  ) {
    return false;
  }
  if (record.existed) {
    return (
      Number.isInteger(record.originalMode) &&
      typeof record.originalDevice === 'string' &&
      /^\d+$/u.test(record.originalDevice) &&
      typeof record.originalInode === 'string' &&
      /^\d+$/u.test(record.originalInode)
    );
  }
  return (
    record.originalMode === undefined &&
    record.originalDevice === undefined &&
    record.originalInode === undefined
  );
}

function isTransactionChecksum(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^[A-Za-z0-9+/]+$/u.test(value));
}

function isValidVersion4TransactionEntry(
  entry: Record<string, unknown>,
  transactionId: string
): boolean {
  return (
    typeof entry.filePath === 'string' &&
    typeof entry.retiredPath === 'string' &&
    entry.retiredPath === transactionSiblingPath(entry.filePath, transactionId, 'retired') &&
    entry.publicationPath === undefined
  );
}

function isValidVersion5TransactionEntry(
  entry: Record<string, unknown>,
  transactionId: string
): boolean {
  if (typeof entry.filePath !== 'string' || typeof entry.existed !== 'boolean') return false;
  const desired = entry.desiredChecksum;
  const hasDesired = typeof desired === 'string';
  const stagedPath = entry.stagedPath;
  const publicationPath = entry.publicationPath;
  const retiredPath = entry.retiredPath;
  if (
    (hasDesired &&
      (typeof stagedPath !== 'string' ||
        stagedPath !== transactionSiblingPath(entry.filePath, transactionId, 'stage'))) ||
    (!hasDesired && stagedPath !== undefined) ||
    (!entry.existed && !hasDesired)
  ) {
    return false;
  }

  const requiresPublication = entry.existed && hasDesired;
  if (
    (requiresPublication &&
      (typeof publicationPath !== 'string' ||
        publicationPath !==
          transactionSiblingPath(entry.filePath, transactionId, 'publication'))) ||
    (!requiresPublication && publicationPath !== undefined)
  ) {
    return false;
  }

  const requiresRetired = entry.existed && !hasDesired;
  return (
    (requiresRetired &&
      typeof retiredPath === 'string' &&
      retiredPath === transactionSiblingPath(entry.filePath, transactionId, 'retired')) ||
    (!requiresRetired && retiredPath === undefined)
  );
}

function isValidVersion5RecoveryAttempt(
  value: unknown,
  transactionPhase: FileTransactionJournal['phase']
): boolean {
  if (value === undefined) return true;
  if (transactionPhase !== 'committing') return false;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const attempt = value as Record<string, unknown>;
  return (
    typeof attempt.id === 'string' &&
    /^[0-9a-f-]{36}$/iu.test(attempt.id) &&
    (attempt.previousId === undefined ||
      (typeof attempt.previousId === 'string' && /^[0-9a-f-]{36}$/iu.test(attempt.previousId))) &&
    attempt.previousId !== attempt.id &&
    (attempt.phase === 'fencing' || attempt.phase === 'ready' || attempt.phase === 'complete')
  );
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
  const paths = buildIslandPatchPaths(appRoot);
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
  const paths = buildIslandPatchPaths(appRoot);
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
      parentDescriptorFor(filePath: string): number {
        const resolved = path.resolve(filePath);
        const parent = path.dirname(resolved);
        if (parent === appRoot) return appRootHandle.fd;
        if (parent === paths.workbenchDirPath) return workbenchHandle.fd;
        throw new IslandShellFailure(
          'blocked',
          `Tyrian atomic publication escapes its admitted directories at '${filePath}'.`
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
    sameRegularFileIdentity(left, right) &&
    (left.kind === 'absent' || (right.kind === 'present' && left.content === right.content))
  );
}

type DurableMetadataPaths = {
  canonicalPath: string;
  retiredPath: string;
  candidatePath: string;
};

type DurableMetadataState = DurableMetadataTopology<RegularFileGeneration>;

type DurableMetadataTopology<T = RegularFileIdentity> = DurableMetadataPaths & {
  canonical: T;
  retired: T;
  candidate: T;
};

/**
 * Metadata publication has one bounded namespace. The canonical name is the
 * reader authority; its fixed retired predecessor keeps the last complete
 * record readable across the only intentional canonical-name gap, and the
 * fixed candidate is disposable until it is linked into canonical.
 */
function durableMetadataPaths(filePath: string): DurableMetadataPaths {
  const directory = path.dirname(filePath);
  const baseName = path.basename(filePath);
  return {
    canonicalPath: filePath,
    retiredPath: path.join(directory, `.tyrian-night-retired-${baseName}.tmp`),
    candidatePath: path.join(directory, `.tyrian-night-candidate-${baseName}.tmp`),
  };
}

/**
 * Before metadata publication used a UUID-named retirement path. It cannot
 * prove which generation was moved after a crash, so current owners preserve
 * that bounded legacy evidence and require manual recovery rather than
 * treating its missing canonical name as clean.
 */
async function assertNoLegacyDurableRemovalEvidence(
  filePath: string,
  description: string
): Promise<void> {
  const directoryPath = path.dirname(filePath);
  let entries: string[];
  try {
    entries = await fs.readdir(directoryPath);
  } catch (error) {
    if (isFileNotFoundError(error)) return;
    throw error;
  }
  const baseName = escapeRegExp(path.basename(filePath));
  const legacyPattern = new RegExp(
    String.raw`^\.tyrian-night-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}-retired-${baseName}\.tmp$`,
    'iu'
  );
  const legacyName = entries.find((entry) => legacyPattern.test(entry));
  if (legacyName === undefined) return;
  const legacyPath = path.join(directoryPath, legacyName);
  throw new IslandShellFailure(
    'blocked',
    `Tyrian ${description} has legacy unproved deletion evidence at '${legacyPath}' and left it intact.`,
    { mutation: { externalDrift: true, incompleteRecovery: true } }
  );
}

async function readDurableMetadataState(
  filePath: string,
  description = 'durable metadata target'
): Promise<DurableMetadataState> {
  await assertNoLegacyDurableRemovalEvidence(filePath, description);
  const paths = durableMetadataPaths(filePath);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const before = await readDurableMetadataTopology(filePath, description);
    try {
      const [canonical, retired, candidate] = await Promise.all([
        readRegularFileGeneration(paths.canonicalPath, description),
        readRegularFileGeneration(paths.retiredPath, `retired ${description}`),
        readRegularFileGeneration(paths.candidatePath, `candidate ${description}`),
      ]);
      const after = await readDurableMetadataTopology(filePath, description);
      if (
        sameDurableMetadataTopology(before, after) &&
        sameRegularFileIdentity(canonical, after.canonical) &&
        sameRegularFileIdentity(retired, after.retired) &&
        sameRegularFileIdentity(candidate, after.candidate)
      ) {
        return { ...paths, canonical, retired, candidate };
      }
    } catch (error) {
      if (!isFileNotFoundError(error)) throw error;
    }
  }
  throw new IslandShellFailure(
    'blocked',
    `Tyrian ${description} changed while reading its durable metadata publication.`,
    { mutation: { externalDrift: true, incompleteRecovery: true } }
  );
}

/** Read-only callers never recreate a canonical name. */
async function readDurableMetadataGeneration(
  filePath: string,
  description = 'durable metadata target'
): Promise<RegularFileGeneration> {
  const state = await readDurableMetadataState(filePath, description);
  assertDurableMetadataReadable(state, sameRegularFileGeneration, description);
  return state.canonical.kind === 'present' ? state.canonical : state.retired;
}

async function readRegularFileIdentity(
  filePath: string,
  description: string
): Promise<RegularFileIdentity> {
  const stats = await lstatIfExists(filePath);
  if (stats === undefined) return { kind: 'absent' };
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian ${description} is not an owned regular file at '${filePath}'.`
    );
  }
  return {
    kind: 'present',
    device: String(stats.dev),
    inode: String(stats.ino),
    mode: Number(stats.mode),
  };
}

function sameRegularFileIdentity(left: RegularFileIdentity, right: RegularFileIdentity): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === 'absent' ||
      (right.kind === 'present' &&
        left.device === right.device &&
        left.inode === right.inode &&
        left.mode === right.mode))
  );
}

async function readDurableMetadataTopology(
  filePath: string,
  description: string
): Promise<DurableMetadataTopology> {
  const paths = durableMetadataPaths(filePath);
  // Canonical first is intentional. A writer moves canonical to retired in
  // one rename, so this order cannot manufacture a false both-absent state
  // by sampling retired before that rename and canonical after it.
  const canonical = await readRegularFileIdentity(paths.canonicalPath, description);
  const retired = await readRegularFileIdentity(paths.retiredPath, `retired ${description}`);
  const candidate = await readRegularFileIdentity(paths.candidatePath, `candidate ${description}`);
  return { ...paths, canonical, retired, candidate };
}

function sameDurableMetadataTopology(
  left: DurableMetadataTopology,
  right: DurableMetadataTopology
): boolean {
  return (
    sameRegularFileIdentity(left.canonical, right.canonical) &&
    sameRegularFileIdentity(left.retired, right.retired) &&
    sameRegularFileIdentity(left.candidate, right.candidate)
  );
}

async function readStableDurableMetadataTopology(
  filePath: string,
  description: string
): Promise<DurableMetadataTopology> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const before = await readDurableMetadataTopology(filePath, description);
    const after = await readDurableMetadataTopology(filePath, description);
    if (sameDurableMetadataTopology(before, after)) return after;
  }
  throw new IslandShellFailure(
    'blocked',
    `Tyrian ${description} changed while reading its durable metadata topology.`,
    { mutation: { externalDrift: true, incompleteRecovery: true } }
  );
}

/** Both content reads and path-only discovery use this publication admission rule. */
function assertDurableMetadataReadable<T extends RegularFileIdentity>(
  topology: DurableMetadataTopology<T>,
  sameGeneration: (left: T, right: T) => boolean,
  description: string
): void {
  if (topology.canonical.kind === 'absent' || topology.retired.kind === 'absent') return;
  if (sameGeneration(topology.canonical, topology.retired)) return;
  if (
    topology.candidate.kind !== 'absent' &&
    sameGeneration(topology.canonical, topology.candidate)
  ) {
    return;
  }
  throw new IslandShellFailure(
    'blocked',
    `Tyrian ${description} has ambiguous canonical and retired generations and left both intact.`,
    { mutation: { externalDrift: true, incompleteRecovery: true } }
  );
}

/** Choose a readable logical source without consuming its content twice. */
async function durableMetadataSourcePath(
  filePath: string,
  description = 'durable metadata target'
): Promise<string | undefined> {
  await assertNoLegacyDurableRemovalEvidence(filePath, description);
  const topology = await readStableDurableMetadataTopology(filePath, description);
  assertDurableMetadataReadable(topology, sameRegularFileIdentity, description);
  if (topology.canonical.kind === 'present') return topology.canonicalPath;
  if (topology.retired.kind === 'present') return topology.retiredPath;
  return undefined;
}

/**
 * A lock owner resolves only the bounded publication states. Candidate-only
 * evidence is pre-publication scratch. A canonical replacement that does not
 * match its candidate is left intact as external ambiguity.
 */
async function settleDurableMetadataPublication(
  filePath: string,
  description = 'durable metadata target'
): Promise<RegularFileGeneration> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let state = await readDurableMetadataState(filePath, description);
    assertDurableMetadataReadable(state, sameRegularFileGeneration, description);

    if (state.canonical.kind === 'absent') {
      if (state.retired.kind === 'absent') {
        if (state.candidate.kind !== 'absent') {
          await removeDurableMetadataScratch(state.candidatePath, state.candidate, description);
          continue;
        }
        return state.canonical;
      }

      try {
        await fs.link(state.retiredPath, state.canonicalPath);
      } catch (error) {
        if (isAlreadyExistsError(error)) continue;
        throw error;
      }
      await syncDirectory(path.dirname(filePath));
      state = await readDurableMetadataState(filePath, description);
      if (!sameRegularFileGeneration(state.canonical, state.retired)) {
        throw new IslandShellFailure(
          'blocked',
          `Tyrian durable metadata predecessor changed while reifying '${filePath}'.`,
          { mutation: { externalDrift: true, incompleteRecovery: true } }
        );
      }

      // Reification produces canonical == retired. Use the same cleanup below
      // whether this owner linked it or a previous owner stopped after linking.
    }

    if (state.retired.kind !== 'absent') {
      if (sameRegularFileGeneration(state.canonical, state.retired)) {
        if (state.candidate.kind !== 'absent') {
          await removeDurableMetadataScratch(state.candidatePath, state.candidate, description);
        }
        await removeDurableMetadataScratch(state.retiredPath, state.retired, description);
        continue;
      }
      // Admission proved canonical == candidate. Keep that proof until the
      // predecessor is gone, including across a crash during cleanup.
      await removeDurableMetadataScratch(state.retiredPath, state.retired, description);
      await removeDurableMetadataScratch(state.candidatePath, state.candidate, description);
      continue;
    }

    if (state.candidate.kind !== 'absent') {
      await removeDurableMetadataScratch(state.candidatePath, state.candidate, description);
      continue;
    }

    return state.canonical;
  }

  throw new IslandShellFailure(
    'blocked',
    `Tyrian durable metadata publication did not settle at '${filePath}'.`,
    { mutation: { externalDrift: true, incompleteRecovery: true } }
  );
}

async function removeDurableMetadataScratch(
  filePath: string,
  expected: RegularFileGeneration,
  description: string
): Promise<void> {
  const current = await readRegularFileGeneration(filePath, `cleanup ${description}`);
  if (!sameRegularFileGeneration(current, expected)) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian durable metadata scratch changed before cleanup at '${filePath}'.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  if (current.kind === 'absent') return;
  await fs.unlink(filePath);
  await syncDirectory(path.dirname(filePath));
}

async function writeDurableTextFile(
  filePath: string,
  content: string,
  expectedGeneration: RegularFileGeneration | typeof ANY_FILE_GENERATION = ANY_FILE_GENERATION
): Promise<RegularFileGeneration> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const paths = durableMetadataPaths(filePath);
  const initialGeneration = await settleDurableMetadataPublication(filePath);
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
  let published = false;
  let retired = false;
  let primaryFailure: unknown;

  try {
    await writeDurableFileExclusive(paths.candidatePath, content);
    await syncDirectory(path.dirname(filePath));
    const candidateGeneration = await readRegularFileGeneration(
      paths.candidatePath,
      `candidate durable publication '${filePath}'`
    );
    if (initialGeneration.kind === 'present') {
      await fs.rename(paths.canonicalPath, paths.retiredPath);
      retired = true;
      await syncDirectory(path.dirname(filePath));
      const movedGeneration = await readRegularFileGeneration(paths.retiredPath);
      if (!sameRegularFileGeneration(movedGeneration, initialGeneration)) {
        retired = !(await restoreRetiredGeneration(paths.retiredPath, paths.canonicalPath));
        throw new IslandShellFailure(
          'blocked',
          `Tyrian durable publication target changed across retirement at '${filePath}'.`,
          { mutation: { externalDrift: true, incompleteRecovery: true } }
        );
      }
    }
    try {
      await fs.link(paths.candidatePath, paths.canonicalPath);
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      throw new IslandShellFailure(
        'blocked',
        `Tyrian durable publication observed a replacement generation at '${filePath}' and preserved it.`,
        { cause: error, mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
    published = true;
    await syncDirectory(path.dirname(filePath));
    const currentGeneration = await readRegularFileGeneration(paths.canonicalPath);
    if (!sameRegularFileGeneration(currentGeneration, candidateGeneration)) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian durable publication target changed across canonical link at '${filePath}'.`,
        { mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
    if (retired) {
      await fs.unlink(paths.retiredPath);
      retired = false;
    }
    await fs.unlink(paths.candidatePath);
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

  if (retired && primaryFailure !== undefined) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian durable publication preserved its prior generation at '${paths.retiredPath}'.`,
      { cause: primaryFailure, mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  return readRegularFileGeneration(paths.canonicalPath);
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
  expectedGeneration: RegularFileGeneration
): Promise<boolean> {
  const initialGeneration = await settleDurableMetadataPublication(filePath, 'removal target');
  if (!sameRegularFileGeneration(initialGeneration, expectedGeneration)) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian removal target changed before retirement at '${filePath}'.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  if (initialGeneration.kind === 'absent') return false;
  const paths = durableMetadataPaths(filePath);
  await fs.rename(filePath, paths.retiredPath);
  await syncDirectory(path.dirname(filePath));
  const movedGeneration = await readRegularFileGeneration(
    paths.retiredPath,
    'retired removal target'
  );
  if (!sameRegularFileGeneration(movedGeneration, initialGeneration)) {
    const restored = await restoreRetiredGeneration(paths.retiredPath, filePath);
    throw new IslandShellFailure(
      'blocked',
      `Tyrian removal target changed across retirement at '${filePath}'${restored ? '.' : `; the moved generation remains at '${paths.retiredPath}'.`}`,
      { mutation: { externalDrift: true, incompleteRecovery: !restored } }
    );
  }

  try {
    await fs.unlink(paths.retiredPath);
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
  const currentGeneration = await settleDurableMetadataPublication(filePath);
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
    const confirmedGeneration = await readDurableMetadataGeneration(filePath);
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
    if (
      findNestedError(error, (candidate) =>
        candidate instanceof IslandDurablePublicationFailure ? candidate : undefined
      ) === undefined
    ) {
      throw error;
    }
    throw new IslandPartialMutationError(
      `Tyrian durable publication changed '${filePath}' but did not complete cleanly.`,
      mutation,
      { cause: error }
    );
  }
  return true;
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
