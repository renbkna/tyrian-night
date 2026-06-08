// @ts-check

import fs from 'node:fs';
import path from 'node:path';

export const TYRIAN_REQUIRED_COMMANDS = [
  'chafa',
  'fastfetch',
  'fish',
  'ghostty',
  'kwriteconfig6',
  'plasma-apply-colorscheme',
  'plasma-apply-desktoptheme',
  'starship',
];

/**
 * @param {string[]} commands
 * @param {boolean} apply
 * @param {(command: string) => boolean} commandExists
 * @param {string} owner
 * @returns {void}
 */
export function checkRequiredCommands(commands, apply, commandExists, owner) {
  const missingCommands = commands.filter((command) => !commandExists(command));

  if (missingCommands.length === 0) {
    return;
  }

  const message = `Missing ${owner} commands: ${missingCommands.join(', ')}\nInstall them first. On CachyOS/Arch: sudo pacman -S --needed ${missingCommands.join(' ')}`;

  if (apply) {
    throw new Error(message);
  }

  console.warn(message);
}

/**
 * @param {string} command
 * @returns {boolean}
 */
export function hasCommand(command) {
  for (const searchDir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!searchDir) {
      continue;
    }

    const candidate = path.join(searchDir, command);

    if (isExecutable(candidate)) {
      return true;
    }
  }

  return false;
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
export function isExecutable(filePath) {
  try {
    const stat = fs.statSync(filePath);

    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
