import { spawnSync } from 'node:child_process';

export const ISLAND_APPLY_SUPPORTED_PLATFORMS = ['linux'] as const;

export type IslandApplyPlatformSupport =
  | { supported: true; platform: 'linux' }
  | { supported: false; platform: NodeJS.Platform; reason: string };

/** The journal protocol selected by the Island platform capability owner. */
export type IslandFileTransactionProtocol = 'v4' | 'v5';

export function readIslandApplyPlatformSupport(
  platform: NodeJS.Platform = process.platform
): IslandApplyPlatformSupport {
  if ((ISLAND_APPLY_SUPPORTED_PLATFORMS as readonly NodeJS.Platform[]).includes(platform)) {
    return { supported: true, platform: platform as 'linux' };
  }

  return {
    supported: false,
    platform,
    reason: `Island UI apply is unsupported on '${platform}'. Tyrian only patches VS Code on Linux because its durable file transaction is proved there. Doctor and Classic UI restore remain available for current managed installations.`,
  };
}

let atomicExchangeAvailable: boolean | undefined;

/**
 * Apply and Repair replace existing VS Code files only through Linux renameat2
 * exchange, exposed by current GNU mv. A plain rename leaves an observable
 * missing file between retirement and publication, so it is not acceptable for
 * those mutations.
 */
export function assertIslandAtomicExchangeAvailable(
  platform: NodeJS.Platform = process.platform
): void {
  const platformSupport = readIslandApplyPlatformSupport(platform);
  if (!platformSupport.supported) throw new Error(platformSupport.reason);

  if (!readIslandAtomicExchangeAvailable()) {
    throw new Error(
      'Island atomic file publication requires GNU mv with --exchange and --no-copy.'
    );
  }
}

/**
 * Choose the one journal protocol allowed for an operation. Apply and Repair
 * always require v5 exchange; Classic Restore uses recoverable v4 only when
 * Linux cannot provide exchange, or on its existing portable platforms.
 */
export function selectIslandFileTransactionProtocol(
  operation: 'apply' | 'restore',
  platform: NodeJS.Platform = process.platform
): IslandFileTransactionProtocol {
  if (operation === 'apply') {
    assertIslandAtomicExchangeAvailable(platform);
    return 'v5';
  }

  return platform === 'linux' && readIslandAtomicExchangeAvailable() ? 'v5' : 'v4';
}

function readIslandAtomicExchangeAvailable(): boolean {
  if (atomicExchangeAvailable === undefined) {
    const help = spawnSync('mv', ['--help'], { encoding: 'utf8' });
    atomicExchangeAvailable =
      help.status === 0 &&
      String(help.stdout).includes('--exchange') &&
      String(help.stdout).includes('--no-copy') &&
      String(help.stdout).includes('--no-target-directory');
  }
  return atomicExchangeAvailable;
}

/**
 * Exchange two names through already-admitted parent directory descriptors.
 * Passing /proc/self/fd paths keeps the operation attached to the namespace
 * that Island admitted, even if a visible ancestor is swapped concurrently.
 */
export function exchangeIslandPaths(options: {
  sourceParentDescriptor: number;
  sourceLeaf: string;
  targetParentDescriptor: number;
  targetLeaf: string;
}): void {
  assertIslandAtomicExchangeAvailable();
  assertExchangeLeaf(options.sourceLeaf);
  assertExchangeLeaf(options.targetLeaf);

  const result = spawnSync(
    'mv',
    [
      '--exchange',
      '--no-copy',
      '--no-target-directory',
      `/proc/self/fd/3/${options.sourceLeaf}`,
      `/proc/self/fd/4/${options.targetLeaf}`,
    ],
    {
      encoding: 'utf8',
      stdio: [
        'ignore',
        'pipe',
        'pipe',
        options.sourceParentDescriptor,
        options.targetParentDescriptor,
      ],
    }
  );

  if (result.status !== 0) {
    const detail = result.error?.message ?? String(result.stderr).trim();
    throw new Error(`Island atomic app-file publication failed: ${detail || 'mv exited nonzero'}`);
  }
}

function assertExchangeLeaf(leaf: string): void {
  if (leaf.length === 0 || leaf === '.' || leaf === '..' || leaf.includes('/')) {
    throw new Error(`Island atomic exchange received an invalid file name '${leaf}'.`);
  }
}
