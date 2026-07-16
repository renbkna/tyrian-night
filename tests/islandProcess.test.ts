import { expect, test } from 'bun:test';

import {
  IslandProcessFailure,
  IslandProcessInvalidOutputError,
  parseIslandProcessFailure,
  runIslandJsonProcess,
} from '../apps/vscode/src/islandProcess';

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

test('successful JSON must satisfy its command-specific runtime validator', async () => {
  const result = runIslandJsonProcess(
    [process.execPath, '-e', `console.log(JSON.stringify({ unexpected: true }))`],
    {
      fallbackMessage: 'process failed',
      invalidOutputMessage: (error) =>
        `invalid success payload: ${error instanceof Error ? error.message : String(error)}`,
      validate: (value) => {
        if (
          typeof value !== 'object' ||
          value === null ||
          !('kind' in value) ||
          value.kind !== 'expected'
        ) {
          throw new Error('missing expected command discriminant');
        }
        return { kind: 'expected' as const };
      },
    }
  );
  await expect(result).rejects.toBeInstanceOf(IslandProcessInvalidOutputError);
  await expect(result).rejects.toThrow(
    'invalid success payload: missing expected command discriminant'
  );
});
