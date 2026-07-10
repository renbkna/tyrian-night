import { parseArgs as parseNodeArgs } from 'node:util';

import {
  applyIslandShell,
  describeIslandShellFailure,
  readAllIslandShellStatuses,
  readIslandShellStatus,
  restoreAllIslandShells,
  restoreIslandShell,
} from './islandShell.js';
import {
  applyIslandUiSupervised,
  readIslandUiSupervisorStatuses,
  restoreIslandUiSupervised,
  seedIslandDesiredThemeSupervised,
} from './islandSupervisor.js';

type IslandCliArgs = {
  'app-root'?: string;
  'css-source'?: string;
  'theme-version'?: string;
  'desired-theme-id'?: string;
};

async function main(): Promise<void> {
  const { args, command } = parseCommandLine(process.argv.slice(2));

  switch (command) {
    case 'apply':
      writeJson(
        await applyIslandShell({
          appRoot: requireArg(args, 'app-root'),
          cssSourcePath: requireArg(args, 'css-source'),
          themeVersion: requireArg(args, 'theme-version'),
        })
      );
      return;
    case 'apply-supervised':
      writeJson(
        await applyIslandUiSupervised({
          appRoot: requireArg(args, 'app-root'),
          cssSourcePath: requireArg(args, 'css-source'),
          themeVersion: requireArg(args, 'theme-version'),
        })
      );
      return;
    case 'restore':
      writeJson(
        await restoreIslandShell({
          appRoot: requireArg(args, 'app-root'),
        })
      );
      return;
    case 'seed-desired-supervised':
      writeJson(
        await seedIslandDesiredThemeSupervised({
          appRoot: requireArg(args, 'app-root'),
          desiredThemeId: requireArg(args, 'desired-theme-id'),
        })
      );
      return;
    case 'restore-supervised':
      writeJson(
        await restoreIslandUiSupervised({
          preferredAppRoots: args['app-root'] ? [args['app-root']] : [],
        })
      );
      return;
    case 'restore-all':
      writeJson(
        await restoreAllIslandShells({
          preferredAppRoots: args['app-root'] ? [args['app-root']] : [],
        })
      );
      return;
    case 'status':
      writeJson(
        await readIslandShellStatus({
          appRoot: requireArg(args, 'app-root'),
        })
      );
      return;
    case 'status-all':
      writeJson(
        await readAllIslandShellStatuses({
          preferredAppRoots: args['app-root'] ? [args['app-root']] : [],
        })
      );
      return;
    case 'status-all-supervised':
      writeJson(
        await readIslandUiSupervisorStatuses({
          preferredAppRoots: args['app-root'] ? [args['app-root']] : [],
        })
      );
      return;
    default:
      throw new Error(
        "Unknown Tyrian Night CLI command. Use 'apply', 'apply-supervised', 'seed-desired-supervised', 'restore', 'restore-supervised', 'restore-all', 'status', 'status-all', or 'status-all-supervised'."
      );
  }
}

function parseCommandLine(argv: string[]): { args: IslandCliArgs; command: string | undefined } {
  const { positionals, values } = parseNodeArgs({
    allowPositionals: true,
    args: argv,
    options: {
      'app-root': { type: 'string' },
      'css-source': { type: 'string' },
      'theme-version': { type: 'string' },
      'desired-theme-id': { type: 'string' },
    },
    strict: true,
  });
  const [command, ...extraPositionals] = positionals;

  if (extraPositionals.length > 0) {
    throw new Error(`Unexpected argument '${extraPositionals[0]}'.`);
  }

  return { args: values, command };
}

function requireArg(args: IslandCliArgs, name: keyof IslandCliArgs): string {
  const value = args[name];

  if (!value) {
    throw new Error(`Missing required argument '--${name}'.`);
  }

  return value;
}

function writeJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value));
}

try {
  await main();
} catch (error) {
  const failure = describeIslandShellFailure(error);
  process.stderr.write(`${JSON.stringify({ version: 1, ...failure })}\n`);
  process.exitCode = 1;
}
