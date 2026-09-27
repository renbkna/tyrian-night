import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  isFileNotFoundError,
  IslandPartialMutationError,
  IslandShellFailure,
} from './islandShellContract.js';

/**
 * One planned file change. `expectedContent` is what the planner read; a
 * target that no longer holds it was changed by someone else after planning.
 * `content: undefined` removes the file.
 */
export type FileMutation = {
  filePath: string;
  content: string | undefined;
  expectedContent: string | undefined;
};

const TEMPORARY_FILE_PATTERN = /^\..+\.tyrian-[0-9a-f-]{36}\.tmp$/u;

/** Whether a directory entry is a writeFileAtomic temporary. */
export function isTemporaryFileName(name: string): boolean {
  return TEMPORARY_FILE_PATTERN.test(name);
}

export function sha256Base64(content: string): string {
  return crypto.hash('sha256', content, 'base64').replace(/=+$/, '');
}

/** Escape a literal fragment embedded by the Island parser's regular expressions. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export async function canonicalizeAppRoot(appRoot: string): Promise<string> {
  if (appRoot.trim().length === 0) {
    throw new Error('Tyrian VS Code app root must not be empty.');
  }

  const resolved = path.resolve(appRoot);

  try {
    return await fs.realpath(resolved);
  } catch (error) {
    if (isFileNotFoundError(error)) return resolved;
    throw error;
  }
}

export async function readTextFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isFileNotFoundError(error)) return undefined;
    throw error;
  }
}

export async function lstatIfExists(
  filePath: string
): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (isFileNotFoundError(error)) return undefined;
    throw error;
  }
}

/**
 * Make a rename or unlink in this directory durable. Windows cannot open a
 * directory for flushing; NTFS journals the rename itself.
 */
async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directoryPath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Replace a file atomically and durably: readers see the old or the new
 * content, never a partial or missing file. An existing file keeps its mode.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const directoryPath = path.dirname(filePath);
  await fs.mkdir(directoryPath, { recursive: true });
  const existing = await lstatIfExists(filePath);
  const temporaryPath = path.join(
    directoryPath,
    `.${path.basename(filePath)}.tyrian-${crypto.randomUUID()}.tmp`
  );

  try {
    const handle = await fs.open(temporaryPath, 'wx');
    try {
      await handle.writeFile(content, 'utf8');
      if (existing?.isFile()) await handle.chmod(Number(existing.mode) & 0o7777);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
  await syncDirectory(directoryPath);
}

/** Remove a file durably; an already absent file is not an error. */
export async function removeFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (isFileNotFoundError(error)) return;
    throw error;
  }
  await syncDirectory(path.dirname(filePath));
}

/**
 * Delete temporary files a crashed writer left behind. Callers hold the
 * Island lock, so no live writer owns them.
 */
export async function removeStaleTemporaryFiles(directoryPath: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(directoryPath);
  } catch (error) {
    if (isFileNotFoundError(error)) return;
    throw error;
  }
  for (const name of names) {
    if (isTemporaryFileName(name)) await fs.rm(path.join(directoryPath, name), { force: true });
  }
}

/**
 * Apply planned mutations in order, then verify. Each step is atomic and the
 * planner orders steps so every prefix leaves a loadable installation;
 * rerunning the same command after any failure converges. Returns whether a
 * file changed.
 */
export async function applyFileMutations(
  mutations: readonly FileMutation[],
  verify: () => Promise<void>
): Promise<boolean> {
  let changed = false;

  try {
    for (const { filePath, content, expectedContent } of mutations) {
      const current = await readTextFileIfExists(filePath);
      if (current === content) continue;
      if (current !== expectedContent) {
        throw new IslandShellFailure(
          'blocked',
          `Tyrian Island target changed after planning at '${filePath}'; it was left untouched.`,
          { mutation: { externalDrift: true } }
        );
      }
      if (content === undefined) await removeFile(filePath);
      else await writeFileAtomic(filePath, content);
      changed = true;
    }
    await verify();
  } catch (error) {
    if (!changed) throw error;
    throw new IslandPartialMutationError(
      `Tyrian changed Island files before the operation failed; rerun it to complete: ${error instanceof Error ? error.message : String(error)}`,
      { physicalChanged: true, incompleteRecovery: true },
      { cause: error }
    );
  }

  return changed;
}
