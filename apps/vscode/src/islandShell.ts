import {
  type IslandShellStatus,
  type IslandShellResult,
  IslandShellFailure,
  IslandPartialMutationError,
  type IslandShellApplyReadiness,
  type IslandShellWriteAccess,
  isPermissionError,
  describeIslandShellFailure,
  type IslandShellCleanupSummary,
  isFileNotFoundError,
  type IslandTransactionHealth,
  IslandShellTransitionFailure,
} from './islandShellContract.js';
import { canonicalizeAppRoot, lstatIfExists } from './islandFileSystem.js';
import {
  assertIslandRegistrationApplicable,
  readManagedAppRootRegistration,
  publishManagedRootRecord,
  assertManagedRootsReadable,
  islandRegistryAccessRequirements,
  readRestorableManagedRootRegistration,
  listIslandShellRoots,
  type ManagedRootRegistration,
  isCurrentManagedRootRegistration,
  readDesiredThemeId,
  type IslandRegisteredRoot,
  type IslandShellEnvironment,
  initializeIslandRegistry,
  IslandRegistryQuarantineError,
} from './islandRegistry.js';
import {
  buildIslandApplyPlan,
  buildRestoreMutations,
  inspectIslandRoot,
  buildRestorePlan,
  type IslandRootState,
  type RestorePlan,
  verifyManagedStateRemoved,
  verifyRestoredShell,
} from './islandPatchPlan.js';
import {
  withIslandFileOwner,
  readIslandInstallationFiles,
  type IslandFileOwner,
  type IslandFileReader,
} from './islandFileTransaction.js';
import fs from 'node:fs/promises';
import { buildIslandPatchPaths } from './islandPatchContract.js';
import {
  islandMutationFacts,
  mergeIslandMutationFacts,
  readIslandMutationFacts,
} from './islandSupervisorCore.js';
import {
  readIslandApplyPlatformSupport,
  selectIslandFileTransactionProtocol,
  type IslandFileTransactionProtocol,
} from './islandPlatform.js';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { isIslandLockLifecycleFailure } from './islandProcessLock.js';
export {
  type IslandShellStatus,
  type IslandTransactionHealth,
  type IslandMutationResult,
  type IslandShellResult,
  type IslandShellFailureCode,
  IslandShellFailure,
  IslandShellTransitionFailure,
  type IslandShellFailureDescription,
  describeIslandShellFailure,
  readIslandShellFailureStatus,
  IslandPartialMutationError,
  type IslandShellCleanupSummary,
  type IslandShellWriteAccess,
  type IslandShellApplyReadiness,
} from './islandShellContract.js';

export type IslandShellInventory = {
  statuses: IslandShellStatus[];
  registryDiagnostics: string[];
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
  await readIslandInstallationFiles(appRoot).assertNamespaceCurrent();
  await fs.access(buildIslandPatchPaths(appRoot).workbenchDirPath);

  return withIslandRootTransition(
    appRoot,
    canonicalOptions,
    transactionProtocol,
    async (initializationChanged, recoveryPhysicalChanged, fileOwner) => {
      const files = fileOwner.files;
      await assertIslandRegistrationApplicable(appRoot, canonicalOptions);
      const plan = await buildIslandApplyPlan(canonicalOptions, files);
      const recordChanged = await publishManagedRootRecord(
        appRoot,
        plan.desiredThemeId,
        canonicalOptions
      );

      let physicalChanged: boolean;
      try {
        physicalChanged = await fileOwner.commit(plan.mutations, async () => {
          await plan.verify();
          const registration = await readManagedAppRootRegistration(appRoot, canonicalOptions);

          if (
            registration.kind !== 'valid' ||
            registration.desiredThemeId !== plan.desiredThemeId
          ) {
            throw new Error(
              'Tyrian Night verification failed: app root was not registered after apply.'
            );
          }
        });
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

      await files.assertNamespaceCurrent();
      const status = await readIslandShellStatusUnlocked(canonicalOptions, files);
      await files.assertNamespaceCurrent();

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
    (files) => assertIslandApplyReady(canonicalOptions, files)
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

async function readIslandShellApplyReadinessUnlocked(
  options: {
    appRoot: string;
    cssSourcePath: string;
    themeVersion: string;
    registryHome?: string;
  },
  files: IslandFileReader = readIslandInstallationFiles(options.appRoot)
): Promise<IslandShellApplyReadiness> {
  const { appRoot } = options;
  let status: IslandShellStatus | undefined;
  let writeAccess: IslandShellWriteAccess | undefined;

  try {
    await files.assertNamespaceCurrent();
    await assertManagedRootsReadable(options);
    status = await readIslandShellStatusUnlocked(options, files);
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
      status.transaction.kind === 'recoverable'
        ? undefined
        : await buildIslandApplyPlan(options, files);
    const changed =
      payload === undefined ||
      status.registrationState !== 'valid' ||
      status.desiredThemeId !== payload.desiredThemeId ||
      payload.changed;

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
      status ??= await readIslandShellStatusUnlocked(options, files);
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

async function assertIslandApplyReady(
  options: {
    appRoot: string;
    cssSourcePath: string;
    themeVersion: string;
    registryHome?: string;
  },
  files: IslandFileReader
): Promise<void> {
  const readiness = await readIslandShellApplyReadinessUnlocked(options, files);
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
  await readIslandInstallationFiles(appRoot).assertNamespaceCurrent();
  const paths = buildIslandPatchPaths(appRoot);
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
    ...islandRegistryAccessRequirements(appRoot, options),
    ...[
      paths.islandCssPath,
      paths.manifestPath,
      paths.backupHtmlPath,
      paths.backupProductJsonPath,
      paths.transactionJournalPath,
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
  await readIslandInstallationFiles(appRoot).assertNamespaceCurrent();
  await fs.access(buildIslandPatchPaths(appRoot).workbenchDirPath);

  return withIslandRootTransition(
    appRoot,
    canonicalOptions,
    transactionProtocol,
    async (initializationChanged, recoveryPhysicalChanged, fileOwner) => {
      const files = fileOwner.files;
      const registration = await readRestorableManagedRootRegistration(appRoot, canonicalOptions);
      const state = await inspectIslandRoot(appRoot, registration, undefined, files);
      const plan = buildRestorePlan(state);
      const recordChanged = await publishManagedRootRecord(appRoot, null, canonicalOptions);
      let physicalChanged: boolean;
      try {
        physicalChanged = await commitRestorePlan(state, plan, canonicalOptions, fileOwner);
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

      await files.assertNamespaceCurrent();
      const status = await readIslandShellStatusUnlocked(canonicalOptions, files);
      await files.assertNamespaceCurrent();

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
          const cleanup = await appRoot.removeMissing();
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

export async function readIslandShellStatus(options: {
  appRoot: string;
  registryHome?: string;
}): Promise<IslandShellStatus> {
  const appRoot = await canonicalizeAppRoot(options.appRoot);
  await readIslandInstallationFiles(appRoot).assertNamespaceCurrent();
  return readIslandShellStatusUnlocked({ ...options, appRoot });
}

async function readIslandShellStatusUnlocked(
  options: {
    appRoot: string;
    registryHome?: string;
  },
  files: IslandFileReader = readIslandInstallationFiles(options.appRoot)
): Promise<IslandShellStatus> {
  let registration: ManagedRootRegistration = { kind: 'absent' };
  let transaction: IslandTransactionHealth | undefined;

  try {
    registration = await readManagedAppRootRegistration(options.appRoot, options);
    await files.assertNamespaceCurrent();
    transaction = await files.health();
    return (await inspectIslandRoot(options.appRoot, registration, transaction, files)).status;
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
  appRoots: IslandRegisteredRoot[],
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

async function commitRestorePlan(
  state: IslandRootState,
  plan: RestorePlan,
  environment: IslandShellEnvironment,
  fileOwner: IslandFileOwner
): Promise<boolean> {
  if (plan.kind === 'noop') {
    return false;
  }

  const files = fileOwner.files;
  return fileOwner.commit(buildRestoreMutations(state, plan), async () => {
    if (plan.kind === 'remove-managed-state') {
      await verifyManagedStateRemoved(state.paths, files);
    } else {
      await verifyRestoredShell(state.paths, files);
    }

    const registration = await readManagedAppRootRegistration(state.status.appRoot, environment);
    if (registration.kind !== 'valid' || registration.desiredThemeId !== null) {
      throw new Error(
        'Tyrian Night verification failed: restored app root is not durably disabled.'
      );
    }
  });
}

/** Coordinate desired registry intent with one explicitly owned file transition. */
async function withIslandRootTransition<T>(
  appRoot: string,
  environment: IslandShellEnvironment,
  transactionProtocol: IslandFileTransactionProtocol,
  action: (
    initializationChanged: boolean,
    recoveryPhysicalChanged: boolean,
    owner: IslandFileOwner
  ) => Promise<T>,
  readinessGate: (files: IslandFileReader) => Promise<void>
): Promise<T> {
  return withIslandFileOwner(appRoot, transactionProtocol, async (owner) => {
    const files = owner.files;
    let initializationChanged = false;
    let recoveryPhysicalChanged = false;
    try {
      initializationChanged = await initializeIslandRegistry(environment, async () => {
        await owner.assertRecoverySupported();
        await readinessGate(files);
        await files.assertNamespaceCurrent();
      });
      recoveryPhysicalChanged = await owner.recover();
      await files.assertNamespaceCurrent();
      return await action(initializationChanged, recoveryPhysicalChanged, owner);
    } catch (error) {
      let status: IslandShellStatus | undefined;
      try {
        status = await readIslandShellStatusUnlocked({ ...environment, appRoot }, files);
        await files.assertNamespaceCurrent();
      } catch {
        status = undefined;
      }
      const transition = new IslandShellTransitionFailure(error, status);
      if (!initializationChanged && !recoveryPhysicalChanged) throw transition;
      throw new IslandPartialMutationError(
        `Tyrian durable state changed before the root transition failed: ${transition.message}`,
        { registryChanged: initializationChanged, physicalChanged: recoveryPhysicalChanged },
        { cause: transition }
      );
    }
  });
}
