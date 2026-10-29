import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  applyFileMutations,
  canonicalizeAppRoot,
  lstatIfExists,
  removeStaleTemporaryFiles,
} from './islandFileSystem.js';
import {
  islandMutationFacts,
  mergeIslandMutationFacts,
  readIslandMutationFacts,
} from './islandMutationFacts.js';
import {
  buildIslandPatchPaths,
  islandSidecarPaths,
  type IslandShellEnvironment,
} from './islandPatchContract.js';
import {
  buildIslandApplyPlan,
  buildRestoreMutations,
  buildRestorePlan,
  inspectIslandRoot,
  verifyIslandClassification,
} from './islandPatchPlan.js';
import { readIslandPlatformSupport } from './islandPlatform.js';
import {
  type IslandAccessRequirement,
  type ManagedRootRegistration,
  isAppRootMissing,
  islandRegistryAccessRequirements,
  listIslandDoctorRoots,
  listIslandRestoreRoots,
  publishManagedRootRecord,
  desiredStateOf,
  readManagedAppRootRegistration,
} from './islandRegistry.js';
import {
  corruptDesiredStateFailure,
  describeIslandShellFailure,
  islandFailureResultKind,
  isPermissionError,
  type IslandShellApplyReadiness,
  type IslandShellCleanupSummary,
  IslandShellFailure,
  type IslandShellResult,
  type IslandShellStatus,
  IslandShellTransitionFailure,
  type IslandShellWriteAccess,
  IslandPartialMutationError,
  errorMessage,
} from './islandShellContract.js';

type IslandShellInventory = {
  statuses: IslandShellStatus[];
  registryDiagnostics: string[];
};

type ApplyOptions = {
  appRoot: string;
  cssSourcePath: string;
  themeVersion: string;
} & IslandShellEnvironment;

/**
 * Publish the desired style, then converge the app files to it. Callers
 * outside tests reach this through the Island CLI, which holds the Island lock.
 */
export async function applyIslandShell(options: ApplyOptions): Promise<IslandShellResult> {
  assertIslandPlatformSupported();
  const appRoot = await canonicalizeAppRoot(options.appRoot);
  const canonicalOptions = { ...options, appRoot };
  await assertIslandApplyReady(canonicalOptions);

  return transitionRoot(canonicalOptions, true, async () => {
    const plan = await buildIslandApplyPlan(canonicalOptions);
    return {
      desiredCssFile: plan.desiredCssFile,
      converge: () => applyFileMutations(plan.mutations, plan.verify),
    };
  });
}

export async function readIslandShellApplyReadiness(
  options: ApplyOptions
): Promise<IslandShellApplyReadiness> {
  const platformSupport = readIslandPlatformSupport();
  if (!platformSupport.supported) {
    return {
      kind: 'unsupported',
      status: undefined,
      writeAccess: undefined,
      reason: platformSupport.reason,
    };
  }

  const appRoot = await canonicalizeAppRoot(options.appRoot);
  return readApplyReadiness({ ...options, appRoot });
}

async function readApplyReadiness(options: ApplyOptions): Promise<IslandShellApplyReadiness> {
  let status: IslandShellStatus | undefined;
  let writeAccess: IslandShellWriteAccess | undefined;

  try {
    status = await readIslandShellStatus(options);
    if (status.classification === 'unsupported-layout') {
      return { kind: 'unsupported', status, writeAccess, reason: status.issues.join(' ') };
    }
    if (status.classification === 'missing') {
      return { kind: 'blocked', status, writeAccess, reason: status.issues.join(' ') };
    }
    if (status.desired.kind === 'corrupt') {
      const { message } = corruptDesiredStateFailure();
      return { kind: 'blocked', status, writeAccess, reason: message };
    }
    writeAccess = await readIslandShellWriteAccess(options);
    const plan = await buildIslandApplyPlan(options);
    const changed =
      !(status.desired.kind === 'enabled' && status.desired.cssFile === plan.desiredCssFile) ||
      plan.changed;

    if (!writeAccess.writable && changed) {
      return {
        kind: 'permission-required',
        status,
        writeAccess,
        reason: 'Tyrian needs write access to the VS Code app files to manage Island UI.',
      };
    }

    return { kind: 'ready', status, writeAccess };
  } catch (error) {
    const failure = describeIslandShellFailure(error);
    const kind = islandFailureResultKind(failure.code);
    if (kind === 'permission-required') {
      status ??= await readIslandShellStatus(options);
      writeAccess ??= await readIslandShellWriteAccess(options);

      return {
        kind: 'permission-required',
        status,
        writeAccess,
        reason:
          'Tyrian needs write access to the VS Code app files to inspect or update Island UI.',
      };
    }

    return {
      kind,
      status,
      writeAccess,
      reason: failure.reason,
    };
  }
}

async function assertIslandApplyReady(options: ApplyOptions): Promise<void> {
  const readiness = await readApplyReadiness(options);
  if (readiness.kind === 'ready') return;
  throw new IslandShellFailure(readiness.kind, readiness.reason);
}

export async function readIslandShellWriteAccess(
  options: {
    appRoot: string;
    cssSourcePath?: string;
  } & IslandShellEnvironment
): Promise<IslandShellWriteAccess> {
  const appRoot = await canonicalizeAppRoot(options.appRoot);
  const paths = buildIslandPatchPaths(appRoot);
  const requirements: IslandAccessRequirement[] = [
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
    ...islandSidecarPaths(paths).map((filePath) => ({
      path: filePath,
      existingMode: fsConstants.R_OK,
      optional: true,
    })),
  ];
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
        reason: errorMessage(error),
      });
    }
  }

  return {
    writable: blockedPaths.length === 0,
    blockedPaths,
    issues: blockedPaths.map(({ path: filePath }) => `Tyrian cannot write '${filePath}'.`),
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

/** Publish disabled desired state, then converge the app files to Classic UI. */
export async function restoreIslandShell(
  options: {
    appRoot: string;
  } & IslandShellEnvironment
): Promise<IslandShellResult> {
  assertIslandPlatformSupported();
  const appRoot = await canonicalizeAppRoot(options.appRoot);
  const canonicalOptions = { ...options, appRoot };

  return transitionRoot(canonicalOptions, false, async () => {
    const registration = await readManagedAppRootRegistration(appRoot, canonicalOptions);
    const state = await inspectIslandRoot(appRoot, registration);
    const plan = buildRestorePlan(state);
    if (plan.kind !== 'noop') {
      const writeAccess = await readIslandShellWriteAccess(canonicalOptions);
      if (!writeAccess.writable) {
        throw new IslandShellFailure(
          'permission-required',
          `Tyrian needs write access to restore Classic UI: ${writeAccess.issues.join(' ')}`
        );
      }
    }
    return {
      desiredCssFile: null,
      converge: async () =>
        plan.kind !== 'noop' &&
        applyFileMutations(buildRestoreMutations(state, plan), () =>
          verifyIslandClassification(appRoot, { kind: 'valid', desiredCssFile: null }, 'clean')
        ),
    };
  });
}

/**
 * One root transition: clear dead temporaries, plan, publish the desired
 * style, then converge the app files to it. The caller holds the Island lock.
 */
async function transitionRoot(
  options: { appRoot: string } & IslandShellEnvironment,
  active: boolean,
  plan: () => Promise<{ desiredCssFile: string | null; converge: () => Promise<boolean> }>
): Promise<IslandShellResult> {
  return withTransitionStatus(options, async () => {
    await removeStaleTemporaryFilesOf(options.appRoot);
    const { desiredCssFile, converge } = await plan();
    const recordChanged = await publishManagedRootRecord(options.appRoot, desiredCssFile, options);
    const physicalChanged = await convergeAfterDesiredState(recordChanged, converge);

    return {
      ...islandMutationFacts({ registryChanged: recordChanged, physicalChanged }),
      active,
      status: await readIslandShellStatus(options),
    };
  });
}

/** Temporaries left by a writer that died; the caller holds the Island lock. */
async function removeStaleTemporaryFilesOf(appRoot: string): Promise<void> {
  await removeStaleTemporaryFiles(appRoot);
  await removeStaleTemporaryFiles(buildIslandPatchPaths(appRoot).workbenchDirPath);
}

function assertIslandPlatformSupported(): void {
  const platformSupport = readIslandPlatformSupport();
  if (!platformSupport.supported) {
    throw new IslandShellFailure('unsupported', platformSupport.reason);
  }
}

/** A physical failure after desired state was published still reports that publication. */
async function convergeAfterDesiredState(
  recordChanged: boolean,
  converge: () => Promise<boolean>
): Promise<boolean> {
  try {
    return await converge();
  } catch (error) {
    if (!recordChanged) throw error;
    throw new IslandPartialMutationError(
      'Tyrian desired state was published, but the app files did not converge.',
      { registryChanged: true },
      { cause: error }
    );
  }
}

/** Attach the status observed after a failed transition, when it is readable. */
async function withTransitionStatus<T>(
  options: { appRoot: string } & IslandShellEnvironment,
  action: () => Promise<T>
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    let status: IslandShellStatus | undefined;
    try {
      status = await readIslandShellStatus(options);
    } catch {
      status = undefined;
    }
    throw new IslandShellTransitionFailure(error, status);
  }
}

export async function restoreAllIslandShells(
  options?: {
    preferredAppRoots?: string[];
  } & IslandShellEnvironment
): Promise<IslandShellCleanupSummary> {
  assertIslandPlatformSupported();
  const listing = await listIslandRestoreRoots(options);
  let mutation = mergeIslandMutationFacts(
    { registryChanged: listing.registryChanged },
    listing.enumerationFailure
  );
  const restoredAppRoots: string[] = [];
  const failedAppRoots: IslandShellCleanupSummary['failedAppRoots'] = [];
  const recordFailure = (appRoot: string, error: unknown) => {
    mutation = mergeIslandMutationFacts(mutation, readIslandMutationFacts(error));
    const failure = describeIslandShellFailure(error);
    failedAppRoots.push({ appRoot, code: failure.code, reason: failure.reason });
  };

  for (const root of listing.roots) {
    try {
      const prune = await root.pruneIfMissing();
      if (prune.pruned) {
        mutation = mergeIslandMutationFacts(mutation, { registryChanged: prune.changed });
        if (prune.quarantinePath !== undefined) {
          listing.quarantinedRecords.push(prune.quarantinePath);
        }
        continue;
      }
      const result = await restoreIslandShell({
        appRoot: root.appRoot,
        registryHome: options?.registryHome,
      });
      mutation = mergeIslandMutationFacts(mutation, result);
      restoredAppRoots.push(root.appRoot);
    } catch (error) {
      recordFailure(root.appRoot, error);
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

export async function readIslandShellStatus(
  options: {
    appRoot: string;
  } & IslandShellEnvironment
): Promise<IslandShellStatus> {
  const appRoot = await canonicalizeAppRoot(options.appRoot);
  let registration: ManagedRootRegistration;

  try {
    registration = await readManagedAppRootRegistration(appRoot, options);
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    return uninspectedStatus(appRoot, 'unreadable', 'permission-denied', [
      'Tyrian could not read its desired-state record for this VS Code installation due to permissions.',
    ]);
  }

  try {
    if (await isAppRootMissing(appRoot)) {
      return uninspectedStatus(appRoot, registration, 'missing', [
        'Tyrian could not find this VS Code installation.',
      ]);
    }
    return (await inspectIslandRoot(appRoot, registration)).status;
  } catch (error) {
    if (isPermissionError(error)) {
      return uninspectedStatus(appRoot, registration, 'permission-denied', [
        'Tyrian could not read the VS Code installation files due to permissions.',
      ]);
    }
    if (error instanceof IslandShellFailure && error.code === 'unsupported') {
      return uninspectedStatus(appRoot, registration, 'unsupported-layout', [error.message]);
    }
    throw error;
  }
}

/** A root whose app files could not be inspected. */
function uninspectedStatus(
  appRoot: string,
  registration: ManagedRootRegistration | 'unreadable',
  classification: 'missing' | 'permission-denied' | 'unsupported-layout',
  issues: string[]
): IslandShellStatus {
  return {
    appRoot,
    desired: desiredStateOf(registration),
    active: undefined,
    managed: undefined,
    classification,
    verificationPassed: false,
    restorePlan: 'unknown',
    workbenchChecksum: undefined,
    productWorkbenchChecksum: undefined,
    receipt: undefined,
    issues,
  };
}

/** Doctor inventory: preferred and registered roots, with unreadable registry data as diagnostics. */
export async function readIslandShellInventory(
  options?: {
    preferredAppRoots?: string[];
  } & IslandShellEnvironment
): Promise<IslandShellInventory> {
  const listing = await listIslandDoctorRoots(options);
  const statuses: IslandShellStatus[] = [];
  for (const appRoot of listing.appRoots) {
    statuses.push(await readIslandShellStatus({ appRoot, registryHome: options?.registryHome }));
  }
  return { statuses, registryDiagnostics: listing.registryDiagnostics };
}
