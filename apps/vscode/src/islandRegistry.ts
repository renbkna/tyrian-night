import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  canonicalizeAppRoot,
  isTemporaryFileName,
  lstatIfExists,
  readTextFileIfExists,
  removeFile,
  removeStaleTemporaryFiles,
  writeFileAtomic,
} from './islandFileSystem.js';
import {
  buildManagedRootRecordPath,
  buildManagedRootsDirectoryPath,
  buildQuarantinedRootsDirectoryPath,
  isIslandCssAssetName,
} from './islandPatchContract.js';
import {
  describeIslandShellFailure,
  type IslandShellFailureDescription,
  isPermissionError,
} from './islandShellContract.js';

const RECORD_NAME_PATTERN = /^[0-9a-f]{64}\.json$/u;

type ManagedRootRecord = {
  appRoot: string;
  desiredCssFile: string | null;
};

export type ManagedRootRegistration =
  | { kind: 'absent' }
  | { kind: 'valid'; desiredCssFile: string | null }
  | { kind: 'corrupt'; reason: string };

export type IslandShellEnvironment = {
  registryHome?: string;
};

export type IslandRegisteredRoot = {
  readonly appRoot: string;
  removeMissing(): Promise<{ changed: boolean; quarantinePath?: string }>;
};

type RootListing = {
  roots: IslandRegisteredRoot[];
  registryDiagnostics: string[];
  registryChanged: boolean;
  quarantinedRecords: string[];
  enumerationFailure?: IslandShellFailureDescription;
};

/**
 * Preferred roots plus every registered root. Doctor reads report unusable
 * registry entries as diagnostics; restore moves them to quarantine so bulk
 * cleanup is never blocked by data it cannot interpret.
 */
export async function listIslandShellRoots(
  options: { preferredAppRoots?: string[]; registryHome?: string } | undefined,
  mode: 'diagnostic-read' | 'restore'
): Promise<RootListing> {
  const environment = { registryHome: options?.registryHome };
  const candidates = new Map<string, { appRoot: string; corrupt: boolean }>();
  for (const candidateRoot of options?.preferredAppRoots ?? []) {
    const appRoot = await canonicalizeAppRoot(candidateRoot);
    candidates.set(appRoot, { appRoot, corrupt: false });
  }

  const registryDiagnostics: string[] = [];
  const quarantinedRecords: string[] = [];
  let enumerationFailure: IslandShellFailureDescription | undefined;
  const directoryPath = buildManagedRootsDirectoryPath(environment.registryHome);

  try {
    if (mode === 'restore') await removeStaleTemporaryFiles(directoryPath);
    for (const entry of await readRegistryEntries(directoryPath)) {
      if (isTemporaryFileName(entry)) continue;
      const recordPath = path.join(directoryPath, entry);
      try {
        const identity = await identifyRecord(recordPath, environment);
        if (identity.kind === 'unidentifiable') {
          if (mode === 'restore') {
            quarantinedRecords.push(await quarantineRecord(recordPath, environment));
          } else {
            registryDiagnostics.push(identity.reason);
          }
          continue;
        }
        if (identity.corrupt && mode === 'diagnostic-read') {
          registryDiagnostics.push(identity.reason);
        }
        candidates.set(identity.appRoot, { appRoot: identity.appRoot, corrupt: identity.corrupt });
      } catch (error) {
        // Restore stops at data it can neither use nor safely move aside.
        if (mode === 'restore') throw error;
        registryDiagnostics.push(`${recordPath}: ${errorMessage(error)}`);
      }
    }
  } catch (error) {
    if (mode === 'restore') enumerationFailure = describeIslandShellFailure(error);
    else registryDiagnostics.push(error instanceof Error ? error.message : String(error));
  }

  return {
    roots: [...candidates.values()]
      .toSorted((left, right) => left.appRoot.localeCompare(right.appRoot))
      .map((candidate) =>
        Object.freeze({
          appRoot: candidate.appRoot,
          removeMissing: () => removeMissingRecord(candidate, environment),
        })
      ),
    registryDiagnostics,
    registryChanged: quarantinedRecords.length > 0,
    quarantinedRecords,
    ...(enumerationFailure !== undefined ? { enumerationFailure } : {}),
  };
}

export async function readManagedAppRootRegistration(
  appRoot: string,
  environment?: IslandShellEnvironment
): Promise<ManagedRootRegistration> {
  const recordPath = buildManagedRootRecordPath(appRoot, environment?.registryHome);
  let content: string | undefined;
  try {
    content = await readRecordFile(recordPath);
  } catch (error) {
    if (isPermissionError(error)) throw error;
    return { kind: 'corrupt', reason: errorMessage(error) };
  }
  if (content === undefined) return { kind: 'absent' };

  try {
    const record = parseManagedRootRecord(content, recordPath);
    if (record.appRoot !== appRoot) {
      throw new Error(`Tyrian managed app root record does not own '${appRoot}'.`);
    }
    return { kind: 'valid', desiredCssFile: record.desiredCssFile };
  } catch (error) {
    return { kind: 'corrupt', reason: errorMessage(error) };
  }
}

/** Publish desired state for one app root. Returns whether the record changed. */
export async function publishManagedRootRecord(
  appRoot: string,
  desiredCssFile: string | null,
  environment?: IslandShellEnvironment
): Promise<boolean> {
  const recordPath = buildManagedRootRecordPath(appRoot, environment?.registryHome);
  const record: ManagedRootRecord = {
    appRoot,
    desiredCssFile,
  };
  const content = `${JSON.stringify(record, null, 2)}\n`;
  parseManagedRootRecord(content, recordPath);

  let current: string | undefined;
  try {
    current = await readRecordFile(recordPath);
  } catch (error) {
    if (isPermissionError(error)) throw error;
    // A corrupt record is replaced by the new desired state.
  }
  if (current === content) return false;
  await writeFileAtomic(recordPath, content);
  return true;
}

export function readDesiredCssFile(
  registration: ManagedRootRegistration
): string | null | undefined {
  return registration.kind === 'valid' ? registration.desiredCssFile : undefined;
}

export type IslandAccessRequirement = {
  path: string;
  existingMode: number;
  missingParentMode?: number;
  optional?: boolean;
};

export function islandRegistryAccessRequirements(
  appRoot: string,
  environment: IslandShellEnvironment
): IslandAccessRequirement[] {
  const directory = buildManagedRootsDirectoryPath(environment.registryHome);
  return [
    ...[path.dirname(directory), directory].map((directoryPath) => ({
      path: directoryPath,
      existingMode: fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK,
      missingParentMode: fsConstants.W_OK | fsConstants.X_OK,
    })),
    {
      path: buildManagedRootRecordPath(appRoot, environment.registryHome),
      existingMode: fsConstants.R_OK,
      optional: true,
    },
  ];
}

async function readRegistryEntries(directoryPath: string): Promise<string[]> {
  const stats = await lstatIfExists(directoryPath);
  if (stats === undefined) return [];
  if (!stats.isDirectory()) {
    throw new Error(`Tyrian managed app roots path is not a directory at '${directoryPath}'.`);
  }
  return (await fs.readdir(directoryPath)).toSorted();
}

/** A record's content, or undefined when absent. Symlinks and non-files are corrupt. */
async function readRecordFile(recordPath: string): Promise<string | undefined> {
  const stats = await lstatIfExists(recordPath);
  if (stats === undefined) return undefined;
  if (!stats.isFile()) {
    throw new Error(`Tyrian managed app root record is not a regular file at '${recordPath}'.`);
  }
  return readTextFileIfExists(recordPath);
}

/**
 * A record is unidentifiable when no app root can be bound to it; a record
 * whose root is identified but whose remaining fields are invalid is corrupt.
 * Unreadable entries and directories throw: quarantine only moves files and links.
 */
async function identifyRecord(
  recordPath: string,
  environment: IslandShellEnvironment
): Promise<
  | { kind: 'unidentifiable'; reason: string }
  | { kind: 'identified'; appRoot: string; corrupt: boolean; reason: string }
> {
  const unidentifiable = (reason: string) => ({ kind: 'unidentifiable' as const, reason });
  if ((await fs.lstat(recordPath)).isDirectory()) {
    throw new Error(`Tyrian managed app root record is a directory at '${recordPath}'.`);
  }
  if (!RECORD_NAME_PATTERN.test(path.basename(recordPath))) {
    return unidentifiable(`Tyrian managed app root record is invalid at '${recordPath}'.`);
  }

  let content: string | undefined;
  try {
    content = await readRecordFile(recordPath);
  } catch (error) {
    if (isPermissionError(error)) throw error;
    return unidentifiable(errorMessage(error));
  }
  if (content === undefined) {
    return unidentifiable(`Tyrian managed app root record vanished at '${recordPath}'.`);
  }

  let appRoot: unknown;
  try {
    appRoot = (JSON.parse(content) as { appRoot?: unknown }).appRoot;
  } catch {
    return unidentifiable(`Tyrian managed app root record is invalid JSON at '${recordPath}'.`);
  }
  if (
    typeof appRoot !== 'string' ||
    !path.isAbsolute(appRoot) ||
    (await canonicalizeAppRoot(appRoot)) !== appRoot ||
    buildManagedRootRecordPath(appRoot, environment.registryHome) !== recordPath
  ) {
    return unidentifiable(`Tyrian managed app root record identity is invalid at '${recordPath}'.`);
  }

  try {
    parseManagedRootRecord(content, recordPath);
    return { kind: 'identified', appRoot, corrupt: false, reason: '' };
  } catch (error) {
    return { kind: 'identified', appRoot, corrupt: true, reason: errorMessage(error) };
  }
}

async function removeMissingRecord(
  candidate: { appRoot: string; corrupt: boolean },
  environment: IslandShellEnvironment
): Promise<{ changed: boolean; quarantinePath?: string }> {
  if ((await lstatIfExists(candidate.appRoot)) !== undefined) {
    throw new Error(
      `Tyrian cannot prune registry ownership for an existing app root at '${candidate.appRoot}'.`
    );
  }
  const recordPath = buildManagedRootRecordPath(candidate.appRoot, environment.registryHome);
  if ((await lstatIfExists(recordPath)) === undefined) return { changed: false };
  if (candidate.corrupt) {
    return { changed: true, quarantinePath: await quarantineRecord(recordPath, environment) };
  }
  await removeFile(recordPath);
  return { changed: true };
}

/** Move an unusable record aside without following it, preserving it for inspection. */
async function quarantineRecord(
  recordPath: string,
  environment: IslandShellEnvironment
): Promise<string> {
  const quarantineDirectory = buildQuarantinedRootsDirectoryPath(environment.registryHome);
  await fs.mkdir(quarantineDirectory, { recursive: true });
  const quarantinePath = path.join(
    quarantineDirectory,
    `${path.basename(recordPath, '.json')}-${crypto.randomUUID()}.json`
  );
  await fs.rename(recordPath, quarantinePath);
  return quarantinePath;
}

function parseManagedRootRecord(content: string, recordPath: string): ManagedRootRecord {
  let parsed: { appRoot?: unknown; desiredCssFile?: unknown };
  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch {
    throw new Error(`Tyrian managed app root record is invalid JSON at '${recordPath}'.`);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Object.keys(parsed).toSorted().join(',') !== 'appRoot,desiredCssFile' ||
    typeof parsed.appRoot !== 'string' ||
    !path.isAbsolute(parsed.appRoot)
  ) {
    throw new Error(
      `Tyrian managed app root record is invalid: expected exactly an absolute appRoot and desiredCssFile at '${recordPath}'.`
    );
  }
  if (
    parsed.desiredCssFile !== null &&
    (typeof parsed.desiredCssFile !== 'string' || !isIslandCssAssetName(parsed.desiredCssFile))
  ) {
    throw new Error(
      `Tyrian managed app root record is invalid: desiredCssFile must be null or a CSS asset name at '${recordPath}'.`
    );
  }
  return parsed as ManagedRootRecord;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
