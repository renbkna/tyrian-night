import {
  applyIslandShell,
  readAllIslandShellStatuses,
  readIslandShellStatus,
  restoreAllIslandShells,
  restoreIslandShell,
} from './islandShell.js';

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case 'apply':
      requireArg(args, 'app-root');
      requireArg(args, 'css-source');
      requireArg(args, 'theme-version');
      writeJson(
        await applyIslandShell({
          appRoot: args['app-root'],
          cssSourcePath: args['css-source'],
          themeVersion: args['theme-version'],
        })
      );
      return;
    case 'restore':
      requireArg(args, 'app-root');
      writeJson(
        await restoreIslandShell({
          appRoot: args['app-root'],
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
      requireArg(args, 'app-root');
      writeJson(
        await readIslandShellStatus({
          appRoot: args['app-root'],
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
    default:
      throw new Error(
        "Unknown Tyrian Night CLI command. Use 'apply', 'restore', 'restore-all', 'status', or 'status-all'."
      );
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];

    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid argument sequence near '${key ?? ''}'.`);
    }

    parsed[key.slice(2)] = value;
  }

  return parsed;
}

function requireArg(args: Record<string, string>, name: string): void {
  if (!args[name]) {
    throw new Error(`Missing required argument '--${name}'.`);
  }
}

function writeJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value));
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
