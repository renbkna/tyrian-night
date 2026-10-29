import { parseArgs } from 'node:util';

import { acquireIslandLock } from './islandLock.js';
import { describeIslandShellFailure } from './islandShellContract.js';
import {
  applyIslandUiSupervised,
  convergeIslandUiSupervised,
  readIslandUiSupervisorStatuses,
  restoreIslandUiSupervised,
} from './islandSupervisor.js';
import {
  ISLAND_CLI_OPTIONS,
  type IslandCliArgs,
  type IslandCliCommand,
  type IslandCliResults,
} from './islandWire.js';

/** Each command and whether it mutates; mutating commands run under the Island lock. */
const COMMANDS: {
  [Command in IslandCliCommand]: {
    mutates: boolean;
    run: (args: IslandCliArgs) => Promise<IslandCliResults[Command]>;
  };
} = {
  'apply-supervised': {
    mutates: true,
    run: (args) =>
      applyIslandUiSupervised({
        appRoot: requireArg(args, 'app-root'),
        cssSourcePath: requireArg(args, 'css-source'),
        themeVersion: requireArg(args, 'theme-version'),
      }),
  },
  converge: {
    mutates: true,
    run: (args) => {
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
  },
  'restore-supervised': {
    mutates: true,
    run: (args) => restoreIslandUiSupervised({ preferredAppRoots: optionalAppRoots(args) }),
  },
  'status-all-supervised': {
    mutates: false,
    run: (args) => readIslandUiSupervisorStatuses({ preferredAppRoots: optionalAppRoots(args) }),
  },
};

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: process.argv.slice(2),
    options: ISLAND_CLI_OPTIONS,
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

  const { mutates, run } = COMMANDS[command as IslandCliCommand];
  if (!mutates) {
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
