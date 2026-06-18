import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs as parseNodeArgs } from 'node:util';

import {
  WORKBENCH_CHECKSUM_KEY,
  buildIslandPatchPaths,
  buildManagedRootsRegistryPath,
} from './islandPatchContract.js';
import { getIslandCssFileForTheme } from './generated/themeCatalog.js';
import {
  formatBrokerPathRejection,
  getSecureSystemPathIssue,
  getUserRegistryHomeIssue,
} from './islandPathSecurity.js';
import { applyIslandShell, restoreIslandShell } from './islandShell.js';

type IslandBrokerArgs = {
  'app-root'?: string;
  'asset-root'?: string;
  'caller-gid'?: string;
  'caller-uid'?: string;
  'expected-product-workbench-checksum'?: string;
  'expected-workbench-checksum'?: string;
  'registry-home'?: string;
  theme?: string;
  'theme-version'?: string;
};

type BrokerCommandResult = {
  changed: boolean;
  action: 'apply' | 'restore';
};

async function main(): Promise<void> {
  const { args, command } = parseCommandLine(process.argv.slice(2));

  switch (command) {
    case 'apply':
      await requirePrivilegedRuntime();
      await requireSecureSystemPath(requireArg(args, 'asset-root'), 'asset root');
      writeJson(
        await applyBrokeredIslandUi({
          appRoot: requireArg(args, 'app-root'),
          assetRoot: requireArg(args, 'asset-root'),
          callerGid: parseNumericId(requireArg(args, 'caller-gid'), 'caller gid'),
          callerUid: parseNumericId(requireArg(args, 'caller-uid'), 'caller uid'),
          expectedProductWorkbenchChecksum: requireArg(args, 'expected-product-workbench-checksum'),
          expectedWorkbenchChecksum: requireArg(args, 'expected-workbench-checksum'),
          registryHome: requireArg(args, 'registry-home'),
          theme: requireArg(args, 'theme'),
          themeVersion: requireArg(args, 'theme-version'),
        })
      );
      return;
    case 'restore':
      await requirePrivilegedRuntime();
      writeJson(
        await restoreBrokeredIslandUi({
          appRoot: requireArg(args, 'app-root'),
          callerGid: parseNumericId(requireArg(args, 'caller-gid'), 'caller gid'),
          callerUid: parseNumericId(requireArg(args, 'caller-uid'), 'caller uid'),
          registryHome: requireArg(args, 'registry-home'),
        })
      );
      return;
    default:
      throw new Error("Unknown Tyrian Night broker command. Use 'apply' or 'restore'.");
  }
}

async function applyBrokeredIslandUi(options: {
  appRoot: string;
  assetRoot: string;
  callerGid: number;
  callerUid: number;
  expectedProductWorkbenchChecksum: string;
  expectedWorkbenchChecksum: string;
  registryHome: string;
  theme: string;
  themeVersion: string;
}): Promise<BrokerCommandResult> {
  const cssFileName = getIslandCssFileForTheme(options.theme);

  if (!cssFileName) {
    throw new Error(`Unsupported Tyrian theme '${options.theme}'.`);
  }

  const cssSourcePath = path.join(options.assetRoot, cssFileName);
  await requireSecureAppRoot(options.appRoot);
  await requireSecureSystemPath(cssSourcePath, 'theme asset');
  await requireUserRegistryHome(options.registryHome, options.callerUid);
  await requireExpectedAppRootHashes({
    appRoot: options.appRoot,
    expectedProductWorkbenchChecksum: options.expectedProductWorkbenchChecksum,
    expectedWorkbenchChecksum: options.expectedWorkbenchChecksum,
  });

  const result = await applyIslandShell({
    appRoot: options.appRoot,
    cssSourcePath,
    registryHome: options.registryHome,
    themeVersion: options.themeVersion,
  });
  await restoreRegistryOwnership(options.registryHome, options.callerUid, options.callerGid);

  return {
    changed: result.changed,
    action: 'apply',
  };
}

async function restoreBrokeredIslandUi(options: {
  appRoot: string;
  callerGid: number;
  callerUid: number;
  registryHome: string;
}): Promise<BrokerCommandResult> {
  await requireSecureAppRoot(options.appRoot);
  await requireUserRegistryHome(options.registryHome, options.callerUid);

  const result = await restoreIslandShell({
    appRoot: options.appRoot,
    registryHome: options.registryHome,
  });
  await restoreRegistryOwnership(options.registryHome, options.callerUid, options.callerGid);

  return {
    changed: result.changed,
    action: 'restore',
  };
}

async function requirePrivilegedRuntime(): Promise<void> {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    throw new Error('Tyrian Night broker must run as root through the system privilege prompt.');
  }
}

async function requireSecureSystemPath(filePath: string, label: string): Promise<void> {
  const stats = await fs.stat(filePath);
  const issue = getSecureSystemPathIssue(stats, label);

  if (issue) {
    throw new Error(formatBrokerPathRejection(issue));
  }
}

async function requireSecureAppRoot(appRoot: string): Promise<void> {
  if (!path.isAbsolute(appRoot)) {
    throw new Error('Tyrian Night broker rejected VS Code app root: expected absolute path.');
  }

  const paths = buildIslandPatchPaths(appRoot);

  await requireSecureSystemPath(appRoot, 'VS Code app root');
  await requireSecureSystemPath(paths.workbenchDirPath, 'VS Code workbench directory');
  await requireSecureSystemPath(paths.workbenchHtmlPath, 'VS Code workbench HTML');
  await requireSecureSystemPath(paths.productJsonPath, 'VS Code product manifest');
}

async function requireExpectedAppRootHashes(options: {
  appRoot: string;
  expectedProductWorkbenchChecksum: string;
  expectedWorkbenchChecksum: string;
}): Promise<void> {
  const paths = buildIslandPatchPaths(options.appRoot);
  const workbenchHtml = await fs.readFile(paths.workbenchHtmlPath, 'utf8');
  const productJson = JSON.parse(await fs.readFile(paths.productJsonPath, 'utf8')) as {
    checksums?: Record<string, string>;
  };
  const workbenchChecksum = sha256Base64(workbenchHtml);
  const productWorkbenchChecksum = productJson.checksums?.[WORKBENCH_CHECKSUM_KEY];

  if (workbenchChecksum !== options.expectedWorkbenchChecksum) {
    throw new Error('Tyrian Night broker rejected apply: workbench hash changed after preflight.');
  }

  if (productWorkbenchChecksum !== options.expectedProductWorkbenchChecksum) {
    throw new Error(
      'Tyrian Night broker rejected apply: product checksum changed after preflight.'
    );
  }
}

async function requireUserRegistryHome(registryHome: string, callerUid: number): Promise<void> {
  if (!path.isAbsolute(registryHome)) {
    throw new Error('Tyrian Night broker rejected registry home: expected absolute path.');
  }

  const stats = await fs.stat(registryHome);
  const issue = getUserRegistryHomeIssue(stats, callerUid);

  if (issue) {
    throw new Error(formatBrokerPathRejection(issue));
  }
}

async function restoreRegistryOwnership(
  registryHome: string,
  callerUid: number,
  callerGid: number
): Promise<void> {
  const registryPath = buildManagedRootsRegistryPath(registryHome);
  const registryDir = path.dirname(registryPath);

  await chownIfExists(registryDir, callerUid, callerGid);
  await chownIfExists(registryPath, callerUid, callerGid);
}

async function chownIfExists(filePath: string, uid: number, gid: number): Promise<void> {
  try {
    await fs.chown(filePath, uid, gid);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return;
    }

    throw error;
  }
}

function parseNumericId(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Tyrian Night broker rejected ${label}: expected numeric id.`);
  }

  const id = Number(value);

  if (!Number.isSafeInteger(id)) {
    throw new Error(`Tyrian Night broker rejected ${label}: expected safe integer id.`);
  }

  return id;
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function sha256Base64(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('base64').replace(/=+$/, '');
}

function parseCommandLine(argv: string[]): {
  args: IslandBrokerArgs;
  command: string | undefined;
} {
  const { positionals, values } = parseNodeArgs({
    allowPositionals: true,
    args: argv,
    options: {
      'app-root': { type: 'string' },
      'asset-root': { type: 'string' },
      'caller-gid': { type: 'string' },
      'caller-uid': { type: 'string' },
      'expected-product-workbench-checksum': { type: 'string' },
      'expected-workbench-checksum': { type: 'string' },
      'registry-home': { type: 'string' },
      theme: { type: 'string' },
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

function requireArg(args: IslandBrokerArgs, name: keyof IslandBrokerArgs): string {
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
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
