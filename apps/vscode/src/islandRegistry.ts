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
  type IslandDesiredState,
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

/** A registry root that restore either prunes (its app root is gone) or restores. */
export type IslandRegisteredRoot = {
  readonly appRoot: string;
  pruneIfMissing(): Promise<
    { pruned: false } | { pruned: true; changed: boolean; quarantinePath?: string }
  >;
};

type RegistryEntry =
  | { kind: 'identified'; appRoot: string; corrupt: boolean; reason: string }
  | { kind: 'unidentifiable'; recordPath: string; reason: string }
  | { kind: 'unreadable'; recordPath: string; error: unknown };

/** Doctor roots: preferred and registered roots, with unusable registry data as diagnostics. */
export async function listIslandDoctorRoots(options?: {
  preferredAppRoots?: string[];
  registryHome?: string;
}): Promise<{ appRoots: string[]; registryDiagnostics: string[] }> {
  const environment = { registryHome: options?.registryHome };
  const appRoots = await canonicalizeAppRoots(options?.preferredAppRoots);
  const registryDiagnostics: string[] = [];

  try {
    for (const entry of await scanRegistry(environment)) {
      if (entry.kind === 'unreadable') {
        registryDiagnostics.push(`${entry.recordPath}: ${errorMessage(entry.error)}`);
        continue;
      }
      if (entry.kind === 'unidentifiable' || entry.corrupt) registryDiagnostics.push(entry.reason);
      if (entry.kind === 'identified') appRoots.add(entry.appRoot);
    }
  } catch (error) {
    registryDiagnostics.push(errorMessage(error));
  }

  return {
    appRoots: [...appRoots].toSorted((left, right) => left.localeCompare(right)),
    registryDiagnostics,
  };
}

/**
 * Restore roots: preferred and registered roots. Unidentifiable records move to
 * quarantine so bulk cleanup is never blocked by data it cannot interpret;
 * entries it can neither read nor move aside are the enumeration failure, and
 * every other root is still returned.
 */
export async function listIslandRestoreRoots(options?: {
  preferredAppRoots?: string[];
  registryHome?: string;
}): Promise<{
  roots: IslandRegisteredRoot[];
  registryChanged: boolean;
  quarantinedRecords: string[];
  enumerationFailure?: IslandShellFailureDescription;
}> {
  const environment = { registryHome: options?.registryHome };
  const candidates = new Map<string, boolean>();
  for (const appRoot of await canonicalizeAppRoots(options?.preferredAppRoots)) {
    candidates.set(appRoot, false);
  }
  const quarantinedRecords: string[] = [];
  const unreadable: unknown[] = [];
  let enumerationFailure: IslandShellFailureDescription | undefined;

  try {
    await removeStaleTemporaryFiles(buildManagedRootsDirectoryPath(environment.registryHome));
    for (const entry of await scanRegistry(environment)) {
      if (entry.kind === 'unreadable') unreadable.push(entry.error);
      else if (entry.kind === 'unidentifiable') {
        try {
          quarantinedRecords.push(await quarantineRecord(entry.recordPath, environment));
        } catch (error) {
          unreadable.push(error);
        }
      } else candidates.set(entry.appRoot, entry.corrupt);
    }
    if (unreadable.length > 0) {
      throw unreadable.length === 1
        ? unreadable[0]
        : new AggregateError(unreadable, 'Tyrian could not read several registry entries.');
    }
  } catch (error) {
    enumerationFailure = describeIslandShellFailure(error);
  }

  return {
    roots: [...candidates]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([appRoot, corrupt]) =>
        Object.freeze({
          appRoot,
          pruneIfMissing: () => pruneMissingRecord({ appRoot, corrupt }, environment),
        })
      ),
    registryChanged: quarantinedRecords.length > 0,
    quarantinedRecords,
    ...(enumerationFailure !== undefined ? { enumerationFailure } : {}),
  };
}

/** An app root is missing when nothing exists at its path; only then may its record be pruned. */
export async function isAppRootMissing(appRoot: string): Promise<boolean> {
  return (await lstatIfExists(appRoot)) === undefined;
}

async function canonicalizeAppRoots(appRoots: string[] | undefined): Promise<Set<string>> {
  const canonical = new Set<string>();
  for (const appRoot of appRoots ?? []) canonical.add(await canonicalizeAppRoot(appRoot));
  return canonical;
}

/** Every registry entry, classified; a missing registry is empty. */
async function scanRegistry(environment: IslandShellEnvironment): Promise<RegistryEntry[]> {
  const directoryPath = buildManagedRootsDirectoryPath(environment.registryHome);
  const entries: RegistryEntry[] = [];
  for (const name of await readRegistryEntries(directoryPath)) {
    if (isTemporaryFileName(name)) continue;
    const recordPath = path.join(directoryPath, name);
    try {
      entries.push(await identifyRecord(recordPath, environment));
    } catch (error) {
      entries.push({ kind: 'unreadable', recordPath, error });
    }
  }
  return entries;
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

export function desiredStateOf(
  registration: ManagedRootRegistration | 'unreadable'
): IslandDesiredState {
  if (registration === 'unreadable') return { kind: 'unreadable' };
  if (registration.kind !== 'valid') return { kind: registration.kind };
  return registration.desiredCssFile === null
    ? { kind: 'disabled' }
    : { kind: 'enabled', cssFile: registration.desiredCssFile };
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
  | { kind: 'unidentifiable'; recordPath: string; reason: string }
  | { kind: 'identified'; appRoot: string; corrupt: boolean; reason: string }
> {
  const unidentifiable = (reason: string) => ({
    kind: 'unidentifiable' as const,
    recordPath,
    reason,
  });
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

async function pruneMissingRecord(
  candidate: { appRoot: string; corrupt: boolean },
  environment: IslandShellEnvironment
): Promise<{ pruned: false } | { pruned: true; changed: boolean; quarantinePath?: string }> {
  if (!(await isAppRootMissing(candidate.appRoot))) return { pruned: false };
  const recordPath = buildManagedRootRecordPath(candidate.appRoot, environment.registryHome);
  if ((await lstatIfExists(recordPath)) === undefined) return { pruned: true, changed: false };
  if (candidate.corrupt) {
    return {
      pruned: true,
      changed: true,
      quarantinePath: await quarantineRecord(recordPath, environment),
    };
  }
  await removeFile(recordPath);
  return { pruned: true, changed: true };
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
