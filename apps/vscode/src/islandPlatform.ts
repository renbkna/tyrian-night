export type IslandPlatformSupport = { supported: true } | { supported: false; reason: string };

const ISLAND_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(['linux', 'darwin', 'win32']);

/**
 * Island UI patches the desktop VS Code builds: Linux, macOS, and Windows.
 * The patch uses only atomic renames; each platform's CLI lock is chosen in
 * islandLock.ts.
 */
export function readIslandPlatformSupport(): IslandPlatformSupport {
  if (!ISLAND_PLATFORMS.has(process.platform)) {
    return {
      supported: false,
      reason: `Island UI is unsupported on '${process.platform}'. Tyrian patches VS Code on Linux, macOS, and Windows.`,
    };
  }
  return { supported: true };
}
