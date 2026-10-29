import {
  type IslandMutationFacts,
  type IslandMutationResult,
  IslandMutationError,
  islandErrorGraph,
  readIslandMutationFacts,
} from './islandMutationFacts.js';
import type { RestorePlan } from './islandPatchPlan.js';

export type IslandShellStatus = {
  appRoot: string;
  /** The desired style, `null` when disabled, `undefined` without a valid record. */
  desiredCssFile: string | null | undefined;
  registrationState: 'absent' | 'valid' | 'corrupt' | 'unreadable';
  active: boolean;
  managed: boolean;
  classification:
    | 'clean'
    | 'patched'
    | 'managed-only'
    | 'missing'
    | 'permission-denied'
    | 'unsupported-layout'
    | 'broken-backup'
    | 'checksum-mismatch';
  verificationPassed: boolean;
  /** What Restore Classic UI would do to this root now; unknown when its files could not be read. */
  restorePlan: RestorePlan['kind'] | 'unknown';
  workbenchChecksum: string | undefined;
  productWorkbenchChecksum: string | undefined;
  receipt:
    | {
        installedAt: string;
        desiredCssFile: string;
        themeVersion: string;
        upstreamWorkbenchChecksum: string;
        patchedWorkbenchChecksum: string;
        cssChecksum: string;
      }
    | undefined;
  issues: string[];
};

export type IslandShellResult = IslandMutationResult & {
  active: boolean;
  status: IslandShellStatus;
};

export type IslandShellFailureCode = 'permission-required' | 'unsupported' | 'corrupt' | 'blocked';

export class IslandShellFailure extends IslandMutationError {
  readonly code: IslandShellFailureCode;

  constructor(
    code: IslandShellFailureCode,
    message: string,
    options?: ErrorOptions & { mutation?: Partial<IslandMutationFacts> }
  ) {
    super(message, options?.mutation ?? {}, options);
    this.name = 'IslandShellFailure';
    this.code = code;
  }
}

/** The one refusal for a desired-state record Tyrian cannot interpret. */
export function corruptDesiredStateFailure(): IslandShellFailure {
  return new IslandShellFailure(
    'corrupt',
    'Island UI desired-state record is corrupt. Run Restore Classic UI to replace it before changing Island UI.'
  );
}

/** A root transition failed; carries the status observed after the failure, when readable. */
export class IslandShellTransitionFailure extends Error {
  readonly status: IslandShellStatus | undefined;

  constructor(error: unknown, status: IslandShellStatus | undefined) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = 'IslandShellTransitionFailure';
    this.status = status;
  }
}

export class IslandPartialMutationError extends IslandMutationError {
  constructor(message: string, mutation: Partial<IslandMutationFacts>, options?: ErrorOptions) {
    super(message, mutation, options);
    this.name = 'IslandPartialMutationError';
  }
}

export type IslandShellFailureDescription = IslandMutationResult & {
  code: IslandShellFailureCode;
  reason: string;
  causes: Array<{ code: IslandShellFailureCode; reason: string }>;
};

export function describeIslandShellFailure(error: unknown): IslandShellFailureDescription {
  const causes = collectIslandFailureCauses(error);
  const reason =
    causes.map((cause) => cause.reason).join(' | ') ||
    (error instanceof Error ? error.message : String(error));

  return { code: failureCodeOf(error), ...readIslandMutationFacts(error), reason, causes };
}

/** The result kind a failure reports: a corrupt record blocks like any other refusal. */
export function islandFailureResultKind(
  code: IslandShellFailureCode
): 'permission-required' | 'unsupported' | 'blocked' {
  return code === 'corrupt' ? 'blocked' : code;
}

export function readIslandShellFailureStatus(error: unknown): IslandShellStatus | undefined {
  return findNestedError(error, (candidate) =>
    candidate instanceof IslandShellTransitionFailure ? candidate.status : undefined
  );
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
      kind: 'unsupported' | 'blocked';
      appRoot: string;
      status: IslandShellStatus | undefined;
      writeAccess: IslandShellWriteAccess | undefined;
      reason: string;
    };

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export function isFileNotFoundError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT';
}

export function isPermissionError(error: unknown): boolean {
  return isNodeError(error) && (error.code === 'EACCES' || error.code === 'EPERM');
}

function hasChildErrors(candidate: unknown): boolean {
  return (
    (candidate instanceof AggregateError && candidate.errors.length > 0) ||
    (candidate instanceof Error && candidate.cause !== undefined)
  );
}

/**
 * The code of a failure and everything it wraps: the first typed failure's code;
 * otherwise permission-required only when every leaf cause is a permission error.
 */
function failureCodeOf(error: unknown): IslandShellFailureCode {
  const typedFailure = findNestedError(error, (candidate) =>
    candidate instanceof IslandShellFailure ? candidate : undefined
  );
  if (typedFailure !== undefined) return typedFailure.code;
  const leaves = [...islandErrorGraph(error)].filter((candidate) => !hasChildErrors(candidate));
  return leaves.length > 0 && leaves.every(isPermissionError) ? 'permission-required' : 'blocked';
}

function findNestedError<T>(
  error: unknown,
  select: (candidate: unknown) => T | undefined
): T | undefined {
  for (const candidate of islandErrorGraph(error)) {
    const selected = select(candidate);
    if (selected !== undefined) return selected;
  }
  return undefined;
}

function collectIslandFailureCauses(
  error: unknown
): Array<{ code: IslandShellFailureCode; reason: string }> {
  const causes: Array<{ code: IslandShellFailureCode; reason: string }> = [];
  const seen = new Set<string>();

  for (const candidate of islandErrorGraph(error)) {
    if (causes.length >= 8) break;
    const hasChildren = hasChildErrors(candidate);

    if (!(candidate instanceof Error)) {
      const reason = String(candidate);
      if (!seen.has(reason)) {
        causes.push({ code: 'blocked', reason });
        seen.add(reason);
      }
      continue;
    }

    const ownsActionableContext =
      candidate instanceof IslandShellFailure ||
      candidate instanceof IslandPartialMutationError ||
      !hasChildren;
    if (!ownsActionableContext || seen.has(candidate.message)) continue;

    causes.push({ code: failureCodeOf(candidate), reason: candidate.message });
    seen.add(candidate.message);
  }

  return causes;
}
