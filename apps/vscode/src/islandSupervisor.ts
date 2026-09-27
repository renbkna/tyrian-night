import path from 'node:path';

import { isTyrianIslandCssFile } from './generated/themeCatalog.js';
import { type IslandMutationResult, islandMutationFacts } from './islandMutationFacts.js';
import {
  applyIslandShell,
  readIslandShellApplyReadiness,
  readIslandShellInventory,
  readIslandShellStatus,
  readIslandShellWriteAccess,
  restoreAllIslandShells,
  restoreIslandShell,
} from './islandShell.js';
import {
  describeIslandShellFailure,
  IslandShellFailure,
  readIslandShellFailureStatus,
  type IslandShellCleanupSummary,
  type IslandShellResult,
  type IslandShellStatus,
  type IslandShellWriteAccess,
} from './islandShellContract.js';

export type IslandUiApplySupervisionResult = IslandMutationResult &
  (
    | {
        kind: 'applied' | 'already-current';
        status: IslandShellStatus;
      }
    | {
        kind: 'permission-required';
        status: IslandShellStatus;
        writeAccess: IslandShellWriteAccess;
        reason: string;
      }
    | {
        kind: 'unsupported' | 'blocked';
        status: IslandShellStatus | undefined;
        reason: string;
      }
  );

export type IslandUiRestoreSupervisionResult = IslandShellCleanupSummary &
  (
    | { kind: 'restored' | 'already-classic' }
    | { kind: 'permission-required' | 'blocked'; reason: string }
  );

/**
 * What convergence did: applied a style, restored leftover Island files, or
 * found nothing to change.
 */
export type IslandUiConvergeResult =
  | { action: 'apply'; result: IslandUiApplySupervisionResult }
  | { action: 'restore'; result: IslandShellResult }
  | { action: 'none' };

export type IslandUiConvergeIntent =
  /** Reconcile to the desired style; without one, remove leftover Island files. */
  | { kind: 'startup' }
  /** Reapply the desired style; without one, enable `fallbackCssFile` when given. */
  | { kind: 'repair'; fallbackCssFile: string | undefined };

export type IslandUiRecommendedAction =
  | 'none'
  | 'apply'
  | 'repair'
  | 'restore'
  | 'prune-missing'
  | 'fix-permissions'
  | 'manual-recovery';

export type IslandUiSupervisorStatus = IslandShellStatus &
  (
    | {
        accessInspection: { kind: 'available'; writeAccess: IslandShellWriteAccess };
        recommendedAction: IslandUiRecommendedAction;
      }
    | {
        accessInspection: { kind: 'failed'; reason: string };
        recommendedAction: 'manual-recovery';
      }
  );

export type IslandUiWriteAccessInspection = IslandUiSupervisorStatus['accessInspection'];

export type IslandUiSupervisorInventory = {
  statuses: IslandUiSupervisorStatus[];
  registryDiagnostics: Array<{
    reason: string;
    recommendedAction: 'manual-recovery';
  }>;
};

export async function applyIslandUiSupervised(options: {
  appRoot: string;
  cssSourcePath: string;
  themeVersion: string;
  registryHome?: string;
}): Promise<IslandUiApplySupervisionResult> {
  const readiness = await readIslandShellApplyReadiness(options);

  if (readiness.kind === 'permission-required') {
    return {
      kind: 'permission-required',
      ...islandMutationFacts(),
      status: readiness.status,
      writeAccess: readiness.writeAccess,
      reason: readiness.reason,
    };
  }

  if (readiness.kind === 'unsupported' || readiness.kind === 'blocked') {
    return {
      kind: readiness.kind,
      ...islandMutationFacts(),
      status: readiness.status,
      reason: readiness.reason,
    };
  }

  try {
    const result = await applyIslandShell(options);

    return { ...result, kind: result.changed ? 'applied' : 'already-current' };
  } catch (error) {
    const failure = describeIslandShellFailure(error);
    const failureStatus = readIslandShellFailureStatus(error) ?? readiness.status;

    if (failure.code === 'permission-required') {
      return {
        ...failure,
        kind: 'permission-required',
        status: failureStatus ?? (await readIslandShellStatus(options)),
        writeAccess: readiness.writeAccess ?? (await readIslandShellWriteAccess(options)),
      };
    }

    return {
      ...failure,
      kind: failure.code === 'unsupported' ? 'unsupported' : 'blocked',
      status: failureStatus,
    };
  }
}

/**
 * Converge one app root to its desired Island style. The caller holds the
 * Island lock, so the desired state this decision reads is the one it acts on:
 * another window cannot publish a different style in between.
 */
export async function convergeIslandUiSupervised(options: {
  appRoot: string;
  islandDirectory: string;
  themeVersion: string;
  intent: IslandUiConvergeIntent;
  registryHome?: string;
}): Promise<IslandUiConvergeResult> {
  const status = await readIslandShellStatus(options);

  if (status.registrationState === 'corrupt') {
    throw new IslandShellFailure(
      'corrupt',
      'Island UI desired-state record is corrupt. Run Doctor before changing app files.'
    );
  }

  const cssFile =
    typeof status.desiredCssFile === 'string'
      ? status.desiredCssFile
      : options.intent.kind === 'repair'
        ? options.intent.fallbackCssFile
        : undefined;

  if (cssFile !== undefined) {
    if (!isTyrianIslandCssFile(cssFile)) {
      throw new IslandShellFailure(
        'unsupported',
        `Island UI desires unavailable style '${cssFile}'. Install a matching Tyrian Night version or restore Classic UI.`
      );
    }
    return {
      action: 'apply',
      result: await applyIslandUiSupervised({
        appRoot: options.appRoot,
        cssSourcePath: path.join(options.islandDirectory, cssFile),
        themeVersion: options.themeVersion,
        registryHome: options.registryHome,
      }),
    };
  }

  if (options.intent.kind === 'startup' && (status.managed || status.active)) {
    return {
      action: 'restore',
      result: await restoreIslandShell({
        appRoot: options.appRoot,
        registryHome: options.registryHome,
      }),
    };
  }

  return { action: 'none' };
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

  return { ...result, kind, reason };
}

export async function readIslandUiSupervisorStatuses(options?: {
  preferredAppRoots?: string[];
  registryHome?: string;
}): Promise<IslandUiSupervisorInventory> {
  const inventory = await readIslandShellInventory(options);
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
  if (accessInspection.kind === 'failed') {
    return { ...status, accessInspection, recommendedAction: 'manual-recovery' };
  }
  return {
    ...status,
    accessInspection,
    recommendedAction: recommendIslandUiAction(status, accessInspection.writeAccess),
  };
}

function recommendIslandUiAction(
  status: IslandShellStatus,
  writeAccess: IslandShellWriteAccess
): IslandUiRecommendedAction {
  if (status.classification === 'missing') return status.registered ? 'prune-missing' : 'none';
  if (status.registrationState === 'corrupt') return 'restore';

  const desired = typeof status.desiredCssFile === 'string';
  if (status.classification === 'permission-denied' || !writeAccess.writable) {
    return desired || status.managed || status.active || status.registered
      ? 'fix-permissions'
      : 'none';
  }

  if (desired) {
    if (status.classification === 'patched') return 'none';
    if (
      status.classification === 'broken-backup' ||
      status.classification === 'checksum-mismatch'
    ) {
      return 'repair';
    }
    return 'apply';
  }

  return status.managed || status.active ? 'restore' : 'none';
}
