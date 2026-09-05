import {
  type IslandShellFailureDescription,
  isNodeError,
  describeIslandShellFailure,
  isPermissionError,
  IslandShellFailure,
} from './islandShellContract.js';
import {
  settleDurableMetadataPublication,
  removeFileDurably,
  canonicalizeAppRoot,
  type RegularFileGeneration,
  readDurableMetadataGeneration,
  writeIfChanged,
  lstatIfExists,
  durableMetadataSourcePath,
  durableMetadataPaths,
  assertNoLegacyDurableRemovalEvidence,
  restoreRetiredGeneration,
  syncDirectories,
} from './islandFileSystem.js';
import { isIslandLockLifecycleFailure, withIslandProcessLock } from './islandProcessLock.js';
import {
  buildManagedRootsDirectoryPath,
  buildManagedRootRecordPath,
  buildIslandRegistryLockPath,
  buildQuarantinedRootsDirectoryPath,
} from './islandPatchContract.js';
import { islandMutationFacts } from './islandSupervisorCore.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { type Dirent, constants as fsConstants } from 'node:fs';

import crypto from 'node:crypto';

export class IslandRegistryQuarantineError extends Error {
  readonly changed = true;
  readonly desiredStateChanged = false;
  readonly registryChanged = true;
  readonly physicalChanged = false;
  readonly externalDrift = false;
  readonly incompleteRecovery = true;
  readonly quarantinePath: string;

  constructor(quarantinePath: string, cause: unknown) {
    super(
      `Tyrian quarantined a managed-root record at '${quarantinePath}', but directory durability sync failed.`,
      { cause }
    );
    this.name = 'IslandRegistryQuarantineError';
    this.quarantinePath = quarantinePath;
  }
}

const MANAGED_ROOT_RECORD_VERSION = 2 as const;

type ManagedRootRecord = {
  version: typeof MANAGED_ROOT_RECORD_VERSION;
  appRoot: string;
  desiredThemeId: string | null;
};

export type ManagedRootRegistration =
  | { kind: 'absent' }
  | { kind: 'valid'; desiredThemeId: string | null }
  | { kind: 'corrupt'; reason: string }
  | { kind: 'unsupported'; reason: string };

type RestorableManagedRootRegistration = Exclude<ManagedRootRegistration, { kind: 'unsupported' }>;

export type IslandShellEnvironment = {
  registryHome?: string;
};

type RegistryRecordGeneration = {
  recordPath: string;
  dev: number | bigint;
  ino: number | bigint;
  mode: number;
  content: string | undefined;
  corrupt: boolean;
};

type RootCandidate = {
  appRoot: string;
  recordGeneration?: RegistryRecordGeneration;
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

type RegistryEnumerationAccumulator = {
  roots: RootCandidate[];
  registryDiagnostics: string[];
  quarantinedRecords?: string[];
};

async function removeMissingManagedAppRoot(
  candidate: RootCandidate,
  environment?: IslandShellEnvironment
): Promise<{ changed: boolean; quarantinePath?: string }> {
  return withRegistryLock(environment, async () => {
    if ((await lstatIfExists(candidate.appRoot)) !== undefined) {
      throw new Error(
        `Tyrian cannot prune registry ownership for an existing app root at '${candidate.appRoot}'.`
      );
    }
    const recordPath = getManagedRootRecordPath(candidate.appRoot, environment);
    let current: RegistryRecordGeneration;
    try {
      await settleDurableMetadataPublication(recordPath, 'managed app root record');
      current = await readRegistryRecordGeneration(
        recordPath,
        candidate.recordGeneration?.corrupt ?? false
      );
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return { changed: false };
      throw error;
    }

    if (candidate.recordGeneration !== undefined) {
      if (!sameRegistryRecordGeneration(current, candidate.recordGeneration)) {
        throw new Error(
          `Tyrian managed app root record changed during restore at '${recordPath}'.`
        );
      }

      if (candidate.recordGeneration.corrupt) {
        const quarantinePath = await quarantineManagedRootRecord(
          recordPath,
          environment,
          candidate.recordGeneration
        );
        return { changed: true, quarantinePath };
      } else {
        await removeFileDurably(
          recordPath,
          { registryChanged: true },
          regularFileGenerationFromRegistry(current)
        );
      }
      return { changed: true };
    }

    const content = current.content;
    if (content === undefined) {
      throw new Error(
        `Tyrian managed app root record is not a readable regular file at '${recordPath}'.`
      );
    }
    const record = parseManagedRootRecord(content, recordPath);
    if (record.appRoot !== candidate.appRoot) {
      throw new Error(`Tyrian managed app root record does not own '${candidate.appRoot}'.`);
    }
    await removeFileDurably(
      recordPath,
      { registryChanged: true },
      regularFileGenerationFromRegistry(current)
    );
    return { changed: true };
  });
}

export async function listIslandShellRoots(
  options?: {
    preferredAppRoots?: string[];
    registryHome?: string;
  },
  behavior?: {
    mode?: 'strict-read' | 'diagnostic-read' | 'restore';
  }
): Promise<RootListing> {
  const environment = {
    registryHome: path.dirname(path.dirname(getManagedRootsDirectoryPath(options))),
  };
  const candidates = new Map<string, RootCandidate>();
  const preferredAppRoots = [...(options?.preferredAppRoots ?? [])];
  const mode = behavior?.mode ?? 'strict-read';

  for (const candidateRoot of preferredAppRoots) {
    const appRoot = await canonicalizeAppRoot(candidateRoot);
    candidates.set(appRoot, { appRoot });
  }

  let enumerationFailure: IslandShellFailureDescription | undefined;
  const registryDiagnostics: string[] = [];
  const quarantinedRecords: string[] = [];
  const registeredRoots: RootCandidate[] = [];
  let initializationChanged = false;

  try {
    if (mode === 'restore') {
      initializationChanged = await initializeManagedRootsForMutation(environment);
      await readManagedAppRootsForRestore(environment, {
        roots: registeredRoots,
        registryDiagnostics,
        quarantinedRecords,
      });
    } else {
      await readManagedAppRootsReadOnly(environment, {
        roots: registeredRoots,
        registryDiagnostics,
        tolerateDiagnostics: mode === 'diagnostic-read',
      });
    }
  } catch (error) {
    if (isIslandLockLifecycleFailure(error)) throw error;
    if (mode === 'restore') {
      enumerationFailure = describeIslandShellFailure(error);
    } else if (mode === 'diagnostic-read') {
      registryDiagnostics.push(error instanceof Error ? error.message : String(error));
    } else {
      throw error;
    }
  }

  for (const root of registeredRoots) {
    candidates.set(root.appRoot, root);
  }

  return {
    roots: [...candidates.values()].map((candidate) =>
      Object.freeze({
        appRoot: candidate.appRoot,
        removeMissing: () => removeMissingManagedAppRoot(candidate, environment),
      })
    ),
    registryDiagnostics,
    registryChanged: initializationChanged || quarantinedRecords.length > 0,
    quarantinedRecords,
    ...(enumerationFailure !== undefined ? { enumerationFailure } : {}),
  };
}

function getManagedRootsDirectoryPath(environment?: IslandShellEnvironment): string {
  return buildManagedRootsDirectoryPath(environment?.registryHome);
}

function getManagedRootRecordPath(appRoot: string, environment?: IslandShellEnvironment): string {
  return buildManagedRootRecordPath(appRoot, environment?.registryHome);
}

export async function readManagedAppRootRegistration(
  appRoot: string,
  environment?: IslandShellEnvironment
): Promise<ManagedRootRegistration> {
  const recordPath = getManagedRootRecordPath(appRoot, environment);
  let generation: RegularFileGeneration;
  try {
    generation = await readDurableMetadataGeneration(recordPath, 'managed app root record');
  } catch (error) {
    if (isPermissionError(error)) throw error;
    return {
      kind: 'corrupt',
      reason: `${recordPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (generation.kind === 'absent') return { kind: 'absent' };
  const { content } = generation;

  try {
    const record = parseManagedRootRecord(content, recordPath);
    if (record.appRoot !== appRoot) {
      throw new Error(`Tyrian managed app root record does not own '${appRoot}'.`);
    }
    return { kind: 'valid', desiredThemeId: record.desiredThemeId };
  } catch (error) {
    return {
      kind: isUnsupportedManagedRootRecord(content) ? 'unsupported' : 'corrupt',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function readRestorableManagedRootRegistration(
  appRoot: string,
  environment?: IslandShellEnvironment
): Promise<RestorableManagedRootRegistration> {
  const registration = await readManagedAppRootRegistration(appRoot, environment);
  if (registration.kind === 'unsupported') {
    throw new IslandShellFailure('corrupt', registration.reason);
  }
  return registration;
}

export async function publishManagedRootRecord(
  appRoot: string,
  desiredThemeId: string | null,
  environment?: IslandShellEnvironment
): Promise<boolean> {
  const recordPath = getManagedRootRecordPath(appRoot, environment);
  const content = serializeManagedRootRecord(appRoot, desiredThemeId);
  parseManagedRootRecord(content, recordPath);
  const publication = await withRegistryLock(environment, async () => {
    const changed = await writeIfChanged(recordPath, content, {
      desiredStateChanged: true,
      registryChanged: true,
    });
    return islandMutationFacts({
      desiredStateChanged: changed,
      registryChanged: changed,
    });
  });
  return publication.changed;
}

async function withRegistryLock<T>(
  environment: IslandShellEnvironment | undefined,
  action: () => Promise<T>
): Promise<T> {
  const directoryPath = getManagedRootsDirectoryPath(environment);
  const registryHome = await canonicalizeFuturePath(path.dirname(path.dirname(directoryPath)));
  return withIslandProcessLock(buildIslandRegistryLockPath(registryHome), action);
}

async function canonicalizeFuturePath(filePath: string): Promise<string> {
  let existingPath = path.resolve(filePath);
  const suffix: string[] = [];

  while ((await lstatIfExists(existingPath)) === undefined) {
    const parentPath = path.dirname(existingPath);
    if (parentPath === existingPath) break;
    suffix.unshift(path.basename(existingPath));
    existingPath = parentPath;
  }

  return path.join(await fs.realpath(existingPath), ...suffix);
}

async function initializeManagedRootsForMutation(
  environment?: IslandShellEnvironment
): Promise<boolean> {
  const initialization = await withRegistryLock(environment, async () => {
    const changed = await initializeManagedRootsForMutationUnlocked(environment);
    return islandMutationFacts({ registryChanged: changed });
  });
  return initialization.registryChanged;
}

async function initializeManagedRootsForMutationUnlocked(
  environment?: IslandShellEnvironment
): Promise<boolean> {
  const directoryPath = getManagedRootsDirectoryPath(environment);
  const directoryStats = await lstatIfExists(directoryPath);

  if (directoryStats !== undefined && !directoryStats.isDirectory()) {
    throw new Error(`Tyrian managed app roots path is not a directory at '${directoryPath}'.`);
  }

  await fs.mkdir(directoryPath, { recursive: true });
  return directoryStats === undefined;
}

async function readManagedAppRootsForMutationStrict(
  environment?: IslandShellEnvironment
): Promise<void> {
  const accumulator: RegistryEnumerationAccumulator = {
    roots: [],
    registryDiagnostics: [],
  };
  await withRegistryLock(environment, () =>
    readManagedRootRecordsFromDirectory(
      getManagedRootsDirectoryPath(environment),
      environment,
      'strict',
      accumulator
    )
  );
}

async function readManagedAppRootsForRestore(
  environment: IslandShellEnvironment | undefined,
  accumulator: RegistryEnumerationAccumulator & { quarantinedRecords: string[] }
): Promise<void> {
  await withRegistryLock(environment, () =>
    readManagedRootRecordsFromDirectory(
      getManagedRootsDirectoryPath(environment),
      environment,
      'restore',
      accumulator
    )
  );
}

async function readManagedAppRootsReadOnly(
  environment: IslandShellEnvironment | undefined,
  options: RegistryEnumerationAccumulator & { tolerateDiagnostics: boolean }
): Promise<void> {
  const directoryPath = getManagedRootsDirectoryPath(environment);
  const stats = await lstatIfExists(directoryPath);

  if (stats !== undefined) {
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      handleRegistryReadIssue(
        `Tyrian managed app roots path is not a directory at '${directoryPath}'.`,
        options
      );
    } else {
      try {
        await readManagedRootRecordsFromDirectory(
          directoryPath,
          environment,
          options.tolerateDiagnostics ? 'diagnostic' : 'strict',
          options
        );
      } catch (error) {
        handleRegistryReadIssue(error instanceof Error ? error.message : String(error), options);
      }
    }
  }
}

async function readManagedRootRecordsFromDirectory(
  directoryPath: string,
  environment: IslandShellEnvironment | undefined,
  mode: 'strict' | 'diagnostic' | 'restore',
  accumulator: RegistryEnumerationAccumulator
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (mode === 'diagnostic') {
      accumulator.registryDiagnostics.push(
        `${directoryPath}: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    throw error;
  }

  const recordNames = new Set<string>();
  const temporaryNames = new Set<string>();
  for (const entry of entries) {
    if (/^[0-9a-f]{64}\.json$/u.test(entry.name)) recordNames.add(entry.name);
    const retiredRecord = /^\.tyrian-night-retired-([0-9a-f]{64}\.json)\.tmp$/u.exec(entry.name);
    if (retiredRecord?.[1] !== undefined) {
      recordNames.add(retiredRecord[1]);
      temporaryNames.add(entry.name);
    }
    const legacyRetiredRecord =
      /^\.tyrian-night-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}-retired-([0-9a-f]{64}\.json)\.tmp$/iu.exec(
        entry.name
      );
    if (legacyRetiredRecord?.[1] !== undefined) {
      recordNames.add(legacyRetiredRecord[1]);
      temporaryNames.add(entry.name);
    }
    if (entry.name.startsWith('.tyrian-night-') && entry.name.endsWith('.tmp')) {
      temporaryNames.add(entry.name);
    }
  }

  for (const recordName of [...recordNames].sort()) {
    const recordPath = path.join(directoryPath, recordName);
    let stats: Awaited<ReturnType<typeof fs.lstat>> | undefined;
    try {
      const corruptCanonical = await readCorruptCanonicalRegistryStats(recordPath);
      if (corruptCanonical !== undefined) {
        stats = corruptCanonical;
      } else {
        const sourcePath = await durableMetadataSourcePath(recordPath);
        if (sourcePath === undefined) continue;
        stats = await fs.lstat(sourcePath);
      }
    } catch (error) {
      const reason = `${recordPath}: ${error instanceof Error ? error.message : String(error)}`;
      if (mode === 'diagnostic') {
        accumulator.registryDiagnostics.push(reason);
        continue;
      }
      throw error;
    }

    if (stats === undefined) continue;
    if (!stats.isFile() || stats.isSymbolicLink()) {
      const reason = `Tyrian managed app root record is invalid at '${recordPath}'.`;
      if (mode === 'diagnostic') {
        accumulator.registryDiagnostics.push(reason);
        continue;
      }
      if (mode === 'restore' && (stats.isFile() || stats.isSymbolicLink())) {
        const generation = registryRecordGenerationFromStats(recordPath, stats, undefined, true);
        await quarantineManagedRootRecordAndRecord(
          recordPath,
          environment,
          generation,
          accumulator
        );
        continue;
      }
      throw new Error(reason);
    }

    let recordGeneration: RegistryRecordGeneration;
    try {
      recordGeneration = await readRegistryRecordGeneration(recordPath, false);
    } catch (error) {
      const reason = `${recordPath}: ${error instanceof Error ? error.message : String(error)}`;
      if (mode === 'diagnostic') {
        accumulator.registryDiagnostics.push(reason);
        continue;
      }
      if (mode === 'restore') {
        const generation = registryRecordGenerationFromStats(recordPath, stats, undefined, true);
        await quarantineManagedRootRecordAndRecord(
          recordPath,
          environment,
          generation,
          accumulator
        );
        continue;
      }
      throw error;
    }
    const content = recordGeneration.content;
    if (content === undefined) {
      throw new Error(`Tyrian managed app root record is not readable at '${recordPath}'.`);
    }

    let appRoot: string;
    try {
      appRoot = await identifyManagedRootRecord(content, recordPath, environment);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (isUnsupportedManagedRootRecord(content)) {
        if (mode === 'diagnostic') {
          accumulator.registryDiagnostics.push(reason);
          continue;
        }
        throw new IslandShellFailure('corrupt', reason);
      }
      if (mode === 'diagnostic') {
        accumulator.registryDiagnostics.push(reason);
        continue;
      }
      if (mode === 'restore') {
        await quarantineManagedRootRecordAndRecord(
          recordPath,
          environment,
          { ...recordGeneration, corrupt: true },
          accumulator
        );
        continue;
      }
      throw error;
    }

    let corrupt = false;
    try {
      const record = parseManagedRootRecord(content, recordPath);
      if (record.appRoot !== appRoot) {
        throw new Error(`Tyrian managed app root record does not own '${appRoot}'.`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (isUnsupportedManagedRootRecord(content)) {
        if (mode === 'diagnostic') {
          accumulator.registryDiagnostics.push(reason);
          continue;
        }
        throw new IslandShellFailure('corrupt', reason);
      }
      corrupt = true;
      if (mode === 'diagnostic') {
        accumulator.registryDiagnostics.push(reason);
      }
    }

    if (accumulator.roots.some((candidate) => candidate.appRoot === appRoot)) {
      const reason = `Tyrian managed app root '${appRoot}' is registered more than once.`;
      if (mode === 'diagnostic') {
        accumulator.registryDiagnostics.push(reason);
        continue;
      }
      throw new Error(reason);
    }

    accumulator.roots.push({
      appRoot,
      recordGeneration: { ...recordGeneration, corrupt },
    });
  }

  for (const entry of entries) {
    if (recordNames.has(entry.name) || temporaryNames.has(entry.name)) continue;
    const recordPath = path.join(directoryPath, entry.name);
    const validRecordName = /^[0-9a-f]{64}\.json$/u.test(entry.name);
    const stats = await lstatIfExists(recordPath);
    if (stats === undefined) continue;

    if (!validRecordName || !stats.isFile() || stats.isSymbolicLink()) {
      const reason = `Tyrian managed app root record is invalid at '${recordPath}'.`;
      if (mode === 'diagnostic') {
        accumulator.registryDiagnostics.push(reason);
        continue;
      }
      if (mode === 'restore' && (stats.isFile() || stats.isSymbolicLink())) {
        const generation = registryRecordGenerationFromStats(recordPath, stats, undefined, true);
        await quarantineManagedRootRecordAndRecord(
          recordPath,
          environment,
          generation,
          accumulator
        );
        continue;
      }
      throw new Error(reason);
    }
  }

  accumulator.roots.sort((left, right) => left.appRoot.localeCompare(right.appRoot));
}

function handleRegistryReadIssue(
  reason: string,
  options: RegistryEnumerationAccumulator & { tolerateDiagnostics: boolean }
): void {
  if (!options.tolerateDiagnostics) throw new Error(reason);
  options.registryDiagnostics.push(reason);
}

async function readRegistryRecordGeneration(
  recordPath: string,
  corrupt: boolean,
  identityPath = recordPath
): Promise<RegistryRecordGeneration> {
  const corruptCanonical = corrupt
    ? await readCorruptCanonicalRegistryStats(recordPath)
    : undefined;
  if (corruptCanonical !== undefined) {
    return registryRecordGenerationFromStats(identityPath, corruptCanonical, undefined, true);
  }
  const sourcePath =
    (await durableMetadataSourcePath(recordPath, 'managed app root record')) ?? recordPath;
  const before = await fs.lstat(sourcePath);
  let content: string | undefined;
  if (before.isFile() && !before.isSymbolicLink()) {
    try {
      content = await fs.readFile(sourcePath, 'utf8');
    } catch (error) {
      if (!corrupt) throw error;
    }
  }
  const after = await lstatIfExists(sourcePath);
  const afterSourcePath = await durableMetadataSourcePath(recordPath, 'managed app root record');
  if (
    after === undefined ||
    afterSourcePath !== sourcePath ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    Number(before.mode) !== Number(after.mode)
  ) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian managed app root record changed during generation inspection at '${recordPath}'.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  return registryRecordGenerationFromStats(identityPath, after, content, corrupt);
}

/**
 * Registry quarantine moves corrupt symlink entries with rename and never
 * follows them. Metadata publication remains regular-file-only: this narrow
 * admission exists only when its fixed predecessor and candidate are absent,
 * so corrupt canonical data cannot hide durable publication evidence.
 */
async function readCorruptCanonicalRegistryStats(
  recordPath: string
): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  const paths = durableMetadataPaths(recordPath);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const before = await lstatIfExists(recordPath);
    if (before === undefined || !before.isSymbolicLink()) return undefined;

    await assertNoLegacyDurableRemovalEvidence(recordPath, 'managed app root record');
    const [retired, candidate, after] = await Promise.all([
      lstatIfExists(paths.retiredPath),
      lstatIfExists(paths.candidatePath),
      lstatIfExists(recordPath),
    ]);
    if (retired !== undefined || candidate !== undefined) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian managed app root record has durable publication evidence beside a corrupt canonical record at '${recordPath}'.`,
        { mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
    await assertNoLegacyDurableRemovalEvidence(recordPath, 'managed app root record');
    if (
      after !== undefined &&
      after.isSymbolicLink() &&
      before.dev === after.dev &&
      before.ino === after.ino &&
      Number(before.mode) === Number(after.mode)
    ) {
      return after;
    }
  }
  throw new IslandShellFailure(
    'blocked',
    `Tyrian corrupt managed app root record changed during no-follow inspection at '${recordPath}'.`,
    { mutation: { externalDrift: true, incompleteRecovery: true } }
  );
}

function registryRecordGenerationFromStats(
  recordPath: string,
  stats: Awaited<ReturnType<typeof fs.lstat>>,
  content: string | undefined,
  corrupt: boolean
): RegistryRecordGeneration {
  return {
    recordPath,
    dev: stats.dev,
    ino: stats.ino,
    mode: Number(stats.mode),
    content,
    corrupt,
  };
}

function sameRegistryRecordGeneration(
  left: RegistryRecordGeneration,
  right: RegistryRecordGeneration
): boolean {
  return (
    left.recordPath === right.recordPath &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.content === right.content
  );
}

function regularFileGenerationFromRegistry(
  generation: RegistryRecordGeneration
): Extract<RegularFileGeneration, { kind: 'present' }> {
  if (generation.content === undefined) {
    throw new Error(
      `Tyrian managed app root record is not a readable regular file at '${generation.recordPath}'.`
    );
  }
  return {
    kind: 'present',
    device: String(generation.dev),
    inode: String(generation.ino),
    mode: generation.mode,
    content: generation.content,
  };
}

async function quarantineManagedRootRecordAndRecord(
  recordPath: string,
  environment: IslandShellEnvironment | undefined,
  expected: RegistryRecordGeneration,
  accumulator: RegistryEnumerationAccumulator
): Promise<void> {
  try {
    const quarantinePath = await quarantineManagedRootRecord(recordPath, environment, expected);
    accumulator.quarantinedRecords?.push(quarantinePath);
  } catch (error) {
    if (error instanceof IslandRegistryQuarantineError) {
      accumulator.quarantinedRecords?.push(error.quarantinePath);
    }
    throw error;
  }
}

async function quarantineManagedRootRecord(
  recordPath: string,
  environment: IslandShellEnvironment | undefined,
  expected: RegistryRecordGeneration
): Promise<string> {
  const corruptCanonical = await readCorruptCanonicalRegistryStats(recordPath);
  let current: RegistryRecordGeneration;
  if (corruptCanonical === undefined) {
    await settleDurableMetadataPublication(recordPath, 'managed app root record');
    current = await readRegistryRecordGeneration(recordPath, expected.corrupt);
  } else {
    current = registryRecordGenerationFromStats(recordPath, corruptCanonical, undefined, true);
  }
  if (!sameRegistryRecordGeneration(current, expected)) {
    throw new Error(`Tyrian managed app root record changed before quarantine at '${recordPath}'.`);
  }

  const quarantineDirectory = buildQuarantinedRootsDirectoryPath(environment?.registryHome);
  await fs.mkdir(quarantineDirectory, { recursive: true });
  const quarantinePath = path.join(
    quarantineDirectory,
    `${path.basename(recordPath, '.json')}-${crypto.randomUUID()}.json`
  );
  await fs.rename(recordPath, quarantinePath);
  const movedGeneration = await readRegistryRecordGeneration(
    quarantinePath,
    expected.corrupt,
    recordPath
  );
  if (!sameRegistryRecordGeneration(movedGeneration, expected)) {
    const restored = await restoreRetiredGeneration(quarantinePath, recordPath);
    throw new IslandShellFailure(
      'blocked',
      `Tyrian managed app root record changed across quarantine at '${recordPath}'${restored ? '.' : `; the moved generation remains at '${quarantinePath}'.`}`,
      { mutation: { externalDrift: true, incompleteRecovery: !restored } }
    );
  }
  try {
    await syncDirectories([path.dirname(recordPath), quarantineDirectory]);
  } catch (error) {
    throw new IslandRegistryQuarantineError(quarantinePath, error);
  }
  return quarantinePath;
}

async function identifyManagedRootRecord(
  content: string,
  recordPath: string,
  environment?: IslandShellEnvironment
): Promise<string> {
  let parsed: { appRoot?: unknown };
  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch {
    throw new Error(`Tyrian managed app root record is invalid JSON at '${recordPath}'.`);
  }
  if (typeof parsed.appRoot !== 'string' || !path.isAbsolute(parsed.appRoot)) {
    throw new Error(
      `Tyrian managed app root record has no identifiable app root at '${recordPath}'.`
    );
  }
  const appRoot = await canonicalizeAppRoot(parsed.appRoot);
  if (appRoot !== parsed.appRoot || getManagedRootRecordPath(appRoot, environment) !== recordPath) {
    throw new Error(`Tyrian managed app root record identity is invalid at '${recordPath}'.`);
  }
  return appRoot;
}

function parseManagedRootRecord(content: string, recordPath: string): ManagedRootRecord {
  let parsed: { version?: unknown; appRoot?: unknown; desiredThemeId?: unknown };

  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch {
    throw new Error(`Tyrian managed app root record is invalid JSON at '${recordPath}'.`);
  }

  if (
    parsed.version !== MANAGED_ROOT_RECORD_VERSION ||
    typeof parsed.appRoot !== 'string' ||
    parsed.appRoot.trim().length === 0 ||
    !path.isAbsolute(parsed.appRoot)
  ) {
    throw new Error(
      `Tyrian managed app root record is invalid: expected version ${MANAGED_ROOT_RECORD_VERSION} with an absolute appRoot at '${recordPath}'.`
    );
  }

  if (
    parsed.desiredThemeId !== null &&
    (typeof parsed.desiredThemeId !== 'string' ||
      !/^[a-z0-9][a-z0-9-]*\.css$/u.test(parsed.desiredThemeId))
  ) {
    throw new Error(
      `Tyrian managed app root record is invalid: version ${MANAGED_ROOT_RECORD_VERSION} requires a CSS asset desiredThemeId at '${recordPath}'.`
    );
  }

  return parsed as ManagedRootRecord;
}

function isUnsupportedManagedRootRecord(content: string): boolean {
  try {
    return (JSON.parse(content) as { version?: unknown }).version !== MANAGED_ROOT_RECORD_VERSION;
  } catch {
    return false;
  }
}

export function isCurrentManagedRootRegistration(registration: ManagedRootRegistration): boolean {
  return registration.kind === 'valid' || registration.kind === 'corrupt';
}

function serializeManagedRootRecord(appRoot: string, desiredThemeId: string | null): string {
  const record: ManagedRootRecord = {
    version: MANAGED_ROOT_RECORD_VERSION,
    appRoot,
    desiredThemeId,
  };
  return JSON.stringify(record, null, 2).concat('\n');
}

export function readDesiredThemeId(
  registration: ManagedRootRegistration
): string | null | undefined {
  return registration.kind === 'valid' ? registration.desiredThemeId : undefined;
}

/** Run admission before registry creation while retaining its mutation lock. */
export async function initializeIslandRegistry(
  environment: IslandShellEnvironment,
  admit: () => Promise<void>
): Promise<boolean> {
  return withRegistryLock(environment, async () => {
    await admit();
    return initializeManagedRootsForMutationUnlocked(environment);
  });
}

export async function assertManagedRootsReadable(
  environment: IslandShellEnvironment
): Promise<void> {
  await readManagedAppRootsReadOnly(environment, {
    roots: [],
    registryDiagnostics: [],
    tolerateDiagnostics: false,
  });
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
  const directory = getManagedRootsDirectoryPath(environment);
  return [
    ...[path.dirname(directory), directory].map((directory) => ({
      path: directory,
      existingMode: fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK,
      missingParentMode: fsConstants.W_OK | fsConstants.X_OK,
    })),
    {
      path: getManagedRootRecordPath(appRoot, environment),
      existingMode: fsConstants.R_OK,
      optional: true,
    },
  ];
}

export async function assertIslandRegistrationApplicable(
  appRoot: string,
  environment: IslandShellEnvironment
): Promise<void> {
  await readManagedAppRootsForMutationStrict(environment);
  const registration = await readManagedAppRootRegistration(appRoot, environment);
  if (registration.kind === 'corrupt' || registration.kind === 'unsupported') {
    throw new IslandShellFailure('corrupt', registration.reason);
  }
}
