import { expect, test } from 'bun:test';

import {
  IslandProcessFailure,
  parseIslandProcessFailure,
  runIslandJsonProcess,
} from '../../apps/vscode/src/islandProcess.js';
import type { IslandShellFailureDescription } from '../../apps/vscode/src/islandShellContract.js';

const failure: IslandShellFailureDescription = {
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

test('Island CLI failures preserve semantic code and mutation facts', () => {
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

test('non-Island process failures retain their plain diagnostic', async () => {
  expect(parseIslandProcessFailure('plain failure\n')).toBeUndefined();
  await expect(
    runIslandJsonProcess([process.execPath, '-e', 'console.error("plain crash"); process.exit(3)'])
  ).rejects.toThrow('plain crash');
});

test('a nonzero exit with an envelope rejects with the typed failure', async () => {
  const script = `process.stderr.write(${JSON.stringify(`${JSON.stringify(failure)}\n`)}); process.exit(1)`;

  await expect(runIslandJsonProcess([process.execPath, '-e', script])).rejects.toBeInstanceOf(
    IslandProcessFailure
  );
});

test('successful non-JSON output is reported as invalid CLI output', async () => {
  await expect(
    runIslandJsonProcess([process.execPath, '-e', 'console.log("not json")'])
  ).rejects.toThrow('Tyrian Night CLI returned invalid output');
});
