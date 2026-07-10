import { expect, test } from 'bun:test';

import { IslandProcessFailure, parseIslandProcessFailure } from '../apps/vscode/src/islandProcess';

test('Island CLI failures preserve semantic code and mutation facts', () => {
  const failure = {
    version: 1,
    code: 'permission-required',
    changed: true,
    reason: 'registry publication changed before permission failure',
  };
  const error = parseIslandProcessFailure(`warning before envelope\n${JSON.stringify(failure)}\n`);

  expect(error).toBeInstanceOf(IslandProcessFailure);
  expect(error).toMatchObject({
    code: 'permission-required',
    changed: true,
    message: failure.reason,
  });
});

test('non-Island process failures retain their plain diagnostic', () => {
  expect(parseIslandProcessFailure('plain failure\n')).toBeUndefined();
});
