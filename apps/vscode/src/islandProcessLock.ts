import {
  IslandLockActionReleaseError,
  withIslandProcessLockCore,
} from './islandProcessLockCore.js';

export { IslandLockActionReleaseError };

export function withIslandProcessLock<T>(claimPath: string, action: () => Promise<T>): Promise<T> {
  return withIslandProcessLockCore(claimPath, action, {
    onReleaseWarning: (warning) => {
      process.emitWarning(warning.message, { code: 'TYRIAN_LOCK_RELEASE' });
    },
  });
}
