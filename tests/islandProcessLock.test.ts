import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, expect, test } from 'bun:test';

import {
  IslandLockActionReleaseError,
  IslandLockReleaseError,
  withIslandProcessLockCore,
} from '../apps/vscode/src/islandProcessLockCore';
import { withIslandProcessLock } from '../apps/vscode/src/islandProcessLock';

type LockChild = ReturnType<typeof Bun.spawn>;

const children = new Set<LockChild>();

afterEach(() => {
  for (const child of children) {
    child.kill(9);
  }
  children.clear();
});

test('an action-side acquisition-shaped error is propagated without retrying the owned action', async () => {
  const lockKey = path.join(
    os.tmpdir(),
    `tyrian-action-error-${process.pid}-${crypto.randomUUID()}.lock`
  );
  const actionError = Object.assign(new Error('owned action failed'), { code: 'EEXIST' });
  let actionCalls = 0;

  const result = withIslandProcessLock(lockKey, async () => {
    actionCalls += 1;
    throw actionError;
  });

  await expect(result).rejects.toBe(actionError);
  expect(actionCalls).toBe(1);
});

test('a process death lets the next owner reclaim the same token claim', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-process-lock-test-'));
  const lockKey = path.join(testRoot, 'root.lock');
  const moduleUrl = pathToFileURL(path.resolve('apps/vscode/src/islandProcessLock.ts')).toString();
  const childScript = `
    import { withIslandProcessLock } from ${JSON.stringify(moduleUrl)};
    await withIslandProcessLock(process.env.TYRIAN_TEST_LOCK_KEY, async () => {
      process.stdout.write('LOCKED\\n');
      await new Promise(() => {});
    });
  `;
  const child = Bun.spawn([process.execPath, '-e', childScript], {
    env: { ...process.env, TYRIAN_TEST_LOCK_KEY: lockKey },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.add(child);

  try {
    await waitForChildLock(child);

    let nextOwnerEntered = false;
    const nextOwner = withIslandProcessLock(lockKey, async () => {
      nextOwnerEntered = true;
    });

    await delay(80);
    expect(nextOwnerEntered).toBe(false);

    child.kill(9);
    await child.exited;
    children.delete(child);

    await nextOwner;
    expect(nextOwnerEntered).toBe(true);
    await expect(fs.stat(lockKey)).rejects.toThrow();
    expect(await listReaperArtifacts(lockKey)).toEqual([]);
  } finally {
    child.kill(9);
    children.delete(child);
    await fs.rm(testRoot, { force: true, recursive: true });
  }
});

test('a reused live pid does not impersonate the recorded process generation', async () => {
  if (process.platform !== 'linux') return;

  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-process-generation-test-'));
  const lockKey = path.join(testRoot, 'reused-pid.lock');
  await fs.writeFile(
    lockKey,
    JSON.stringify({
      version: 2,
      pid: process.pid,
      token: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      processIdentity: 'different-boot:different-start-time',
    }).concat('\n'),
    'utf8'
  );

  try {
    await expect(withIslandProcessLock(lockKey, async () => 'reclaimed')).resolves.toBe(
      'reclaimed'
    );
    await expect(fs.stat(lockKey)).rejects.toThrow();
  } finally {
    await fs.rm(testRoot, { force: true, recursive: true });
  }
});

async function waitForChildLock(child: LockChild): Promise<void> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let stdout = '';

  await Promise.race([
    (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          const stderr = await new Response(child.stderr).text();
          throw new Error(
            `Child exited before acquiring lock (exit ${String(await child.exited)}). stderr: ${stderr}`
          );
        }
        stdout += decoder.decode(value, { stream: true });
        if (stdout.includes('LOCKED\n')) return;
      }
    })(),
    delay(5_000).then(() => {
      throw new Error('Child did not acquire the token claim within 5 seconds.');
    }),
  ]);
}

test('distinct lock paths remain isolated without bounded-key collisions', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-lock-isolation-test-'));
  const firstKey = path.join(testRoot, 'first.lock');
  const secondKey = path.join(testRoot, 'second.lock');
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  const firstIsEntered = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  const holdFirst = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  try {
    const firstOwner = withIslandProcessLock(firstKey, async () => {
      firstEntered();
      await holdFirst;
    });
    await firstIsEntered;

    let secondEntered = false;
    await withIslandProcessLock(secondKey, async () => {
      secondEntered = true;
      expect(await fs.stat(firstKey)).toBeDefined();
    });

    expect(secondEntered).toBe(true);
    releaseFirst();
    await firstOwner;
  } finally {
    releaseFirst();
    await fs.rm(testRoot, { force: true, recursive: true });
  }
});

test('claim inspection fails closed after bounded continuous replacement', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-lock-inspection-bound-test-'));
  const lockKey = path.join(testRoot, 'continuous-replacement.lock');
  let replacements = 0;

  try {
    await expect(
      withIslandProcessLockCore(lockKey, async () => undefined, {
        onClaimReadBeforeVerification: async (claimPath) => {
          if (claimPath !== lockKey) return;
          const replacementPath = `${lockKey}.replacement-${replacements}`;
          replacements += 1;
          await fs.writeFile(replacementPath, `replacement ${replacements}\n`, 'utf8');
          await fs.rename(replacementPath, lockKey);
        },
      })
    ).rejects.toThrow('changed continuously during bounded inspection');
    expect(replacements).toBe(8);
  } finally {
    await fs.rm(testRoot, { force: true, recursive: true });
  }
});

test('concurrent dead-owner reapers elect once and never unlink a replacement generation', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-lock-reaper-test-'));
  const lockKey = path.join(testRoot, 'shared.lock');
  await fs.writeFile(
    lockKey,
    JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      token: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    }).concat('\n'),
    'utf8'
  );
  let activeOwners = 0;
  let maximumActiveOwners = 0;

  try {
    await Promise.all(
      Array.from({ length: 12 }, () =>
        withIslandProcessLock(lockKey, async () => {
          activeOwners += 1;
          maximumActiveOwners = Math.max(maximumActiveOwners, activeOwners);
          await delay(5);
          activeOwners -= 1;
        })
      )
    );

    expect(maximumActiveOwners).toBe(1);
    await expect(fs.stat(lockKey)).rejects.toThrow();
    expect(await listReaperArtifacts(lockKey)).toEqual([]);
  } finally {
    await fs.rm(testRoot, { force: true, recursive: true });
  }
});

test('an old unidentifiable claim fails closed and is never stolen by age', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-lock-unknown-test-'));
  const lockKey = path.join(testRoot, 'unknown.lock');
  await fs.writeFile(lockKey, 'unknown owner format\n', 'utf8');
  await fs.utimes(lockKey, new Date(0), new Date(0));

  try {
    await expect(
      withIslandProcessLockCore(lockKey, async () => undefined, { timeoutMs: 80, retryMs: 5 })
    ).rejects.toThrow('cannot be proven safe to reclaim');
    expect(await fs.readFile(lockKey, 'utf8')).toBe('unknown owner format\n');
  } finally {
    await fs.rm(testRoot, { force: true, recursive: true });
  }
});

test('a PID-only live claim is reported as ambiguous within the acquisition bound', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-lock-pid-only-test-'));
  const lockKey = path.join(testRoot, 'pid-only.lock');
  await fs.writeFile(
    lockKey,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      token: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    }).concat('\n'),
    'utf8'
  );

  try {
    await expect(
      withIslandProcessLockCore(lockKey, async () => undefined, { timeoutMs: 60, retryMs: 5 })
    ).rejects.toThrow('ambiguous PID-only process identity');
    expect(await fs.readFile(lockKey, 'utf8')).toContain(`"pid":${process.pid}`);
  } finally {
    await fs.rm(testRoot, { force: true, recursive: true });
  }
});

test('a parseable crash-left owner candidate is scavenged before acquisition', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-lock-candidate-test-'));
  const lockKey = path.join(testRoot, 'candidate.lock');
  const token = crypto.randomUUID();
  const candidatePath = path.join(testRoot, `.${path.basename(lockKey)}.${token}.owner`);
  await fs.writeFile(
    candidatePath,
    JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      token,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    }).concat('\n'),
    'utf8'
  );

  try {
    await expect(withIslandProcessLock(lockKey, async () => 'acquired')).resolves.toBe('acquired');
    await expect(fs.stat(candidatePath)).rejects.toThrow();
  } finally {
    await fs.rm(testRoot, { force: true, recursive: true });
  }
});

test('cyclic persisted reaper metadata fails within the acquisition bound', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-lock-cycle-test-'));
  const lockKey = path.join(testRoot, 'cycle.lock');
  const claimContent = JSON.stringify({
    version: 1,
    pid: 2_147_483_647,
    token: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  }).concat('\n');
  await fs.writeFile(lockKey, claimContent, 'utf8');
  const stats = await fs.lstat(lockKey);
  const owner = JSON.parse(claimContent) as { token: string };
  const expected = {
    dev: String(stats.dev),
    ino: String(stats.ino),
    contentHash: crypto.createHash('sha256').update(claimContent, 'utf8').digest('hex'),
    ownerToken: owner.token,
  };
  const generationId = crypto
    .createHash('sha256')
    .update(
      `${expected.dev}:${expected.ino}:${expected.contentHash}:${expected.ownerToken}`,
      'utf8'
    )
    .digest('hex');
  const firstToken = crypto.randomUUID();
  const secondToken = crypto.randomUUID();
  const records = [
    { token: firstToken, predecessorToken: null },
    { token: secondToken, predecessorToken: firstToken },
    { token: firstToken, predecessorToken: secondToken },
  ];

  for (const [index, record] of records.entries()) {
    const suffix =
      index === 0
        ? ''
        : `-${crypto.createHash('sha256').update(String(record.predecessorToken), 'utf8').digest('hex')}`;
    await fs.writeFile(
      `${lockKey}.reap-${generationId}${suffix}`,
      JSON.stringify({
        version: 1,
        expected,
        reaper: {
          version: 1,
          pid: 2_147_483_647,
          token: record.token,
          createdAt: new Date().toISOString(),
        },
        predecessorToken: record.predecessorToken,
      }).concat('\n'),
      'utf8'
    );
  }

  try {
    await expect(
      withIslandProcessLockCore(lockKey, async () => undefined, { timeoutMs: 60, retryMs: 5 })
    ).rejects.toThrow('cyclic reaper token');
  } finally {
    await fs.rm(testRoot, { force: true, recursive: true });
  }
});

test('a crashed parseable reaper generation is resumed without stealing a replacement', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-lock-dead-reaper-test-'));
  const lockKey = path.join(testRoot, 'shared.lock');
  const claimContent = JSON.stringify({
    version: 1,
    pid: 2_147_483_647,
    token: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  }).concat('\n');
  const claimOwner = JSON.parse(claimContent) as { token: string };
  await fs.writeFile(lockKey, claimContent, 'utf8');
  const claimStats = await fs.lstat(lockKey);
  const expected = {
    dev: String(claimStats.dev),
    ino: String(claimStats.ino),
    contentHash: crypto.createHash('sha256').update(claimContent, 'utf8').digest('hex'),
    ownerToken: claimOwner.token,
  };
  const generationId = crypto
    .createHash('sha256')
    .update(
      `${expected.dev}:${expected.ino}:${expected.contentHash}:${expected.ownerToken}`,
      'utf8'
    )
    .digest('hex');
  const electionPath = `${lockKey}.reap-${generationId}`;
  await fs.writeFile(
    electionPath,
    JSON.stringify({
      version: 1,
      expected,
      reaper: {
        version: 1,
        pid: 2_147_483_647,
        token: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      },
      predecessorToken: null,
    }).concat('\n'),
    'utf8'
  );

  try {
    await expect(withIslandProcessLock(lockKey, async () => 'recovered')).resolves.toBe(
      'recovered'
    );
    await expect(fs.stat(lockKey)).rejects.toThrow();
    expect(await listReaperArtifacts(lockKey)).toEqual([]);
  } finally {
    await fs.rm(testRoot, { force: true, recursive: true });
  }
});

test('a live reaper barrier blocks publication and entry until validated cleanup completes', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-lock-barrier-test-'));
  const lockKey = path.join(testRoot, 'shared.lock');
  const deadClaim = JSON.stringify({
    version: 1,
    pid: 2_147_483_647,
    token: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  }).concat('\n');
  await fs.writeFile(lockKey, deadClaim, 'utf8');
  let releaseReaper!: () => void;
  let signalValidated!: () => void;
  const reaperMayFinish = new Promise<void>((resolve) => {
    releaseReaper = resolve;
  });
  const reaperValidated = new Promise<void>((resolve) => {
    signalValidated = resolve;
  });
  const entries: string[] = [];

  try {
    const first = withIslandProcessLockCore(
      lockKey,
      async () => {
        entries.push('first');
      },
      {
        onReaperValidated: async () => {
          signalValidated();
          await reaperMayFinish;
        },
      }
    );
    await reaperValidated;

    const second = withIslandProcessLock(lockKey, async () => {
      entries.push('second');
    });
    await delay(80);
    expect(entries).toEqual([]);
    expect(await fs.readFile(lockKey, 'utf8')).toBe(deadClaim);
    expect((await listReaperArtifacts(lockKey)).length).toBeGreaterThan(0);

    releaseReaper();
    await Promise.all([first, second]);
    expect(entries).toEqual(['first', 'second']);
    expect(await listReaperArtifacts(lockKey)).toEqual([]);
    await expect(fs.stat(lockKey)).rejects.toThrow();
  } finally {
    releaseReaper();
    await fs.rm(testRoot, { force: true, recursive: true });
  }
});

test('release restores a replacement moved across the final generation boundary', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-lock-release-race-test-'));
  const lockKey = path.join(testRoot, 'release-race.lock');
  const replacement = 'external replacement generation\n';

  try {
    await expect(
      withIslandProcessLockCore(lockKey, async () => 'completed', {
        renameClaim: async (claimPath, retirementPath) => {
          await fs.rm(claimPath);
          await fs.writeFile(claimPath, replacement, 'utf8');
          await fs.rename(claimPath, retirementPath);
        },
      })
    ).rejects.toMatchObject({
      name: IslandLockReleaseError.name,
      releaseError: expect.objectContaining({
        message: expect.stringContaining('generation changed during retirement'),
      }),
    });
    expect(await fs.readFile(lockKey, 'utf8')).toBe(replacement);
    expect((await fs.readdir(testRoot)).filter((entry) => entry.includes('.retired-'))).toEqual([]);
  } finally {
    await fs.rm(testRoot, { force: true, recursive: true });
  }
});

test('reaper restores a replacement moved across the final generation boundary', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-lock-reaper-race-test-'));
  const lockKey = path.join(testRoot, 'reaper-race.lock');
  const replacement = 'external replacement generation\n';
  await fs.writeFile(
    lockKey,
    JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      token: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    }).concat('\n'),
    'utf8'
  );

  try {
    await expect(
      withIslandProcessLockCore(lockKey, async () => undefined, {
        timeoutMs: 40,
        retryMs: 5,
        renameClaim: async (claimPath, retirementPath) => {
          await fs.rm(claimPath);
          await fs.writeFile(claimPath, replacement, 'utf8');
          await fs.rename(claimPath, retirementPath);
        },
      })
    ).rejects.toThrow('generation changed during retirement');
    expect(await fs.readFile(lockKey, 'utf8')).toBe(replacement);
    expect((await fs.readdir(testRoot)).filter((entry) => entry.includes('.retired-'))).toEqual([]);
  } finally {
    await fs.rm(testRoot, { force: true, recursive: true });
  }
});

test('release cannot report success while retirement cleanup remains', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-lock-retirement-cleanup-test-'));
  const lockKey = path.join(testRoot, 'release-cleanup.lock');
  let retirementPath: string | undefined;
  let cleanupCalls = 0;

  try {
    await expect(
      withIslandProcessLockCore(lockKey, async () => 'completed', {
        retryMs: 1,
        unlinkRetiredClaim: async (candidatePath) => {
          retirementPath = candidatePath;
          cleanupCalls += 1;
          throw Object.assign(new Error('injected retirement cleanup failure'), { code: 'EACCES' });
        },
      })
    ).rejects.toMatchObject({
      name: IslandLockReleaseError.name,
      releaseError: expect.objectContaining({
        message: expect.stringContaining('retirement cleanup remains'),
      }),
    });
    expect(cleanupCalls).toBe(3);
    await expect(fs.stat(lockKey)).rejects.toThrow();
    expect(retirementPath).toBeDefined();
    expect(await fs.readFile(retirementPath!, 'utf8')).toContain('"token"');
  } finally {
    await fs.rm(testRoot, { force: true, recursive: true });
  }
});

test('reaper exposes a retirement cleanup artifact instead of hiding it', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-reaper-retirement-test-'));
  const lockKey = path.join(testRoot, 'reaper-cleanup.lock');
  let retirementPath: string | undefined;
  let cleanupCalls = 0;
  await fs.writeFile(
    lockKey,
    JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      token: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    }).concat('\n'),
    'utf8'
  );

  try {
    await expect(
      withIslandProcessLockCore(lockKey, async () => undefined, {
        retryMs: 1,
        unlinkRetiredClaim: async (candidatePath) => {
          retirementPath = candidatePath;
          cleanupCalls += 1;
          throw Object.assign(new Error('injected retirement cleanup failure'), { code: 'EACCES' });
        },
      })
    ).rejects.toThrow('retirement cleanup remains');
    expect(cleanupCalls).toBe(3);
    await expect(fs.stat(lockKey)).rejects.toThrow();
    expect(retirementPath).toBeDefined();
    expect(await fs.readFile(retirementPath!, 'utf8')).toContain('"token"');
  } finally {
    await fs.rm(testRoot, { force: true, recursive: true });
  }
});

test('a transient release failure is retried synchronously before success is reported', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-lock-release-test-'));
  const lockKey = path.join(testRoot, 'release.lock');
  let warningCalls = 0;
  let releaseCalls = 0;

  try {
    const result = await withIslandProcessLockCore(lockKey, async () => ({ changed: true }), {
      renameClaim: async (claimPath, retirementPath) => {
        releaseCalls += 1;
        if (releaseCalls === 1) throw new Error('injected release loss');
        await fs.rename(claimPath, retirementPath);
      },
      onReleaseWarning: () => {
        warningCalls += 1;
        throw new Error('injected warning observer failure');
      },
    });

    expect(result).toEqual({ changed: true });
    expect(warningCalls).toBe(0);
    expect(releaseCalls).toBe(2);
    await expect(fs.stat(lockKey)).rejects.toThrow();
  } finally {
    await fs.rm(testRoot, { force: true, recursive: true });
  }
});

test('persistent release failure after success is observable with a bounded failure ceiling', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-lock-release-bound-test-'));
  const lockKey = path.join(testRoot, 'release-bound.lock');
  let releaseCalls = 0;

  try {
    await expect(
      withIslandProcessLockCore(
        lockKey,
        async () => ({
          ...mutationFacts({ physicalChanged: true }),
          value: 'completed',
        }),
        {
          retryMs: 1,
          renameClaim: async () => {
            releaseCalls += 1;
            throw new Error('persistent release failure');
          },
        }
      )
    ).rejects.toMatchObject({
      name: IslandLockReleaseError.name,
      physicalChanged: true,
      incompleteRecovery: true,
    });
    expect(releaseCalls).toBe(3);
    expect(await fs.stat(lockKey)).toBeDefined();
  } finally {
    await fs.rm(testRoot, { force: true, recursive: true });
  }
});

test('action and release failure are reported as one typed aggregate', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-lock-dual-failure-test-'));
  const lockKey = path.join(testRoot, 'dual-failure.lock');
  const actionError = Object.assign(new Error('action failed'), {
    ...mutationFacts({ physicalChanged: true }),
  });

  try {
    try {
      await withIslandProcessLockCore(
        lockKey,
        async () => {
          throw actionError;
        },
        { renameClaim: async () => Promise.reject(new Error('release failed')) }
      );
      throw new Error('Expected the action and release to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(IslandLockActionReleaseError);
      expect((error as IslandLockActionReleaseError).changed).toBe(true);
      expect((error as IslandLockActionReleaseError).incompleteRecovery).toBe(true);
    }
  } finally {
    await fs.rm(testRoot, { force: true, recursive: true });
  }
});

async function listReaperArtifacts(claimPath: string): Promise<string[]> {
  const prefix = `${path.basename(claimPath)}.reap-`;
  return (await fs.readdir(path.dirname(claimPath))).filter((entry) => entry.startsWith(prefix));
}

function mutationFacts(
  facts: Partial<{
    desiredStateChanged: boolean;
    registryChanged: boolean;
    physicalChanged: boolean;
    externalDrift: boolean;
    incompleteRecovery: boolean;
  }> = {}
) {
  const result = {
    desiredStateChanged: facts.desiredStateChanged ?? false,
    registryChanged: facts.registryChanged ?? false,
    physicalChanged: facts.physicalChanged ?? false,
    externalDrift: facts.externalDrift ?? false,
    incompleteRecovery: facts.incompleteRecovery ?? false,
  };
  return {
    ...result,
    changed: result.desiredStateChanged || result.registryChanged || result.physicalChanged,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
