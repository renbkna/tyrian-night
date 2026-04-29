import { EventEmitter } from 'node:events';

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

let activeTheme = 'Tyrian Night';
let warningResponse: string | undefined = 'I Understand';

class FakeStream extends EventEmitter {
  setEncoding(_encoding: BufferEncoding): void {}
}

mock.module('node:child_process', () => ({
  spawn(command: string, args: string[]) {
    spawnCalls.push({ command, args });

    const child = new EventEmitter() as EventEmitter & {
      stdout: FakeStream;
      stderr: FakeStream;
    };
    child.stdout = new FakeStream();
    child.stderr = new FakeStream();

    queueMicrotask(() => {
      child.stdout.emit(
        'data',
        JSON.stringify({ changed: false, restoredAppRoots: [], failedAppRoots: [] })
      );
      child.emit('close', 0);
    });

    return child;
  },
}));

mock.module('vscode', () => ({
  ConfigurationTarget: {
    Global: 1,
  },
  commands: {
    executeCommand: async () => undefined,
    registerCommand(command: string, handler: CommandHandler) {
      registeredCommands.set(command, handler);
      return { dispose: () => undefined };
    },
  },
  env: {
    appRoot: '/test-vscode-app-root',
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
      return warningResponse;
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
  warningResponse = 'I Understand';
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
  expect(spawnCalls[0]?.args[1]).toBe('apply');
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

async function activateAndGetRepairCommand(): Promise<CommandHandler> {
  const { activate } = await import('../src/extension');
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
}
