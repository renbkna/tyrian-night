import {
  applyIslandShell,
  describeIslandShellFailure,
  readAllIslandShellStatusesWithDiagnostics,
  readIslandShellApplyReadiness,
  readIslandShellFailureStatus,
  readIslandShellStatus,
  readIslandShellWriteAccess,
  restoreAllIslandShells,
  seedIslandDesiredTheme,
  type IslandDesiredSeedResult,
  type IslandShellCleanupSummary,
  type IslandShellStatus,
  type IslandShellInventory,
  type IslandShellWriteAccess,
} from './islandShell.js';

export type IslandUiApplySupervisionResult =
  | {
      kind: 'applied';
      changed: true;
      status: IslandShellStatus;
    }
  | {
      kind: 'already-current';
      changed: false;
      status: IslandShellStatus;
    }
  | {
      kind: 'permission-required';
      changed: boolean;
      status: IslandShellStatus;
      writeAccess: IslandShellWriteAccess;
      reason: string;
    }
  | {
      kind: 'unsupported';
      changed: boolean;
      status: IslandShellStatus | undefined;
      reason: string;
    }
  | {
      kind: 'blocked';
      changed: boolean;
      status: IslandShellStatus | undefined;
      reason: string;
    };

export type IslandUiRestoreSupervisionResult =
  | (IslandShellCleanupSummary & {
      kind: 'restored' | 'already-classic';
    })
  | {
      kind: 'permission-required';
      changed: IslandShellCleanupSummary['changed'];
      restoredAppRoots: IslandShellCleanupSummary['restoredAppRoots'];
      failedAppRoots: IslandShellCleanupSummary['failedAppRoots'];
      quarantinedRecords: IslandShellCleanupSummary['quarantinedRecords'];
      enumerationFailure?: IslandShellCleanupSummary['enumerationFailure'];
      reason: string;
    }
  | {
      kind: 'blocked';
      changed: IslandShellCleanupSummary['changed'];
      restoredAppRoots: IslandShellCleanupSummary['restoredAppRoots'];
      failedAppRoots: IslandShellCleanupSummary['failedAppRoots'];
      quarantinedRecords: IslandShellCleanupSummary['quarantinedRecords'];
      enumerationFailure?: IslandShellCleanupSummary['enumerationFailure'];
      reason: string;
    };

export type IslandUiSupervisorStatus = IslandShellStatus & {
  writeAccess: IslandShellWriteAccess | undefined;
};

export function seedIslandDesiredThemeSupervised(options: {
  appRoot: string;
  desiredThemeId: string;
  registryHome?: string;
}): Promise<IslandDesiredSeedResult> {
  return seedIslandDesiredTheme(options);
}

export async function applyIslandUiSupervised(options: {
  appRoot: string;
  cssSourcePath: string;
  themeVersion: string;
  registryHome?: string;
}): Promise<IslandUiApplySupervisionResult> {
  const readiness = await readIslandShellApplyReadiness(options);

  try {
    const result = await applyIslandShell(options);

    return {
      kind: result.changed ? 'applied' : 'already-current',
      changed: result.changed,
      status: result.status,
    } as IslandUiApplySupervisionResult;
  } catch (error) {
    const failure = describeIslandShellFailure(error);
    const failureStatus = readIslandShellFailureStatus(error) ?? readiness.status;

    if (failure.code === 'permission-required') {
      const status = failureStatus ?? (await readIslandShellStatus(options));
      const writeAccess = readiness.writeAccess ?? (await readIslandShellWriteAccess(options));

      return {
        kind: 'permission-required',
        changed: failure.changed,
        status,
        writeAccess,
        reason: failure.reason,
      };
    }

    if (failure.code === 'unsupported') {
      return {
        kind: 'unsupported',
        changed: failure.changed,
        status: failureStatus,
        reason: failure.reason,
      };
    }

    return {
      kind: 'blocked',
      changed: failure.changed,
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
  registryDiagnostics: string[];
};

export async function readIslandUiSupervisorStatuses(options?: {
  preferredAppRoots?: string[];
  registryHome?: string;
}): Promise<IslandUiSupervisorInventory> {
  const inventory: IslandShellInventory = await readAllIslandShellStatusesWithDiagnostics(options);
  const supervisorStatuses: IslandUiSupervisorStatus[] = [];

  for (const status of inventory.statuses) {
    let writeAccess: IslandShellWriteAccess | undefined;

    try {
      writeAccess = await readIslandShellWriteAccess({
        appRoot: status.appRoot,
        registryHome: options?.registryHome,
      });
    } catch {
      writeAccess = undefined;
    }

    supervisorStatuses.push({
      ...status,
      writeAccess,
    });
  }

  return {
    statuses: supervisorStatuses,
    registryDiagnostics: inventory.registryDiagnostics,
  };
}
