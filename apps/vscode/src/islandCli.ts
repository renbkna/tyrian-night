import { parseArgs } from 'node:util';

import { acquireIslandLock } from './islandLock.js';
import { describeIslandShellFailure } from './islandShellContract.js';
import {
  applyIslandUiSupervised,
  convergeIslandUiSupervised,
  readIslandUiSupervisorStatuses,
  restoreIslandUiSupervised,
} from './islandSupervisor.js';
import type { IslandCliCommand, IslandCliResults } from './islandWire.js';

type IslandCliArgs = {
  'app-root'?: string;
  'css-source'?: string;
  'fallback-css'?: string;
  'island-dir'?: string;
  repair?: boolean;
  'theme-version'?: string;
};

const COMMANDS: {
  [Command in IslandCliCommand]: (args: IslandCliArgs) => Promise<IslandCliResults[Command]>;
} = {
  'apply-supervised': (args) =>
    applyIslandUiSupervised({
      appRoot: requireArg(args, 'app-root'),
      cssSourcePath: requireArg(args, 'css-source'),
      themeVersion: requireArg(args, 'theme-version'),
    }),
  converge: (args) => {
    if (!args.repair && args['fallback-css'] !== undefined) {
      throw new Error("Argument '--fallback-css' requires '--repair'.");
    }
    return convergeIslandUiSupervised({
      appRoot: requireArg(args, 'app-root'),
      islandDirectory: requireArg(args, 'island-dir'),
      themeVersion: requireArg(args, 'theme-version'),
      intent: args.repair
        ? { kind: 'repair', fallbackCssFile: args['fallback-css'] }
        : { kind: 'startup' },
    });
  },
  'restore-supervised': (args) =>
    restoreIslandUiSupervised({ preferredAppRoots: optionalAppRoots(args) }),
  'status-all-supervised': (args) =>
    readIslandUiSupervisorStatuses({ preferredAppRoots: optionalAppRoots(args) }),
};

const MUTATING_COMMANDS: ReadonlySet<string> = new Set<IslandCliCommand>([
  'apply-supervised',
  'converge',
  'restore-supervised',
]);

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: process.argv.slice(2),
    options: {
      'app-root': { type: 'string' },
      'css-source': { type: 'string' },
      'fallback-css': { type: 'string' },
      'island-dir': { type: 'string' },
      repair: { type: 'boolean' },
      'theme-version': { type: 'string' },
    },
    strict: true,
  });
  const [command, ...extraPositionals] = positionals;

  if (extraPositionals.length > 0) {
    throw new Error(`Unexpected argument '${extraPositionals[0]}'.`);
  }
  if (command === undefined || !Object.hasOwn(COMMANDS, command)) {
    throw new Error(
      `Unknown Tyrian Night CLI command. Use ${Object.keys(COMMANDS)
        .map((name) => `'${name}'`)
        .join(', ')}.`
    );
  }

  const run = COMMANDS[command as IslandCliCommand];
  if (!MUTATING_COMMANDS.has(command)) {
    process.stdout.write(JSON.stringify(await run(values)));
    return;
  }

  const lock = await acquireIslandLock();
  if (lock.kind === 'delegated') {
    process.exitCode = lock.exitCode;
    return;
  }
  try {
    process.stdout.write(JSON.stringify(await run(values)));
  } finally {
    await lock.release();
  }
}

function requireArg(
  args: IslandCliArgs,
  name: 'app-root' | 'css-source' | 'island-dir' | 'theme-version'
): string {
  const value = args[name];
  if (!value) throw new Error(`Missing required argument '--${name}'.`);
  return value;
}

function optionalAppRoots(args: IslandCliArgs): string[] {
  return args['app-root'] ? [args['app-root']] : [];
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${JSON.stringify(describeIslandShellFailure(error))}\n`);
  process.exitCode = 1;
}
