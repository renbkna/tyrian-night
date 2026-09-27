// @ts-check

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Loads a typed source data module (`module.exports = <typed value>`). The
 * modules are CommonJS so loading is synchronous and every call reads the
 * current file: the require cache entry is evicted after each load.
 * `bun run check` type-checks the modules against their declared contract
 * types, so callers validate only cross-file relationships and value ranges.
 *
 * Loading runs the module, so this owner admits only a regular file before
 * loading it; a symbolic link or directory never reaches `require`.
 *
 * @param {string} filePath
 * @returns {unknown}
 */
export function loadSourceModule(filePath) {
  const modulePath = path.resolve(filePath);
  if (!fs.lstatSync(modulePath).isFile()) {
    throw new Error(`Source module must be a regular file: ${modulePath}`);
  }
  const resolvedPath = require.resolve(modulePath);
  try {
    return require(resolvedPath);
  } finally {
    delete require.cache[resolvedPath];
  }
}
