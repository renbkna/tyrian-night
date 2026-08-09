export const ISLAND_APPLY_SUPPORTED_PLATFORMS = ['linux'] as const;

export type IslandApplyPlatformSupport =
  | { supported: true; platform: 'linux' }
  | { supported: false; platform: NodeJS.Platform; reason: string };

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
