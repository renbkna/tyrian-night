import { spawn, type SpawnOptions } from 'node:child_process';

export type IslandProcessResult = {
  stdout: string;
  stderr: string;
};

export type IslandProcessFailureEnvelope = {
  version: 1;
  code: 'permission-required' | 'unsupported' | 'corrupt' | 'blocked';
  changed: boolean;
  reason: string;
};

export class IslandProcessFailure extends Error {
  readonly code: IslandProcessFailureEnvelope['code'];
  readonly changed: boolean;

  constructor(failure: IslandProcessFailureEnvelope) {
    super(failure.reason);
    this.name = 'IslandProcessFailure';
    this.code = failure.code;
    this.changed = failure.changed;
  }
}

export async function runIslandProcess(
  command: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    fallbackMessage: string;
  }
): Promise<IslandProcessResult> {
  const [executable, ...args] = command;

  return new Promise((resolve, reject) => {
    const spawnOptions: SpawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
    };

    if (options.env) {
      spawnOptions.env = options.env;
    }

    const child = spawn(executable, args, spawnOptions);
    let stdout = '';
    let stderr = '';

    if (!child.stdout || !child.stderr) {
      reject(new Error('Tyrian Night process runner failed to open output pipes.'));
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const output = (stderr || stdout).trim();
        const failure = parseIslandProcessFailure(output);
        reject(failure ?? new Error(output || options.fallbackMessage));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

export function parseIslandProcessFailure(output: string): IslandProcessFailure | undefined {
  const candidateLine = output
    .split(/\r?\n/u)
    .toReversed()
    .find((line) => line.trim().length > 0);
  if (candidateLine === undefined) return undefined;

  try {
    const candidate = JSON.parse(candidateLine) as Partial<IslandProcessFailureEnvelope>;
    if (
      candidate.version !== 1 ||
      !['permission-required', 'unsupported', 'corrupt', 'blocked'].includes(
        candidate.code ?? ''
      ) ||
      typeof candidate.changed !== 'boolean' ||
      typeof candidate.reason !== 'string' ||
      candidate.reason.length === 0
    ) {
      return undefined;
    }

    return new IslandProcessFailure(candidate as IslandProcessFailureEnvelope);
  } catch {
    return undefined;
  }
}

export async function runIslandJsonProcess<T>(
  command: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    fallbackMessage: string;
    invalidOutputMessage: (error: unknown) => string;
  }
): Promise<T> {
  const { stdout } = await runIslandProcess(command, options);

  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    throw new Error(options.invalidOutputMessage(error));
  }
}
