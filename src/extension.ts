import path from 'node:path';
import { spawn } from 'node:child_process';

import * as vscode from 'vscode';

const THEME_NAME = 'Tyrian Night';
const ISLAND_UI_ENABLED_KEY = 'tyrianNight.islandUiEnabled';
const THEME_PROMPT_KEY = 'tyrianNight.themePrompted';

let extContext: vscode.ExtensionContext;
let syncQueue = Promise.resolve();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extContext = context;

  try {
    await initializeState();
    registerCommands();
    extContext.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('workbench.colorTheme')) {
          void enqueueSync(() => syncIslandUi({ allowThemePrompt: false }));
        }
      })
    );
    await enqueueSync(() => syncIslandUi({ allowThemePrompt: true }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Tyrian Night: ${message}`);
  }
}

async function initializeState(): Promise<void> {
  if (extContext.globalState.get<boolean | undefined>(ISLAND_UI_ENABLED_KEY) === undefined) {
    await extContext.globalState.update(ISLAND_UI_ENABLED_KEY, true);
  }
}

function registerCommands(): void {
  extContext.subscriptions.push(
    vscode.commands.registerCommand('tyrianNight.enableIslandUi', enableIslandUi),
    vscode.commands.registerCommand('tyrianNight.repairIslandUi', repairIslandUi),
    vscode.commands.registerCommand('tyrianNight.restoreClassicUi', restoreClassicUi)
  );
}

function enqueueSync(task: () => Promise<void>): Promise<void> {
  syncQueue = syncQueue.then(task, task);
  return syncQueue;
}

async function syncIslandUi(options: { allowThemePrompt: boolean }): Promise<void> {
  const islandUiEnabled = extContext.globalState.get<boolean>(ISLAND_UI_ENABLED_KEY, true);
  const activeTheme = getActiveTheme();

  if (activeTheme !== THEME_NAME) {
    if (options.allowThemePrompt) {
      const switchedTheme = await maybePromptToSwitchTheme(activeTheme);

      if (switchedTheme) {
        return;
      }
    }

    await restoreIslandUi({
      notifyWhenUnchanged: false,
      reloadMessage: 'Tyrian Night: Island UI was removed because another color theme is active.',
    });
    return;
  }

  if (!islandUiEnabled) {
    await restoreIslandUi({
      notifyWhenUnchanged: false,
      reloadMessage: 'Tyrian Night: Classic UI restored. Reload VS Code to finish reverting.',
    });
    return;
  }

  await applyIslandUi({
    notifyWhenUnchanged: false,
    reloadMessage: 'Tyrian Night: Island UI was updated. Reload VS Code to apply it.',
  });
}

async function maybePromptToSwitchTheme(activeTheme: string | undefined): Promise<boolean> {
  const promptShown = extContext.globalState.get<boolean>(THEME_PROMPT_KEY, false);

  if (promptShown || activeTheme === THEME_NAME) {
    return false;
  }

  await extContext.globalState.update(THEME_PROMPT_KEY, true);

  const action = await vscode.window.showInformationMessage(
    'Tyrian Night is installed. Switch to the Tyrian Night color theme and enable Island UI now?',
    'Switch Theme',
    'Later'
  );

  if (action !== 'Switch Theme') {
    return false;
  }

  await vscode.workspace
    .getConfiguration('workbench')
    .update('colorTheme', THEME_NAME, vscode.ConfigurationTarget.Global);

  return true;
}

async function enableIslandUi(): Promise<void> {
  await extContext.globalState.update(ISLAND_UI_ENABLED_KEY, true);

  if (getActiveTheme() !== THEME_NAME) {
    const action = await vscode.window.showInformationMessage(
      'Tyrian Night: Island UI follows the Tyrian Night theme. Switch themes now?',
      'Switch Theme',
      'Later'
    );

    if (action === 'Switch Theme') {
      await vscode.workspace
        .getConfiguration('workbench')
        .update('colorTheme', THEME_NAME, vscode.ConfigurationTarget.Global);
    }

    return;
  }

  await applyIslandUi({
    notifyWhenUnchanged: true,
    reloadMessage: 'Tyrian Night: Island UI installed. Reload VS Code to apply it.',
  });
}

async function repairIslandUi(): Promise<void> {
  if (getActiveTheme() !== THEME_NAME) {
    vscode.window.showInformationMessage(
      'Tyrian Night: Switch to the Tyrian Night theme before repairing Island UI.'
    );
    return;
  }

  await applyIslandUi({
    notifyWhenUnchanged: true,
    reloadMessage: 'Tyrian Night: Island UI repaired. Reload VS Code to apply it.',
  });
}

async function applyIslandUi(options: {
  notifyWhenUnchanged: boolean;
  reloadMessage: string;
}): Promise<void> {
  const result = await runIslandCli([
    'apply',
    '--app-root',
    vscode.env.appRoot,
    '--css-source',
    path.join(extContext.extensionPath, 'themes', 'tyrian-night.css'),
    '--theme-version',
    String(extContext.extension.packageJSON.version ?? 'unknown'),
  ]);

  if (!result.changed) {
    if (options.notifyWhenUnchanged) {
      vscode.window.showInformationMessage('Tyrian Night: Island UI is already up to date.');
    }
    return;
  }

  await promptForReload(options.reloadMessage);
}

async function restoreClassicUi(): Promise<void> {
  await extContext.globalState.update(ISLAND_UI_ENABLED_KEY, false);
  await restoreIslandUi({
    notifyWhenUnchanged: true,
    reloadMessage: 'Tyrian Night: Classic UI restored. Reload VS Code to finish reverting.',
  });
}

async function restoreIslandUi(options: {
  notifyWhenUnchanged: boolean;
  reloadMessage: string;
}): Promise<void> {
  const result = await runIslandCli(['restore-all', '--app-root', vscode.env.appRoot]);

  if (!result.changed) {
    if (options.notifyWhenUnchanged) {
      vscode.window.showInformationMessage('Tyrian Night: Classic UI is already active.');
    }
    return;
  }

  await promptForReload(options.reloadMessage);
}

function runIslandCli(argumentsList: string[]): Promise<{ changed: boolean }> {
  const cliPath = path.join(extContext.extensionPath, 'out', 'islandCli.js');

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...argumentsList], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(normalizeCliError(stderr || stdout)));
        return;
      }

      try {
        resolve(JSON.parse(stdout) as { changed: boolean });
      } catch (error) {
        reject(
          new Error(
            `Tyrian Night CLI returned invalid output: ${error instanceof Error ? error.message : String(error)}`
          )
        );
      }
    });
  });
}

function normalizeCliError(output: string): string {
  const message = output.trim();

  if (!message) {
    return 'Island UI CLI failed without an error message.';
  }

  if (/EACCES|EPERM/i.test(message)) {
    return `${message} Tyrian Night needs write access to the VS Code app files to manage Island UI.`;
  }

  return message;
}

function getActiveTheme(): string | undefined {
  return vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
}

async function promptForReload(message: string): Promise<void> {
  const action = await vscode.window.showInformationMessage(message, 'Reload Window', 'Later');

  if (action === 'Reload Window') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

export function deactivate(): void {
  // Island UI is managed explicitly by commands and the uninstall hook.
}
