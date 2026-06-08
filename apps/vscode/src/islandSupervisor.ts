import {
  applyIslandShell,
  readAllIslandShellStatuses,
  readIslandShellApplyReadiness,
  readIslandShellStatus,
  readIslandShellWriteAccess,
  restoreAllIslandShells,
  type IslandShellCleanupSummary,
  type IslandShellStatus,
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
      changed: false;
      status: IslandShellStatus | undefined;
      reason: string;
    }
  | {
      kind: 'blocked';
      changed: false;
      status: IslandShellStatus | undefined;
      reason: string;
    };

export type IslandUiRestoreSupervisionResult =
  | (IslandShellCleanupSummary & {
      kind: 'restored' | 'already-classic';
    })
  | {
      kind: 'permission-required';
      changed: boolean;
      restoredAppRoots: string[];
      failedAppRoots: Array<{ appRoot: string; reason: string }>;
      reason: string;
    }
  | {
      kind: 'blocked';
      changed: boolean;
      restoredAppRoots: string[];
      failedAppRoots: Array<{ appRoot: string; reason: string }>;
      reason: string;
    };

export type IslandUiSupervisorStatus = IslandShellStatus & {
  writeAccess: IslandShellWriteAccess | undefined;
  recommendedAction: 'none' | 'apply' | 'restore' | 'elevated-repair' | 'inspect';
};

export async function applyIslandUiSupervised(options: {
  appRoot: string;
  cssSourcePath: string;
  themeVersion: string;
  registryHome?: string;
}): Promise<IslandUiApplySupervisionResult> {
  const readiness = await readIslandShellApplyReadiness(options);

  switch (readiness.kind) {
    case 'permission-required':
      return {
        kind: 'permission-required',
        changed: readiness.changed,
        status: readiness.status,
        writeAccess: readiness.writeAccess,
        reason: readiness.reason,
      };
    case 'unsupported':
      return {
        kind: 'unsupported',
        changed: false,
        status: readiness.status,
        reason: readiness.reason,
      };
    case 'blocked':
      return {
        kind: 'blocked',
        changed: false,
        status: readiness.status,
        reason: readiness.reason,
      };
    case 'ready':
      break;
  }

  if (!readiness.changed) {
    return {
      kind: 'already-current',
      changed: false,
      status: readiness.status,
    };
  }

  try {
    const result = await applyIslandShell(options);
    const status = await readIslandShellStatus(options);

    return {
      kind: result.changed ? 'applied' : 'already-current',
      changed: result.changed,
      status,
    } as IslandUiApplySupervisionResult;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    if (isPermissionMessage(reason)) {
      return {
        kind: 'permission-required',
        changed: true,
        status: readiness.status,
        writeAccess: readiness.writeAccess,
        reason,
      };
    }

    if (isUnsupportedMessage(reason)) {
      return {
        kind: 'unsupported',
        changed: false,
        status: readiness.status,
        reason,
      };
    }

    return {
      kind: 'blocked',
      changed: false,
      status: readiness.status,
      reason,
    };
  }
}

export async function restoreIslandUiSupervised(options?: {
  preferredAppRoots?: string[];
  registryHome?: string;
}): Promise<IslandUiRestoreSupervisionResult> {
  const result = await restoreAllIslandShells(options);

  if (result.failedAppRoots.length === 0) {
    return {
      ...result,
      kind: result.changed ? 'restored' : 'already-classic',
    };
  }

  const reason = result.failedAppRoots
    .map(({ appRoot, reason: failureReason }) => `${appRoot}: ${failureReason}`)
    .join('\n');
  const kind = result.failedAppRoots.some(({ reason: failureReason }) =>
    isPermissionMessage(failureReason)
  )
    ? 'permission-required'
    : 'blocked';

  return {
    ...result,
    kind,
    reason,
  };
}

export async function readIslandUiSupervisorStatuses(options?: {
  preferredAppRoots?: string[];
  registryHome?: string;
}): Promise<IslandUiSupervisorStatus[]> {
  const statuses = await readAllIslandShellStatuses(options);
  const supervisorStatuses: IslandUiSupervisorStatus[] = [];

  for (const status of statuses) {
    let writeAccess: IslandShellWriteAccess | undefined;

    try {
      writeAccess = await readIslandShellWriteAccess({ appRoot: status.appRoot });
    } catch {
      writeAccess = undefined;
    }

    supervisorStatuses.push({
      ...status,
      writeAccess,
      recommendedAction: recommendAction(status, writeAccess),
    });
  }

  return supervisorStatuses;
}

function recommendAction(
  status: IslandShellStatus,
  writeAccess: IslandShellWriteAccess | undefined
): IslandUiSupervisorStatus['recommendedAction'] {
  if (status.classification === 'permission-denied') {
    return 'elevated-repair';
  }

  if (status.classification === 'clean' && writeAccess?.writable === false) {
    return 'elevated-repair';
  }

  if (status.classification === 'broken-backup' || status.classification === 'checksum-mismatch') {
    return writeAccess?.writable === false ? 'elevated-repair' : 'restore';
  }

  if (status.classification === 'managed-only' || status.classification === 'missing') {
    return 'restore';
  }

  return 'none';
}

function isPermissionMessage(message: string): boolean {
  return /EACCES|EPERM|permission/i.test(message);
}

function isUnsupportedMessage(message: string): boolean {
  return message.startsWith('Unsupported ');
}
