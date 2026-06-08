import { expect, test } from 'bun:test';

import {
  formatBrokerPathRejection,
  getSecureSystemPathIssue,
  getSecureUnlockTargetIssue,
  getUserRegistryHomeIssue,
} from '../apps/vscode/src/islandPathSecurity';

test('system path security classifies root ownership and writable mode drift', () => {
  expect(getSecureSystemPathIssue({ mode: 0o755, uid: 0 }, 'asset')).toBeUndefined();
  expect(getSecureSystemPathIssue({ mode: 0o755 }, 'asset')).toBeUndefined();
  expect(getSecureSystemPathIssue({ mode: 0o755, uid: 1000 }, 'asset')).toBe(
    'asset: expected root ownership.'
  );
  expect(getSecureSystemPathIssue({ mode: 0o775, uid: 0 }, 'asset')).toBe(
    'asset: path is group/world writable.'
  );
});

test('unlock target security permits only root or caller-owned non-shared paths', () => {
  expect(getSecureUnlockTargetIssue({ mode: 0o644, uid: 0 }, 1000, 'workbench')).toBeUndefined();
  expect(getSecureUnlockTargetIssue({ mode: 0o644, uid: 1000 }, 1000, 'workbench')).toBeUndefined();
  expect(getSecureUnlockTargetIssue({ mode: 0o644, uid: 1001 }, 1000, 'workbench')).toBe(
    'workbench: expected root or caller ownership.'
  );
  expect(getSecureUnlockTargetIssue({ mode: 0o666, uid: 1000 }, 1000, 'workbench')).toBe(
    'workbench: path is group/world writable.'
  );
});

test('registry home security keeps caller ownership and world-write checks shared', () => {
  expect(getUserRegistryHomeIssue({ mode: 0o755, uid: 1000 }, 1000)).toBeUndefined();
  expect(getUserRegistryHomeIssue({ mode: 0o755, uid: 0 }, 1000)).toBe(
    'registry home: expected caller ownership.'
  );
  expect(getUserRegistryHomeIssue({ mode: 0o777, uid: 1000 }, 1000)).toBe(
    'registry home: path is world writable.'
  );
  expect(formatBrokerPathRejection('asset: expected root ownership.')).toBe(
    'Tyrian Night broker rejected asset: expected root ownership.'
  );
});
