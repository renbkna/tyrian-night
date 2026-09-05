import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {
  isAlreadyExistsError,
  isFileNotFoundError,
  IslandShellFailure,
  describeIslandShellFailure,
  findNestedError,
  IslandPartialMutationError,
} from './islandShellContract.js';
import path from 'node:path';
import { type IslandMutationFacts, mergeIslandMutationFacts } from './islandSupervisorCore.js';

const ANY_FILE_GENERATION = Symbol('any-file-generation');

type RegularFileIdentity =
  | { kind: 'absent' }
  | { kind: 'present'; device: string; inode: string; mode: number };

export type RegularFileGeneration =
  | { kind: 'absent' }
  | (Extract<RegularFileIdentity, { kind: 'present' }> & { content: string });

class IslandDurablePublicationFailure extends Error {
  readonly publicationChanged = true;

  constructor(filePath: string, cause: unknown) {
    super(`Tyrian published a new durable generation at '${filePath}' before a later failure.`, {
      cause,
    });
    this.name = 'IslandDurablePublicationFailure';
  }
}

export function sha256Base64(content: string): string {
  return crypto.hash('sha256', content, 'base64').replace(/=+$/, '');
}

/** Escape a literal fragment embedded by the Island parser's regular expressions. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export async function restoreRetiredGeneration(
  retiredPath: string,
  targetPath: string
): Promise<boolean> {
  try {
    await fs.link(retiredPath, targetPath);
    await fs.unlink(retiredPath);
    return true;
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    return false;
  }
}

export async function canonicalizeAppRoot(appRoot: string): Promise<string> {
  if (appRoot.trim().length === 0) {
    throw new Error('Tyrian VS Code app root must not be empty.');
  }

  const resolved = path.resolve(appRoot);

  try {
    return await fs.realpath(resolved);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return resolved;
    }

    throw error;
  }
}

export async function writeDurableFileExclusive(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, 'wx');

  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeDurableJsonFile(
  filePath: string,
  value: unknown,
  expectedGeneration: RegularFileGeneration | typeof ANY_FILE_GENERATION = ANY_FILE_GENERATION
): Promise<RegularFileGeneration> {
  return writeDurableTextFile(filePath, serializeDurableJson(value), expectedGeneration);
}

export function serializeDurableJson(value: unknown): string {
  return JSON.stringify(value, null, 2).concat('\n');
}

export async function readRegularFileGeneration(
  filePath: string,
  description = 'durable publication target'
): Promise<RegularFileGeneration> {
  const before = await lstatIfExists(filePath);
  if (before === undefined) return { kind: 'absent' };
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian ${description} is not an owned regular file at '${filePath}'.`
    );
  }
  const content = await fs.readFile(filePath, 'utf8');
  const after = await lstatIfExists(filePath);
  if (
    after === undefined ||
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    Number(before.mode) !== Number(after.mode)
  ) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian ${description} changed during inspection at '${filePath}'.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  return {
    kind: 'present',
    device: String(after.dev),
    inode: String(after.ino),
    mode: Number(after.mode),
    content,
  };
}

export function sameRegularFileGeneration(
  left: RegularFileGeneration,
  right: RegularFileGeneration
): boolean {
  return (
    sameRegularFileIdentity(left, right) &&
    (left.kind === 'absent' || (right.kind === 'present' && left.content === right.content))
  );
}

type DurableMetadataPaths = {
  canonicalPath: string;
  retiredPath: string;
  candidatePath: string;
};

type DurableMetadataState = DurableMetadataTopology<RegularFileGeneration>;

type DurableMetadataTopology<T = RegularFileIdentity> = DurableMetadataPaths & {
  canonical: T;
  retired: T;
  candidate: T;
};

/**
 * Metadata publication has one bounded namespace. The canonical name is the
 * reader authority; its fixed retired predecessor keeps the last complete
 * record readable across the only intentional canonical-name gap, and the
 * fixed candidate is disposable until it is linked into canonical.
 */
export function durableMetadataPaths(filePath: string): DurableMetadataPaths {
  const directory = path.dirname(filePath);
  const baseName = path.basename(filePath);
  return {
    canonicalPath: filePath,
    retiredPath: path.join(directory, `.tyrian-night-retired-${baseName}.tmp`),
    candidatePath: path.join(directory, `.tyrian-night-candidate-${baseName}.tmp`),
  };
}

/**
 * Before metadata publication used a UUID-named retirement path. It cannot
 * prove which generation was moved after a crash, so current owners preserve
 * that bounded legacy evidence and require manual recovery rather than
 * treating its missing canonical name as clean.
 */
export async function assertNoLegacyDurableRemovalEvidence(
  filePath: string,
  description: string
): Promise<void> {
  const directoryPath = path.dirname(filePath);
  let entries: string[];
  try {
    entries = await fs.readdir(directoryPath);
  } catch (error) {
    if (isFileNotFoundError(error)) return;
    throw error;
  }
  const baseName = escapeRegExp(path.basename(filePath));
  const legacyPattern = new RegExp(
    String.raw`^\.tyrian-night-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}-retired-${baseName}\.tmp$`,
    'iu'
  );
  const legacyName = entries.find((entry) => legacyPattern.test(entry));
  if (legacyName === undefined) return;
  const legacyPath = path.join(directoryPath, legacyName);
  throw new IslandShellFailure(
    'blocked',
    `Tyrian ${description} has legacy unproved deletion evidence at '${legacyPath}' and left it intact.`,
    { mutation: { externalDrift: true, incompleteRecovery: true } }
  );
}

async function readDurableMetadataState(
  filePath: string,
  description = 'durable metadata target'
): Promise<DurableMetadataState> {
  await assertNoLegacyDurableRemovalEvidence(filePath, description);
  const paths = durableMetadataPaths(filePath);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const before = await readDurableMetadataTopology(filePath, description);
    try {
      const [canonical, retired, candidate] = await Promise.all([
        readRegularFileGeneration(paths.canonicalPath, description),
        readRegularFileGeneration(paths.retiredPath, `retired ${description}`),
        readRegularFileGeneration(paths.candidatePath, `candidate ${description}`),
      ]);
      const after = await readDurableMetadataTopology(filePath, description);
      if (
        sameDurableMetadataTopology(before, after) &&
        sameRegularFileIdentity(canonical, after.canonical) &&
        sameRegularFileIdentity(retired, after.retired) &&
        sameRegularFileIdentity(candidate, after.candidate)
      ) {
        return { ...paths, canonical, retired, candidate };
      }
    } catch (error) {
      if (!isFileNotFoundError(error)) throw error;
    }
  }
  throw new IslandShellFailure(
    'blocked',
    `Tyrian ${description} changed while reading its durable metadata publication.`,
    { mutation: { externalDrift: true, incompleteRecovery: true } }
  );
}

/** Read-only callers never recreate a canonical name. */
export async function readDurableMetadataGeneration(
  filePath: string,
  description = 'durable metadata target'
): Promise<RegularFileGeneration> {
  const state = await readDurableMetadataState(filePath, description);
  assertDurableMetadataReadable(state, sameRegularFileGeneration, description);
  return state.canonical.kind === 'present' ? state.canonical : state.retired;
}

async function readRegularFileIdentity(
  filePath: string,
  description: string
): Promise<RegularFileIdentity> {
  const stats = await lstatIfExists(filePath);
  if (stats === undefined) return { kind: 'absent' };
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian ${description} is not an owned regular file at '${filePath}'.`
    );
  }
  return {
    kind: 'present',
    device: String(stats.dev),
    inode: String(stats.ino),
    mode: Number(stats.mode),
  };
}

function sameRegularFileIdentity(left: RegularFileIdentity, right: RegularFileIdentity): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === 'absent' ||
      (right.kind === 'present' &&
        left.device === right.device &&
        left.inode === right.inode &&
        left.mode === right.mode))
  );
}

async function readDurableMetadataTopology(
  filePath: string,
  description: string
): Promise<DurableMetadataTopology> {
  const paths = durableMetadataPaths(filePath);
  // Canonical first is intentional. A writer moves canonical to retired in
  // one rename, so this order cannot manufacture a false both-absent state
  // by sampling retired before that rename and canonical after it.
  const canonical = await readRegularFileIdentity(paths.canonicalPath, description);
  const retired = await readRegularFileIdentity(paths.retiredPath, `retired ${description}`);
  const candidate = await readRegularFileIdentity(paths.candidatePath, `candidate ${description}`);
  return { ...paths, canonical, retired, candidate };
}

function sameDurableMetadataTopology(
  left: DurableMetadataTopology,
  right: DurableMetadataTopology
): boolean {
  return (
    sameRegularFileIdentity(left.canonical, right.canonical) &&
    sameRegularFileIdentity(left.retired, right.retired) &&
    sameRegularFileIdentity(left.candidate, right.candidate)
  );
}

async function readStableDurableMetadataTopology(
  filePath: string,
  description: string
): Promise<DurableMetadataTopology> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const before = await readDurableMetadataTopology(filePath, description);
    const after = await readDurableMetadataTopology(filePath, description);
    if (sameDurableMetadataTopology(before, after)) return after;
  }
  throw new IslandShellFailure(
    'blocked',
    `Tyrian ${description} changed while reading its durable metadata topology.`,
    { mutation: { externalDrift: true, incompleteRecovery: true } }
  );
}

/** Both content reads and path-only discovery use this publication admission rule. */
function assertDurableMetadataReadable<T extends RegularFileIdentity>(
  topology: DurableMetadataTopology<T>,
  sameGeneration: (left: T, right: T) => boolean,
  description: string
): void {
  if (topology.canonical.kind === 'absent' || topology.retired.kind === 'absent') return;
  if (sameGeneration(topology.canonical, topology.retired)) return;
  if (
    topology.candidate.kind !== 'absent' &&
    sameGeneration(topology.canonical, topology.candidate)
  ) {
    return;
  }
  throw new IslandShellFailure(
    'blocked',
    `Tyrian ${description} has ambiguous canonical and retired generations and left both intact.`,
    { mutation: { externalDrift: true, incompleteRecovery: true } }
  );
}

/** Choose a readable logical source without consuming its content twice. */
export async function durableMetadataSourcePath(
  filePath: string,
  description = 'durable metadata target'
): Promise<string | undefined> {
  await assertNoLegacyDurableRemovalEvidence(filePath, description);
  const topology = await readStableDurableMetadataTopology(filePath, description);
  assertDurableMetadataReadable(topology, sameRegularFileIdentity, description);
  if (topology.canonical.kind === 'present') return topology.canonicalPath;
  if (topology.retired.kind === 'present') return topology.retiredPath;
  return undefined;
}

/**
 * A lock owner resolves only the bounded publication states. Candidate-only
 * evidence is pre-publication scratch. A canonical replacement that does not
 * match its candidate is left intact as external ambiguity.
 */
export async function settleDurableMetadataPublication(
  filePath: string,
  description = 'durable metadata target'
): Promise<RegularFileGeneration> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let state = await readDurableMetadataState(filePath, description);
    assertDurableMetadataReadable(state, sameRegularFileGeneration, description);

    if (state.canonical.kind === 'absent') {
      if (state.retired.kind === 'absent') {
        if (state.candidate.kind !== 'absent') {
          await removeDurableMetadataScratch(state.candidatePath, state.candidate, description);
          continue;
        }
        return state.canonical;
      }

      try {
        await fs.link(state.retiredPath, state.canonicalPath);
      } catch (error) {
        if (isAlreadyExistsError(error)) continue;
        throw error;
      }
      await syncDirectory(path.dirname(filePath));
      state = await readDurableMetadataState(filePath, description);
      if (!sameRegularFileGeneration(state.canonical, state.retired)) {
        throw new IslandShellFailure(
          'blocked',
          `Tyrian durable metadata predecessor changed while reifying '${filePath}'.`,
          { mutation: { externalDrift: true, incompleteRecovery: true } }
        );
      }

      // Reification produces canonical == retired. Use the same cleanup below
      // whether this owner linked it or a previous owner stopped after linking.
    }

    if (state.retired.kind !== 'absent') {
      if (sameRegularFileGeneration(state.canonical, state.retired)) {
        if (state.candidate.kind !== 'absent') {
          await removeDurableMetadataScratch(state.candidatePath, state.candidate, description);
        }
        await removeDurableMetadataScratch(state.retiredPath, state.retired, description);
        continue;
      }
      // Admission proved canonical == candidate. Keep that proof until the
      // predecessor is gone, including across a crash during cleanup.
      await removeDurableMetadataScratch(state.retiredPath, state.retired, description);
      await removeDurableMetadataScratch(state.candidatePath, state.candidate, description);
      continue;
    }

    if (state.candidate.kind !== 'absent') {
      await removeDurableMetadataScratch(state.candidatePath, state.candidate, description);
      continue;
    }

    return state.canonical;
  }

  throw new IslandShellFailure(
    'blocked',
    `Tyrian durable metadata publication did not settle at '${filePath}'.`,
    { mutation: { externalDrift: true, incompleteRecovery: true } }
  );
}

async function removeDurableMetadataScratch(
  filePath: string,
  expected: RegularFileGeneration,
  description: string
): Promise<void> {
  const current = await readRegularFileGeneration(filePath, `cleanup ${description}`);
  if (!sameRegularFileGeneration(current, expected)) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian durable metadata scratch changed before cleanup at '${filePath}'.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  if (current.kind === 'absent') return;
  await fs.unlink(filePath);
  await syncDirectory(path.dirname(filePath));
}

async function writeDurableTextFile(
  filePath: string,
  content: string,
  expectedGeneration: RegularFileGeneration | typeof ANY_FILE_GENERATION = ANY_FILE_GENERATION
): Promise<RegularFileGeneration> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const paths = durableMetadataPaths(filePath);
  const initialGeneration = await settleDurableMetadataPublication(filePath);
  if (
    expectedGeneration !== ANY_FILE_GENERATION &&
    !sameRegularFileGeneration(initialGeneration, expectedGeneration)
  ) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian durable publication target changed before staging at '${filePath}'.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  let published = false;
  let retired = false;
  let primaryFailure: unknown;

  try {
    await writeDurableFileExclusive(paths.candidatePath, content);
    await syncDirectory(path.dirname(filePath));
    const candidateGeneration = await readRegularFileGeneration(
      paths.candidatePath,
      `candidate durable publication '${filePath}'`
    );
    if (initialGeneration.kind === 'present') {
      await fs.rename(paths.canonicalPath, paths.retiredPath);
      retired = true;
      await syncDirectory(path.dirname(filePath));
      const movedGeneration = await readRegularFileGeneration(paths.retiredPath);
      if (!sameRegularFileGeneration(movedGeneration, initialGeneration)) {
        retired = !(await restoreRetiredGeneration(paths.retiredPath, paths.canonicalPath));
        throw new IslandShellFailure(
          'blocked',
          `Tyrian durable publication target changed across retirement at '${filePath}'.`,
          { mutation: { externalDrift: true, incompleteRecovery: true } }
        );
      }
    }
    try {
      await fs.link(paths.candidatePath, paths.canonicalPath);
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      throw new IslandShellFailure(
        'blocked',
        `Tyrian durable publication observed a replacement generation at '${filePath}' and preserved it.`,
        { cause: error, mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
    published = true;
    await syncDirectory(path.dirname(filePath));
    const currentGeneration = await readRegularFileGeneration(paths.canonicalPath);
    if (!sameRegularFileGeneration(currentGeneration, candidateGeneration)) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian durable publication target changed across canonical link at '${filePath}'.`,
        { mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
    if (retired) {
      await fs.unlink(paths.retiredPath);
      retired = false;
    }
    await fs.unlink(paths.candidatePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    if (published) {
      const failure = describeIslandShellFailure(error);
      primaryFailure = new IslandDurablePublicationFailure(
        filePath,
        new IslandShellFailure(failure.code, failure.reason, {
          cause: error,
          mutation: { incompleteRecovery: true },
        })
      );
    } else {
      primaryFailure = error;
    }
  }

  if (retired && primaryFailure !== undefined) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian durable publication preserved its prior generation at '${paths.retiredPath}'.`,
      { cause: primaryFailure, mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  return readRegularFileGeneration(paths.canonicalPath);
}

export async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await fs.open(directoryPath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncDirectories(directoryPaths: string[]): Promise<void> {
  for (const directoryPath of new Set(directoryPaths)) {
    await syncDirectory(directoryPath);
  }
}

export async function removeFileDurably(
  filePath: string,
  mutation: Partial<IslandMutationFacts> = {},
  expectedGeneration: RegularFileGeneration
): Promise<boolean> {
  const initialGeneration = await settleDurableMetadataPublication(filePath, 'removal target');
  if (!sameRegularFileGeneration(initialGeneration, expectedGeneration)) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian removal target changed before retirement at '${filePath}'.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  if (initialGeneration.kind === 'absent') return false;
  const paths = durableMetadataPaths(filePath);
  await fs.rename(filePath, paths.retiredPath);
  await syncDirectory(path.dirname(filePath));
  const movedGeneration = await readRegularFileGeneration(
    paths.retiredPath,
    'retired removal target'
  );
  if (!sameRegularFileGeneration(movedGeneration, initialGeneration)) {
    const restored = await restoreRetiredGeneration(paths.retiredPath, filePath);
    throw new IslandShellFailure(
      'blocked',
      `Tyrian removal target changed across retirement at '${filePath}'${restored ? '.' : `; the moved generation remains at '${paths.retiredPath}'.`}`,
      { mutation: { externalDrift: true, incompleteRecovery: !restored } }
    );
  }

  try {
    await fs.unlink(paths.retiredPath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    const failure = describeIslandShellFailure(error);
    throw new IslandShellFailure(failure.code, failure.reason, {
      cause: error,
      mutation: mergeIslandMutationFacts(mutation, { incompleteRecovery: true }),
    });
  }

  return true;
}

export async function writeIfChanged(
  filePath: string,
  content: string,
  mutation: Partial<IslandMutationFacts> = {},
  expectedGeneration: RegularFileGeneration | typeof ANY_FILE_GENERATION = ANY_FILE_GENERATION
): Promise<boolean> {
  const currentGeneration = await settleDurableMetadataPublication(filePath);
  if (
    expectedGeneration !== ANY_FILE_GENERATION &&
    !sameRegularFileGeneration(currentGeneration, expectedGeneration)
  ) {
    throw new IslandShellFailure(
      'blocked',
      `Tyrian durable publication target changed before comparison at '${filePath}'.`,
      { mutation: { externalDrift: true, incompleteRecovery: true } }
    );
  }
  const currentContent =
    currentGeneration.kind === 'present' ? currentGeneration.content : undefined;

  if (currentContent === content) {
    const confirmedGeneration = await readDurableMetadataGeneration(filePath);
    if (!sameRegularFileGeneration(confirmedGeneration, currentGeneration)) {
      throw new IslandShellFailure(
        'blocked',
        `Tyrian durable publication target changed during no-op comparison at '${filePath}'.`,
        { mutation: { externalDrift: true, incompleteRecovery: true } }
      );
    }
    return false;
  }

  try {
    await writeDurableTextFile(filePath, content, currentGeneration);
  } catch (error) {
    if (
      findNestedError(error, (candidate) =>
        candidate instanceof IslandDurablePublicationFailure ? candidate : undefined
      ) === undefined
    ) {
      throw error;
    }
    throw new IslandPartialMutationError(
      `Tyrian durable publication changed '${filePath}' but did not complete cleanly.`,
      mutation,
      { cause: error }
    );
  }
  return true;
}

export async function readTextFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

export async function lstatIfExists(
  filePath: string
): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return undefined;
    }

    throw error;
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}
