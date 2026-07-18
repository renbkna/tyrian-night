import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';

import { beforeEach, expect, mock, test } from 'bun:test';

type CommandHandler = () => unknown | Promise<unknown>;

const ISLAND_UI_CONFIG_KEY = 'tyrianNight.islandUi:/test-vscode-app-root';
const LEGACY_ISLAND_UI_ENABLED_KEY = 'tyrianNight.islandUiEnabled';
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
  const repairCommand = await activateAndGetRepairCommand();
  resetObservations();

  await repairCommand();

  expect(warningMessages).toHaveLength(1);
  expect(globalStateUpdates).toContainEqual([UNINSTALL_WARNING_ACKNOWLEDGED_KEY, true]);
  expect(globalStateUpdates.some(([key]) => key === ISLAND_UI_CONFIG_KEY)).toBe(false);
  expect(spawnCalls.map((call) => call.args[1])).toEqual(['status', 'apply-supervised']);
});

test('repair Island UI does not patch when warning acknowledgement is cancelled', async () => {
  const repairCommand = await activateAndGetRepairCommand();
  resetObservations();
  warningResponse = 'Cancel';

  await repairCommand();

  expect(warningMessages).toHaveLength(1);
  expect(globalStateUpdates.some(([key]) => key === ISLAND_UI_CONFIG_KEY)).toBe(false);
  expect(spawnCalls.map((call) => call.args[1])).toEqual(['status']);
});

test('unsupported Apply and Repair stop before command-side state changes', async () => {
  const { activate } = await import('../apps/vscode/src/extension');
  await activate(createExtensionContext());
  const applyCommand = registeredCommands.get('tyrianNight.applyIslandUi');
  const repairCommand = registeredCommands.get('tyrianNight.repairIslandUi');
  resetObservations();
  activeTheme = 'Default Dark Modern';
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });

  try {
    await applyCommand?.();
    await repairCommand?.();
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
  }

  expect(spawnCalls).toEqual([]);
  expect(configurationUpdates).toEqual([]);
  expect(globalStateUpdates).toEqual([]);
  expect(warningMessages).toHaveLength(2);
  expect(
    warningMessages.every(([message]) => String(message).includes('only patches VS Code on Linux'))
  ).toBe(true);
});

test('extension rejects a successful CLI payload without the command discriminant', async () => {
  const repairCommand = await activateAndGetRepairCommand();
  resetObservations();
  queuedSpawnResponses.push({ unexpected: true });

  await expect(repairCommand()).rejects.toThrow(
    'Tyrian Night CLI returned invalid output: Invalid Island reconciliation status.version.'
  );
});

test('extension rejects an impossible versioned registration payload', async () => {
  const repairCommand = await activateAndGetRepairCommand();
  resetObservations();
  queuedSpawnResponses.push({
    version: 1,
    registration: { kind: 'absent', desiredThemeId: 'tyrian-night.css' },
    managed: false,
    active: false,
  });

  await expect(repairCommand()).rejects.toThrow(
    'Invalid Island reconciliation status.registration.desiredThemeId.'
  );
});

test('typed nonzero apply failure preserves causes, recovery guidance, and reload', async () => {
  globalStateStore.set(UNINSTALL_WARNING_ACKNOWLEDGED_KEY, true);
  const repairCommand = await activateAndGetRepairCommand();
  resetObservations();
  queuedSpawnResponses.push(
    fakeReconciliationStatus({ kind: 'valid', desiredThemeId: 'tyrian-night.css' }, true, true),
    typedIslandFailureResponse('apply lock release failed after mutation')
  );

  await repairCommand();

  expect(spawnCalls.map((call) => call.args[1])).toEqual(['status', 'apply-supervised']);
  expect(
    informationMessages.some(([message]) => String(message).includes('apply lock release failed'))
  ).toBe(true);
  expect(
    informationMessages.some(([message]) =>
      String(message).includes('lock release generation remained observable')
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
  const { activate } = await import('../apps/vscode/src/extension');
  await activate(createExtensionContext());
  const restoreCommand = registeredCommands.get('tyrianNight.restoreClassicUi');
  resetObservations();
  queuedSpawnResponses.push(
    typedIslandFailureResponse('restore lock release failed after mutation')
  );

  await restoreCommand?.();

  expect(spawnCalls.map((call) => call.args[1])).toEqual(['restore-supervised']);
  expect(
    informationMessages.some(([message]) => String(message).includes('restore lock release failed'))
  ).toBe(true);
  expect(warningMessages.some(([message]) => String(message).includes('manual recovery'))).toBe(
    true
  );
  expect(
    informationMessages.some(([message]) => String(message).includes('changed app files'))
  ).toBe(true);
});

test('typed nonzero direct restore failure receives startup lifecycle remediation', async () => {
  queuedSpawnResponses.push(
    fakeReconciliationStatus({ kind: 'legacy' }, true, true),
    typedIslandFailureResponse('direct restore failed after mutation')
  );

  const { activate } = await import('../apps/vscode/src/extension');
  await activate(createExtensionContext());

  expect(spawnCalls.map((call) => call.args[1])).toEqual(['status', 'restore']);
  expect(
    informationMessages.some(([message]) => String(message).includes('direct restore failed'))
  ).toBe(true);
  expect(warningMessages.some(([message]) => String(message).includes('manual recovery'))).toBe(
    true
  );
});

test('legacy enabled state migrates once into the shared shell record', async () => {
  activeTheme = 'Tyrian Nocturne';
  globalStateStore.set(LEGACY_ISLAND_UI_ENABLED_KEY, true);
  globalStateStore.set(UNINSTALL_WARNING_ACKNOWLEDGED_KEY, true);
  queuedSpawnResponses.push(
    { kind: 'seeded', desiredThemeId: 'tyrian-nocturne.css' },
    fakeReconciliationStatus({ kind: 'valid', desiredThemeId: 'tyrian-nocturne.css' }, true)
  );

  const { activate } = await import('../apps/vscode/src/extension');
  await activate(createExtensionContext());

  expect(globalStateUpdates.some(([key]) => key === ISLAND_UI_CONFIG_KEY)).toBe(false);
  expect(globalStateUpdates).toContainEqual([LEGACY_ISLAND_UI_ENABLED_KEY, undefined]);
  expect(spawnCalls.map((call) => call.args[1])).toEqual([
    'seed-desired-supervised',
    'status',
    'apply-supervised',
  ]);
  const desiredIndex = spawnCalls[0]!.args.indexOf('--desired-theme-id');
  expect(spawnCalls[0]!.args[desiredIndex + 1]).toBe('tyrian-nocturne.css');
});

test('legacy per-root state migrates into shell authority and is deleted', async () => {
  activeTheme = 'Default Dark Modern';
  globalStateStore.set(ISLAND_UI_CONFIG_KEY, { theme: 'Tyrian Nocturne' });
  queuedSpawnResponses.push(
    { kind: 'seeded', desiredThemeId: 'tyrian-nocturne.css' },
    fakeReconciliationStatus({ kind: 'valid', desiredThemeId: 'tyrian-nocturne.css' }, true)
  );

  const { activate } = await import('../apps/vscode/src/extension');
  await activate(createExtensionContext());

  expect(globalStateUpdates).toContainEqual([ISLAND_UI_CONFIG_KEY, undefined]);
  expect(spawnCalls.map((call) => call.args[1])).toEqual([
    'seed-desired-supervised',
    'status',
    'apply-supervised',
  ]);
  const cssSourceIndex = spawnCalls[2]!.args.indexOf('--css-source');
  expect(spawnCalls[2]!.args[cssSourceIndex + 1]).toEndWith('tyrian-nocturne.css');
});

test('legacy desired state is retained until the shared shell migration commits', async () => {
  globalStateStore.set(LEGACY_ISLAND_UI_ENABLED_KEY, true);
  queuedSpawnResponses.push({
    kind: 'permission-required',
    ...mutationFacts(),
    status: fakeIslandStatus('clean'),
    writeAccess: {
      writable: false,
      blockedPaths: [{ path: '/test-vscode-app-root/product.json', reason: 'EACCES' }],
      issues: [],
    },
    reason: 'EACCES: permission denied',
  });

  const { activate } = await import('../apps/vscode/src/extension');
  await activate(createExtensionContext());

  expect(globalStateStore.get(LEGACY_ISLAND_UI_ENABLED_KEY)).toBe(true);
  expect(globalStateUpdates).not.toContainEqual([LEGACY_ISLAND_UI_ENABLED_KEY, undefined]);
});

test('stale local migration cannot overwrite an existing shared desired style', async () => {
  globalStateStore.set(ISLAND_UI_CONFIG_KEY, { theme: 'Tyrian Nocturne' });
  queuedSpawnResponses.push(
    { kind: 'existing', desiredThemeId: 'tyrian-night.css' },
    fakeReconciliationStatus({ kind: 'valid', desiredThemeId: 'tyrian-night.css' }, true, true)
  );

  const { activate } = await import('../apps/vscode/src/extension');
  await activate(createExtensionContext());

  expect(globalStateUpdates).toContainEqual([ISLAND_UI_CONFIG_KEY, undefined]);
  expect(spawnCalls.map((call) => call.args[1])).toEqual([
    'seed-desired-supervised',
    'status',
    'apply-supervised',
  ]);
  const cssSourceIndex = spawnCalls[2]!.args.indexOf('--css-source');
  expect(spawnCalls[2]!.args[cssSourceIndex + 1]).toEndWith('tyrian-night.css');
});

test('activation restores a desired-unknown v1 record instead of selecting a window theme', async () => {
  queuedSpawnResponses.push(fakeReconciliationStatus({ kind: 'legacy' }, true, true));

  const { activate } = await import('../apps/vscode/src/extension');
  await activate(createExtensionContext());

  expect(spawnCalls.map((call) => call.args[1])).toEqual(['status', 'restore']);
});

test('activation restores current physical evidence when no desired record exists', async () => {
  activeTheme = 'Default Dark Modern';
  queuedSpawnResponses.push(
    {
      ...fakeReconciliationStatus({ kind: 'absent' }, true, true),
    },
    { ...mutationFacts(), active: false }
  );

  const { activate } = await import('../apps/vscode/src/extension');
  await activate(createExtensionContext());

  expect(spawnCalls.map((call) => call.args[1])).toEqual(['status', 'restore']);
});

test('commands serialize Island UI mutations through the sync queue', async () => {
  const { activate } = await import('../apps/vscode/src/extension');
  globalStateStore.delete(ISLAND_UI_CONFIG_KEY);
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
    expect(spawnCalls).toHaveLength(1);
    pendingSpawnClosers.shift()?.();
    await waitForSpawnCount(2);
    expect(spawnCalls).toHaveLength(2);
    pendingSpawnClosers.shift()?.();
    await repair;
    await waitForSpawnCount(3);
    pendingSpawnClosers.shift()?.();
    await restore;
  } finally {
    while (pendingSpawnClosers.length > 0) {
      pendingSpawnClosers.shift()?.();
    }
  }
});

test('shared installation desired style wins over a window-local color theme', async () => {
  activeTheme = 'Default Dark Modern';
  globalStateStore.set(UNINSTALL_WARNING_ACKNOWLEDGED_KEY, true);
  queuedSpawnResponses.push(
    fakeReconciliationStatus({ kind: 'valid', desiredThemeId: 'tyrian-nocturne.css' }, true, true)
  );

  const { activate } = await import('../apps/vscode/src/extension');
  await activate(createExtensionContext());

  expect(spawnCalls.map((call) => call.args[1])).toEqual(['status', 'apply-supervised']);
  const cssSourceIndex = spawnCalls[1]!.args.indexOf('--css-source');
  expect(spawnCalls[1]!.args[cssSourceIndex + 1]).toEndWith('tyrian-nocturne.css');
});

test('activation blocks an unavailable desired style instead of deleting shared policy', async () => {
  activeTheme = 'Default Dark Modern';
  queuedSpawnResponses.push(
    fakeReconciliationStatus(
      { kind: 'valid', desiredThemeId: 'retired-tyrian-style.css' },
      true,
      true
    )
  );

  const { activate } = await import('../apps/vscode/src/extension');
  await activate(createExtensionContext());

  expect(spawnCalls.map((call) => call.args[1])).toEqual(['status']);
  expect(informationMessages.at(-1)?.[0]).toContain('desires unavailable style');
});

test('repair preserves an unavailable shared desired style instead of falling back to the window theme', async () => {
  globalStateStore.set(UNINSTALL_WARNING_ACKNOWLEDGED_KEY, true);
  const repairCommand = await activateAndGetRepairCommand();
  resetObservations();
  queuedSpawnResponses.push(
    fakeReconciliationStatus(
      { kind: 'valid', desiredThemeId: 'retired-tyrian-style.css' },
      true,
      true
    )
  );

  await repairCommand();

  expect(spawnCalls.map((call) => call.args[1])).toEqual(['status']);
  expect(informationMessages.at(-1)?.[0]).toContain('desires unavailable style');
  expect(warningMessages).toEqual([]);
});

test('activation surfaces a typed incomplete reconciliation result', async () => {
  globalStateStore.set(UNINSTALL_WARNING_ACKNOWLEDGED_KEY, true);
  queuedSpawnResponses.push(
    fakeReconciliationStatus({ kind: 'valid', desiredThemeId: 'tyrian-night.css' }, true, true),
    {
      kind: 'blocked',
      ...mutationFacts({ incompleteRecovery: true }),
      status: fakeIslandStatus('transaction-blocked'),
      reason: 'pending transaction requires manual recovery',
    }
  );

  const { activate } = await import('../apps/vscode/src/extension');
  await activate(createExtensionContext());

  expect(spawnCalls.map((call) => call.args[1])).toEqual(['status', 'apply-supervised']);
  expect(informationMessages.at(-1)?.[0]).toContain('startup reconciliation is blocked');
  expect(informationMessages.at(-1)?.[0]).toContain('manual recovery');
});

test('restore completes through the supervisor without extra prompts', async () => {
  const { activate } = await import('../apps/vscode/src/extension');
  await activate(createExtensionContext());
  await waitForRegisteredCommand('tyrianNight.restoreClassicUi');

  const restoreCommand = registeredCommands.get('tyrianNight.restoreClassicUi');
  expect(restoreCommand).toBeFunction();
  resetObservations();
  queuedSpawnResponses.push({
    kind: 'restored',
    ...mutationFacts({ physicalChanged: true }),
    restoredAppRoots: ['/test-vscode-app-root'],
    failedAppRoots: [],
  });

  await restoreCommand?.();

  expect(spawnCalls.map((call) => call.args[1])).toEqual(['restore-supervised']);
  expect(warningMessages).toEqual([]);
  expect(globalStateUpdates.some(([key]) => key === ISLAND_UI_CONFIG_KEY)).toBe(false);
});

test('restore does not request reload for desired-state and registry changes without physical change', async () => {
  const { activate } = await import('../apps/vscode/src/extension');
  await activate(createExtensionContext());
  const restoreCommand = registeredCommands.get('tyrianNight.restoreClassicUi');
  resetObservations();
  queuedSpawnResponses.push({
    kind: 'restored',
    ...mutationFacts({ desiredStateChanged: true, registryChanged: true }),
    restoredAppRoots: ['/test-vscode-app-root'],
    failedAppRoots: [],
    quarantinedRecords: [],
  });

  await restoreCommand?.();

  expect(informationMessages.at(-1)?.[0]).toBe('Tyrian Night: Classic UI is already active.');
  expect(informationMessages.some((message) => message.includes('Reload Window'))).toBe(false);
});

test('repair Island UI handles permission-required supervisor result through Doctor', async () => {
  const repairCommand = await activateAndGetRepairCommand();
  resetObservations();
  queuedWarningResponses.push('I Understand', 'Open Doctor');
  queuedSpawnResponses.push(
    fakeReconciliationStatus({ kind: 'absent' }),
    {
      kind: 'permission-required',
      ...mutationFacts(),
      status: fakeIslandStatus('clean'),
      writeAccess: {
        writable: false,
        blockedPaths: [{ path: '/test-vscode-app-root/product.json', reason: 'EACCES' }],
        issues: ["Tyrian cannot write '/test-vscode-app-root/product.json'."],
      },
      reason: 'EACCES: permission denied',
    },
    {
      version: 1,
      statuses: [
        {
          ...fakeIslandStatus('clean'),
          accessInspection: {
            kind: 'available',
            writable: false,
            blockedPaths: [{ path: '/test-vscode-app-root/product.json', reason: 'EACCES' }],
          },
        },
      ],
      registryDiagnostics: [],
    }
  );

  await repairCommand();

  expect(spawnCalls.map((call) => call.args[1])).toEqual([
    'status',
    'apply-supervised',
    'status-all-supervised',
  ]);
  expect(warningMessages.at(-1)?.[0]).toContain('VS Code app files are not writable');
  expect(warningMessages.at(-1)?.[0]).toContain('outside Tyrian');
  expect(warningMessages.at(-1)?.slice(1)).toEqual(['Why This Is Needed', 'Open Doctor', 'Later']);
});

test('permission-required Island UI prompt can open the public setup guidance', async () => {
  const repairCommand = await activateAndGetRepairCommand();
  resetObservations();
  queuedWarningResponses.push('I Understand', 'Why This Is Needed');
  queuedSpawnResponses.push(fakeReconciliationStatus({ kind: 'absent' }), {
    kind: 'permission-required',
    ...mutationFacts(),
    status: fakeIslandStatus('clean'),
    writeAccess: {
      writable: false,
      blockedPaths: [{ path: '/test-vscode-app-root/product.json', reason: 'EACCES' }],
      issues: ["Tyrian cannot write '/test-vscode-app-root/product.json'."],
    },
    reason: 'EACCES: permission denied',
  });

  await repairCommand();

  expect(warningMessages.at(-1)?.slice(1)).toEqual(['Why This Is Needed', 'Open Doctor', 'Later']);
  expect(externalUrls).toEqual([
    'https://github.com/renbkna/tyrian-night/blob/main/apps/vscode/README.md#island-ui',
  ]);
  expect(spawnCalls.map((call) => call.args[1])).toEqual(['status', 'apply-supervised']);
});

test('permission-required restore routes only to setup guidance, Doctor, or dismissal', async () => {
  const { activate } = await import('../apps/vscode/src/extension');
  await activate(createExtensionContext());
  await waitForRegisteredCommand('tyrianNight.restoreClassicUi');

  const restoreCommand = registeredCommands.get('tyrianNight.restoreClassicUi');
  expect(restoreCommand).toBeFunction();
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
        reason: 'EACCES: permission denied',
      },
    ],
  });

  await restoreCommand?.();

  expect(spawnCalls.map((call) => call.args[1])).toEqual(['restore-supervised']);
  expect(warningMessages.at(-1)?.[0]).toContain('outside Tyrian');
  expect(warningMessages.at(-1)?.[0]).toContain('/test-vscode-app-root');
  expect(warningMessages.at(-1)?.slice(1)).toEqual(['Why This Is Needed', 'Open Doctor', 'Later']);
  expect(informationMessages.at(-1)?.[0]).toContain('remains incomplete');
});

test('Doctor treats a null desired record as disabled and recommends restore for evidence', async () => {
  const { activate } = await import('../apps/vscode/src/extension');
  await activate(createExtensionContext());
  const doctor = registeredCommands.get('tyrianNight.doctorIslandUi');
  resetObservations();
  queuedSpawnResponses.push({
    version: 1,
    statuses: [
      {
        ...fakeIslandStatus('broken-backup'),
        desiredThemeId: null,
        accessInspection: { kind: 'available', writable: true, blockedPaths: [] },
      },
    ],
    registryDiagnostics: [],
  });

  await doctor?.();

  const content = (openedDocuments.at(-1) as { content?: string } | undefined)?.content;
  expect(content).toContain('Desired Island UI state: disabled');
  expect(content).toContain('Recommended action: Restore Classic UI');
});

test('Doctor exposes the supervisor-owned restore remedy for a legacy registration', async () => {
  const { activate } = await import('../apps/vscode/src/extension');
  await activate(createExtensionContext());
  const doctor = registeredCommands.get('tyrianNight.doctorIslandUi');
  resetObservations();
  queuedWarningResponses.push('Later');
  queuedSpawnResponses.push({
    version: 1,
    statuses: [
      {
        ...fakeIslandStatus('broken-backup'),
        desiredThemeId: undefined,
        recommendedAction: 'restore',
        accessInspection: { kind: 'available', writable: true, blockedPaths: [] },
      },
    ],
    registryDiagnostics: [],
  });

  await doctor?.();

  const content = (openedDocuments.at(-1) as { content?: string } | undefined)?.content;
  expect(content).toContain('Self-heal: available via Restore Classic UI');
  expect(content).toContain('Recommended action: Restore Classic UI');
  expect(warningMessages.at(-1)?.[0]).toContain('self-healable Island UI issues');
});

test('Doctor reports unidentifiable registry data without mutating it', async () => {
  const { activate } = await import('../apps/vscode/src/extension');
  await activate(createExtensionContext());
  const doctor = registeredCommands.get('tyrianNight.doctorIslandUi');
  resetObservations();
  queuedSpawnResponses.push({
    version: 1,
    statuses: [],
    registryDiagnostics: [
      {
        reason: '/state/broken.json: invalid JSON',
        recommendedAction: 'manual-recovery',
      },
    ],
  });

  await doctor?.();

  const content = (openedDocuments.at(-1) as { content?: string } | undefined)?.content;
  expect(content).toContain('Registry diagnostic: /state/broken.json: invalid JSON');
  expect(content).toContain(
    'Recommended action: Inspect and recover transaction evidence manually'
  );
  expect(spawnCalls.map((call) => call.args[1])).toEqual(['status-all-supervised']);
});

test('Doctor exposes failed access inspection and owner-forced manual recovery', async () => {
  const { activate } = await import('../apps/vscode/src/extension');
  await activate(createExtensionContext());
  const doctor = registeredCommands.get('tyrianNight.doctorIslandUi');
  resetObservations();
  queuedSpawnResponses.push({
    version: 1,
    statuses: [
      {
        ...fakeIslandStatus('clean'),
        accessInspection: {
          kind: 'failed',
          reason: 'app root changed generation during access inspection',
        },
        recommendedAction: 'manual-recovery',
      },
    ],
    registryDiagnostics: [],
  });

  await doctor?.();

  const content = (openedDocuments.at(-1) as { content?: string } | undefined)?.content;
  expect(content).toContain(
    'Write-access inspection failed: app root changed generation during access inspection'
  );
  expect(content).toContain(
    'Recommended action: Inspect and recover transaction evidence manually'
  );
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

async function waitForRegisteredCommand(command: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (registeredCommands.has(command)) {
      return;
    }

    await Promise.resolve();
  }
}

async function waitForSpawnCount(count: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (spawnCalls.length >= count) {
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
        ...mutationFacts(),
        status: fakeIslandStatus('patched'),
      };
    case 'restore-supervised':
      return {
        kind: 'already-classic',
        ...mutationFacts(),
        restoredAppRoots: [],
        failedAppRoots: [],
      };
    case 'status-all-supervised':
      return {
        version: 1,
        statuses: [
          {
            ...fakeIslandStatus('clean'),
            accessInspection: {
              kind: 'available',
              writable: true,
              blockedPaths: [],
            },
          },
        ],
        registryDiagnostics: [],
      };
    case 'status':
      return fakeReconciliationStatus({ kind: 'absent' });
    case 'seed-desired-supervised':
      return { kind: 'seeded', desiredThemeId: 'tyrian-night.css' };
    case 'restore':
      return { ...mutationFacts(), active: false };
    default:
      return { ...mutationFacts(), restoredAppRoots: [], failedAppRoots: [] };
  }
}

function mutationFacts(
  facts: Partial<{
    desiredStateChanged: boolean;
    registryChanged: boolean;
    physicalChanged: boolean;
    externalDrift: boolean;
    incompleteRecovery: boolean;
  }> = {}
) {
  const result = {
    desiredStateChanged: facts.desiredStateChanged ?? false,
    registryChanged: facts.registryChanged ?? false,
    physicalChanged: facts.physicalChanged ?? false,
    externalDrift: facts.externalDrift ?? false,
    incompleteRecovery: facts.incompleteRecovery ?? false,
  };
  return {
    ...result,
    changed: result.desiredStateChanged || result.registryChanged || result.physicalChanged,
  };
}

function fakeReconciliationStatus(
  registration:
    | { kind: 'absent' }
    | { kind: 'valid'; desiredThemeId: string | null }
    | { kind: 'legacy' }
    | { kind: 'corrupt' },
  managed = false,
  active = false
) {
  return { version: 1, registration, managed, active };
}

function typedIslandFailureResponse(reason: string): FakeProcessResponse {
  return {
    fakeProcessResponse: true,
    exitCode: 1,
    stdout: '',
    stderr: JSON.stringify({
      version: 1,
      code: 'blocked',
      ...mutationFacts({ physicalChanged: true, incompleteRecovery: true }),
      reason,
      causes: [
        { code: 'blocked', reason },
        { code: 'blocked', reason: 'lock release generation remained observable' },
      ],
    }),
  };
}

function fakeIslandStatus(classification: string): {
  appRoot: string;
  desiredThemeId: string | null | undefined;
  classification: string;
  verificationPassed: boolean;
  canSelfHeal: boolean;
  transaction: { kind: 'clean'; recoverability: 'none' };
  recommendedAction:
    | 'none'
    | 'apply'
    | 'repair'
    | 'restore'
    | 'prune-missing'
    | 'fix-permissions'
    | 'manual-recovery';
  restoreProof: 'none' | 'manifest-v3-backup-pair' | 'strip-tyrian-block';
  workbenchChecksum: string;
  productWorkbenchChecksum: string;
  receipt: undefined;
  issues: string[];
} {
  return {
    appRoot: vscodeAppRoot,
    desiredThemeId: classification === 'patched' ? 'tyrian-night.css' : undefined,
    classification,
    verificationPassed: classification === 'clean' || classification === 'patched',
    canSelfHeal: false,
    transaction: { kind: 'clean', recoverability: 'none' },
    recommendedAction:
      classification === 'broken-backup'
        ? 'restore'
        : classification === 'transaction-blocked'
          ? 'manual-recovery'
          : 'none',
    restoreProof: 'none',
    workbenchChecksum: 'test-workbench-hash',
    productWorkbenchChecksum: 'test-workbench-hash',
    receipt: undefined,
    issues: [],
  };
}
