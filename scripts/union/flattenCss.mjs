// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCAL_IMPORT_RE = /^\s*@import\s+(?:"([^"]+)"|'([^']+)')\s*;\s*$/u;

/**
 * @param {string} entryPath
 * @returns {string}
 */
export function flattenCssFile(entryPath) {
  const resolvedEntryPath = path.resolve(entryPath);

  return flattenCssPath(resolvedEntryPath, findUnionCssRoot(resolvedEntryPath), new Set());
}

/**
 * @param {string} filePath
 * @param {string} rootPath
 * @param {Set<string>} seen
 * @returns {string}
 */
function flattenCssPath(filePath, rootPath, seen) {
  if (seen.has(filePath)) {
    throw new Error(`Union CSS import cycle includes ${filePath}`);
  }

  seen.add(filePath);

  const directory = path.dirname(filePath);
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const flattened = lines.map((line) => {
    const match = LOCAL_IMPORT_RE.exec(line);

    if (match === null) {
      return line;
    }

    const importPath = match[1] ?? match[2];

    if (path.isAbsolute(importPath)) {
      throw new Error(`Union CSS imports must stay inside source/union-css: ${importPath}`);
    }

    if (!importPath.endsWith('.css')) {
      throw new Error(`Union CSS imports must target CSS files: ${importPath}`);
    }

    const resolvedImportPath = path.resolve(directory, importPath);
    assertInsideUnionCssRoot(resolvedImportPath, rootPath, importPath);

    return flattenCssPath(resolvedImportPath, rootPath, seen).trimEnd();
  });

  seen.delete(filePath);

  return flattened.join('\n').replace(/\n{3,}/gu, '\n\n');
}

/**
 * @param {string} entryPath
 * @returns {string}
 */
function findUnionCssRoot(entryPath) {
  let directory = path.dirname(entryPath);

  while (path.basename(directory) !== 'union-css') {
    const parent = path.dirname(directory);

    if (parent === directory) {
      return path.dirname(entryPath);
    }

    directory = parent;
  }

  return directory;
}

/**
 * @param {string} candidatePath
 * @param {string} rootPath
 * @param {string} importPath
 * @returns {void}
 */
function assertInsideUnionCssRoot(candidatePath, rootPath, importPath) {
  if (!isInsidePath(candidatePath, rootPath)) {
    throw new Error(`Union CSS imports must stay inside source/union-css: ${importPath}`);
  }

  if (!isInsidePath(fs.realpathSync.native(candidatePath), fs.realpathSync.native(rootPath))) {
    throw new Error(`Union CSS imports must stay inside source/union-css: ${importPath}`);
  }
}

/**
 * @param {string} candidatePath
 * @param {string} rootPath
 * @returns {boolean}
 */
function isInsidePath(candidatePath, rootPath) {
  const relativePath = path.relative(rootPath, candidatePath);

  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const entryPath = process.argv[2] ?? 'source/union-css/index.css';
  process.stdout.write(flattenCssFile(entryPath));
}
