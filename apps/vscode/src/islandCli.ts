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
} from './islandSupervisor.js';
import {
  ISLAND_WIRE_PROTOCOL_VERSION,
  projectIslandApplyResult,
  projectIslandDirectRestoreResult,
  projectIslandShellApplyResult,
  projectIslandReconciliationStatus,
  projectIslandRestoreResult,
  projectIslandSupervisorInventory,
} from './islandWire.js';

type IslandCliArgs = {
  'app-root'?: string;
  'css-source'?: string;
  'theme-version'?: string;
};

async function main(): Promise<void> {
  const { args, command } = parseCommandLine(process.argv.slice(2));

  switch (command) {
    case 'apply':
      writeJson(
        projectIslandShellApplyResult(
          await applyIslandShell({
            appRoot: requireArg(args, 'app-root'),
            cssSourcePath: requireArg(args, 'css-source'),
            themeVersion: requireArg(args, 'theme-version'),
          })
        )
      );
      return;
    case 'apply-supervised':
      writeJson(
        projectIslandApplyResult(
          await applyIslandUiSupervised({
            appRoot: requireArg(args, 'app-root'),
            cssSourcePath: requireArg(args, 'css-source'),
            themeVersion: requireArg(args, 'theme-version'),
          })
        )
      );
      return;
    case 'restore':
      writeJson(
        projectIslandDirectRestoreResult(
          await restoreIslandShell({
            appRoot: requireArg(args, 'app-root'),
          })
        )
      );
      return;
    case 'restore-supervised':
      writeJson(
        projectIslandRestoreResult(
          await restoreIslandUiSupervised({
            preferredAppRoots: args['app-root'] ? [args['app-root']] : [],
          })
        )
      );
      return;
    case 'restore-all':
      {
        const result = await restoreAllIslandShells({
          preferredAppRoots: args['app-root'] ? [args['app-root']] : [],
        });
        writeJson(result);
        if (result.failedAppRoots.length > 0 || result.enumerationFailure !== undefined) {
          process.exitCode = 2;
        }
      }
      return;
    case 'status':
      writeJson(
        projectIslandReconciliationStatus(
          await readIslandShellStatus({
            appRoot: requireArg(args, 'app-root'),
          })
        )
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
        projectIslandSupervisorInventory(
          await readIslandUiSupervisorStatuses({
            preferredAppRoots: args['app-root'] ? [args['app-root']] : [],
          })
        )
      );
      return;
    default:
      throw new Error(
        "Unknown Tyrian Night CLI command. Use 'apply', 'apply-supervised', 'restore', 'restore-supervised', 'restore-all', 'status', 'status-all', or 'status-all-supervised'."
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
  process.stderr.write(
    `${JSON.stringify({ version: ISLAND_WIRE_PROTOCOL_VERSION, ...failure })}\n`
  );
  process.exitCode = 1;
}
