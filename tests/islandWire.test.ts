import { expect, test } from 'bun:test';

import type { IslandShellStatus } from '../apps/vscode/src/islandShell';
import {
  decodeIslandReconciliationStatus,
  decodeIslandSupervisorInventory,
  projectIslandReconciliationStatus,
  projectIslandSupervisorInventory,
} from '../apps/vscode/src/islandWire';

test('reconciliation projection makes registration relations structural', () => {
  const absent = projectIslandReconciliationStatus(shellStatus());
  const valid = projectIslandReconciliationStatus(
    shellStatus({
      desiredThemeId: null,
      registrationState: 'valid',
      registered: true,
    })
  );
  const unsupported = projectIslandReconciliationStatus(
    shellStatus({ registrationState: 'unsupported', registered: false })
  );

  expect(absent).toEqual({
    version: 2,
    registration: { kind: 'absent' },
    managed: false,
    active: false,
  });
  expect(absent).not.toHaveProperty('registered');
  expect(valid.registration).toEqual({ kind: 'valid', desiredThemeId: null });
  expect(decodeIslandReconciliationStatus(valid)).toEqual(valid);
  expect(unsupported.registration).toEqual({ kind: 'unsupported' });
  expect(decodeIslandReconciliationStatus(unsupported)).toEqual(unsupported);
});

test('reconciliation projection rejects contradictory owner facts', () => {
  expect(() =>
    projectIslandReconciliationStatus(
      shellStatus({ registrationState: 'absent', registered: true })
    )
  ).toThrow('registration facts contradict');
  expect(() =>
    projectIslandReconciliationStatus(
      shellStatus({ registrationState: 'valid', registered: true, desiredThemeId: undefined })
    )
  ).toThrow('missing its desired theme state');
  expect(() =>
    projectIslandReconciliationStatus(
      shellStatus({ registrationState: 'unsupported', registered: true })
    )
  ).toThrow('registration facts contradict');
});

test('reconciliation decoder rejects unversioned, v1, and contradictory payloads', () => {
  expect(() =>
    decodeIslandReconciliationStatus({
      registration: { kind: 'absent' },
      managed: false,
      active: false,
    })
  ).toThrow('Island reconciliation status.version');
  expect(() =>
    decodeIslandReconciliationStatus({
      version: 1,
      registration: { kind: 'absent' },
      managed: false,
      active: false,
    })
  ).toThrow(
    'Unsupported Island reconciliation status protocol version 1; expected current version 2.'
  );
  expect(() =>
    decodeIslandReconciliationStatus({
      version: 2,
      registration: { kind: 'absent', desiredThemeId: 'theme.css' },
      managed: false,
      active: false,
    })
  ).toThrow('Island reconciliation status.registration.desiredThemeId');
  expect(() =>
    decodeIslandReconciliationStatus({
      version: 2,
      registration: { kind: 'legacy' },
      managed: true,
      active: true,
    })
  ).toThrow('Island reconciliation status.registration.kind');
});

test('supervisor inventory wire preserves failed access evidence and owned recommendation', () => {
  const inventory = projectIslandSupervisorInventory({
    statuses: [
      {
        ...shellStatus({
          transaction: {
            kind: 'recoverable',
            recoverability: 'automatic',
            journalPath: '/test-vscode-app-root/.tyrian-island-transaction.json',
            version: 4,
            phase: 'verified',
            reason: 'verified cleanup remains',
          },
        }),
        accessInspection: {
          kind: 'failed',
          reason: 'access path changed generation',
        },
        recommendedAction: 'manual-recovery',
      },
    ],
    registryDiagnostics: [],
  });

  expect(inventory).toMatchObject({
    version: 2,
    statuses: [
      {
        accessInspection: {
          kind: 'failed',
          reason: 'access path changed generation',
        },
        transaction: {
          kind: 'recoverable',
          version: 4,
        },
        recommendedAction: 'manual-recovery',
      },
    ],
  });
  expect(decodeIslandSupervisorInventory(inventory)).toEqual(inventory);
  expect(() => decodeIslandSupervisorInventory({ ...inventory, version: 1 })).toThrow(
    'Unsupported Island supervisor inventory protocol version 1; expected current version 2.'
  );
  expect(() =>
    decodeIslandSupervisorInventory({
      ...inventory,
      statuses: [{ ...inventory.statuses[0], recommendedAction: 'none' }],
    })
  ).toThrow('Island supervisor inventory.statuses[0].recommendedAction');
});

function shellStatus(overrides: Partial<IslandShellStatus> = {}): IslandShellStatus {
  return {
    appRoot: '/test-vscode-app-root',
    desiredThemeId: undefined,
    registrationState: 'absent',
    active: false,
    managed: false,
    registered: false,
    classification: 'clean',
    verificationPassed: true,
    canSelfHeal: false,
    transaction: { kind: 'clean', recoverability: 'none' },
    restoreProof: 'none',
    workbenchChecksum: 'workbench-checksum',
    productWorkbenchChecksum: 'workbench-checksum',
    receipt: undefined,
    issues: [],
    ...overrides,
  };
}
