import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, expect, test } from 'bun:test';

import {
  IslandLockActionReleaseError,
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

test('a successful action survives release loss and a throwing warning observer', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-lock-release-test-'));
  const lockKey = path.join(testRoot, 'release.lock');
  let warningCalls = 0;
  let releaseCalls = 0;

  try {
    const result = await withIslandProcessLockCore(lockKey, async () => ({ changed: true }), {
      unlinkClaim: async (claimPath) => {
        releaseCalls += 1;
        if (releaseCalls === 1) throw new Error('injected release loss');
        await fs.unlink(claimPath);
      },
      onReleaseWarning: () => {
        warningCalls += 1;
        throw new Error('injected warning observer failure');
      },
    });

    expect(result).toEqual({ changed: true });
    expect(warningCalls).toBe(1);
    await waitForMissingPath(lockKey);
  } finally {
    await fs.rm(testRoot, { force: true, recursive: true });
  }
});

test('action and release failure are reported as one typed aggregate', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-lock-dual-failure-test-'));
  const lockKey = path.join(testRoot, 'dual-failure.lock');
  const actionError = Object.assign(new Error('action failed'), { changed: true });

  try {
    try {
      await withIslandProcessLockCore(
        lockKey,
        async () => {
          throw actionError;
        },
        { unlinkClaim: async () => Promise.reject(new Error('release failed')) }
      );
      throw new Error('Expected the action and release to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(IslandLockActionReleaseError);
      expect((error as IslandLockActionReleaseError).changed).toBe(true);
    }
  } finally {
    await fs.rm(testRoot, { force: true, recursive: true });
  }
});

async function waitForMissingPath(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fs.stat(filePath);
    } catch {
      return;
    }
    await delay(10);
  }
  throw new Error(`Path was not removed by deferred release: ${filePath}`);
}

async function listReaperArtifacts(claimPath: string): Promise<string[]> {
  const prefix = `${path.basename(claimPath)}.reap-`;
  return (await fs.readdir(path.dirname(claimPath))).filter((entry) => entry.startsWith(prefix));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
