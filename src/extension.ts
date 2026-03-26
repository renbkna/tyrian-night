import path from 'node:path';
import { spawn } from 'node:child_process';

import * as vscode from 'vscode';

const THEME_NAME = 'Tyrian Night';
const ISLAND_UI_ENABLED_KEY = 'tyrianNight.islandUiEnabled';
const THEME_PROMPT_KEY = 'tyrianNight.themePrompted';
const UNINSTALL_WARNING_ACKNOWLEDGED_KEY = 'tyrianNight.uninstallWarningAcknowledged';
const UNINSTALL_WARNING_MESSAGE =
  'Tyrian Night: Island UI patches VS Code workbench files. Before uninstalling this extension, you must run "Tyrian Night: Restore Classic UI". Uninstalling the extension alone will not remove the custom UI.';

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
    await extContext.globalState.update(ISLAND_UI_ENABLED_KEY, false);
  }
}

function registerCommands(): void {
  extContext.subscriptions.push(
    vscode.commands.registerCommand('tyrianNight.applyIslandUi', applyIslandUiCommand),
    vscode.commands.registerCommand('tyrianNight.repairIslandUi', repairIslandUi),
    vscode.commands.registerCommand('tyrianNight.restoreClassicUi', restoreClassicUi),
    vscode.commands.registerCommand('tyrianNight.doctorIslandUi', doctorIslandUi)
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

  if (!(await ensureUninstallWarningAcknowledged({ interactive: options.allowThemePrompt }))) {
    await extContext.globalState.update(ISLAND_UI_ENABLED_KEY, false);
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
    'Tyrian Night is installed. Switch to the Tyrian Night color theme now? You can enable Island UI after acknowledging the restore-before-uninstall warning.',
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

async function applyIslandUiCommand(): Promise<void> {
  if (getActiveTheme() !== THEME_NAME) {
    const action = await vscode.window.showInformationMessage(
      'Tyrian Night: Apply Island UI with the Tyrian Night theme?',
      'Switch Theme',
      'Cancel'
    );

    if (action !== 'Switch Theme') {
      return;
    }

    await vscode.workspace
      .getConfiguration('workbench')
      .update('colorTheme', THEME_NAME, vscode.ConfigurationTarget.Global);
  }

  if (!(await ensureUninstallWarningAcknowledged({ interactive: true }))) {
    return;
  }

  await extContext.globalState.update(ISLAND_UI_ENABLED_KEY, true);
  await applyIslandUi({
    notifyWhenUnchanged: true,
    reloadMessage: 'Tyrian Night: Island UI applied. Reload VS Code to apply it.',
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
  const result = (await runIslandCli([
    'apply',
    '--app-root',
    vscode.env.appRoot,
    '--css-source',
    path.join(extContext.extensionPath, 'themes', 'tyrian-night.css'),
    '--theme-version',
    String(extContext.extension.packageJSON.version ?? 'unknown'),
  ])) as { changed: boolean };

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

async function doctorIslandUi(): Promise<void> {
  const statuses = await runIslandCli<
    Array<{
      appRoot: string;
      active: boolean;
      managed: boolean;
      classification:
        | 'clean'
        | 'patched'
        | 'managed-only'
        | 'permission-denied'
        | 'broken-backup'
        | 'checksum-mismatch';
      verificationPassed: boolean;
      canSelfHeal: boolean;
      issues: string[];
    }>
  >(['status-all', '--app-root', vscode.env.appRoot]);

  if (statuses.length === 0) {
    vscode.window.showInformationMessage(
      'Tyrian Night Doctor: No managed VS Code app roots were found.'
    );
    return;
  }

  const content = [
    '# Tyrian Night Doctor',
    '',
    ...statuses.map((status) => {
      const detailLines = [
        `- \`${status.appRoot}\`: ${formatDoctorClassification(status.classification)}`,
        `  Verification: ${status.verificationPassed ? 'passed' : 'failed'}`,
        `  Self-heal: ${status.canSelfHeal ? 'available via Restore Classic UI' : 'not needed'}`,
      ];

      for (const issue of status.issues) {
        detailLines.push(`  Issue: ${issue}`);
      }

      return detailLines.join('\n');
    }),
  ].join('\n');

  const document = await vscode.workspace.openTextDocument({
    content,
    language: 'markdown',
  });

  await vscode.window.showTextDocument(document, {
    preview: false,
  });

  const healableStatuses = statuses.filter((status) => status.canSelfHeal);

  if (healableStatuses.length > 0) {
    const action = await vscode.window.showWarningMessage(
      `Tyrian Night Doctor found self-healable Island UI issues in ${healableStatuses.length} VS Code installation${healableStatuses.length === 1 ? '' : 's'}.`,
      'Run Restore Classic UI',
      'Later'
    );

    if (action === 'Run Restore Classic UI') {
      await restoreClassicUi();
    }
  }
}

async function restoreIslandUi(options: {
  notifyWhenUnchanged: boolean;
  reloadMessage: string;
}): Promise<void> {
  const result = (await runIslandCli(['restore-all', '--app-root', vscode.env.appRoot])) as {
    changed: boolean;
    restoredAppRoots: string[];
    failedAppRoots: Array<{ appRoot: string; reason: string }>;
  };

  if (result.failedAppRoots.length > 0) {
    throw new Error(
      `Tyrian Night cleanup failed for ${result.failedAppRoots
        .map(({ appRoot, reason }) => `${appRoot} (${reason})`)
        .join(', ')}`
    );
  }

  if (!result.changed) {
    if (options.notifyWhenUnchanged) {
      vscode.window.showInformationMessage('Tyrian Night: Classic UI is already active.');
    }
    return;
  }

  await promptForReload(options.reloadMessage);
}

function runIslandCli<T>(argumentsList: string[]): Promise<T> {
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
        resolve(JSON.parse(stdout) as T);
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

function formatDoctorClassification(
  classification:
    | 'clean'
    | 'patched'
    | 'managed-only'
    | 'permission-denied'
    | 'broken-backup'
    | 'checksum-mismatch'
): string {
  switch (classification) {
    case 'clean':
      return 'Clean';
    case 'patched':
      return 'Patched';
    case 'managed-only':
      return 'Managed-only';
    case 'permission-denied':
      return 'Permission denied';
    case 'broken-backup':
      return 'Broken backup';
    case 'checksum-mismatch':
      return 'Checksum mismatch';
  }
}

async function promptForReload(message: string): Promise<void> {
  const action = await vscode.window.showInformationMessage(message, 'Reload Window', 'Later');

  if (action === 'Reload Window') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

async function ensureUninstallWarningAcknowledged(options: {
  interactive: boolean;
}): Promise<boolean> {
  if (extContext.globalState.get<boolean>(UNINSTALL_WARNING_ACKNOWLEDGED_KEY, false)) {
    return true;
  }

  if (!options.interactive) {
    return false;
  }

  const action = await vscode.window.showWarningMessage(
    UNINSTALL_WARNING_MESSAGE,
    { modal: true },
    'I Understand',
    'Cancel'
  );

  if (action !== 'I Understand') {
    vscode.window.showInformationMessage(
      'Tyrian Night: Island UI was not enabled. Run "Restore Classic UI" before uninstalling whenever Island UI is active.'
    );
    return false;
  }

  await extContext.globalState.update(UNINSTALL_WARNING_ACKNOWLEDGED_KEY, true);
  return true;
}

export function deactivate(): void {
  // No-op.
}
