import type { parseArgs } from 'node:util';

import type {
  IslandUiApplySupervisionResult,
  IslandUiConvergeResult,
  IslandUiRestoreSupervisionResult,
  IslandUiSupervisorInventory,
} from './islandSupervisor.js';

/**
 * The Island CLI commands and the JSON each writes to stdout on success. The
 * extension only spawns the CLI bundled in the same build, so this map and the
 * options below are the whole wire contract; failures write an `IslandShellFailureDescription` line
 * to stderr and exit nonzero.
 */
export type IslandCliResults = {
  'apply-supervised': IslandUiApplySupervisionResult;
  converge: IslandUiConvergeResult;
  'restore-supervised': IslandUiRestoreSupervisionResult;
  'status-all-supervised': IslandUiSupervisorInventory;
};

export type IslandCliCommand = keyof IslandCliResults;

/** The CLI options: the extension encodes them and the CLI parses them strictly. */
export const ISLAND_CLI_OPTIONS = {
  'app-root': { type: 'string' },
  'css-source': { type: 'string' },
  'fallback-css': { type: 'string' },
  'island-dir': { type: 'string' },
  repair: { type: 'boolean' },
  'theme-version': { type: 'string' },
} as const;

export type IslandCliArgs = ReturnType<
  typeof parseArgs<{ options: typeof ISLAND_CLI_OPTIONS }>
>['values'];

export function encodeIslandCliArgs(args: IslandCliArgs): string[] {
  return Object.entries(args).flatMap(([name, value]) =>
    value === undefined || value === false
      ? []
      : value === true
        ? [`--${name}`]
        : [`--${name}`, value]
  );
}
