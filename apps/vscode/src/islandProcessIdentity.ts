export type CallerOwnership = {
  callerGid: number;
  callerUid: number;
};

export function readCallerOwnership(options?: {
  callerGid?: number;
  callerUid?: number;
}): CallerOwnership | undefined {
  if (options?.callerUid !== undefined && options.callerGid !== undefined) {
    return {
      callerGid: options.callerGid,
      callerUid: options.callerUid,
    };
  }

  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    return undefined;
  }

  return {
    callerGid: process.getgid(),
    callerUid: process.getuid(),
  };
}

export function buildCallerOwnershipArgs(options?: {
  callerGid?: number;
  callerUid?: number;
}): string[] {
  const ownership = readCallerOwnership(options);

  return ownership
    ? ['--caller-uid', String(ownership.callerUid), '--caller-gid', String(ownership.callerGid)]
    : [];
}
