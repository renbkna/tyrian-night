import { spawn, type SpawnOptions } from 'node:child_process';

export type IslandProcessResult = {
  stdout: string;
  stderr: string;
};

export type IslandProcessFailureEnvelope = {
  version: 1;
  code: 'permission-required' | 'unsupported' | 'corrupt' | 'blocked';
  changed: boolean;
  desiredStateChanged: boolean;
  registryChanged: boolean;
  physicalChanged: boolean;
  externalDrift: boolean;
  incompleteRecovery: boolean;
  reason: string;
  causes: Array<{ code: IslandProcessFailureEnvelope['code']; reason: string }>;
};

export class IslandProcessFailure extends Error {
  readonly code: IslandProcessFailureEnvelope['code'];
  readonly changed: boolean;
  readonly desiredStateChanged: boolean;
  readonly registryChanged: boolean;
  readonly physicalChanged: boolean;
  readonly externalDrift: boolean;
  readonly incompleteRecovery: boolean;
  readonly causes: IslandProcessFailureEnvelope['causes'];

  constructor(failure: IslandProcessFailureEnvelope) {
    super(failure.reason);
    this.name = 'IslandProcessFailure';
    this.code = failure.code;
    this.changed = failure.changed;
    this.desiredStateChanged = failure.desiredStateChanged;
    this.registryChanged = failure.registryChanged;
    this.physicalChanged = failure.physicalChanged;
    this.externalDrift = failure.externalDrift;
    this.incompleteRecovery = failure.incompleteRecovery;
    this.causes = failure.causes;
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
      typeof candidate.desiredStateChanged !== 'boolean' ||
      typeof candidate.registryChanged !== 'boolean' ||
      typeof candidate.physicalChanged !== 'boolean' ||
      typeof candidate.externalDrift !== 'boolean' ||
      typeof candidate.incompleteRecovery !== 'boolean' ||
      candidate.changed !==
        (candidate.desiredStateChanged || candidate.registryChanged || candidate.physicalChanged) ||
      typeof candidate.reason !== 'string' ||
      candidate.reason.length === 0 ||
      !Array.isArray(candidate.causes) ||
      candidate.causes.length > 8 ||
      candidate.causes.some(
        (cause) =>
          typeof cause !== 'object' ||
          cause === null ||
          !('code' in cause) ||
          !['permission-required', 'unsupported', 'corrupt', 'blocked'].includes(
            typeof cause.code === 'string' ? cause.code : ''
          ) ||
          !('reason' in cause) ||
          typeof cause.reason !== 'string' ||
          cause.reason.length === 0
      )
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
