import { restoreAllIslandShells } from './islandShell.js';

async function cleanup(): Promise<void> {
  await restoreAllIslandShells();
}

try {
  await cleanup();
} catch (error) {
  console.error('Error during Tyrian Night cleanup:', error);
}
