import type {
  IslandUiApplySupervisionResult,
  IslandUiConvergeResult,
  IslandUiRestoreSupervisionResult,
  IslandUiSupervisorInventory,
} from './islandSupervisor.js';

/**
 * The Island CLI commands and the JSON each writes to stdout on success. The
 * extension only spawns the CLI bundled in the same build, so this map is the
 * whole wire contract; failures write an `IslandShellFailureDescription` line
 * to stderr and exit nonzero.
 */
export type IslandCliResults = {
  'apply-supervised': IslandUiApplySupervisionResult;
  converge: IslandUiConvergeResult;
  'restore-supervised': IslandUiRestoreSupervisionResult;
  'status-all-supervised': IslandUiSupervisorInventory;
};

export type IslandCliCommand = keyof IslandCliResults;
