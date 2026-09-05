import { ISLAND_PATCH_STRATEGY } from './islandPatchContract.js';
import {
  type IslandMutationFacts,
  islandMutationFacts,
  readIslandMutationFacts,
  mergeIslandMutationFacts,
} from './islandSupervisorCore.js';

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

export function combineIslandFailureCodes(failures: unknown[]): IslandShellFailureCode {
  const codes = failures.map((failure) => describeIslandShellFailure(failure).code);

  if (codes.every((code) => code === 'permission-required')) return 'permission-required';
  if (codes.includes('corrupt')) return 'corrupt';
  if (codes.includes('blocked')) return 'blocked';
  return 'unsupported';
}

export function isFileNotFoundError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT';
}

export function isAlreadyExistsError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'EEXIST';
}

export function isPermissionError(error: unknown): boolean {
  return isNodeError(error) && (error.code === 'EACCES' || error.code === 'EPERM');
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
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

export function findNestedError<T>(
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
