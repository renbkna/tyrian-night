import {
  type IslandMutationFacts,
  type IslandMutationResult,
  IslandMutationError,
  islandErrorGraph,
  readIslandMutationFacts,
} from './islandMutationFacts.js';

export type IslandShellStatus = {
  appRoot: string;
  desiredCssFile: string | null | undefined;
  registrationState: 'absent' | 'valid' | 'corrupt';
  active: boolean;
  managed: boolean;
  registered: boolean;
  classification:
    | 'clean'
    | 'patched'
    | 'managed-only'
    | 'missing'
    | 'permission-denied'
    | 'broken-backup'
    | 'checksum-mismatch';
  verificationPassed: boolean;
  restoreProof: 'none' | 'manifest-backup-pair' | 'strip-tyrian-block';
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
  const typedFailure = findNestedError(error, (candidate) =>
    candidate instanceof IslandShellFailure ? candidate : undefined
  );
  const causes = collectIslandFailureCauses(error);
  const reason =
    causes.map((cause) => cause.reason).join(' | ') ||
    (error instanceof Error ? error.message : String(error));
  const code =
    typedFailure?.code ??
    (findNestedError(error, (candidate) =>
      isPermissionError(candidate) ? candidate : undefined
    ) === undefined
      ? 'blocked'
      : 'permission-required');

  return { code, ...readIslandMutationFacts(error), reason, causes };
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
    const hasChildren =
      (candidate instanceof AggregateError && candidate.errors.length > 0) ||
      (candidate instanceof Error && candidate.cause !== undefined);

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
