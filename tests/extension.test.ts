import * as childProcess from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, expect, mock, test } from 'bun:test';

type CommandHandler = () => unknown | Promise<unknown>;

const ISLAND_UI_ENABLED_KEY = 'tyrianNight.islandUiEnabled';
const UNINSTALL_WARNING_ACKNOWLEDGED_KEY = 'tyrianNight.uninstallWarningAcknowledged';

const registeredCommands = new Map<string, CommandHandler>();
const globalStateStore = new Map<string, unknown>();
const globalStateUpdates: Array<[string, unknown]> = [];
const spawnCalls: Array<{ command: string; args: string[] }> = [];
const warningMessages: unknown[][] = [];
const informationMessages: unknown[][] = [];
const externalUrls: string[] = [];
const pendingSpawnClosers: Array<() => void> = [];
const queuedWarningResponses: Array<string | undefined> = [];
const queuedSpawnResponses: unknown[] = [];

let activeTheme = 'Tyrian Night';
let vscodeAppRoot = '/test-vscode-app-root';
let warningResponse: string | undefined = 'I Understand';
let holdSpawnClose = false;

class FakeStream extends EventEmitter {
  setEncoding(_encoding: BufferEncoding): void {}
}

mock.module('node:child_process', () => ({
  ...childProcess,
  spawn(command: string, args: string[]) {
    spawnCalls.push({ command, args });

    const child = new EventEmitter() as EventEmitter & {
      stdout: FakeStream;
      stderr: FakeStream;
    };
    child.stdout = new FakeStream();
    child.stderr = new FakeStream();

    const close = () => {
      child.stdout.emit(
        'data',
        JSON.stringify(queuedSpawnResponses.shift() ?? defaultCliResult(args))
      );
      child.emit('close', 0);
    };

    if (holdSpawnClose) {
      pendingSpawnClosers.push(close);
    } else {
      queueMicrotask(close);
    }

    return child;
  },
}));

mock.module('vscode', () => ({
  ConfigurationTarget: {
    Global: 1,
  },
  Uri: {
    parse: (value: string) => value,
  },
  version: '1.118.0',
  commands: {
    executeCommand: async () => undefined,
    registerCommand(command: string, handler: CommandHandler) {
      registeredCommands.set(command, handler);
      return { dispose: () => undefined };
    },
  },
  env: {
    get appRoot() {
      return vscodeAppRoot;
    },
    openExternal: async (uri: string) => {
      externalUrls.push(uri);
      return true;
    },
  },
  window: {
    showErrorMessage: async (...args: unknown[]) => {
      informationMessages.push(args);
      return undefined;
    },
    showInformationMessage: async (...args: unknown[]) => {
      informationMessages.push(args);
      return undefined;
    },
    showTextDocument: async () => undefined,
    showWarningMessage: async (...args: unknown[]) => {
      warningMessages.push(args);
      return queuedWarningResponses.length > 0 ? queuedWarningResponses.shift() : warningResponse;
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => (key === 'colorTheme' ? activeTheme : undefined),
      update: async () => undefined,
    }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    openTextDocument: async (document: unknown) => document,
  },
}));

beforeEach(() => {
  activeTheme = 'Tyrian Night';
  vscodeAppRoot = '/test-vscode-app-root';
  warningResponse = 'I Understand';
  holdSpawnClose = false;
  registeredCommands.clear();
  globalStateStore.clear();
  resetObservations();
});

test('repair Island UI requires warning acknowledgement and records enabled state', async () => {
  const repairCommand = await activateAndGetRepairCommand();
  resetObservations();

  await repairCommand();

  expect(warningMessages).toHaveLength(1);
  expect(globalStateUpdates).toContainEqual([UNINSTALL_WARNING_ACKNOWLEDGED_KEY, true]);
  expect(globalStateUpdates).toContainEqual([ISLAND_UI_ENABLED_KEY, true]);
  expect(spawnCalls).toHaveLength(1);
  expect(spawnCalls[0]?.args[1]).toBe('apply-supervised');
});

test('repair Island UI does not patch when warning acknowledgement is cancelled', async () => {
  const repairCommand = await activateAndGetRepairCommand();
  resetObservations();
  warningResponse = 'Cancel';

  await repairCommand();

  expect(warningMessages).toHaveLength(1);
  expect(globalStateUpdates).not.toContainEqual([ISLAND_UI_ENABLED_KEY, true]);
  expect(spawnCalls).toHaveLength(0);
});

test('commands serialize Island UI mutations through the sync queue', async () => {
  holdSpawnClose = true;

  const { activate } = await import('../apps/vscode/src/extension');
  const activation = activate(createExtensionContext());
  await waitForRegisteredCommand('tyrianNight.restoreClassicUi');

  const restoreCommand = registeredCommands.get('tyrianNight.restoreClassicUi');
  expect(restoreCommand).toBeFunction();
  const restore = restoreCommand?.();

  try {
    expect(spawnCalls).toHaveLength(1);
    pendingSpawnClosers.shift()?.();
    await activation;
    await Promise.resolve();
    expect(spawnCalls).toHaveLength(2);
    pendingSpawnClosers.shift()?.();
    await restore;
  } finally {
    while (pendingSpawnClosers.length > 0) {
      pendingSpawnClosers.shift()?.();
    }
  }
});

test('cancelled uninstall warning restores any existing Island patch before disabling state', async () => {
  globalStateStore.set(ISLAND_UI_ENABLED_KEY, true);
  warningResponse = 'Cancel';

  const { activate } = await import('../apps/vscode/src/extension');
  await activate(createExtensionContext());

  expect(globalStateUpdates).toContainEqual([ISLAND_UI_ENABLED_KEY, false]);
  expect(spawnCalls.some((call) => call.args.includes('restore-supervised'))).toBe(true);
});

test('restore does not offer package access reset without a recorded write-access unlock', async () => {
  const { activate } = await import('../apps/vscode/src/extension');
  await activate(createExtensionContext());
  await waitForRegisteredCommand('tyrianNight.restoreClassicUi');

  const restoreCommand = registeredCommands.get('tyrianNight.restoreClassicUi');
  expect(restoreCommand).toBeFunction();
  resetObservations();
  queuedSpawnResponses.push({
    kind: 'restored',
    changed: true,
    restoredAppRoots: ['/test-vscode-app-root'],
    failedAppRoots: [],
  });

  await restoreCommand?.();

  expect(spawnCalls.map((call) => call.args[1])).toEqual(['restore-supervised']);
  expect(warningMessages).toEqual([]);
});

test('repair Island UI handles permission-required supervisor result through Doctor', async () => {
  const repairCommand = await activateAndGetRepairCommand();
  resetObservations();
  queuedWarningResponses.push('I Understand', 'Open Doctor');
  queuedSpawnResponses.push(
    {
      kind: 'permission-required',
      changed: true,
      status: fakeIslandStatus('clean'),
      writeAccess: {
        writable: false,
        blockedPaths: [{ path: '/test-vscode-app-root/product.json', reason: 'EACCES' }],
        issues: ["Tyrian cannot write '/test-vscode-app-root/product.json'."],
      },
      reason: 'EACCES: permission denied',
    },
    [
      {
        ...fakeIslandStatus('clean'),
        writeAccess: {
          writable: false,
          blockedPaths: [{ path: '/test-vscode-app-root/product.json', reason: 'EACCES' }],
          issues: ["Tyrian cannot write '/test-vscode-app-root/product.json'."],
        },
        recommendedAction: 'elevated-repair',
      },
    ]
  );

  await repairCommand();

  expect(spawnCalls.map((call) => call.args[1])).toEqual([
    'apply-supervised',
    'status-all-supervised',
  ]);
  expect(warningMessages.at(-1)?.[0]).toContain('VS Code app files are not writable');
  expect(warningMessages.at(-1)?.[0]).toContain('unlock write access');
});

test('permission-required Island UI prompt can open the public trust docs before admin access', async () => {
  const repairCommand = await activateAndGetRepairCommand();
  resetObservations();
  queuedWarningResponses.push('I Understand', 'Why This Is Needed');
  queuedSpawnResponses.push({
    kind: 'permission-required',
    changed: true,
    status: fakeIslandStatus('clean'),
    writeAccess: {
      writable: false,
      blockedPaths: [{ path: '/test-vscode-app-root/product.json', reason: 'EACCES' }],
      issues: ["Tyrian cannot write '/test-vscode-app-root/product.json'."],
    },
    reason: 'EACCES: permission denied',
  });

  await repairCommand();

  expect(warningMessages.at(-1)).toContain('Why This Is Needed');
  expect(externalUrls).toEqual(['https://github.com/renbkna/tyrian-night#island-ui']);
  expect(spawnCalls.map((call) => call.args[1])).toEqual(['apply-supervised']);
});

test('write-access unlock does not repeat the permission prompt when reload sees the patch', async () => {
  const appRoot = await createWritableAppRoot();
  const workbenchHash = await readWorkbenchHash(appRoot);
  vscodeAppRoot = appRoot;

  try {
    const repairCommand = await activateAndGetRepairCommand();
    resetObservations();
    queuedWarningResponses.push('I Understand', 'Unlock Write Access');
    queuedSpawnResponses.push(
      {
        kind: 'permission-required',
        changed: true,
        status: fakeIslandStatus('clean', workbenchHash),
        writeAccess: {
          writable: false,
          blockedPaths: [{ path: path.join(appRoot, 'product.json'), reason: 'EACCES' }],
          issues: [`Tyrian cannot write '${path.join(appRoot, 'product.json')}'.`],
        },
        reason: 'EACCES: permission denied',
      },
      {},
      {
        kind: 'permission-required',
        changed: true,
        status: fakeIslandStatus('clean', workbenchHash),
        writeAccess: {
          writable: false,
          blockedPaths: [{ path: path.join(appRoot, 'product.json'), reason: 'EACCES' }],
          issues: [`Tyrian cannot write '${path.join(appRoot, 'product.json')}'.`],
        },
        reason: 'EACCES: permission denied',
      },
      [
        {
          ...fakeIslandStatus('patched', workbenchHash),
          writeAccess: {
            writable: true,
            blockedPaths: [],
            issues: [],
          },
          recommendedAction: 'none',
        },
      ]
    );

    await repairCommand();

    const permissionPrompts = warningMessages.filter(([message]) =>
      String(message).includes('VS Code app files are not writable')
    );
    const cliCommands = spawnCalls
      .filter((call) => call.command === process.execPath)
      .map((call) => call.args[1]);

    expect(permissionPrompts).toHaveLength(1);
    expect(cliCommands).toEqual(['apply-supervised', 'apply-supervised', 'status-all-supervised']);
    expect(
      informationMessages.some(([message]) => String(message).includes('Reload VS Code'))
    ).toBe(true);
  } finally {
    await fs.rm(appRoot, { force: true, recursive: true });
  }
});

async function activateAndGetRepairCommand(): Promise<CommandHandler> {
  const { activate } = await import('../apps/vscode/src/extension');
  await activate(createExtensionContext());

  const repairCommand = registeredCommands.get('tyrianNight.repairIslandUi');
  expect(repairCommand).toBeFunction();
  return repairCommand;
}

function createExtensionContext(): {
  extension: { packageJSON: { version: string } };
  extensionPath: string;
  globalState: {
    get: <T>(key: string, defaultValue?: T) => T | undefined;
    update: (key: string, value: unknown) => Promise<void>;
  };
  subscriptions: Array<{ dispose: () => void }>;
} {
  return {
    extension: {
      packageJSON: {
        version: 'test',
      },
    },
    extensionPath: '/test-extension-root',
    globalState: {
      get: <T>(key: string, defaultValue?: T): T | undefined =>
        globalStateStore.has(key) ? (globalStateStore.get(key) as T) : defaultValue,
      update: async (key: string, value: unknown): Promise<void> => {
        globalStateStore.set(key, value);
        globalStateUpdates.push([key, value]);
      },
    },
    subscriptions: [],
  };
}

function resetObservations(): void {
  globalStateUpdates.length = 0;
  spawnCalls.length = 0;
  warningMessages.length = 0;
  informationMessages.length = 0;
  externalUrls.length = 0;
  pendingSpawnClosers.length = 0;
  queuedWarningResponses.length = 0;
  queuedSpawnResponses.length = 0;
}

async function waitForRegisteredCommand(command: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (registeredCommands.has(command)) {
      return;
    }

    await Promise.resolve();
  }
}

function defaultCliResult(args: string[]): unknown {
  switch (args[1]) {
    case 'apply-supervised':
      return {
        kind: 'already-current',
        changed: false,
        status: fakeIslandStatus('patched'),
      };
    case 'restore-supervised':
      return {
        kind: 'already-classic',
        changed: false,
        restoredAppRoots: [],
        failedAppRoots: [],
      };
    case 'status-all-supervised':
      return [
        {
          ...fakeIslandStatus('clean'),
          writeAccess: {
            writable: true,
            blockedPaths: [],
            issues: [],
          },
          recommendedAction: 'none',
        },
      ];
    default:
      return { changed: false, restoredAppRoots: [], failedAppRoots: [] };
  }
}

function fakeIslandStatus(
  classification: string,
  workbenchHash = 'test-workbench-hash'
): {
  appRoot: string;
  active: boolean;
  managed: boolean;
  classification: string;
  verificationPassed: boolean;
  canSelfHeal: boolean;
  restoreProof: 'none' | 'manifest-v2-backup-pair' | 'strip-tyrian-block';
  workbenchChecksum: string;
  productWorkbenchChecksum: string;
  receipt: undefined;
  issues: string[];
} {
  return {
    appRoot: vscodeAppRoot,
    active: classification === 'patched',
    managed: classification !== 'clean',
    classification,
    verificationPassed: classification === 'clean' || classification === 'patched',
    canSelfHeal: false,
    restoreProof: 'none',
    workbenchChecksum: workbenchHash,
    productWorkbenchChecksum: workbenchHash,
    receipt: undefined,
    issues: [],
  };
}

async function createWritableAppRoot(): Promise<string> {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tyrian-extension-app-root-'));
  const workbenchDir = path.join(appRoot, 'out/vs/code/electron-browser/workbench');
  const workbenchHtml = cleanWorkbenchHtml();
  const workbenchHash = sha256Base64(workbenchHtml);

  await fs.mkdir(workbenchDir, { recursive: true });
  await fs.writeFile(path.join(workbenchDir, 'workbench.html'), workbenchHtml, 'utf8');
  await fs.writeFile(
    path.join(appRoot, 'product.json'),
    JSON.stringify(
      {
        checksums: {
          'vs/code/electron-browser/workbench/workbench.html': workbenchHash,
        },
      },
      null,
      '\t'
    ).concat('\n'),
    'utf8'
  );

  return appRoot;
}

async function readWorkbenchHash(appRoot: string): Promise<string> {
  return sha256Base64(
    await fs.readFile(
      path.join(appRoot, 'out/vs/code/electron-browser/workbench/workbench.html'),
      'utf8'
    )
  );
}

function cleanWorkbenchHtml(): string {
  return `<html>
\t<head>
\t\t<link rel="stylesheet" href="../../../workbench/workbench.desktop.main.css">
\t</head>
</html>
`;
}

function sha256Base64(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('base64').replace(/=+$/, '');
}
