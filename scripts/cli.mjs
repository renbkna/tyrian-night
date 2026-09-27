// @ts-check

import fs from 'node:fs';

/**
 * Whether the module that owns `meta` is the process entry point. Both sides
 * are compared as physical paths: Node resolves the entry module through
 * symbolic links, while `argv[1]` keeps the path the caller typed.
 *
 * @param {ImportMeta} meta
 * @returns {boolean}
 */
export function isDirectRun(meta) {
  const entry = process.argv[1];
  return entry !== undefined && fs.realpathSync(entry) === fs.realpathSync(meta.filename);
}
