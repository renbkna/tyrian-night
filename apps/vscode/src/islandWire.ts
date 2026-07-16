import type { IslandShellStatus, IslandShellWriteAccess } from './islandShell.js';

export const ISLAND_WIRE_PROTOCOL_VERSION = 1 as const;

export type IslandUiRecommendedAction =
  | 'none'
  | 'apply'
  | 'repair'
  | 'restore'
  | 'prune-missing'
  | 'fix-permissions'
  | 'manual-recovery';

export type IslandUiWriteAccessInspection =
  | {
      kind: 'available';
      writeAccess: IslandShellWriteAccess;
    }
  | {
      kind: 'failed';
      reason: string;
    };

export type IslandReconciliationStatus = {
  version: typeof ISLAND_WIRE_PROTOCOL_VERSION;
  registration:
    | { kind: 'absent' }
    | { kind: 'valid'; desiredThemeId: string | null }
    | { kind: 'legacy' }
    | { kind: 'corrupt' };
  managed: boolean;
  active: boolean;
};

type IslandDoctorAccessInspection =
  | {
      kind: 'available';
      writable: boolean;
      blockedPaths: Array<{ path: string; reason: string }>;
    }
  | {
      kind: 'failed';
      reason: string;
    };

type IslandDoctorStatusBase = Pick<
  IslandShellStatus,
  | 'appRoot'
  | 'desiredThemeId'
  | 'classification'
  | 'verificationPassed'
  | 'restoreProof'
  | 'transaction'
  | 'workbenchChecksum'
  | 'productWorkbenchChecksum'
  | 'receipt'
  | 'issues'
>;

export type IslandDoctorStatus = IslandDoctorStatusBase &
  (
    | {
        recommendedAction: IslandUiRecommendedAction;
        accessInspection: Extract<IslandDoctorAccessInspection, { kind: 'available' }>;
      }
    | {
        recommendedAction: 'manual-recovery';
        accessInspection: Extract<IslandDoctorAccessInspection, { kind: 'failed' }>;
      }
  );

export type IslandSupervisorInventory = {
  version: typeof ISLAND_WIRE_PROTOCOL_VERSION;
  statuses: IslandDoctorStatus[];
  registryDiagnostics: Array<{
    reason: string;
    recommendedAction: 'manual-recovery';
  }>;
};

type IslandSupervisorInventorySource = {
  statuses: Array<
    IslandShellStatus & {
      accessInspection: IslandUiWriteAccessInspection;
      recommendedAction: IslandUiRecommendedAction;
    }
  >;
  registryDiagnostics: Array<{
    reason: string;
    recommendedAction: 'manual-recovery';
  }>;
};

const SHELL_CLASSIFICATIONS: {
  [Classification in IslandShellStatus['classification']]: Classification;
} = {
  clean: 'clean',
  patched: 'patched',
  'managed-only': 'managed-only',
  'transaction-pending': 'transaction-pending',
  'transaction-blocked': 'transaction-blocked',
  missing: 'missing',
  'permission-denied': 'permission-denied',
  'broken-backup': 'broken-backup',
  'checksum-mismatch': 'checksum-mismatch',
};

const RESTORE_PROOFS: {
  [Proof in IslandShellStatus['restoreProof']]: Proof;
} = {
  none: 'none',
  'manifest-v3-backup-pair': 'manifest-v3-backup-pair',
  'strip-tyrian-block': 'strip-tyrian-block',
};

const RECOMMENDED_ACTIONS: {
  [Action in IslandUiRecommendedAction]: Action;
} = {
  none: 'none',
  apply: 'apply',
  repair: 'repair',
  restore: 'restore',
  'prune-missing': 'prune-missing',
  'fix-permissions': 'fix-permissions',
  'manual-recovery': 'manual-recovery',
};

type IslandTransaction = IslandShellStatus['transaction'];
type RecoverableIslandTransaction = Extract<IslandTransaction, { kind: 'recoverable' }>;

const TRANSACTION_KINDS: {
  [Kind in IslandTransaction['kind']]: Kind;
} = {
  clean: 'clean',
  recoverable: 'recoverable',
  unsupported: 'unsupported',
  corrupt: 'corrupt',
  'external-drift': 'external-drift',
  unavailable: 'unavailable',
};

const RECOVERABLE_TRANSACTION_PHASES: {
  [Phase in RecoverableIslandTransaction['phase']]: Phase;
} = {
  preparing: 'preparing',
  prepared: 'prepared',
  committing: 'committing',
  verified: 'verified',
};

export function projectIslandReconciliationStatus(
  status: IslandShellStatus
): IslandReconciliationStatus {
  const registered = status.registrationState !== 'absent';
  if (status.registered !== registered) {
    throw new Error('Island status registration facts contradict their owner state.');
  }

  let registration: IslandReconciliationStatus['registration'];
  if (status.registrationState === 'valid') {
    if (status.desiredThemeId === undefined) {
      throw new Error('Island valid registration is missing its desired theme state.');
    }
    registration = { kind: 'valid', desiredThemeId: status.desiredThemeId };
  } else {
    if (status.desiredThemeId !== undefined) {
      throw new Error('Island non-valid registration carries an impossible desired theme state.');
    }
    registration = { kind: status.registrationState };
  }

  return {
    version: ISLAND_WIRE_PROTOCOL_VERSION,
    registration,
    managed: status.managed,
    active: status.active,
  };
}

export function decodeIslandReconciliationStatus(value: unknown): IslandReconciliationStatus {
  const field = 'Island reconciliation status';
  const record = requireProtocolRecord(value, field);
  requireProtocolVersion(record.version, field);
  const registrationRecord = requireProtocolRecord(record.registration, `${field}.registration`);
  const kind = requireProtocolDiscriminant(
    registrationRecord.kind,
    { absent: 'absent', valid: 'valid', legacy: 'legacy', corrupt: 'corrupt' },
    `${field}.registration.kind`
  );
  let registration: IslandReconciliationStatus['registration'];
  if (kind === 'valid') {
    if (
      registrationRecord.desiredThemeId !== null &&
      typeof registrationRecord.desiredThemeId !== 'string'
    ) {
      throw invalidProtocolField(`${field}.registration.desiredThemeId`);
    }
    registration = { kind, desiredThemeId: registrationRecord.desiredThemeId };
  } else {
    if ('desiredThemeId' in registrationRecord) {
      throw invalidProtocolField(`${field}.registration.desiredThemeId`);
    }
    registration = { kind };
  }

  return {
    version: ISLAND_WIRE_PROTOCOL_VERSION,
    registration,
    managed: requireProtocolBoolean(record.managed, `${field}.managed`),
    active: requireProtocolBoolean(record.active, `${field}.active`),
  };
}

export function projectIslandSupervisorInventory(
  inventory: IslandSupervisorInventorySource
): IslandSupervisorInventory {
  return {
    version: ISLAND_WIRE_PROTOCOL_VERSION,
    statuses: inventory.statuses.map(projectIslandDoctorStatus),
    registryDiagnostics: inventory.registryDiagnostics,
  };
}

function projectIslandDoctorStatus(
  status: IslandSupervisorInventorySource['statuses'][number]
): IslandDoctorStatus {
  const base: IslandDoctorStatusBase = {
    appRoot: status.appRoot,
    desiredThemeId: status.desiredThemeId,
    classification: status.classification,
    verificationPassed: status.verificationPassed,
    restoreProof: status.restoreProof,
    transaction: status.transaction,
    workbenchChecksum: status.workbenchChecksum,
    productWorkbenchChecksum: status.productWorkbenchChecksum,
    receipt: status.receipt,
    issues: status.issues,
  };
  if (status.accessInspection.kind === 'failed') {
    if (status.recommendedAction !== 'manual-recovery') {
      throw new Error('Failed Island access inspection must require manual recovery.');
    }
    return {
      ...base,
      accessInspection: status.accessInspection,
      recommendedAction: 'manual-recovery',
    };
  }
  return {
    ...base,
    accessInspection: {
      kind: 'available',
      writable: status.accessInspection.writeAccess.writable,
      blockedPaths: status.accessInspection.writeAccess.blockedPaths,
    },
    recommendedAction: status.recommendedAction,
  };
}

export function decodeIslandSupervisorInventory(value: unknown): IslandSupervisorInventory {
  const field = 'Island supervisor inventory';
  const record = requireProtocolRecord(value, field);
  requireProtocolVersion(record.version, field);
  if (!Array.isArray(record.statuses)) throw invalidProtocolField(`${field}.statuses`);
  if (!Array.isArray(record.registryDiagnostics)) {
    throw invalidProtocolField(`${field}.registryDiagnostics`);
  }
  return {
    version: ISLAND_WIRE_PROTOCOL_VERSION,
    statuses: record.statuses.map(validateDoctorStatus),
    registryDiagnostics: record.registryDiagnostics.map((value, index) => {
      const diagnosticField = `${field}.registryDiagnostics[${index}]`;
      const diagnostic = requireProtocolRecord(value, diagnosticField);
      if (diagnostic.recommendedAction !== 'manual-recovery') {
        throw invalidProtocolField(`${diagnosticField}.recommendedAction`);
      }
      return {
        reason: requireProtocolString(diagnostic.reason, `${diagnosticField}.reason`),
        recommendedAction: 'manual-recovery' as const,
      };
    }),
  };
}

function validateDoctorStatus(value: unknown, index: number): IslandDoctorStatus {
  const field = `Island supervisor inventory.statuses[${index}]`;
  const record = requireProtocolRecord(value, field);
  if (
    record.desiredThemeId !== undefined &&
    record.desiredThemeId !== null &&
    typeof record.desiredThemeId !== 'string'
  ) {
    throw invalidProtocolField(`${field}.desiredThemeId`);
  }
  const accessInspection = validateDoctorAccessInspection(
    record.accessInspection,
    `${field}.accessInspection`
  );
  const recommendedAction = requireProtocolDiscriminant(
    record.recommendedAction,
    RECOMMENDED_ACTIONS,
    `${field}.recommendedAction`
  );
  const base: IslandDoctorStatusBase = {
    appRoot: requireProtocolString(record.appRoot, `${field}.appRoot`),
    desiredThemeId: record.desiredThemeId as string | null | undefined,
    classification: requireProtocolDiscriminant(
      record.classification,
      SHELL_CLASSIFICATIONS,
      `${field}.classification`
    ),
    verificationPassed: requireProtocolBoolean(
      record.verificationPassed,
      `${field}.verificationPassed`
    ),
    restoreProof: requireProtocolDiscriminant(
      record.restoreProof,
      RESTORE_PROOFS,
      `${field}.restoreProof`
    ),
    transaction: validateTransaction(record.transaction, `${field}.transaction`),
    workbenchChecksum: validateOptionalString(
      record.workbenchChecksum,
      `${field}.workbenchChecksum`
    ),
    productWorkbenchChecksum: validateOptionalString(
      record.productWorkbenchChecksum,
      `${field}.productWorkbenchChecksum`
    ),
    receipt: validateReceipt(record.receipt, `${field}.receipt`),
    issues: validateStringArray(record.issues, `${field}.issues`),
  };
  if (accessInspection.kind === 'failed') {
    if (recommendedAction !== 'manual-recovery') {
      throw invalidProtocolField(`${field}.recommendedAction`);
    }
    return { ...base, accessInspection, recommendedAction };
  }
  return { ...base, accessInspection, recommendedAction };
}

function validateDoctorAccessInspection(
  value: unknown,
  field: string
): IslandDoctorAccessInspection {
  const record = requireProtocolRecord(value, field);
  const kind = requireProtocolDiscriminant(
    record.kind,
    { available: 'available', failed: 'failed' },
    `${field}.kind`
  );
  if (kind === 'failed') {
    return { kind, reason: requireProtocolString(record.reason, `${field}.reason`) };
  }
  return {
    kind,
    writable: requireProtocolBoolean(record.writable, `${field}.writable`),
    blockedPaths: validateBlockedPaths(record.blockedPaths, `${field}.blockedPaths`),
  };
}

function validateTransaction(value: unknown, field: string): IslandShellStatus['transaction'] {
  const record = requireProtocolRecord(value, field);
  const kind = requireProtocolDiscriminant(record.kind, TRANSACTION_KINDS, `${field}.kind`);

  if (kind === 'clean') {
    if (record.recoverability !== 'none') throw invalidProtocolField(`${field}.recoverability`);
    return { kind, recoverability: 'none' };
  }
  if (kind === 'recoverable') {
    if (record.recoverability !== 'automatic' || (record.version !== 3 && record.version !== 4)) {
      throw invalidProtocolField(field);
    }
    return {
      kind,
      recoverability: 'automatic',
      journalPath: requireProtocolString(record.journalPath, `${field}.journalPath`),
      version: record.version,
      phase: requireProtocolDiscriminant(
        record.phase,
        RECOVERABLE_TRANSACTION_PHASES,
        `${field}.phase`
      ),
      reason: requireProtocolString(record.reason, `${field}.reason`),
    };
  }
  if (kind === 'unsupported') {
    if (record.recoverability !== 'manual' || (record.version !== 1 && record.version !== 2)) {
      throw invalidProtocolField(`${field}.version`);
    }
    return {
      kind,
      recoverability: 'manual',
      journalPath: requireProtocolString(record.journalPath, `${field}.journalPath`),
      version: record.version,
      reason: requireProtocolString(record.reason, `${field}.reason`),
    };
  }
  if (record.recoverability !== 'manual') {
    throw invalidProtocolField(`${field}.recoverability`);
  }
  return {
    kind,
    recoverability: 'manual',
    journalPath: requireProtocolString(record.journalPath, `${field}.journalPath`),
    reason: requireProtocolString(record.reason, `${field}.reason`),
  };
}

function validateReceipt(value: unknown, field: string): IslandShellStatus['receipt'] {
  if (value === undefined) return undefined;
  const record = requireProtocolRecord(value, field);
  if (record.patchStrategy !== 'stylesheet-link-v1') {
    throw invalidProtocolField(`${field}.patchStrategy`);
  }
  return {
    installedAt: requireProtocolString(record.installedAt, `${field}.installedAt`),
    desiredThemeId: requireProtocolString(record.desiredThemeId, `${field}.desiredThemeId`),
    themeVersion: requireProtocolString(record.themeVersion, `${field}.themeVersion`),
    patchStrategy: 'stylesheet-link-v1',
    upstreamWorkbenchChecksum: requireProtocolString(
      record.upstreamWorkbenchChecksum,
      `${field}.upstreamWorkbenchChecksum`
    ),
    patchedWorkbenchChecksum: requireProtocolString(
      record.patchedWorkbenchChecksum,
      `${field}.patchedWorkbenchChecksum`
    ),
    cssChecksum: requireProtocolString(record.cssChecksum, `${field}.cssChecksum`),
  };
}

function validateBlockedPaths(
  value: unknown,
  field: string
): Array<{ path: string; reason: string }> {
  if (!Array.isArray(value)) throw invalidProtocolField(field);
  return value.map((entry, index) => {
    const record = requireProtocolRecord(entry, `${field}[${index}]`);
    return {
      path: requireProtocolString(record.path, `${field}[${index}].path`),
      reason: requireProtocolString(record.reason, `${field}[${index}].reason`),
    };
  });
}

function validateStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw invalidProtocolField(field);
  }
  return value;
}

function validateOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || typeof value === 'string') return value;
  throw invalidProtocolField(field);
}

function requireProtocolVersion(value: unknown, field: string): void {
  if (value !== ISLAND_WIRE_PROTOCOL_VERSION) {
    throw invalidProtocolField(`${field}.version`);
  }
}

function requireProtocolRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidProtocolField(field);
  }
  return value as Record<string, unknown>;
}

function requireProtocolString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw invalidProtocolField(field);
  return value;
}

function requireProtocolBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw invalidProtocolField(field);
  return value;
}

function requireProtocolDiscriminant<Kind extends string>(
  value: unknown,
  kinds: { readonly [Candidate in Kind]: Candidate },
  field: string
): Kind {
  if (typeof value !== 'string' || !Object.hasOwn(kinds, value)) {
    throw invalidProtocolField(field);
  }
  return value as Kind;
}

function invalidProtocolField(field: string): Error {
  return new Error(`Invalid ${field}.`);
}
