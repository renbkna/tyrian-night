import { findInstalledAppRoots, restoreIslandShell } from './islandShell.js';

async function cleanup(): Promise<void> {
  const appRoots = await findInstalledAppRoots();

  for (const appRoot of appRoots) {
    await restoreIslandShell({
      appRoot,
    });
  }
}

try {
  await cleanup();
} catch (error) {
  console.error('Error during Tyrian Night cleanup:', error);
}
