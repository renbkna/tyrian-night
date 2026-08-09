// @ts-check

import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const WALLPAPER_ASSET_PATH = 'assets/wallpaper-tyrian.png';
export const FASTFETCH_IMAGE_ASSET_PATH = 'assets/tyrian-fetch.webp';
export const TYRIAN_INSTALL_HOME = '.local/share/tyrian-night';
export const TYRIAN_STATE_HOME = '.local/state/tyrian-night';
export const TYRIAN_BACKUP_HOME = `${TYRIAN_STATE_HOME}/backups`;
export const FASTFETCH_IMAGE_CONFIG_PATH = `~/${TYRIAN_INSTALL_HOME}/assets/tyrian-fetch.webp`;

/**
 * @param {string} userHome
 * @param {string} operation
 * @returns {string}
 */
export function buildTyrianBackupRoot(userHome, operation) {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');

  return path.join(
    userHome,
    TYRIAN_BACKUP_HOME,
    `${operation}-${stamp}-${process.pid}-${randomUUID()}`
  );
}
