import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { readIslandMutationFacts } from './islandSupervisorCore.js';

const DEFAULT_LOCK_RETRY_MS = 20;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_RELEASE_ATTEMPTS = 3;
const DEFAULT_CLAIM_INSPECTION_ATTEMPTS = 8;
const MAX_REAPER_CHAIN_LENGTH = 128;
const heldLockContext = new AsyncLocalStorage<ReadonlySet<string>>();

type LockOwner = {
  version: 3;
  pid: number;
  token: string;
  createdAt: string;
  processIdentity: string | null;
};

type ClaimGeneration = {
  dev: number | bigint;
  ino: number | bigint;
  contentHash: string | undefined;
  owner: LockOwner | undefined;
};

type SerializedClaimGeneration = {
  dev: string;
  ino: string;
  contentHash: string;
  ownerToken: string;
};

type ReaperElectionRecord = {
  version: 2;
  expected: SerializedClaimGeneration;
  reaper: LockOwner;
  predecessorToken: string | null;
};

export type IslandLockReleaseWarning = {
  claimPath: string;
  message: string;
  cause: unknown;
};

export type IslandProcessLockCoreOptions = {
  timeoutMs?: number;
  retryMs?: number;
  onReleaseWarning?: (warning: IslandLockReleaseWarning) => void;
  onReaperValidated?: () => Promise<void>;
  onClaimReadBeforeVerification?: (claimPath: string) => Promise<void>;
  renameClaim?: (claimPath: string, retirementPath: string) => Promise<void>;
  unlinkRetiredClaim?: (retirementPath: string) => Promise<void>;
};

export class IslandLockActionReleaseError extends AggregateError {
  readonly islandLifecycleFailure = 'lock-release' as const;
  readonly actionError: unknown;
  readonly releaseError: unknown;
  readonly changed: boolean;
  readonly desiredStateChanged: boolean;
  readonly registryChanged: boolean;
  readonly physicalChanged: boolean;
  readonly externalDrift: boolean;
  readonly incompleteRecovery = true;

  constructor(claimPath: string, actionError: unknown, releaseError: unknown) {
    super(
      [actionError, releaseError],
      `Tyrian action and lock release both failed at '${claimPath}'.`
    );
    this.name = 'IslandLockActionReleaseError';
    this.actionError = actionError;
    this.releaseError = releaseError;
    const facts = readIslandMutationFacts(actionError);
    this.desiredStateChanged = facts.desiredStateChanged;
    this.registryChanged = facts.registryChanged;
    this.physicalChanged = facts.physicalChanged;
    this.externalDrift = facts.externalDrift;
    this.changed = facts.changed;
  }
}

export class IslandLockReleaseError<T> extends Error {
  readonly islandLifecycleFailure = 'lock-release' as const;
  readonly actionResult: T;
  readonly releaseError: unknown;
  readonly changed: boolean;
  readonly desiredStateChanged: boolean;
  readonly registryChanged: boolean;
  readonly physicalChanged: boolean;
  readonly externalDrift: boolean;
  readonly incompleteRecovery = true;

  constructor(claimPath: string, actionResult: T, releaseError: unknown) {
    super(`Tyrian action completed, but lock release failed at '${claimPath}'.`, {
      cause: releaseError,
    });
    this.name = 'IslandLockReleaseError';
    this.actionResult = actionResult;
    this.releaseError = releaseError;
    const facts = readIslandMutationFacts(actionResult);
    this.desiredStateChanged = facts.desiredStateChanged;
    this.registryChanged = facts.registryChanged;
    this.physicalChanged = facts.physicalChanged;
    this.externalDrift = facts.externalDrift;
    this.changed = facts.changed;
  }
}

export function isIslandLockLifecycleFailure(error: unknown): boolean {
  const pending = [error];
  const visited = new Set<unknown>();

  while (pending.length > 0) {
    const candidate = pending.shift();
    if (candidate === undefined || visited.has(candidate)) continue;
    visited.add(candidate);

    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      'islandLifecycleFailure' in candidate &&
      candidate.islandLifecycleFailure === 'lock-release'
    ) {
      return true;
    }
    if (candidate instanceof AggregateError) pending.push(...candidate.errors);
    if (candidate instanceof Error && candidate.cause !== undefined) pending.push(candidate.cause);
  }

  return false;
}

export async function withIslandProcessLockCore<T>(
  claimPath: string,
  action: () => Promise<T>,
  options: IslandProcessLockCoreOptions = {}
): Promise<T> {
  const heldLocks = heldLockContext.getStore();
  if (heldLocks?.has(claimPath)) {
    return action();
  }

  const generation = await acquireClaim(claimPath, options);
  const nextHeld = new Set(heldLocks ?? []);
  nextHeld.add(claimPath);

  let value: T;
  try {
    value = await heldLockContext.run(nextHeld, action);
  } catch (actionError) {
    try {
      await releaseClaimWithRetry(claimPath, generation, options);
    } catch (releaseError) {
      throw new IslandLockActionReleaseError(claimPath, actionError, releaseError);
    }
    throw actionError;
  }

  try {
    await releaseClaimWithRetry(claimPath, generation, options);
  } catch (releaseError) {
    const warning: IslandLockReleaseWarning = {
      claimPath,
      message: `Tyrian action completed, but lock release failed at '${claimPath}' after bounded retries.`,
      cause: releaseError,
    };
    try {
      options.onReleaseWarning?.(warning);
    } catch {
      // Warning observers cannot change the already-completed action result.
    }
    throw new IslandLockReleaseError(claimPath, value, releaseError);
  }

  return value;
}

async function acquireClaim(
  claimPath: string,
  options: IslandProcessLockCoreOptions
): Promise<ClaimGeneration> {
  await scavengeOwnerCandidates(claimPath);
  const owner = createLockOwner();
  const candidatePath = ownerCandidatePath(claimPath, owner.token);
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_LOCK_RETRY_MS;

  await writeOwnerCandidate(candidatePath, owner);

  try {
    while (true) {
      if (!(await settleReaperBarriers(claimPath, options))) {
        if (Date.now() - startedAt >= timeoutMs) {
          throw new Error(`Timed out waiting for Tyrian reaper barrier at '${claimPath}'.`);
        }
        await delay(retryMs);
        continue;
      }

      try {
        await fs.link(candidatePath, claimPath);
        const generation = await inspectClaim(claimPath, options.onClaimReadBeforeVerification);

        if (generation === undefined || generation.owner?.token !== owner.token) {
          throw new Error(`Tyrian lock publication could not be verified at '${claimPath}'.`);
        }

        if (!(await settleReaperBarriers(claimPath, options))) {
          await releaseClaim(
            claimPath,
            generation,
            options.renameClaim,
            options.unlinkRetiredClaim,
            retryMs
          );
          await delay(retryMs);
          continue;
        }

        const published = await inspectClaim(claimPath, options.onClaimReadBeforeVerification);
        if (published === undefined || !sameGeneration(published, generation)) {
          continue;
        }

        return generation;
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') {
          throw error;
        }
      }

      const generation = await inspectClaim(claimPath, options.onClaimReadBeforeVerification);
      if (generation === undefined) continue;

      if (generation.owner === undefined) {
        if (Date.now() - startedAt >= timeoutMs) {
          throw new Error(
            `Tyrian lock claim '${claimPath}' is unidentifiable and cannot be proven safe to reclaim.`
          );
        }
      } else if (classifyProcessOwner(generation.owner) === 'dead') {
        await beginReaperElection(claimPath, generation, options);
        continue;
      } else if (Date.now() - startedAt >= timeoutMs) {
        const ownerState = classifyProcessOwner(generation.owner);
        throw new Error(
          ownerState === 'ambiguous'
            ? `Tyrian lock claim '${claimPath}' has ambiguous process identity and cannot be proven safe to reclaim within ${timeoutMs}ms.`
            : `Timed out waiting for Tyrian lock '${claimPath}' owned by process ${generation.owner.pid}.`
        );
      }

      await delay(retryMs);
    }
  } finally {
    await fs.rm(candidatePath, { force: true });
  }
}

async function beginReaperElection(
  claimPath: string,
  expected: ClaimGeneration,
  options: IslandProcessLockCoreOptions
): Promise<void> {
  if (expected.owner === undefined || expected.contentHash === undefined) {
    throw new Error(`Tyrian lock claim '${claimPath}' cannot be identified for reaping.`);
  }
  const current = await inspectClaim(claimPath, options.onClaimReadBeforeVerification);
  if (current === undefined || !sameGeneration(current, expected)) return;

  const serialized = serializeClaimGeneration(expected);
  const generationId = serializedGenerationId(serialized);
  const electionPath = `${claimPath}.reap-${generationId}`;
  const record: ReaperElectionRecord = {
    version: 2,
    expected: serialized,
    reaper: createLockOwner(),
    predecessorToken: null,
  };

  if (await publishElection(electionPath, record)) {
    await finishReaperElection(claimPath, generationId, record, options);
  } else {
    await settleReaperBarriers(claimPath, options);
  }
}

async function settleReaperBarriers(
  claimPath: string,
  options: IslandProcessLockCoreOptions
): Promise<boolean> {
  while (true) {
    const generationIds = await listReaperGenerationIds(claimPath);
    if (generationIds.length === 0) return true;

    let progressed = false;
    for (const generationId of generationIds) {
      const result = await settleReaperGeneration(claimPath, generationId, options);
      progressed ||= result;
    }
    if (!progressed) return false;
  }
}

async function settleReaperGeneration(
  claimPath: string,
  generationId: string,
  options: IslandProcessLockCoreOptions
): Promise<boolean> {
  const elections = await readReaperElectionChain(claimPath, generationId);
  if (elections.length === 0) return true;
  const tip = elections.at(-1)!;

  const reaperState = classifyProcessOwner(tip.record.reaper);
  if (reaperState !== 'dead') return false;

  const successor: ReaperElectionRecord = {
    version: 2,
    expected: tip.record.expected,
    reaper: createLockOwner(),
    predecessorToken: tip.record.reaper.token,
  };
  const successorPath = `${claimPath}.reap-${generationId}-${crypto
    .createHash('sha256')
    .update(tip.record.reaper.token, 'utf8')
    .digest('hex')}`;

  if (!(await publishElection(successorPath, successor))) return true;
  await finishReaperElection(claimPath, generationId, successor, options);
  return true;
}

async function finishReaperElection(
  claimPath: string,
  generationId: string,
  election: ReaperElectionRecord,
  options: IslandProcessLockCoreOptions
): Promise<void> {
  try {
    let current = await inspectClaim(claimPath, options.onClaimReadBeforeVerification);
    if (current === undefined || !matchesSerializedGeneration(current, election.expected)) return;

    await options.onReaperValidated?.();
    current = await inspectClaim(claimPath, options.onClaimReadBeforeVerification);
    if (current === undefined || !matchesSerializedGeneration(current, election.expected)) return;
    await retireClaimGeneration(
      claimPath,
      current,
      options.renameClaim,
      options.unlinkRetiredClaim,
      options.retryMs ?? DEFAULT_LOCK_RETRY_MS
    );
  } finally {
    await removeReaperElectionChain(claimPath, generationId);
  }
}

async function publishElection(
  electionPath: string,
  record: ReaperElectionRecord
): Promise<boolean> {
  const candidatePath = ownerCandidatePath(electionPath, record.reaper.token);
  await writeDurableCandidate(candidatePath, record);

  try {
    await fs.link(candidatePath, electionPath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') return false;
    throw error;
  } finally {
    await fs.rm(candidatePath, { force: true });
  }
}

async function listReaperGenerationIds(claimPath: string): Promise<string[]> {
  const paths = await listReaperElectionPaths(claimPath);
  const prefix = `${path.basename(claimPath)}.reap-`;
  return [
    ...new Set(
      paths.map((electionPath) =>
        path.basename(electionPath).slice(prefix.length, prefix.length + 64)
      )
    ),
  ].sort();
}

async function listReaperElectionPaths(
  claimPath: string,
  generationId?: string
): Promise<string[]> {
  const directoryPath = path.dirname(claimPath);
  const baseName = path.basename(claimPath);
  const generationPattern = generationId ?? '[0-9a-f]{64}';
  const pattern = new RegExp(
    `^${escapeRegExp(baseName)}\\.reap-${generationPattern}(?:-[0-9a-f]{64})?$`,
    'u'
  );
  const entries = await fs.readdir(directoryPath);
  return entries
    .filter((entry) => pattern.test(entry))
    .map((entry) => path.join(directoryPath, entry))
    .sort();
}

async function readReaperElectionChain(
  claimPath: string,
  generationId: string
): Promise<Array<{ path: string; record: ReaperElectionRecord }>> {
  const paths = await listReaperElectionPaths(claimPath, generationId);
  const elections: Array<{ path: string; record: ReaperElectionRecord }> = [];
  for (const electionPath of paths) {
    const record = await readReaperElectionRecord(electionPath, generationId);
    if (record !== undefined) elections.push({ path: electionPath, record });
  }
  if (elections.length === 0) return [];
  if (elections.length > MAX_REAPER_CHAIN_LENGTH) {
    throw new Error(
      `Tyrian reaper election '${generationId}' exceeds the ${MAX_REAPER_CHAIN_LENGTH}-record recovery bound.`
    );
  }

  const uniqueTokens = new Set(elections.map(({ record }) => record.reaper.token));
  if (uniqueTokens.size !== elections.length) {
    throw new Error(`Tyrian reaper election '${generationId}' contains a cyclic reaper token.`);
  }

  const chain: Array<{ path: string; record: ReaperElectionRecord }> = [];
  let current = elections.find(({ record }) => record.predecessorToken === null);
  if (current === undefined) {
    throw new Error(`Tyrian reaper election '${generationId}' has no root record.`);
  }

  const visitedPaths = new Set<string>();
  while (current !== undefined) {
    if (visitedPaths.has(current.path)) {
      throw new Error(`Tyrian reaper election '${generationId}' contains a cycle.`);
    }
    visitedPaths.add(current.path);
    chain.push(current);
    const successors = elections.filter(
      ({ record }) => record.predecessorToken === current!.record.reaper.token
    );
    if (successors.length > 1) {
      throw new Error(`Tyrian reaper election '${generationId}' has competing successors.`);
    }
    current = successors[0];
  }

  if (chain.length !== elections.length) {
    throw new Error(`Tyrian reaper election '${generationId}' contains a disconnected record.`);
  }
  return chain;
}

async function readReaperElectionRecord(
  electionPath: string,
  generationId: string
): Promise<ReaperElectionRecord | undefined> {
  let parsed: Partial<ReaperElectionRecord>;
  let content: string;
  try {
    content = await fs.readFile(electionPath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    parsed = JSON.parse(content) as Partial<ReaperElectionRecord>;
  } catch {
    throw new Error(
      `Tyrian reaper election '${electionPath}' is unidentifiable and cannot be recovered safely.`
    );
  }

  const reaper = parseLockOwnerValue(parsed.reaper);
  const expected = parsed.expected;
  if (
    parsed.version !== 2 ||
    reaper === undefined ||
    (parsed.predecessorToken !== null &&
      (typeof parsed.predecessorToken !== 'string' ||
        !/^[0-9a-f-]{36}$/iu.test(parsed.predecessorToken))) ||
    expected === undefined ||
    typeof expected.dev !== 'string' ||
    typeof expected.ino !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(expected.contentHash) ||
    !/^[0-9a-f-]{36}$/iu.test(expected.ownerToken) ||
    serializedGenerationId(expected) !== generationId
  ) {
    throw new Error(
      `Tyrian reaper election '${electionPath}' is unidentifiable and cannot be recovered safely.`
    );
  }

  return {
    version: 2,
    expected,
    reaper,
    predecessorToken: parsed.predecessorToken,
  };
}

async function removeReaperElectionChain(claimPath: string, generationId: string): Promise<void> {
  const chain = await readReaperElectionChain(claimPath, generationId);

  for (const { path: electionPath } of chain.toReversed()) {
    try {
      await fs.unlink(electionPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    }
    await syncDirectory(path.dirname(claimPath));
  }
}

function serializeClaimGeneration(generation: ClaimGeneration): SerializedClaimGeneration {
  if (generation.owner === undefined || generation.contentHash === undefined) {
    throw new Error('Tyrian cannot serialize an unidentifiable lock generation.');
  }
  return {
    dev: String(generation.dev),
    ino: String(generation.ino),
    contentHash: generation.contentHash,
    ownerToken: generation.owner.token,
  };
}

function matchesSerializedGeneration(
  generation: ClaimGeneration,
  expected: SerializedClaimGeneration
): boolean {
  return (
    String(generation.dev) === expected.dev &&
    String(generation.ino) === expected.ino &&
    generation.contentHash === expected.contentHash &&
    generation.owner?.token === expected.ownerToken
  );
}

function serializedGenerationId(generation: SerializedClaimGeneration): string {
  return crypto
    .createHash('sha256')
    .update(
      `${generation.dev}:${generation.ino}:${generation.contentHash}:${generation.ownerToken}`,
      'utf8'
    )
    .digest('hex');
}

function createLockOwner(): LockOwner {
  return {
    version: 3,
    pid: process.pid,
    token: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    processIdentity: readLinuxProcessIdentity(process.pid) ?? null,
  };
}

function ownerCandidatePath(targetPath: string, token: string): string {
  return path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${token}.owner`);
}

async function scavengeOwnerCandidates(claimPath: string): Promise<void> {
  const directoryPath = path.dirname(claimPath);
  const baseName = path.basename(claimPath);
  const pattern = new RegExp(
    String.raw`^\.${escapeRegExp(baseName)}(?:\.reap-[0-9a-f]{64}(?:-[0-9a-f]{64})?)?\.[0-9a-f-]{36}\.owner$`,
    'iu'
  );
  const entries = await fs.readdir(directoryPath);
  let removed = false;

  for (const entry of entries) {
    if (!pattern.test(entry)) continue;
    const candidatePath = path.join(directoryPath, entry);
    const before = await lstatIfExists(candidatePath);
    if (before === undefined || !before.isFile() || before.isSymbolicLink()) continue;

    let value: unknown;
    try {
      value = JSON.parse(await fs.readFile(candidatePath, 'utf8'));
    } catch {
      continue;
    }

    const after = await lstatIfExists(candidatePath);
    if (after === undefined || before.dev !== after.dev || before.ino !== after.ino) continue;
    const owner = parseLockOwnerValue(value) ?? readReaperOwnerValue(value);
    if (
      owner === undefined ||
      Date.now() - Date.parse(owner.createdAt) < DEFAULT_LOCK_TIMEOUT_MS ||
      classifyProcessOwner(owner) !== 'dead'
    ) {
      continue;
    }

    try {
      await fs.unlink(candidatePath);
      removed = true;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    }
  }

  if (removed) await syncDirectory(directoryPath);
}

function readReaperOwnerValue(value: unknown): LockOwner | undefined {
  if (typeof value !== 'object' || value === null || !('reaper' in value)) return undefined;
  return parseLockOwnerValue(value.reaper);
}

async function writeOwnerCandidate(candidatePath: string, owner: LockOwner): Promise<void> {
  return writeDurableCandidate(candidatePath, owner);
}

async function writeDurableCandidate(candidatePath: string, value: unknown): Promise<void> {
  const handle = await fs.open(candidatePath, 'wx');

  try {
    await handle.writeFile(JSON.stringify(value).concat('\n'), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function inspectClaim(
  claimPath: string,
  onReadBeforeVerification?: (claimPath: string) => Promise<void>
): Promise<ClaimGeneration | undefined> {
  for (let attempt = 1; attempt <= DEFAULT_CLAIM_INSPECTION_ATTEMPTS; attempt += 1) {
    const before = await lstatIfExists(claimPath);
    if (before === undefined) return undefined;

    let content: string | undefined;
    if (before.isFile() && !before.isSymbolicLink()) {
      try {
        content = await fs.readFile(claimPath, 'utf8');
      } catch {
        content = undefined;
      }
    }

    await onReadBeforeVerification?.(claimPath);
    const after = await lstatIfExists(claimPath);
    if (after === undefined) return undefined;
    if (before.dev !== after.dev || before.ino !== after.ino) continue;

    return {
      dev: after.dev,
      ino: after.ino,
      contentHash:
        content === undefined
          ? undefined
          : crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
      owner: content === undefined ? undefined : parseLockOwner(content),
    };
  }

  throw new Error(
    `Tyrian lock claim '${claimPath}' changed continuously during bounded inspection.`
  );
}

async function releaseClaim(
  claimPath: string,
  expected: ClaimGeneration,
  renameClaim: ((claimPath: string, retirementPath: string) => Promise<void>) | undefined,
  unlinkRetiredClaim: ((retirementPath: string) => Promise<void>) | undefined,
  retryMs: number
): Promise<void> {
  const current = await inspectClaim(claimPath);
  if (current === undefined || !sameGeneration(current, expected)) {
    throw new Error(`Tyrian lock generation changed before release at '${claimPath}'.`);
  }

  await retireClaimGeneration(claimPath, expected, renameClaim, unlinkRetiredClaim, retryMs);
}

async function retireClaimGeneration(
  claimPath: string,
  expected: ClaimGeneration,
  renameClaim: ((claimPath: string, retirementPath: string) => Promise<void>) | undefined,
  unlinkRetiredClaim: ((retirementPath: string) => Promise<void>) | undefined,
  retryMs: number
): Promise<void> {
  const retirementPath = `${claimPath}.retired-${crypto.randomUUID()}`;
  await (renameClaim ?? fs.rename)(claimPath, retirementPath);
  const retired = await inspectClaim(retirementPath);

  if (retired !== undefined && sameGeneration(retired, expected)) {
    await removeRetiredClaimWithRetry(retirementPath, unlinkRetiredClaim, retryMs);
    return;
  }

  if (retired === undefined) {
    throw new Error(`Tyrian lock retirement lost its moved generation at '${retirementPath}'.`);
  }

  try {
    await fs.link(retirementPath, claimPath);
    await fs.unlink(retirementPath);
  } catch (restoreError) {
    throw new Error(
      `Tyrian lock replacement was preserved at '${retirementPath}' but could not be restored to '${claimPath}'.`,
      { cause: restoreError }
    );
  }

  throw new Error(`Tyrian lock generation changed during retirement at '${claimPath}'.`);
}

async function removeRetiredClaimWithRetry(
  retirementPath: string,
  unlinkRetiredClaim: ((retirementPath: string) => Promise<void>) | undefined,
  retryMs: number
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= DEFAULT_RELEASE_ATTEMPTS; attempt += 1) {
    try {
      await (unlinkRetiredClaim ?? fs.unlink)(retirementPath);
      return;
    } catch (error) {
      if ((await lstatIfExists(retirementPath)) === undefined) return;
      lastError = error;
      if (attempt < DEFAULT_RELEASE_ATTEMPTS) await delay(retryMs);
    }
  }

  throw new Error(`Tyrian lock retirement cleanup remains at '${retirementPath}'.`, {
    cause: lastError,
  });
}

async function releaseClaimWithRetry(
  claimPath: string,
  generation: ClaimGeneration,
  options: IslandProcessLockCoreOptions
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= DEFAULT_RELEASE_ATTEMPTS; attempt += 1) {
    try {
      await releaseClaim(
        claimPath,
        generation,
        options.renameClaim,
        options.unlinkRetiredClaim,
        options.retryMs ?? DEFAULT_LOCK_RETRY_MS
      );
      return;
    } catch (error) {
      lastError = error;
      const current = await inspectClaim(claimPath);
      if (current === undefined) break;
      if (!sameGeneration(current, generation)) break;
      if (attempt < DEFAULT_RELEASE_ATTEMPTS) {
        await delay(options.retryMs ?? DEFAULT_LOCK_RETRY_MS);
      }
    }
  }

  throw lastError;
}

function sameGeneration(left: ClaimGeneration, right: ClaimGeneration): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.contentHash === right.contentHash &&
    left.owner?.token === right.owner?.token
  );
}

function parseLockOwner(content: string): LockOwner | undefined {
  try {
    return parseLockOwnerValue(JSON.parse(content));
  } catch {
    return undefined;
  }
}

function parseLockOwnerValue(value: unknown): LockOwner | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const owner = value as Partial<LockOwner>;
  if (
    owner.version !== 3 ||
    typeof owner.pid !== 'number' ||
    !Number.isInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.token !== 'string' ||
    !/^[0-9a-f-]{36}$/iu.test(owner.token) ||
    typeof owner.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(owner.createdAt)) ||
    (owner.processIdentity !== null &&
      (typeof owner.processIdentity !== 'string' || owner.processIdentity.length === 0))
  ) {
    return undefined;
  }
  return owner as LockOwner;
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await fs.open(directoryPath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

async function lstatIfExists(
  filePath: string
): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function classifyProcessOwner(owner: LockOwner): 'alive' | 'dead' | 'ambiguous' {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EPERM') return 'dead';
  }

  if (owner.processIdentity === null) return 'ambiguous';

  const currentIdentity = readLinuxProcessIdentity(owner.pid);
  if (currentIdentity === undefined) return 'ambiguous';
  return currentIdentity === owner.processIdentity ? 'alive' : 'dead';
}

function readLinuxProcessIdentity(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined;

  try {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd === -1) return undefined;
    const fieldsAfterCommand = stat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/u);
    const startTime = fieldsAfterCommand[19];

    return bootId && startTime ? `${bootId}:${startTime}` : undefined;
  } catch {
    return undefined;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
