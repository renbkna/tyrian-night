import { spawn } from 'node:child_process';

import { IslandMutationError } from './islandMutationFacts.js';
import type {
  IslandShellFailureCode,
  IslandShellFailureDescription,
} from './islandShellContract.js';

/** A typed Island CLI failure reconstructed from its stderr envelope. */
export class IslandProcessFailure extends IslandMutationError {
  readonly code: IslandShellFailureCode;
  readonly causes: IslandShellFailureDescription['causes'];

  constructor(description: IslandShellFailureDescription) {
    super(description.reason, description);
    this.name = 'IslandProcessFailure';
    this.code = description.code;
    this.causes = description.causes;
  }
}

/**
 * Run a same-build Island process and return its stdout JSON. A nonzero exit
 * rejects with the typed failure envelope when the process wrote one, or with
 * its raw diagnostic when it crashed.
 */
export function runIslandJsonProcess<T>(command: string[], env?: NodeJS.ProcessEnv): Promise<T> {
  const [executable, ...args] = command;

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        const output = (stderr || stdout).trim();
        reject(
          parseIslandProcessFailure(output) ??
            new Error(output || 'Island UI CLI failed without an error message.')
        );
        return;
      }

      try {
        resolve(JSON.parse(stdout) as T);
      } catch (error) {
        reject(
          new Error(
            `Tyrian Night CLI returned invalid output: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          )
        );
      }
    });
  });
}

/** The envelope is the last output line; anything else is crash text. */
export function parseIslandProcessFailure(output: string): IslandProcessFailure | undefined {
  const lastLine = output.split(/\r?\n/u).findLast((line) => line.trim().length > 0);
  if (lastLine === undefined) return undefined;

  let envelope: unknown;
  try {
    envelope = JSON.parse(lastLine);
  } catch {
    return undefined;
  }
  return typeof envelope === 'object' && envelope !== null && !Array.isArray(envelope)
    ? new IslandProcessFailure(envelope as IslandShellFailureDescription)
    : undefined;
}
