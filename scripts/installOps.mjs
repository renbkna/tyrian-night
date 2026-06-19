// @ts-check

import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {'copy' | 'link'} ManagedPathMode
 */

/**
 * @param {boolean} apply
 * @param {string} message
 * @param {() => void} action
 * @returns {void}
 */
export function operation(apply, message, action) {
  console.log(`${apply ? 'apply' : 'dry-run'}: ${message}`);

  if (apply) {
    action();
  }
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
export function exists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {ManagedPathMode} mode
 * @param {string} sourcePath
 * @param {string} targetPath
 * @returns {void}
 */
export function installManagedPathRaw(mode, sourcePath, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.rmSync(targetPath, { recursive: true, force: true });

  if (mode === 'link') {
    fs.symlinkSync(sourcePath, targetPath);
    return;
  }

  copyPath(sourcePath, targetPath);
}

/**
 * @param {string} filePath
 * @param {string} content
 * @param {{ finalNewline?: boolean }} [options]
 * @returns {void}
 */
export function writeTextFileRaw(filePath, content, options = {}) {
  const finalContent =
    options.finalNewline === true && !content.endsWith('\n') ? `${content}\n` : content;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, finalContent, 'utf8');
}

/**
 * @param {string} filePath
 * @param {Buffer} content
 * @returns {void}
 */
export function writeBinaryFileRaw(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/**
 * @param {string} sourcePath
 * @param {string} backupRoot
 * @param {string} userHome
 * @returns {string | undefined}
 */
export function backupHomePath(sourcePath, backupRoot, userHome) {
  if (!exists(sourcePath)) {
    return undefined;
  }

  const relativePath = path.relative(userHome, sourcePath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return undefined;
  }

  const backupPath = path.join(backupRoot, 'home', relativePath);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  const stat = fs.lstatSync(sourcePath);

  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(sourcePath), backupPath);
  } else {
    copyPath(sourcePath, backupPath);
  }

  return backupPath;
}

/**
 * @param {string} sourcePath
 * @param {string} targetPath
 * @returns {void}
 */
function copyPath(sourcePath, targetPath) {
  fs.cpSync(sourcePath, targetPath, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}
