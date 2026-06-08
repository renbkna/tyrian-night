import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  WORKBENCH_CHECKSUM_KEY,
  buildIslandPatchPaths,
  buildManagedRootsRegistryPath,
} from './islandPatchContract.js';
import { getIslandCssFileForTheme } from './generated/themeCatalog.js';
import {
  formatBrokerPathRejection,
  getSecureSystemPathIssue,
  getSecureUnlockTargetIssue,
  getUserRegistryHomeIssue,
} from './islandPathSecurity.js';
import { applyIslandShell, restoreIslandShell } from './islandShell.js';

type BrokerCommandResult = {
  changed: boolean;
  action: 'apply' | 'restore' | 'restore-access' | 'unlock';
};

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case 'apply':
      requireArg(args, 'app-root');
      requireArg(args, 'asset-root');
      requireArg(args, 'expected-product-workbench-checksum');
      requireArg(args, 'expected-workbench-checksum');
      requireArg(args, 'registry-home');
      requireArg(args, 'theme');
      requireArg(args, 'theme-version');
      requireArg(args, 'caller-uid');
      requireArg(args, 'caller-gid');
      await requirePrivilegedRuntime();
      await requireSecureSystemPath(args['asset-root'], 'asset root');
      writeJson(
        await applyBrokeredIslandUi({
          appRoot: args['app-root'],
          assetRoot: args['asset-root'],
          callerGid: parseNumericId(args['caller-gid'], 'caller gid'),
          callerUid: parseNumericId(args['caller-uid'], 'caller uid'),
          expectedProductWorkbenchChecksum: args['expected-product-workbench-checksum'],
          expectedWorkbenchChecksum: args['expected-workbench-checksum'],
          registryHome: args['registry-home'],
          theme: args.theme,
          themeVersion: args['theme-version'],
        })
      );
      return;
    case 'restore':
      requireArg(args, 'app-root');
      requireArg(args, 'registry-home');
      requireArg(args, 'caller-uid');
      requireArg(args, 'caller-gid');
      await requirePrivilegedRuntime();
      writeJson(
        await restoreBrokeredIslandUi({
          appRoot: args['app-root'],
          callerGid: parseNumericId(args['caller-gid'], 'caller gid'),
          callerUid: parseNumericId(args['caller-uid'], 'caller uid'),
          registryHome: args['registry-home'],
        })
      );
      return;
    case 'unlock':
      requireArg(args, 'app-root');
      requireArg(args, 'expected-product-workbench-checksum');
      requireArg(args, 'expected-workbench-checksum');
      requireArg(args, 'caller-uid');
      requireArg(args, 'caller-gid');
      await requirePrivilegedRuntime();
      writeJson(
        await unlockIslandWriteAccess({
          appRoot: args['app-root'],
          callerGid: parseNumericId(args['caller-gid'], 'caller gid'),
          callerUid: parseNumericId(args['caller-uid'], 'caller uid'),
          expectedProductWorkbenchChecksum: args['expected-product-workbench-checksum'],
          expectedWorkbenchChecksum: args['expected-workbench-checksum'],
        })
      );
      return;
    case 'restore-access':
      requireArg(args, 'app-root');
      requireArg(args, 'expected-product-workbench-checksum');
      requireArg(args, 'expected-workbench-checksum');
      requireArg(args, 'caller-uid');
      await requirePrivilegedRuntime();
      writeJson(
        await restoreIslandPackageAccess({
          appRoot: args['app-root'],
          callerUid: parseNumericId(args['caller-uid'], 'caller uid'),
          expectedProductWorkbenchChecksum: args['expected-product-workbench-checksum'],
          expectedWorkbenchChecksum: args['expected-workbench-checksum'],
        })
      );
      return;
    default:
      throw new Error(
        "Unknown Tyrian Night broker command. Use 'apply', 'restore', 'restore-access', or 'unlock'."
      );
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

async function unlockIslandWriteAccess(options: {
  appRoot: string;
  callerGid: number;
  callerUid: number;
  expectedProductWorkbenchChecksum: string;
  expectedWorkbenchChecksum: string;
}): Promise<BrokerCommandResult & { unlockedPaths: string[] }> {
  await requireSecureUnlockAppRoot(options.appRoot, options.callerUid);
  await requireExpectedAppRootHashes({
    appRoot: options.appRoot,
    expectedProductWorkbenchChecksum: options.expectedProductWorkbenchChecksum,
    expectedWorkbenchChecksum: options.expectedWorkbenchChecksum,
  });

  const paths = buildIslandPatchPaths(options.appRoot);
  const unlockTargets = [
    {
      filePath: paths.workbenchDirPath,
      modeMask: 0o700,
    },
    {
      filePath: paths.workbenchHtmlPath,
      modeMask: 0o600,
    },
    {
      filePath: paths.productJsonPath,
      modeMask: 0o600,
    },
  ];
  let changed = false;

  for (const target of unlockTargets) {
    const before = await fs.stat(target.filePath);

    if (before.uid !== options.callerUid || before.gid !== options.callerGid) {
      await fs.chown(target.filePath, options.callerUid, options.callerGid);
      changed = true;
    }

    const nextMode = before.mode | target.modeMask;

    if ((before.mode & target.modeMask) !== target.modeMask) {
      await fs.chmod(target.filePath, nextMode);
      changed = true;
    }

    await requireUnlockedForCaller(target.filePath, options.callerUid, target.modeMask);
  }

  return {
    action: 'unlock',
    changed,
    unlockedPaths: unlockTargets.map((target) => target.filePath),
  };
}

async function restoreIslandPackageAccess(options: {
  appRoot: string;
  callerUid: number;
  expectedProductWorkbenchChecksum: string;
  expectedWorkbenchChecksum: string;
}): Promise<BrokerCommandResult & { restoredPaths: string[] }> {
  await requireSecureUnlockAppRoot(options.appRoot, options.callerUid);
  await requireExpectedAppRootHashes({
    appRoot: options.appRoot,
    expectedProductWorkbenchChecksum: options.expectedProductWorkbenchChecksum,
    expectedWorkbenchChecksum: options.expectedWorkbenchChecksum,
  });

  const paths = buildIslandPatchPaths(options.appRoot);
  const restoreTargets = [
    {
      filePath: paths.workbenchDirPath,
      mode: 0o755,
    },
    {
      filePath: paths.workbenchHtmlPath,
      mode: 0o644,
    },
    {
      filePath: paths.productJsonPath,
      mode: 0o644,
    },
  ];
  let changed = false;

  for (const target of restoreTargets) {
    const before = await fs.stat(target.filePath);

    if (before.uid !== 0 || before.gid !== 0) {
      await fs.chown(target.filePath, 0, 0);
      changed = true;
    }

    const currentMode = before.mode & 0o777;

    if (currentMode !== target.mode) {
      await fs.chmod(target.filePath, target.mode);
      changed = true;
    }

    await requireSecureSystemPath(target.filePath, 'restored VS Code app file');
  }

  return {
    action: 'restore-access',
    changed,
    restoredPaths: restoreTargets.map((target) => target.filePath),
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

async function requireSecureUnlockAppRoot(appRoot: string, callerUid: number): Promise<void> {
  if (!path.isAbsolute(appRoot)) {
    throw new Error('Tyrian Night broker rejected VS Code app root: expected absolute path.');
  }

  const paths = buildIslandPatchPaths(appRoot);

  await requireSecureSystemPath(appRoot, 'VS Code app root');
  await requireSecureUnlockTarget(paths.workbenchDirPath, callerUid, 'VS Code workbench directory');
  await requireSecureUnlockTarget(paths.workbenchHtmlPath, callerUid, 'VS Code workbench HTML');
  await requireSecureUnlockTarget(paths.productJsonPath, callerUid, 'VS Code product manifest');
}

async function requireSecureUnlockTarget(
  filePath: string,
  callerUid: number,
  label: string
): Promise<void> {
  const stats = await fs.stat(filePath);
  const issue = getSecureUnlockTargetIssue(stats, callerUid, label);

  if (issue) {
    throw new Error(formatBrokerPathRejection(issue));
  }
}

async function requireUnlockedForCaller(
  filePath: string,
  callerUid: number,
  modeMask: number
): Promise<void> {
  const stats = await fs.stat(filePath);

  if (stats.uid !== callerUid || (stats.mode & modeMask) !== modeMask) {
    throw new Error('Tyrian Night broker failed to unlock VS Code app file write access.');
  }
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
