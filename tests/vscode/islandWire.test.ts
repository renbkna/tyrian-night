import { expect, test } from 'bun:test';

import {
  decodeIslandCliInvocation,
  encodeIslandCliInvocation,
  type IslandCliInvocation,
} from '../../apps/vscode/src/islandWire.js';

test('every command input survives the CLI wire', () => {
  const invocations: IslandCliInvocation[] = [
    {
      command: 'apply-supervised',
      input: { appRoot: '/app with space', cssSourcePath: '/ext/a.css', themeVersion: '3.1.0' },
    },
    {
      command: 'converge',
      input: {
        appRoot: '/app',
        islandDirectory: '/ext/island',
        themeVersion: '3.1.0',
        intent: { kind: 'startup' },
      },
    },
    {
      command: 'converge',
      input: {
        appRoot: '/app',
        islandDirectory: '/ext/island',
        themeVersion: '3.1.0',
        intent: { kind: 'repair', fallbackCssFile: 'tyrian-abyss.css' },
      },
    },
    {
      command: 'converge',
      input: {
        appRoot: '/app',
        islandDirectory: '/ext/island',
        themeVersion: '3.1.0',
        intent: { kind: 'repair', fallbackCssFile: undefined },
      },
    },
    { command: 'restore-supervised', input: { preferredAppRoots: ['/a', '/b'] } },
    { command: 'status-all-supervised', input: { preferredAppRoots: [] } },
  ];

  for (const invocation of invocations) {
    expect(
      decodeIslandCliInvocation(encodeIslandCliInvocation(invocation.command, invocation.input))
    ).toEqual(invocation);
  }
});

test('the CLI rejects options another command owns and incomplete inputs', () => {
  expect(() =>
    decodeIslandCliInvocation(['restore-supervised', '--css-source', '/ext/a.css'])
  ).toThrow("Unknown option '--css-source'");
  expect(() => decodeIslandCliInvocation(['apply-supervised', '--app-root', '/app'])).toThrow(
    "Missing required argument '--css-source'."
  );
  expect(() =>
    decodeIslandCliInvocation([
      'converge',
      '--app-root',
      '/app',
      '--island-dir',
      '/ext/island',
      '--theme-version',
      '3.1.0',
      '--fallback-css',
      'tyrian-abyss.css',
    ])
  ).toThrow("Argument '--fallback-css' requires '--repair'.");
  expect(() => decodeIslandCliInvocation(['status-all-supervised', 'extra'])).toThrow(
    "Unexpected argument 'extra'"
  );
  expect(() => decodeIslandCliInvocation(['restore-supervised', '--app-root', ''])).toThrow(
    "Argument '--app-root' must not be empty."
  );
  expect(() => decodeIslandCliInvocation(['patch'])).toThrow('Unknown Tyrian Night CLI command');
});
