import {
  IslandLockActionReleaseError,
  IslandLockReleaseError,
  isIslandLockLifecycleFailure,
  withIslandProcessLockCore,
} from './islandProcessLockCore.js';

export { IslandLockActionReleaseError, IslandLockReleaseError, isIslandLockLifecycleFailure };

export function withIslandProcessLock<T>(claimPath: string, action: () => Promise<T>): Promise<T> {
  return withIslandProcessLockCore(claimPath, action, {
    onReleaseWarning: (warning) => {
      process.emitWarning(warning.message, { code: 'TYRIAN_LOCK_RELEASE' });
    },
  });
}
