import { expect, test } from 'bun:test';

import { IslandProcessFailure, parseIslandProcessFailure } from '../apps/vscode/src/islandProcess';

test('Island CLI failures preserve semantic code and mutation facts', () => {
  const failure = {
    version: 1,
    code: 'permission-required',
    changed: true,
    desiredStateChanged: true,
    registryChanged: true,
    physicalChanged: false,
    externalDrift: false,
    incompleteRecovery: true,
    reason: 'registry publication changed before permission failure',
    causes: [
      { code: 'blocked', reason: 'registry publish path' },
      { code: 'permission-required', reason: 'app root permission path' },
    ],
  };
  const error = parseIslandProcessFailure(`warning before envelope\n${JSON.stringify(failure)}\n`);

  expect(error).toBeInstanceOf(IslandProcessFailure);
  expect(error).toMatchObject({
    code: 'permission-required',
    changed: true,
    desiredStateChanged: true,
    registryChanged: true,
    physicalChanged: false,
    externalDrift: false,
    incompleteRecovery: true,
    causes: failure.causes,
    message: failure.reason,
  });
});

test('legacy aggregate-only failure envelopes are rejected instead of inventing typed facts', () => {
  expect(
    parseIslandProcessFailure(
      JSON.stringify({
        version: 1,
        code: 'blocked',
        changed: true,
        reason: 'mutation category is unknown',
      })
    )
  ).toBeUndefined();
});

test('non-Island process failures retain their plain diagnostic', () => {
  expect(parseIslandProcessFailure('plain failure\n')).toBeUndefined();
});
