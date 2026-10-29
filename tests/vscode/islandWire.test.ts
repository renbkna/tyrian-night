import { parseArgs } from 'node:util';

import { expect, test } from 'bun:test';

import {
  encodeIslandCliArgs,
  ISLAND_CLI_OPTIONS,
  type IslandCliArgs,
} from '../../apps/vscode/src/islandWire.js';

test('encoded CLI arguments parse back to the same values', () => {
  const cases: IslandCliArgs[] = [
    { 'app-root': '/app', 'island-dir': '/ext/island', 'theme-version': '3.1.0' },
    {
      'app-root': '/app with space',
      'island-dir': '/ext/island',
      'theme-version': '3.1.0',
      repair: true,
      'fallback-css': 'tyrian-abyss.css',
    },
  ];

  for (const values of cases) {
    expect(
      parseArgs({ args: encodeIslandCliArgs(values), options: ISLAND_CLI_OPTIONS, strict: true })
        .values
    ).toEqual(values);
  }
});

test('absent and false options are not encoded', () => {
  expect(
    encodeIslandCliArgs({ 'app-root': '/app', repair: false, 'fallback-css': undefined })
  ).toEqual(['--app-root', '/app']);
});
