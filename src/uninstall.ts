import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function getSettingsPath(): string {
  const platform = os.platform();
  const homeDir = os.homedir();

  switch (platform) {
    case 'win32':
      return path.join(
        process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'),
        'Code',
        'User',
        'settings.json'
      );
    case 'darwin':
      return path.join(homeDir, 'Library', 'Application Support', 'Code', 'User', 'settings.json');
    default:
      return path.join(homeDir, '.config', 'Code', 'User', 'settings.json');
  }
}

async function cleanup(): Promise<void> {
  const settingsPath = getSettingsPath();

  if (!fs.existsSync(settingsPath)) {
    return;
  }

  try {
    const content = fs.readFileSync(settingsPath, 'utf8');

    // Safe string manipulation to remove tyrian-night.css from the imports list
    // This avoids failing on VS Code settings.json files with comments or trailing commas
    if (content.includes('tyrian-night.css')) {
      const lines = content.split('\n');
      const filtered = lines.filter((line: string) => !line.includes('tyrian-night.css'));

      if (filtered.length !== lines.length) {
        fs.writeFileSync(settingsPath, filtered.join('\n'));
        console.log('Successfully removed Tyrian Night CSS from Custom UI Style imports.');
      }
    }
  } catch (error) {
    console.error('Error during Tyrian Night cleanup:', error);
  }
}

try {
  await cleanup();
} catch (error) {
  console.error(error);
}
