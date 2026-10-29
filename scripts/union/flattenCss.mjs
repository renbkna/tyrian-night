// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { isDirectRun } from '../cli.mjs';

const LOCAL_IMPORT_RE = /^\s*@import\s+(?:"([^"]+)"|'([^']+)')\s*;\s*$/u;

/**
 * @typedef {{ text: string; file: string; line: number }} FlattenedCssLine
 *   One output line and the source file and 1-based line it came from.
 */

/**
 * @param {string} entryPath
 * @returns {string}
 */
export function flattenCssFile(entryPath) {
  return flattenCssLines(entryPath)
    .map(({ text }) => text)
    .join('\n');
}

/**
 * The flattened source, line by line, with each line's origin.
 * @param {string} entryPath
 * @returns {FlattenedCssLine[]}
 */
export function flattenCssLines(entryPath) {
  const resolvedEntryPath = path.resolve(entryPath);

  return flattenCssPath(resolvedEntryPath, findUnionCssRoot(resolvedEntryPath), new Set());
}

/**
 * @param {string} filePath
 * @param {string} rootPath
 * @param {Set<string>} seen
 * @returns {FlattenedCssLine[]}
 */
function flattenCssPath(filePath, rootPath, seen) {
  if (seen.has(filePath)) {
    throw new Error(`Union CSS import cycle includes ${filePath}`);
  }

  seen.add(filePath);

  const directory = path.dirname(filePath);
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const flattened = lines.flatMap((text, index) => {
    const match = LOCAL_IMPORT_RE.exec(text);

    if (match === null) {
      return [{ text, file: filePath, line: index + 1 }];
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

    return trimTrailingWhitespace(flattenCssPath(resolvedImportPath, rootPath, seen));
  });

  seen.delete(filePath);

  // A run of blank lines collapses to one.
  return flattened.filter((entry, index) => entry.text !== '' || flattened[index - 1]?.text !== '');
}

/**
 * Drops trailing whitespace, as `String.prototype.trimEnd` would on the joined text.
 * @param {FlattenedCssLine[]} lines
 * @returns {FlattenedCssLine[]}
 */
function trimTrailingWhitespace(lines) {
  const trimmed = [...lines];
  while (trimmed.length > 0 && trimmed.at(-1)?.text.trim() === '') trimmed.pop();
  const last = trimmed.at(-1);
  if (last !== undefined) trimmed[trimmed.length - 1] = { ...last, text: last.text.trimEnd() };
  return trimmed;
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

if (isDirectRun(import.meta)) {
  const entryPath = process.argv[2] ?? 'source/union-css/index.css';
  process.stdout.write(flattenCssFile(entryPath));
}
