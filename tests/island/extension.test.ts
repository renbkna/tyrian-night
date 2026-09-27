import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';

import { beforeEach, expect, mock, test } from 'bun:test';

import { islandMutationFacts as mutationFacts } from '../../apps/vscode/src/islandMutationFacts.js';
import type {
  IslandShellFailureDescription,
  IslandShellResult,
  IslandShellStatus,
  IslandShellWriteAccess,
} from '../../apps/vscode/src/islandShellContract.js';
import type {
  IslandUiRecommendedAction,
  IslandUiSupervisorStatus,
} from '../../apps/vscode/src/islandSupervisor.js';
import type { IslandCliResults } from '../../apps/vscode/src/islandWire.js';
import type { TyrianExtensionContext } from '../../apps/vscode/src/extension.js';

type CommandHandler = () => unknown | Promise<unknown>;

const UNINSTALL_WARNING_ACKNOWLEDGED_KEY = 'tyrianNight.uninstallWarningAcknowledged';

const registeredCommands = new Map<string, CommandHandler>();
const globalStateStore = new Map<string, unknown>();
const globalStateUpdates: Array<[string, unknown]> = [];
const configurationUpdates: Array<[string, unknown]> = [];
const spawnCalls: Array<{ command: string; args: string[] }> = [];
const warningMessages: unknown[][] = [];
const informationMessages: unknown[][] = [];
const externalUrls: string[] = [];
const pendingSpawnClosers: Array<() => void> = [];
const queuedWarningResponses: Array<string | undefined> = [];
type FakeProcessResponse = {
  fakeProcessResponse: true;
  exitCode: number;
  stdout: string;
  stderr: string;
};

const queuedSpawnResponses: Array<unknown | FakeProcessResponse> = [];
const openedDocuments: unknown[] = [];

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
      const queuedResponse = queuedSpawnResponses.shift();
      if (isFakeProcessResponse(queuedResponse)) {
        if (queuedResponse.stdout.length > 0) child.stdout.emit('data', queuedResponse.stdout);
        if (queuedResponse.stderr.length > 0) child.stderr.emit('data', queuedResponse.stderr);
        child.emit('close', queuedResponse.exitCode);
        return;
      }
      child.stdout.emit('data', JSON.stringify(queuedResponse ?? defaultCliResult(args)));
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

function isFakeProcessResponse(value: unknown): value is FakeProcessResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'fakeProcessResponse' in value &&
    value.fakeProcessResponse === true
  );
}

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
      update: async (key: string, value: unknown) => {
        configurationUpdates.push([key, value]);
      },
    }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    openTextDocument: async (document: unknown) => {
      openedDocuments.push(document);
      return document;
    },
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

test('repair Island UI requires warning acknowledgement and delegates desired state to shell', async () => {
  const repairCommand = await activateAndGetCommand('tyrianNight.repairIslandUi');
  resetObservations();

  await repairCommand();

  expect(warningMessages).toHaveLength(1);
  expect(globalStateUpdates).toContainEqual([UNINSTALL_WARNING_ACKNOWLEDGED_KEY, true]);
  expect(spawnCalls.map((call) => call.args[1])).toEqual(['converge']);
  expect(spawnCalls[0]!.args.slice(2)).toEqual([
    '--app-root',
    '/test-vscode-app-root',
    '--island-dir',
    '/test-extension-root/island',
    '--theme-version',
    'test',
    '--repair',
    '--fallback-css',
    'tyrian-night.css',
  ]);
});

test('repair Island UI does not patch when warning acknowledgement is cancelled', async () => {
  const repairCommand = await activateAndGetCommand('tyrianNight.repairIslandUi');
  resetObservations();
  warningResponse = 'Cancel';

  await repairCommand();

  expect(warningMessages).toHaveLength(1);
  expect(spawnCalls).toEqual([]);
});

test('repair without a desired or active Tyrian style changes nothing', async () => {
  globalStateStore.set(UNINSTALL_WARNING_ACKNOWLEDGED_KEY, true);
  const repairCommand = await activateAndGetCommand('tyrianNight.repairIslandUi');
  resetObservations();
  activeTheme = 'Default Dark Modern';

  await repairCommand();

  expect(spawnCalls[0]!.args.slice(-1)).toEqual(['--repair']);
  expect(informationMessages.at(-1)?.[0]).toContain('Apply Island UI once before repairing it');
});

test('unsupported platforms skip startup reconciliation and every Island command', async () => {
  const { activate } = await import('../../apps/vscode/src/extension.js');
  activeTheme = 'Default Dark Modern';
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { configurable: true, value: 'freebsd' });
  const commands = [
    'tyrianNight.applyIslandUi',
    'tyrianNight.repairIslandUi',
    'tyrianNight.restoreClassicUi',
    'tyrianNight.doctorIslandUi',
  ];

  try {
    await activate(createExtensionContext());
    expect(spawnCalls).toEqual([]);
    resetObservations();

    for (const command of commands) {
      await registeredCommands.get(command)?.();
    }
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
  }

  expect(spawnCalls).toEqual([]);
  expect(configurationUpdates).toEqual([]);
  expect(globalStateUpdates).toEqual([]);
  expect(warningMessages).toHaveLength(commands.length);
  expect(
    warningMessages.every(([message]) => String(message).includes("unsupported on 'freebsd'"))
  ).toBe(true);
});

test('typed nonzero apply failure preserves causes, recovery guidance, and reload', async () => {
  globalStateStore.set(UNINSTALL_WARNING_ACKNOWLEDGED_KEY, true);
  const repairCommand = await activateAndGetCommand('tyrianNight.repairIslandUi');
  resetObservations();
  queuedSpawnResponses.push(typedIslandFailureResponse('apply verification failed after mutation'));

  await repairCommand();

  expect(spawnCalls.map((call) => call.args[1])).toEqual(['converge']);
  expect(
    informationMessages.some(([message]) => String(message).includes('apply verification failed'))
  ).toBe(true);
  expect(
    informationMessages.some(([message]) =>
      String(message).includes('workbench checksum did not match')
    )
  ).toBe(true);
  expect(warningMessages.some(([message]) => String(message).includes('manual recovery'))).toBe(
    true
  );
  expect(
    informationMessages.some(([message]) => String(message).includes('changed app files'))
  ).toBe(true);
});

test('typed nonzero supervised restore failure retains recovery and reload guidance', async () => {
  const { activate } = await import('../../apps/vscode/src/extension.js');
  await activate(createExtensionContext());
  const restoreCommand = registeredCommands.get('tyrianNight.restoreClassicUi');
  resetObservations();
  queuedSpawnResponses.push(
    typedIslandFailureResponse('restore verification failed after mutation')
  );

  await restoreCommand?.();

  expect(spawnCalls.map((call) => call.args[1])).toEqual(['restore-supervised']);
  expect(
    informationMessages.some(([message]) => String(message).includes('restore verification failed'))
  ).toBe(true);
  expect(warningMessages.some(([message]) => String(message).includes('manual recovery'))).toBe(
    true
  );
  expect(
    informationMessages.some(([message]) => String(message).includes('changed app files'))
  ).toBe(true);
});

test('activation converges under the CLI lock and offers reload after a restore', async () => {
  activeTheme = 'Default Dark Modern';
  queuedSpawnResponses.push({
    action: 'restore',
    result: shellResult({ physicalChanged: true }),
  } satisfies CliResult<'converge'>);

  const { activate } = await import('../../apps/vscode/src/extension.js');
  await activate(createExtensionContext());

  expect(spawnCalls.map((call) => call.args.slice(1))).toEqual([
    [
      'converge',
      '--app-root',
      '/test-vscode-app-root',
      '--island-dir',
      '/test-extension-root/island',
      '--theme-version',
      'test',
    ],
  ]);
  expect(
    informationMessages.some(([message]) =>
      String(message).includes('Incomplete Island UI state was restored')
    )
  ).toBe(true);
});

test('commands serialize Island UI mutations through the sync queue', async () => {
  const { activate } = await import('../../apps/vscode/src/extension.js');
  globalStateStore.set(UNINSTALL_WARNING_ACKNOWLEDGED_KEY, true);
  await activate(createExtensionContext());

  const repairCommand = registeredCommands.get('tyrianNight.repairIslandUi');
  const restoreCommand = registeredCommands.get('tyrianNight.restoreClassicUi');
  expect(repairCommand).toBeFunction();
  expect(restoreCommand).toBeFunction();
  resetObservations();
  holdSpawnClose = true;

  const repair = repairCommand?.();
  await waitForSpawnCount(1);
  const restore = restoreCommand?.();

  try {
    await waitForSpawnCount(2);
    expect(spawnCalls.map((call) => call.args[1])).toEqual(['converge']);
    pendingSpawnClosers.shift()?.();
    await repair;
    await waitForSpawnCount(2);
    expect(spawnCalls.map((call) => call.args[1])).toEqual(['converge', 'restore-supervised']);
    pendingSpawnClosers.shift()?.();
    await restore;
  } finally {
    while (pendingSpawnClosers.length > 0) {
      pendingSpawnClosers.shift()?.();
    }
  }
});

test('activation reports an unavailable desired style from the CLI', async () => {
  activeTheme = 'Default Dark Modern';
  queuedSpawnResponses.push(
    typedIslandFailureResponse(
      "Island UI desires unavailable style 'retired-tyrian-style.css'. Install a matching Tyrian Night version or restore Classic UI.",
      { code: 'unsupported', facts: {} }
    )
  );

  const { activate } = await import('../../apps/vscode/src/extension.js');
  await activate(createExtensionContext());

  expect(spawnCalls.map((call) => call.args[1])).toEqual(['converge']);
  expect(informationMessages.at(-1)?.[0]).toContain('desires unavailable style');
});

test('activation surfaces a typed incomplete reconciliation result', async () => {
  globalStateStore.set(UNINSTALL_WARNING_ACKNOWLEDGED_KEY, true);
  queuedSpawnResponses.push({
    action: 'apply',
    result: {
      kind: 'blocked',
      ...mutationFacts({ incompleteRecovery: true }),
      status: fakeStatus({ classification: 'broken-backup' }),
      reason: 'Island target changed after planning',
    },
  } satisfies CliResult<'converge'>);

  const { activate } = await import('../../apps/vscode/src/extension.js');
  await activate(createExtensionContext());

  expect(spawnCalls.map((call) => call.args[1])).toEqual(['converge']);
  expect(informationMessages.at(-1)?.[0]).toContain('startup reconciliation is blocked');
  expect(informationMessages.at(-1)?.[0]).toContain('changed after planning');
});

test('restore completes through the supervisor without extra prompts', async () => {
  const restoreCommand = await activateAndGetCommand('tyrianNight.restoreClassicUi');
  resetObservations();
  queuedSpawnResponses.push({
    kind: 'restored',
    ...mutationFacts({ physicalChanged: true }),
    restoredAppRoots: ['/test-vscode-app-root'],
    failedAppRoots: [],
    quarantinedRecords: [],
  } satisfies CliResult<'restore-supervised'>);

  await restoreCommand();

  expect(spawnCalls.map((call) => call.args[1])).toEqual(['restore-supervised']);
  expect(warningMessages).toEqual([]);
});

test('restore does not request reload for desired-state and registry changes without physical change', async () => {
  const restoreCommand = await activateAndGetCommand('tyrianNight.restoreClassicUi');
  resetObservations();
  queuedSpawnResponses.push({
    kind: 'restored',
    ...mutationFacts({ desiredStateChanged: true, registryChanged: true }),
    restoredAppRoots: ['/test-vscode-app-root'],
    failedAppRoots: [],
    quarantinedRecords: [],
  } satisfies CliResult<'restore-supervised'>);

  await restoreCommand();

  expect(informationMessages.at(-1)?.[0]).toBe('Tyrian Night: Classic UI is already active.');
  expect(informationMessages.some((message) => message.includes('Reload Window'))).toBe(false);
});

test('restore reports a structured blocked result without rejecting the command', async () => {
  const restoreCommand = await activateAndGetCommand('tyrianNight.restoreClassicUi');
  resetObservations();
  queuedSpawnResponses.push({
    kind: 'blocked',
    ...mutationFacts(),
    reason: 'Island target changed after planning',
    restoredAppRoots: [],
    failedAppRoots: [
      {
        appRoot: '/test-vscode-app-root',
        code: 'blocked',
        reason: 'Island target changed after planning',
      },
    ],
    quarantinedRecords: [],
  } satisfies CliResult<'restore-supervised'>);

  await expect(restoreCommand()).resolves.toBeUndefined();

  expect(spawnCalls.map((call) => call.args[1])).toEqual(['restore-supervised']);
  expect(informationMessages.at(-1)?.[0]).toContain('Classic UI restore is blocked');
  expect(informationMessages.at(-1)?.[0]).toContain('changed after planning');
});

test('repair Island UI handles permission-required supervisor result through Doctor', async () => {
  const repairCommand = await activateAndGetCommand('tyrianNight.repairIslandUi');
  resetObservations();
  queuedWarningResponses.push('I Understand', 'Open Doctor');
  queuedSpawnResponses.push(permissionRequiredConvergence(), {
    statuses: [supervisedStatus({}, 'fix-permissions', [BLOCKED_PRODUCT_JSON])],
    registryDiagnostics: [],
  } satisfies CliResult<'status-all-supervised'>);

  await repairCommand();

  expect(spawnCalls.map((call) => call.args[1])).toEqual(['converge', 'status-all-supervised']);
  expect(warningMessages.at(-1)?.[0]).toContain('VS Code app files are not writable');
  expect(warningMessages.at(-1)?.[0]).toContain('outside Tyrian');
  expect(warningMessages.at(-1)?.slice(1)).toEqual(['Why This Is Needed', 'Open Doctor', 'Later']);
});

test('permission-required Island UI prompt can open the public setup guidance', async () => {
  const repairCommand = await activateAndGetCommand('tyrianNight.repairIslandUi');
  resetObservations();
  queuedWarningResponses.push('I Understand', 'Why This Is Needed');
  queuedSpawnResponses.push(permissionRequiredConvergence());

  await repairCommand();

  expect(warningMessages.at(-1)?.slice(1)).toEqual(['Why This Is Needed', 'Open Doctor', 'Later']);
  expect(externalUrls).toEqual([
    'https://github.com/renbkna/tyrian-night/blob/main/apps/vscode/README.md#island-ui',
  ]);
  expect(spawnCalls.map((call) => call.args[1])).toEqual(['converge']);
});

test('permission-required restore routes only to setup guidance, Doctor, or dismissal', async () => {
  const restoreCommand = await activateAndGetCommand('tyrianNight.restoreClassicUi');
  resetObservations();
  queuedWarningResponses.push('Later');
  queuedSpawnResponses.push({
    kind: 'permission-required',
    ...mutationFacts({ physicalChanged: true }),
    reason: 'EACCES: permission denied',
    restoredAppRoots: [],
    failedAppRoots: [
      {
        appRoot: '/test-vscode-app-root',
        code: 'permission-required',
        reason: 'EACCES: permission denied',
      },
    ],
    quarantinedRecords: [],
  } satisfies CliResult<'restore-supervised'>);

  await restoreCommand();

  expect(spawnCalls.map((call) => call.args[1])).toEqual(['restore-supervised']);
  expect(warningMessages.at(-1)?.[0]).toContain('outside Tyrian');
  expect(warningMessages.at(-1)?.[0]).toContain('/test-vscode-app-root');
  expect(warningMessages.at(-1)?.slice(1)).toEqual(['Why This Is Needed', 'Open Doctor', 'Later']);
  expect(informationMessages.at(-1)?.[0]).toContain('remains incomplete');
});

test('Doctor treats a null desired record as disabled and recommends restore for evidence', async () => {
  const doctor = await activateAndGetCommand('tyrianNight.doctorIslandUi');
  resetObservations();
  queuedSpawnResponses.push({
    statuses: [
      supervisedStatus(
        {
          registrationState: 'valid',
          registered: true,
          desiredCssFile: null,
          classification: 'broken-backup',
        },
        'restore'
      ),
    ],
    registryDiagnostics: [],
  } satisfies CliResult<'status-all-supervised'>);

  await doctor();

  const content = (openedDocuments.at(-1) as { content?: string } | undefined)?.content;
  expect(content).toContain('Desired Island UI state: disabled');
  expect(content).toContain('Recommended action: Restore Classic UI');
});

test('Doctor reports unidentifiable registry data without mutating it', async () => {
  const doctor = await activateAndGetCommand('tyrianNight.doctorIslandUi');
  resetObservations();
  queuedSpawnResponses.push({
    statuses: [],
    registryDiagnostics: [
      {
        reason: '/state/broken.json: invalid JSON',
        recommendedAction: 'manual-recovery',
      },
    ],
  } satisfies CliResult<'status-all-supervised'>);

  await doctor();

  const content = (openedDocuments.at(-1) as { content?: string } | undefined)?.content;
  expect(content).toContain('Registry diagnostic: /state/broken.json: invalid JSON');
  expect(content).toContain('Recommended action: Inspect the reported files manually');
  expect(spawnCalls.map((call) => call.args[1])).toEqual(['status-all-supervised']);
});

test('Doctor exposes failed access inspection and owner-forced manual recovery', async () => {
  const doctor = await activateAndGetCommand('tyrianNight.doctorIslandUi');
  resetObservations();
  queuedSpawnResponses.push({
    statuses: [
      {
        ...fakeStatus(),
        accessInspection: {
          kind: 'failed',
          reason: 'app root changed generation during access inspection',
        },
        recommendedAction: 'manual-recovery',
      },
    ],
    registryDiagnostics: [],
  } satisfies CliResult<'status-all-supervised'>);

  await doctor();

  const content = (openedDocuments.at(-1) as { content?: string } | undefined)?.content;
  expect(content).toContain(
    'Write-access inspection failed: app root changed generation during access inspection'
  );
  expect(content).toContain('Recommended action: Inspect the reported files manually');
});

async function activateAndGetCommand(command: string): Promise<CommandHandler> {
  const { activate } = await import('../../apps/vscode/src/extension.js');
  await activate(createExtensionContext());

  const handler = registeredCommands.get(command);
  if (handler === undefined) throw new Error(`Command '${command}' was not registered.`);
  return handler;
}

function createExtensionContext(): TyrianExtensionContext {
  return {
    extension: { packageJSON: { version: 'test' } },
    extensionPath: '/test-extension-root',
    globalState: {
      get: readGlobalState,
      update: async (key: string, value: unknown): Promise<void> => {
        globalStateStore.set(key, value);
        globalStateUpdates.push([key, value]);
      },
    },
    subscriptions: [],
  };
}

function readGlobalState<T>(key: string): T | undefined;
function readGlobalState<T>(key: string, defaultValue: T): T;
function readGlobalState<T>(key: string, defaultValue?: T): T | undefined {
  return globalStateStore.has(key) ? (globalStateStore.get(key) as T) : defaultValue;
}

function resetObservations(): void {
  globalStateUpdates.length = 0;
  configurationUpdates.length = 0;
  spawnCalls.length = 0;
  warningMessages.length = 0;
  informationMessages.length = 0;
  externalUrls.length = 0;
  pendingSpawnClosers.length = 0;
  queuedWarningResponses.length = 0;
  queuedSpawnResponses.length = 0;
  openedDocuments.length = 0;
}

async function waitForSpawnCount(count: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (spawnCalls.length >= count) {
      return;
    }

    await Promise.resolve();
  }
}

type CliResult<Command extends keyof IslandCliResults> = IslandCliResults[Command];

const BLOCKED_PRODUCT_JSON = { path: '/test-vscode-app-root/product.json', reason: 'EACCES' };

function defaultCliResult(args: string[]): unknown {
  switch (args[1]) {
    case 'apply-supervised':
      return {
        kind: 'already-current',
        ...mutationFacts(),
        status: validStatus('tyrian-night.css'),
      } satisfies CliResult<'apply-supervised'>;
    case 'restore-supervised':
      return {
        kind: 'already-classic',
        ...mutationFacts(),
        restoredAppRoots: [],
        failedAppRoots: [],
        quarantinedRecords: [],
      } satisfies CliResult<'restore-supervised'>;
    case 'status-all-supervised':
      return {
        statuses: [supervisedStatus()],
        registryDiagnostics: [],
      } satisfies CliResult<'status-all-supervised'>;
    case 'converge':
      return { action: 'none' } satisfies CliResult<'converge'>;
    default:
      throw new Error(`Unexpected Island CLI command '${args[1]}'.`);
  }
}

function fakeStatus(overrides: Partial<IslandShellStatus> = {}): IslandShellStatus {
  return {
    appRoot: vscodeAppRoot,
    desiredCssFile: undefined,
    registrationState: 'absent',
    active: false,
    managed: false,
    registered: false,
    classification: 'clean',
    verificationPassed: true,
    restoreProof: 'none',
    workbenchChecksum: 'test-workbench-hash',
    productWorkbenchChecksum: 'test-workbench-hash',
    receipt: undefined,
    issues: [],
    ...overrides,
  };
}

function validStatus(desiredCssFile: string | null): IslandShellStatus {
  return fakeStatus({
    registrationState: 'valid',
    registered: true,
    desiredCssFile,
    managed: true,
    active: true,
  });
}

function supervisedStatus(
  overrides: Partial<IslandShellStatus> = {},
  recommendedAction: IslandUiRecommendedAction = 'none',
  blockedPaths: IslandShellWriteAccess['blockedPaths'] = []
): IslandUiSupervisorStatus {
  return {
    ...fakeStatus(overrides),
    accessInspection: { kind: 'available', writeAccess: writeAccess(blockedPaths) },
    recommendedAction,
  };
}

function writeAccess(blockedPaths: IslandShellWriteAccess['blockedPaths']): IslandShellWriteAccess {
  return {
    writable: blockedPaths.length === 0,
    checkedPaths: [],
    blockedPaths,
    issues: blockedPaths.map(({ path }) => `Tyrian cannot write '${path}'.`),
  };
}

function permissionRequiredConvergence(): CliResult<'converge'> {
  return {
    action: 'apply',
    result: {
      kind: 'permission-required',
      ...mutationFacts(),
      status: fakeStatus(),
      writeAccess: writeAccess([BLOCKED_PRODUCT_JSON]),
      reason: 'EACCES: permission denied',
    },
  };
}

function shellResult(facts: Parameters<typeof mutationFacts>[0]): IslandShellResult {
  return { ...mutationFacts(facts), active: false, status: fakeStatus() };
}

function typedIslandFailureResponse(
  reason: string,
  failure: {
    code: IslandShellFailureDescription['code'];
    facts: Parameters<typeof mutationFacts>[0];
  } = { code: 'blocked', facts: { physicalChanged: true, incompleteRecovery: true } }
): FakeProcessResponse {
  return {
    fakeProcessResponse: true,
    exitCode: 1,
    stdout: '',
    stderr: JSON.stringify({
      code: failure.code,
      ...mutationFacts(failure.facts),
      reason,
      causes: [
        { code: failure.code, reason },
        { code: failure.code, reason: 'workbench checksum did not match' },
      ],
    } satisfies IslandShellFailureDescription),
  };
}
