import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { buildIslandLockPath, islandRegistryHome } from './islandPatchContract.js';
import { IslandShellFailure, isNodeError } from './islandShellContract.js';

/** Set in the child a lock tool runs, which already holds the lock. */
export const ISLAND_LOCK_HELD_ENV = 'TYRIAN_ISLAND_LOCK_HELD';
const LOCK_WAIT_SECONDS = 60;
/** EX_TEMPFAIL: flock's configured conflict status and BSD lockf's timeout status. */
const LOCK_TIMEOUT_EXIT_CODE = 75;
const PIPE_RETRY_MS = 250;

type PipeLock = { release(): Promise<void> };

/**
 * Run one CLI command while holding the per-user Island lock. The operating
 * system owns the lock and drops it however its holder exits, so it never goes
 * stale. Linux and macOS re-run this process under flock(1) or lockf(1): the
 * child runs `command` and this process exits with the child's status, or
 * throws a `blocked` failure when the lock stays held past the wait. Windows
 * listens on a named pipe, which exists only while its process lives, and runs
 * `command` here.
 */
export async function runUnderIslandLock(command: () => Promise<void>): Promise<void> {
  if (process.env[ISLAND_LOCK_HELD_ENV] === '1') {
    await command();
    return;
  }

  if (process.platform === 'win32') {
    const pipeIdentity = crypto.hash('sha256', islandRegistryHome(), 'hex').slice(0, 16);
    const lock = await holdPipeLock(
      `\\\\.\\pipe\\tyrian-night-island-${pipeIdentity}`,
      LOCK_WAIT_SECONDS
    );
    try {
      await command();
    } finally {
      await lock.release();
    }
    return;
  }

  process.exitCode = rerunUnderLockCommand();
}

function rerunUnderLockCommand(): number {
  const lockPath = buildIslandLockPath();
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const [tool, toolArgs] =
    process.platform === 'darwin'
      ? ['lockf', ['-k', '-t', String(LOCK_WAIT_SECONDS), lockPath]]
      : [
          'flock',
          [
            '--exclusive',
            '--wait',
            String(LOCK_WAIT_SECONDS),
            '--conflict-exit-code',
            String(LOCK_TIMEOUT_EXIT_CODE),
            lockPath,
          ],
        ];
  const child = spawnSync(
    tool,
    [...toolArgs, process.execPath, ...process.execArgv, ...process.argv.slice(1)],
    { stdio: 'inherit', env: { ...process.env, [ISLAND_LOCK_HELD_ENV]: '1' } }
  );

  if (child.error) {
    throw new IslandShellFailure(
      'unsupported',
      `Island UI requires ${tool}: ${child.error.message}`,
      {
        cause: child.error,
      }
    );
  }
  if (child.status === LOCK_TIMEOUT_EXIT_CODE) {
    throw lockTimeout();
  }
  return child.status ?? 1;
}

/**
 * Hold a lock by listening on a local pipe or socket name: only one process
 * can listen on it, and the name is freed when that process closes or dies.
 */
export async function holdPipeLock(pipePath: string, waitSeconds: number): Promise<PipeLock> {
  const deadline = Date.now() + waitSeconds * 1000;

  for (;;) {
    const server = net.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(pipePath, () => resolve());
      });
      server.unref();
      return { release: () => new Promise<void>((resolve) => server.close(() => resolve())) };
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EADDRINUSE') throw error;
      if (Date.now() >= deadline) throw lockTimeout();
      await delay(PIPE_RETRY_MS);
    }
  }
}

function lockTimeout(): IslandShellFailure {
  return new IslandShellFailure(
    'blocked',
    `Another Tyrian Night Island operation held the Island lock for ${LOCK_WAIT_SECONDS} seconds.`
  );
}
