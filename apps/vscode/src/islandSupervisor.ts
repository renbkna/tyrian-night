import {
  applyIslandShell,
  describeIslandShellFailure,
  readAllIslandShellStatusesWithDiagnostics,
  readIslandShellApplyReadiness,
  readIslandShellFailureStatus,
  readIslandShellStatus,
  readIslandShellWriteAccess,
  restoreAllIslandShells,
  type IslandMutationResult,
  type IslandShellCleanupSummary,
  type IslandShellStatus,
  type IslandShellInventory,
  type IslandShellWriteAccess,
} from './islandShell.js';
import { isIslandLockLifecycleFailure } from './islandProcessLock.js';
import { islandMutationFacts } from './islandSupervisorCore.js';
import type { IslandUiRecommendedAction, IslandUiWriteAccessInspection } from './islandWire.js';

export type { IslandUiRecommendedAction } from './islandWire.js';

export type IslandUiApplySupervisionResult =
  | (IslandMutationResult & {
      kind: 'applied';
      status: IslandShellStatus;
    })
  | (IslandMutationResult & {
      kind: 'already-current';
      status: IslandShellStatus;
    })
  | (IslandMutationResult & {
      kind: 'permission-required';
      status: IslandShellStatus;
      writeAccess: IslandShellWriteAccess;
      reason: string;
    })
  | (IslandMutationResult & {
      kind: 'unsupported';
      status: IslandShellStatus | undefined;
      reason: string;
    })
  | (IslandMutationResult & {
      kind: 'blocked';
      status: IslandShellStatus | undefined;
      reason: string;
    });

export type IslandUiRestoreSupervisionResult =
  | (IslandShellCleanupSummary & {
      kind: 'restored' | 'already-classic';
    })
  | (IslandShellCleanupSummary & {
      kind: 'permission-required';
      reason: string;
    })
  | (IslandShellCleanupSummary & {
      kind: 'blocked';
      reason: string;
    });

export type IslandUiSupervisorStatus = IslandShellStatus & {
  accessInspection: IslandUiWriteAccessInspection;
  recommendedAction: IslandUiRecommendedAction;
};

export async function applyIslandUiSupervised(options: {
  appRoot: string;
  cssSourcePath: string;
  themeVersion: string;
  registryHome?: string;
}): Promise<IslandUiApplySupervisionResult> {
  const readiness = await readIslandShellApplyReadiness(options);
  const noMutation = islandMutationFacts();

  if (readiness.kind === 'permission-required') {
    return {
      kind: 'permission-required',
      ...noMutation,
      status: readiness.status,
      writeAccess: readiness.writeAccess,
      reason: readiness.reason,
    };
  }

  if (readiness.kind === 'unsupported' || readiness.kind === 'blocked') {
    const transaction = readiness.status?.transaction;
    return {
      kind: readiness.kind,
      ...islandMutationFacts({
        externalDrift: transaction?.kind === 'external-drift',
        incompleteRecovery:
          transaction?.kind === 'corrupt' ||
          transaction?.kind === 'external-drift' ||
          transaction?.kind === 'unavailable',
      }),
      status: readiness.status,
      reason: readiness.reason,
    };
  }

  try {
    const result = await applyIslandShell(options);

    return {
      kind: result.changed ? 'applied' : 'already-current',
      ...result,
      status: result.status,
    } as IslandUiApplySupervisionResult;
  } catch (error) {
    if (isIslandLockLifecycleFailure(error)) throw error;
    const failure = describeIslandShellFailure(error);
    const failureStatus = readIslandShellFailureStatus(error) ?? readiness.status;

    if (failure.code === 'permission-required') {
      const status = failureStatus ?? (await readIslandShellStatus(options));
      const writeAccess = readiness.writeAccess ?? (await readIslandShellWriteAccess(options));

      return {
        kind: 'permission-required',
        ...failure,
        status,
        writeAccess,
        reason: failure.reason,
      };
    }

    if (failure.code === 'unsupported') {
      return {
        kind: 'unsupported',
        ...failure,
        status: failureStatus,
        reason: failure.reason,
      };
    }

    return {
      kind: 'blocked',
      ...failure,
      status: failureStatus,
      reason: failure.reason,
    };
  }
}

export async function restoreIslandUiSupervised(options?: {
  preferredAppRoots?: string[];
  registryHome?: string;
}): Promise<IslandUiRestoreSupervisionResult> {
  const result = await restoreAllIslandShells(options);

  if (result.failedAppRoots.length === 0 && !result.enumerationFailure) {
    return {
      ...result,
      kind: result.changed ? 'restored' : 'already-classic',
    };
  }

  const reason = result.failedAppRoots
    .map(({ appRoot, reason: failureReason }) => `${appRoot}: ${failureReason}`)
    .concat(
      result.enumerationFailure ? [`Registry enumeration: ${result.enumerationFailure.reason}`] : []
    )
    .join('\n');
  const failureCodes = [
    ...result.failedAppRoots.map(({ code }) => code),
    ...(result.enumerationFailure ? [result.enumerationFailure.code] : []),
  ];
  const kind = failureCodes.every((code) => code === 'permission-required')
    ? 'permission-required'
    : 'blocked';

  return {
    ...result,
    kind,
    reason,
  };
}

export type IslandUiSupervisorInventory = {
  statuses: IslandUiSupervisorStatus[];
  registryDiagnostics: Array<{
    reason: string;
    recommendedAction: 'manual-recovery';
  }>;
};

export async function readIslandUiSupervisorStatuses(options?: {
  preferredAppRoots?: string[];
  registryHome?: string;
}): Promise<IslandUiSupervisorInventory> {
  const inventory: IslandShellInventory = await readAllIslandShellStatusesWithDiagnostics(options);
  const supervisorStatuses: IslandUiSupervisorStatus[] = [];

  for (const status of inventory.statuses) {
    let accessInspection: IslandUiWriteAccessInspection;

    try {
      accessInspection = {
        kind: 'available',
        writeAccess: await readIslandShellWriteAccess({
          appRoot: status.appRoot,
          registryHome: options?.registryHome,
        }),
      };
    } catch (error) {
      accessInspection = {
        kind: 'failed',
        reason:
          (error instanceof Error ? error.message : String(error)) ||
          'Unknown Island write-access inspection failure.',
      };
    }

    supervisorStatuses.push(superviseIslandUiStatus(status, accessInspection));
  }

  return {
    statuses: supervisorStatuses,
    registryDiagnostics: inventory.registryDiagnostics.map((reason) => ({
      reason,
      recommendedAction: 'manual-recovery',
    })),
  };
}

export function superviseIslandUiStatus(
  status: IslandShellStatus,
  accessInspection: IslandUiWriteAccessInspection
): IslandUiSupervisorStatus {
  return {
    ...status,
    accessInspection,
    recommendedAction:
      accessInspection.kind === 'failed'
        ? 'manual-recovery'
        : recommendIslandUiAction(status, accessInspection.writeAccess),
  };
}

function recommendIslandUiAction(
  status: IslandShellStatus,
  writeAccess: IslandShellWriteAccess
): IslandUiRecommendedAction {
  if (
    status.transaction.kind === 'corrupt' ||
    status.transaction.kind === 'external-drift' ||
    status.transaction.kind === 'unavailable'
  ) {
    return 'manual-recovery';
  }

  if (status.registrationState === 'unsupported') return 'manual-recovery';
  if (status.classification === 'missing') return status.registered ? 'prune-missing' : 'none';
  if (status.registrationState === 'corrupt') return 'restore';

  const desired = typeof status.desiredThemeId === 'string';
  if (status.classification === 'permission-denied' || !writeAccess.writable) {
    return desired || status.managed || status.active || status.registered
      ? 'fix-permissions'
      : 'none';
  }

  if (desired) {
    if (status.classification === 'patched') return 'none';
    if (
      status.classification === 'broken-backup' ||
      status.classification === 'checksum-mismatch' ||
      status.classification === 'transaction-pending'
    ) {
      return 'repair';
    }
    return 'apply';
  }

  return status.managed || status.active || status.classification === 'transaction-pending'
    ? 'restore'
    : 'none';
}
