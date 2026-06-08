import { expect, test } from 'bun:test';

import {
  OPEN_DOCTOR_ACTION,
  RESET_FILE_ACCESS_ACTION,
  TRUST_DOCS_ACTION,
  buildWriteAccessActions,
  shouldOfferPackageAccessReset,
} from '../apps/vscode/src/islandExtensionPolicy';
import type { IslandUiSupervisorStatus } from '../apps/vscode/src/islandSupervisor';

test('write-access prompts always include trust docs before secondary actions', () => {
  expect(buildWriteAccessActions('Unlock Write Access')).toEqual([
    'Unlock Write Access',
    TRUST_DOCS_ACTION,
    OPEN_DOCTOR_ACTION,
    'Later',
  ]);
  expect(buildWriteAccessActions(undefined)).toEqual([
    TRUST_DOCS_ACTION,
    OPEN_DOCTOR_ACTION,
    'Later',
  ]);
});

test('package access reset is offered only for writable hash-proven app surfaces', () => {
  expect(shouldOfferPackageAccessReset(fakeStatus({ writable: true }), true, true, true)).toBe(
    true
  );
  expect(shouldOfferPackageAccessReset(fakeStatus({ writable: true }), true, true, false)).toBe(
    false
  );
  expect(shouldOfferPackageAccessReset(fakeStatus({ writable: true }), true, false, true)).toBe(
    false
  );
  expect(shouldOfferPackageAccessReset(fakeStatus({ writable: false }), true, true, true)).toBe(
    false
  );
  expect(shouldOfferPackageAccessReset(fakeStatus({ writable: true }), false, true, true)).toBe(
    false
  );
  expect(
    shouldOfferPackageAccessReset(
      {
        ...fakeStatus({ writable: true }),
        productWorkbenchChecksum: undefined,
      },
      true,
      true,
      true
    )
  ).toBe(false);
});

test('package access reset action name stays explicit about what admin access does', () => {
  expect(RESET_FILE_ACCESS_ACTION).toBe('Reset File Access');
});

function fakeStatus(options: { writable: boolean }): IslandUiSupervisorStatus {
  return {
    appRoot: '/test-vscode-app-root',
    active: false,
    managed: false,
    classification: 'clean',
    verificationPassed: true,
    canSelfHeal: false,
    restoreProof: 'none',
    workbenchChecksum: 'workbench-hash',
    productWorkbenchChecksum: 'product-hash',
    issues: [],
    writeAccess: {
      writable: options.writable,
      checkedPaths: [],
      blockedPaths: [],
      issues: [],
    },
    recommendedAction: 'none',
  };
}
