import { spawn, type SpawnOptions } from 'node:child_process';

export type IslandProcessResult = {
  stdout: string;
  stderr: string;
};

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
        reject(new Error((stderr || stdout).trim() || options.fallbackMessage));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
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
