import { spawn } from 'node:child_process';
import path from 'node:path';

import * as vscode from 'vscode';

import {
  readIslandBrokerStatus,
  runIslandBrokerApply,
  runIslandBrokerRestore,
} from './islandBrokerClient.js';
import {
  readIslandWriteAccessStatus,
  runIslandPackageAccessRestore,
  runIslandWriteAccessUnlock,
} from './islandWriteAccessClient.js';
import {
  DEFAULT_TYRIAN_THEME_LABEL,
  getIslandCssFileForTheme,
  isTyrianThemeLabel,
} from './generated/themeCatalog.js';
import type { IslandShellStatus } from './islandShell.js';
import type {
  IslandUiApplySupervisionResult as IslandApplyResult,
  IslandUiRestoreSupervisionResult as IslandRestoreResult,
  IslandUiSupervisorStatus as IslandSupervisorStatus,
} from './islandSupervisor.js';

const OPEN_DOCTOR_ACTION = 'Open Doctor';
const RESET_FILE_ACCESS_ACTION = 'Reset File Access';
const TRUST_DOCS_ACTION = 'Why This Is Needed';
const LATER_ACTION = 'Later';
const ISLAND_UI_TRUST_DOCS_URL = 'https://github.com/renbkna/tyrian-night#island-ui';
const ISLAND_UI_ENABLED_KEY = 'tyrianNight.islandUiEnabled';
const ISLAND_UI_UNLOCKED_APP_ROOTS_KEY = 'tyrianNight.unlockedAppRoots';
const THEME_PROMPT_KEY = 'tyrianNight.themePrompted';
const UNINSTALL_WARNING_ACKNOWLEDGED_KEY = 'tyrianNight.uninstallWarningAcknowledged';
const UNINSTALL_WARNING_MESSAGE =
  'Tyrian Night: Island UI patches VS Code workbench files. Before uninstalling this extension, you must run "Tyrian Night: Restore Classic UI". Uninstalling the extension alone will not remove the custom UI.';

let extContext: vscode.ExtensionContext;
let syncQueue = Promise.resolve();

function isTyrianTheme(theme: string | undefined): theme is string {
  return isTyrianThemeLabel(theme);
}

function getCssFileForTheme(theme: string): string {
  return getIslandCssFileForTheme(theme) ?? getIslandCssFileForTheme(DEFAULT_TYRIAN_THEME_LABEL)!;
}

function buildWriteAccessActions(primaryAction: string | undefined): string[] {
  return primaryAction
    ? [primaryAction, TRUST_DOCS_ACTION, OPEN_DOCTOR_ACTION, LATER_ACTION]
    : [TRUST_DOCS_ACTION, OPEN_DOCTOR_ACTION, LATER_ACTION];
}

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
    vscode.commands.registerCommand('tyrianNight.applyIslandUi', () =>
      enqueueSync(applyIslandUiCommand)
    ),
    vscode.commands.registerCommand('tyrianNight.repairIslandUi', () =>
      enqueueSync(repairIslandUi)
    ),
    vscode.commands.registerCommand('tyrianNight.restoreClassicUi', () =>
      enqueueSync(restoreClassicUi)
    ),
    vscode.commands.registerCommand('tyrianNight.doctorIslandUi', () => enqueueSync(doctorIslandUi))
  );
}

function enqueueSync(task: () => Promise<void>): Promise<void> {
  syncQueue = syncQueue.then(task, task);
  return syncQueue;
}

async function syncIslandUi(options: { allowThemePrompt: boolean }): Promise<void> {
  const islandUiEnabled = extContext.globalState.get<boolean>(ISLAND_UI_ENABLED_KEY, true);
  const activeTheme = getActiveTheme();

  if (!isTyrianTheme(activeTheme)) {
    if (options.allowThemePrompt) {
      const switchedTheme = await maybePromptToSwitchTheme(activeTheme);

      if (switchedTheme) {
        return;
      }
    }

    await restoreIslandUi({
      interactive: false,
      notifyWhenUnchanged: false,
      reloadMessage: 'Tyrian Night: Island UI was removed because another color theme is active.',
    });
    return;
  }

  if (!islandUiEnabled) {
    await restoreIslandUi({
      interactive: false,
      notifyWhenUnchanged: false,
      reloadMessage: 'Tyrian Night: Classic UI restored. Reload VS Code to finish reverting.',
    });
    return;
  }

  if (!(await ensureUninstallWarningAcknowledged({ interactive: options.allowThemePrompt }))) {
    await extContext.globalState.update(ISLAND_UI_ENABLED_KEY, false);
    await restoreIslandUi({
      interactive: false,
      notifyWhenUnchanged: false,
      reloadMessage:
        'Tyrian Night: Island UI was removed because the uninstall warning was not acknowledged.',
    });
    return;
  }

  await applyIslandUi({
    interactive: false,
    notifyWhenUnchanged: false,
    reloadMessage: 'Tyrian Night: Island UI was updated. Reload VS Code to apply it.',
  });
}

async function maybePromptToSwitchTheme(activeTheme: string | undefined): Promise<boolean> {
  const promptShown = extContext.globalState.get<boolean>(THEME_PROMPT_KEY, false);

  if (promptShown || isTyrianTheme(activeTheme)) {
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
    .update('colorTheme', DEFAULT_TYRIAN_THEME_LABEL, vscode.ConfigurationTarget.Global);

  return true;
}

async function applyIslandUiCommand(): Promise<void> {
  if (!isTyrianTheme(getActiveTheme())) {
    const action = await vscode.window.showInformationMessage(
      'Tyrian Night: Apply Island UI with a Tyrian theme?',
      'Switch Theme',
      'Cancel'
    );

    if (action !== 'Switch Theme') {
      return;
    }

    await vscode.workspace
      .getConfiguration('workbench')
      .update('colorTheme', DEFAULT_TYRIAN_THEME_LABEL, vscode.ConfigurationTarget.Global);
  }

  if (!(await enableIslandUiAfterWarning())) {
    return;
  }

  await applyIslandUi({
    interactive: true,
    notifyWhenUnchanged: true,
    reloadMessage: 'Tyrian Night: Island UI applied. Reload VS Code to apply it.',
  });
}

async function repairIslandUi(): Promise<void> {
  if (!isTyrianTheme(getActiveTheme())) {
    vscode.window.showInformationMessage(
      'Tyrian Night: Switch to a Tyrian theme before repairing Island UI.'
    );
    return;
  }

  if (!(await enableIslandUiAfterWarning())) {
    return;
  }

  await applyIslandUi({
    interactive: true,
    notifyWhenUnchanged: true,
    reloadMessage: 'Tyrian Night: Island UI repaired. Reload VS Code to apply it.',
  });
}

async function applyIslandUi(options: {
  interactive: boolean;
  notifyWhenUnchanged: boolean;
  reloadMessage: string;
}): Promise<IslandApplyResult['kind']> {
  const activeTheme = getActiveTheme() ?? DEFAULT_TYRIAN_THEME_LABEL;
  const cssFile = getCssFileForTheme(activeTheme);
  const result = await runIslandCli<IslandApplyResult>([
    'apply-supervised',
    '--app-root',
    vscode.env.appRoot,
    '--css-source',
    path.join(extContext.extensionPath, 'apps', 'vscode', 'island', cssFile),
    '--theme-version',
    String(extContext.extension.packageJSON.version ?? 'unknown'),
  ]);

  switch (result.kind) {
    case 'applied':
      await promptForReload(options.reloadMessage);
      return result.kind;
    case 'already-current':
      if (options.notifyWhenUnchanged) {
        vscode.window.showInformationMessage('Tyrian Night: Island UI is already up to date.');
      }
      return result.kind;
    case 'permission-required':
      if (options.interactive) {
        await showIslandPermissionRequired(result, {
          reloadMessage: options.reloadMessage,
          theme: activeTheme,
        });
      }
      return result.kind;
    case 'unsupported':
      if (options.interactive) {
        await vscode.window
          .showWarningMessage(
            `Tyrian Night: This VS Code workbench layout is not supported for Island UI yet. ${result.reason}`,
            OPEN_DOCTOR_ACTION,
            LATER_ACTION
          )
          .then(async (action) => {
            if (action === OPEN_DOCTOR_ACTION) {
              await doctorIslandUi();
            }
          });
      }
      return result.kind;
    case 'blocked':
      if (options.interactive) {
        await vscode.window.showErrorMessage(
          `Tyrian Night: Island UI repair is blocked. ${result.reason}`
        );
      }
      return result.kind;
  }
}

async function showIslandPermissionRequired(
  result: Extract<IslandApplyResult, { kind: 'permission-required' }>,
  options: {
    reloadMessage: string;
    theme: string;
  }
): Promise<void> {
  const writeAccess = await readIslandWriteAccessStatus();
  const blockedPaths = result.writeAccess.blockedPaths
    .map(({ path: blockedPath }) => blockedPath)
    .join(', ');
  const detail = blockedPaths
    ? ` Blocked path${result.writeAccess.blockedPaths.length === 1 ? '' : 's'}: ${blockedPaths}`
    : '';
  const shouldProbeBroker =
    !writeAccess.available &&
    result.status.workbenchChecksum !== undefined &&
    result.status.productWorkbenchChecksum !== undefined;
  const broker = shouldProbeBroker ? await readIslandBrokerStatus() : undefined;
  const brokerCanRepair =
    broker?.available === true &&
    result.status.workbenchChecksum !== undefined &&
    result.status.productWorkbenchChecksum !== undefined;
  const unlockCanRepair =
    writeAccess.available &&
    result.status.workbenchChecksum !== undefined &&
    result.status.productWorkbenchChecksum !== undefined;
  const actions = buildWriteAccessActions(
    unlockCanRepair
      ? 'Unlock Write Access'
      : brokerCanRepair
        ? 'Repair with Write Access'
        : undefined
  );
  const brokerDetail = broker?.available
    ? ' Tyrian could not prove the current workbench hashes for elevated repair.'
    : ` ${writeAccess.available ? 'Tyrian could not prove the current workbench hashes for write access.' : writeAccess.reason}`;
  const action = await vscode.window.showWarningMessage(
    `Tyrian Night: VS Code app files are not writable, usually after a package install or update. Island UI is still desired. Tyrian can ask for system permission once to unlock write access for the current VS Code app files, then repair normally.${detail}`,
    ...actions
  );

  if (action === 'Unlock Write Access' && unlockCanRepair && writeAccess.available) {
    try {
      await unlockIslandWriteAccess(result.status);
      await continueApplyAfterWriteAccessUnlock({
        interactive: true,
        notifyWhenUnchanged: true,
        reloadMessage: options.reloadMessage,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Tyrian Night: write access unlock failed. ${message}`);
    }
    return;
  }

  if (action === 'Repair with Write Access' && brokerCanRepair && broker?.available) {
    try {
      const expectedProductWorkbenchChecksum = result.status.productWorkbenchChecksum;
      const expectedWorkbenchChecksum = result.status.workbenchChecksum;

      if (
        expectedProductWorkbenchChecksum === undefined ||
        expectedWorkbenchChecksum === undefined
      ) {
        throw new Error('Tyrian could not prove the current workbench hashes for elevated repair.');
      }

      const brokerResult = await runIslandBrokerApply({
        appRoot: vscode.env.appRoot,
        broker,
        expectedProductWorkbenchChecksum,
        expectedWorkbenchChecksum,
        theme: options.theme,
        themeVersion: String(extContext.extension.packageJSON.version ?? 'unknown'),
      });

      if (brokerResult.changed) {
        await promptForReload(options.reloadMessage);
      } else {
        vscode.window.showInformationMessage('Tyrian Night: Island UI is already up to date.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(
        `Tyrian Night: privileged Island UI repair failed. ${message}`
      );
    }
    return;
  }

  if (action === TRUST_DOCS_ACTION) {
    await openIslandUiTrustDocs();
    return;
  }

  if (action === OPEN_DOCTOR_ACTION) {
    if (!writeAccess.available && brokerDetail) {
      await vscode.window.showInformationMessage(`Tyrian Night: ${brokerDetail.trim()}`);
    }
    await doctorIslandUi();
  }
}

async function restoreClassicUi(): Promise<void> {
  await extContext.globalState.update(ISLAND_UI_ENABLED_KEY, false);
  await restoreIslandUi({
    interactive: true,
    notifyWhenUnchanged: true,
    reloadMessage: 'Tyrian Night: Classic UI restored. Reload VS Code to finish reverting.',
  });
}

async function doctorIslandUi(): Promise<void> {
  const statuses = await runIslandCli<IslandSupervisorStatus[]>([
    'status-all-supervised',
    '--app-root',
    vscode.env.appRoot,
  ]);
  const writeAccess = await readIslandWriteAccessStatus();
  const desiredState = extContext.globalState.get<boolean>(ISLAND_UI_ENABLED_KEY, false)
    ? 'enabled'
    : 'disabled';

  if (statuses.length === 0) {
    vscode.window.showInformationMessage(
      'Tyrian Night Doctor: No managed VS Code app roots were found.'
    );
    return;
  }

  const content = [
    '# Tyrian Night Doctor',
    '',
    `VS Code: ${vscode.version}`,
    `Desired Island UI state: ${desiredState}`,
    `System write-access prompt: ${
      writeAccess.available ? 'available' : `unavailable (${writeAccess.reason})`
    }`,
    '',
    ...statuses.map((status) => {
      const detailLines = [
        `- \`${status.appRoot}\`: ${formatDoctorClassification(status.classification)}`,
        `  Verification: ${status.verificationPassed ? 'passed' : 'failed'}`,
        `  Self-heal: ${status.canSelfHeal ? 'available via Restore Classic UI' : 'not needed'}`,
        `  Recommended action: ${formatRecommendedAction(status.recommendedAction)}`,
        `  Elevation needed: ${status.recommendedAction === 'elevated-repair' ? 'yes' : 'no'}`,
        `  Restore proof: ${formatRestoreProof(status.restoreProof)}`,
      ];

      if (status.workbenchChecksum) {
        detailLines.push(`  Workbench hash: ${status.workbenchChecksum}`);
      }

      if (status.productWorkbenchChecksum) {
        detailLines.push(`  Product workbench hash: ${status.productWorkbenchChecksum}`);
      }

      if (status.receipt) {
        detailLines.push(
          `  Last receipt: ${status.receipt.patchStrategy} ${status.receipt.themeVersion} at ${status.receipt.installedAt}`
        );
        detailLines.push(`  Receipt CSS hash: ${status.receipt.cssChecksum}`);
      }

      if (status.writeAccess) {
        detailLines.push(`  Writable: ${status.writeAccess.writable ? 'yes' : 'no'}`);

        for (const blockedPath of status.writeAccess.blockedPaths) {
          detailLines.push(`  Blocked path: ${blockedPath.path}`);
        }
      }

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
      LATER_ACTION
    );

    if (action === 'Run Restore Classic UI') {
      await restoreClassicUi();
    }
  }
}

async function restoreIslandUi(options: {
  interactive: boolean;
  notifyWhenUnchanged: boolean;
  reloadMessage: string;
}): Promise<IslandRestoreResult['kind']> {
  const result = await runIslandCli<IslandRestoreResult>([
    'restore-supervised',
    '--app-root',
    vscode.env.appRoot,
  ]);

  if (result.kind === 'permission-required') {
    if (options.interactive) {
      await showIslandRestorePermissionRequired(result, {
        reloadMessage: options.reloadMessage,
      });
    }
    return result.kind;
  }

  if (result.kind === 'blocked') {
    throw new Error(
      `Tyrian Night cleanup failed for ${result.failedAppRoots
        .map(({ appRoot, reason }) => `${appRoot} (${reason})`)
        .join(', ')}`
    );
  }

  if (!result.changed) {
    if (options.interactive) {
      await maybePromptToRestoreIslandPackageAccess();
    }

    if (options.notifyWhenUnchanged) {
      vscode.window.showInformationMessage('Tyrian Night: Classic UI is already active.');
    }
    return result.kind;
  }

  if (options.interactive) {
    await maybePromptToRestoreIslandPackageAccess();
  }

  await promptForReload(options.reloadMessage);
  return result.kind;
}

async function showIslandRestorePermissionRequired(
  result: Extract<IslandRestoreResult, { kind: 'permission-required' }>,
  options: {
    reloadMessage: string;
  }
): Promise<void> {
  const writeAccess = await readIslandWriteAccessStatus();
  const currentStatus = await readCurrentIslandSupervisorStatus();
  const unlockCanRestore =
    writeAccess.available &&
    currentStatus?.workbenchChecksum !== undefined &&
    currentStatus.productWorkbenchChecksum !== undefined;
  const broker = unlockCanRestore ? undefined : await readIslandBrokerStatus();
  const failedRoots = result.failedAppRoots.map(({ appRoot }) => appRoot).join(', ');
  const detail = failedRoots
    ? ` Affected root${result.failedAppRoots.length === 1 ? '' : 's'}: ${failedRoots}`
    : '';
  const actions = buildWriteAccessActions(
    unlockCanRestore
      ? 'Unlock Write Access'
      : broker?.available
        ? 'Restore with Write Access'
        : undefined
  );
  const brokerDetail = broker?.available
    ? ''
    : ` ${writeAccess.available ? 'Tyrian could not prove the current workbench hashes for write access.' : writeAccess.reason}`;
  const action = await vscode.window.showWarningMessage(
    `Tyrian Night: Classic UI restore needs write access to VS Code app files. Tyrian can ask for system permission once to unlock write access for this VS Code install, then restore normally.${detail}`,
    ...actions
  );

  if (action === 'Unlock Write Access' && unlockCanRestore && currentStatus) {
    try {
      await unlockIslandWriteAccess(currentStatus);
      await continueRestoreAfterWriteAccessUnlock({
        interactive: true,
        notifyWhenUnchanged: true,
        reloadMessage: options.reloadMessage,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Tyrian Night: write access unlock failed. ${message}`);
    }
    return;
  }

  if (action === 'Restore with Write Access' && broker?.available) {
    try {
      const brokerResult = await runIslandBrokerRestore({
        appRoot: vscode.env.appRoot,
        broker,
      });

      if (brokerResult.changed) {
        await promptForReload(options.reloadMessage);
      } else {
        vscode.window.showInformationMessage('Tyrian Night: Classic UI is already active.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(
        `Tyrian Night: privileged Classic UI restore failed. ${message}`
      );
    }
    return;
  }

  if (action === TRUST_DOCS_ACTION) {
    await openIslandUiTrustDocs();
    return;
  }

  if (action === OPEN_DOCTOR_ACTION) {
    if (!writeAccess.available && brokerDetail) {
      await vscode.window.showInformationMessage(`Tyrian Night: ${brokerDetail.trim()}`);
    }
    await doctorIslandUi();
  }
}

async function continueApplyAfterWriteAccessUnlock(options: {
  interactive: boolean;
  notifyWhenUnchanged: boolean;
  reloadMessage: string;
}): Promise<void> {
  const outcome = await applyIslandUi({
    ...options,
    interactive: false,
  });

  if (outcome !== 'permission-required') {
    return;
  }

  const currentStatus = await readCurrentIslandSupervisorStatus();

  if (currentStatus?.active) {
    await promptForReload(options.reloadMessage);
    return;
  }

  vscode.window.showErrorMessage(
    'Tyrian Night: write access was unlocked, but Island UI repair still cannot write VS Code app files. Open Tyrian Night: Doctor Island UI for details.'
  );
}

async function continueRestoreAfterWriteAccessUnlock(options: {
  interactive: boolean;
  notifyWhenUnchanged: boolean;
  reloadMessage: string;
}): Promise<void> {
  const outcome = await restoreIslandUi({
    ...options,
    interactive: false,
  });

  if (outcome !== 'permission-required') {
    return;
  }

  const currentStatus = await readCurrentIslandSupervisorStatus();

  if (currentStatus && !currentStatus.active && !currentStatus.managed) {
    await promptForReload(options.reloadMessage);
    return;
  }

  vscode.window.showErrorMessage(
    'Tyrian Night: write access was unlocked, but Classic UI restore still cannot write VS Code app files. Open Tyrian Night: Doctor Island UI for details.'
  );
}

async function unlockIslandWriteAccess(status: IslandShellStatus): Promise<void> {
  const expectedProductWorkbenchChecksum = status.productWorkbenchChecksum;
  const expectedWorkbenchChecksum = status.workbenchChecksum;

  if (expectedProductWorkbenchChecksum === undefined || expectedWorkbenchChecksum === undefined) {
    throw new Error('Tyrian could not prove the current workbench hashes for write access.');
  }

  const writeAccess = await readIslandWriteAccessStatus();

  if (!writeAccess.available) {
    throw new Error(writeAccess.reason);
  }

  await runIslandWriteAccessUnlock({
    appRoot: vscode.env.appRoot,
    expectedProductWorkbenchChecksum,
    expectedWorkbenchChecksum,
    writeAccess,
  });
  await rememberUnlockedAppRoot(vscode.env.appRoot);
}

async function maybePromptToRestoreIslandPackageAccess(): Promise<void> {
  if (!isUnlockedAppRootRemembered(vscode.env.appRoot)) {
    return;
  }

  const writeAccess = await readIslandWriteAccessStatus();

  if (!writeAccess.available) {
    return;
  }

  const currentStatus = await readCurrentIslandSupervisorStatus();

  if (
    !(
      writeAccess.available &&
      currentStatus?.workbenchChecksum !== undefined &&
      currentStatus.productWorkbenchChecksum !== undefined &&
      currentStatus.writeAccess?.writable === true
    )
  ) {
    return;
  }

  const action = await vscode.window.showWarningMessage(
    'Tyrian Night: Classic UI is restored. Reset VS Code app file ownership back to package-style access?',
    RESET_FILE_ACCESS_ACTION,
    TRUST_DOCS_ACTION,
    LATER_ACTION
  );

  if (action === TRUST_DOCS_ACTION) {
    await openIslandUiTrustDocs();
    return;
  }

  if (action !== RESET_FILE_ACCESS_ACTION) {
    return;
  }

  try {
    await runIslandPackageAccessRestore({
      appRoot: vscode.env.appRoot,
      expectedProductWorkbenchChecksum: currentStatus.productWorkbenchChecksum,
      expectedWorkbenchChecksum: currentStatus.workbenchChecksum,
      writeAccess,
    });
    await forgetUnlockedAppRoot(vscode.env.appRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showWarningMessage(
      `Tyrian Night: Classic UI was restored, but VS Code file ownership could not be reset automatically. ${message}`
    );
  }
}

function readUnlockedAppRoots(): string[] {
  const appRoots = extContext.globalState.get<unknown>(ISLAND_UI_UNLOCKED_APP_ROOTS_KEY, []);

  return Array.isArray(appRoots)
    ? appRoots.filter((appRoot): appRoot is string => typeof appRoot === 'string')
    : [];
}

function isUnlockedAppRootRemembered(appRoot: string): boolean {
  return readUnlockedAppRoots().includes(appRoot);
}

async function rememberUnlockedAppRoot(appRoot: string): Promise<void> {
  const appRoots = new Set(readUnlockedAppRoots());
  appRoots.add(appRoot);
  await extContext.globalState.update(ISLAND_UI_UNLOCKED_APP_ROOTS_KEY, [...appRoots]);
}

async function forgetUnlockedAppRoot(appRoot: string): Promise<void> {
  await extContext.globalState.update(
    ISLAND_UI_UNLOCKED_APP_ROOTS_KEY,
    readUnlockedAppRoots().filter((storedAppRoot) => storedAppRoot !== appRoot)
  );
}

async function openIslandUiTrustDocs(): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(ISLAND_UI_TRUST_DOCS_URL));
}

async function readCurrentIslandSupervisorStatus(): Promise<IslandSupervisorStatus | undefined> {
  const statuses = await runIslandCli<IslandSupervisorStatus[]>([
    'status-all-supervised',
    '--app-root',
    vscode.env.appRoot,
  ]);

  return statuses.find((status) => status.appRoot === vscode.env.appRoot);
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
    | 'missing'
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
    case 'missing':
      return 'Missing';
    case 'permission-denied':
      return 'Permission denied';
    case 'broken-backup':
      return 'Broken backup';
    case 'checksum-mismatch':
      return 'Checksum mismatch';
  }
}

function formatRecommendedAction(action: IslandSupervisorStatus['recommendedAction']): string {
  switch (action) {
    case 'none':
      return 'None';
    case 'apply':
      return 'Apply Island UI';
    case 'restore':
      return 'Restore Classic UI';
    case 'elevated-repair':
      return 'Repair with write access';
    case 'inspect':
      return 'Inspect manually';
  }
}

function formatRestoreProof(proof: IslandShellStatus['restoreProof']): string {
  switch (proof) {
    case 'none':
      return 'None';
    case 'manifest-v2-backup-pair':
      return 'Manifest v2 backup pair';
    case 'strip-tyrian-block':
      return 'Strip Tyrian block only';
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

async function enableIslandUiAfterWarning(): Promise<boolean> {
  if (!(await ensureUninstallWarningAcknowledged({ interactive: true }))) {
    return false;
  }

  await extContext.globalState.update(ISLAND_UI_ENABLED_KEY, true);
  return true;
}

export function deactivate(): void {
  // No-op.
}
