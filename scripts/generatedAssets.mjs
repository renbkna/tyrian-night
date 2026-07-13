// @ts-check

import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {{ path: string; content: string | Uint8Array }} GeneratedAsset
 * @typedef {{ directory: string; match?: RegExp }} GeneratedOwnership
 */

/**
 * Synchronizes generated files and enforces exact ownership inside declared output areas.
 *
 * @param {GeneratedAsset[]} assets
 * @param {string} repoRoot
 * @param {{ check?: boolean; ownership?: GeneratedOwnership[] }} [options]
 * @returns {string[]}
 */
export function syncGeneratedAssets(assets, repoRoot, options = {}) {
  const check = options.check ?? false;
  const ownership = options.ownership ?? [];
  const expected = new Map();

  for (const asset of assets) {
    const relativePath = requireRelativePath(asset.path);

    if (expected.has(relativePath)) {
      throw new Error(`Duplicate generated asset '${relativePath}'`);
    }

    expected.set(relativePath, asset.content);
  }

  const actualOwnedPaths = listOwnedFiles(repoRoot, ownership);
  const unexpectedPaths = [...actualOwnedPaths]
    .filter((filePath) => !expected.has(filePath))
    .toSorted();

  if (!check) {
    for (const filePath of unexpectedPaths) {
      fs.rmSync(path.join(repoRoot, filePath), { force: true, recursive: true });
    }

    for (const rule of ownership) {
      if (!rule.match) {
        removeEmptyDirectories(path.join(repoRoot, requireRelativePath(rule.directory)));
      }
    }

    for (const [filePath, content] of expected) {
      const absolutePath = path.join(repoRoot, filePath);
      assertNoGeneratedPathSymlink(repoRoot, filePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, content);
    }

    return [];
  }

  const stalePaths = [...unexpectedPaths];

  for (const [filePath, content] of expected) {
    const absolutePath = path.join(repoRoot, filePath);
    assertNoGeneratedPathSymlink(repoRoot, filePath);

    try {
      const current = fs.readFileSync(absolutePath);
      const expectedContent =
        typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);

      if (!current.equals(expectedContent)) {
        stalePaths.push(filePath);
      }
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }

      stalePaths.push(filePath);
    }
  }

  return [...new Set(stalePaths)].toSorted();
}

/**
 * @param {string} repoRoot
 * @param {GeneratedOwnership[]} ownership
 * @returns {Set<string>}
 */
function listOwnedFiles(repoRoot, ownership) {
  const files = new Set();

  for (const rule of ownership) {
    const directory = requireRelativePath(rule.directory);
    const absoluteDirectory = path.join(repoRoot, directory);
    assertNoGeneratedPathSymlink(repoRoot, directory);

    walkOwnedDirectory(absoluteDirectory, '', rule.match, (relativePath) => {
      files.add(path.posix.join(directory.replaceAll('\\', '/'), relativePath));
    });
  }

  return files;
}

/**
 * Generated writers must not follow repository symlinks into unowned paths.
 *
 * @param {string} repoRoot
 * @param {string} relativePath
 * @returns {void}
 */
function assertNoGeneratedPathSymlink(repoRoot, relativePath) {
  let currentPath = path.resolve(repoRoot);

  for (const segment of requireRelativePath(relativePath).split('/')) {
    currentPath = path.join(currentPath, segment);

    try {
      if (fs.lstatSync(currentPath).isSymbolicLink()) {
        throw new Error(`Generated path must not contain symlinks: '${relativePath}'`);
      }
    } catch (error) {
      if (isMissingPathError(error)) {
        return;
      }

      throw error;
    }
  }
}

/**
 * @param {string} absoluteDirectory
 * @param {string} relativeDirectory
 * @param {RegExp | undefined} match
 * @param {(relativePath: string) => void} visit
 * @returns {void}
 */
function walkOwnedDirectory(absoluteDirectory, relativeDirectory, match, visit) {
  let entries;

  try {
    entries = fs.readdirSync(path.join(absoluteDirectory, relativeDirectory), {
      withFileTypes: true,
    });
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }

    throw error;
  }

  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory.replaceAll('\\', '/'), entry.name);

    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      walkOwnedDirectory(absoluteDirectory, relativePath, match, visit);
      continue;
    }

    if (match && !matches(match, relativePath)) {
      continue;
    }

    visit(relativePath);
  }
}

/**
 * @param {string} directory
 * @returns {void}
 */
function removeEmptyDirectories(directory) {
  if (!fs.existsSync(directory)) {
    return;
  }

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      removeEmptyDirectories(path.join(directory, entry.name));
    }
  }

  if (fs.readdirSync(directory).length === 0) {
    fs.rmdirSync(directory);
  }
}

/**
 * @param {RegExp} pattern
 * @param {string} value
 * @returns {boolean}
 */
function matches(pattern, value) {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function requireRelativePath(filePath) {
  const normalized = path.normalize(filePath);

  if (
    filePath === '' ||
    path.isAbsolute(filePath) ||
    normalized === '..' ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`Generated path must stay inside the repository: '${filePath}'`);
  }

  return normalized.replaceAll('\\', '/');
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissingPathError(error) {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}
