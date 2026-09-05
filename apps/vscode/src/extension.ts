import path from 'node:path';

import * as vscode from 'vscode';

import {
  DEFAULT_TYRIAN_THEME_LABEL,
  TYRIAN_THEME_CATALOG,
  getIslandCssFileForTheme,
  isTyrianThemeLabel,
} from './generated/themeCatalog.js';
import { readIslandApplyPlatformSupport } from './islandPlatform.js';
import { IslandProcessFailure, runIslandJsonProcess } from './islandProcess.js';
import {
  decodeIslandReconciliationStatus,
  decodeIslandApplyResult,
  decodeIslandDirectRestoreResult,
  decodeIslandRestoreResult,
  decodeIslandSupervisorInventory,
  type IslandApplyResult,
  type IslandDoctorStatus,
  type IslandReconciliationStatus,
  type IslandRestoreResult,
  type IslandUiRecommendedAction,
} from './islandWire.js';

const OPEN_DOCTOR_ACTION = 'Open Doctor';
const TRUST_DOCS_ACTION = 'Why This Is Needed';
const LATER_ACTION = 'Later';
const PERMISSION_ACTIONS = [TRUST_DOCS_ACTION, OPEN_DOCTOR_ACTION, LATER_ACTION] as const;
const ISLAND_UI_TRUST_DOCS_URL =
  'https://github.com/renbkna/tyrian-night/blob/main/apps/vscode/README.md#island-ui';
const THEME_PROMPT_KEY = 'tyrianNight.themePrompted';
const UNINSTALL_WARNING_ACKNOWLEDGED_KEY = 'tyrianNight.uninstallWarningAcknowledged';
const UNINSTALL_WARNING_MESSAGE =
  'Tyrian Night: Island UI patches VS Code workbench files. Before uninstalling this extension, you must run "Tyrian Night: Restore Classic UI". Uninstalling the extension alone will not remove the custom UI.';

let extContext: vscode.ExtensionContext;
let syncQueue = Promise.resolve();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extContext = context;

  try {
    registerCommands();
    await enqueueSync(reconcileIslandUi);
    await maybePromptToSwitchTheme(getActiveTheme());
  } catch (error) {
    if (error instanceof IslandProcessFailure) {
      await showIslandProcessFailure(error, 'startup reconciliation');
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Tyrian Night: ${message}`);
  }
}

function registerCommands(): void {
  extContext.subscriptions.push(
    vscode.commands.registerCommand('tyrianNight.applyIslandUi', () =>
      enqueueSync(() => runIslandCommand(applyIslandUiCommand, 'Island UI apply'))
    ),
    vscode.commands.registerCommand('tyrianNight.repairIslandUi', () =>
      enqueueSync(() => runIslandCommand(repairIslandUi, 'Island UI repair'))
    ),
    vscode.commands.registerCommand('tyrianNight.restoreClassicUi', () =>
      enqueueSync(restoreClassicUi)
    ),
    vscode.commands.registerCommand('tyrianNight.doctorIslandUi', () => enqueueSync(doctorIslandUi))
  );
}

async function runIslandCommand(task: () => Promise<void>, operation: string): Promise<void> {
  try {
    await task();
  } catch (error) {
    if (!(error instanceof IslandProcessFailure)) throw error;
    await showIslandProcessFailure(error, operation);
  }
}

function enqueueSync(task: () => Promise<void>): Promise<void> {
  syncQueue = syncQueue.then(task, task);
  return syncQueue;
}

async function reconcileIslandUi(): Promise<void> {
  if (!readIslandApplyPlatformSupport().supported) {
    const status = await readCurrentIslandStatus();

    if (status.registration.kind === 'unsupported') {
      throw new Error(
        'Island UI desired-state record uses an unsupported format. Run Doctor before changing app files.'
      );
    }

    if (status.registration.kind !== 'absent' || status.managed || status.active) {
      await restoreCurrentIslandUi();
    }

    return;
  }

  const status = await readCurrentIslandStatus();

  if (status.registration.kind === 'unsupported') {
    throw new Error(
      'Island UI desired-state record uses an unsupported format. Run Doctor before changing app files.'
    );
  }

  if (status.registration.kind === 'corrupt') {
    throw new Error(
      'Island UI desired-state record is corrupt. Run Doctor before changing app files.'
    );
  }

  if (status.registration.kind === 'absent') {
    if (status.managed || status.active) {
      await restoreCurrentIslandUi();
    }
    return;
  }

  const desiredThemeId = status.registration.desiredThemeId;
  if (desiredThemeId === null) {
    if (status.managed || status.active) {
      await restoreCurrentIslandUi();
    }
    return;
  }

  const desiredCssFile = resolveDesiredCssFile(desiredThemeId);

  if (desiredCssFile !== undefined) {
    const result = await applyIslandCssFile(desiredCssFile, {
      interactive: false,
      notifyWhenUnchanged: false,
      reloadMessage: 'Tyrian Night: Island UI was updated. Reload VS Code to apply it.',
    });
    switch (result.kind) {
      case 'applied':
      case 'already-current':
        return;
      default:
        throw new Error(`Island UI startup reconciliation is ${result.kind}. ${result.reason}`);
    }
  }

  throw new Error(
    `Island UI desires unavailable style '${desiredThemeId}'. Install a matching Tyrian Night version or restore Classic UI.`
  );
}

async function maybePromptToSwitchTheme(activeTheme: string | undefined): Promise<void> {
  const promptShown = extContext.globalState.get<boolean>(THEME_PROMPT_KEY, false);

  if (promptShown || isTyrianThemeLabel(activeTheme)) {
    return;
  }

  await extContext.globalState.update(THEME_PROMPT_KEY, true);

  const action = await vscode.window.showInformationMessage(
    'Tyrian Night is installed. Switch to the Tyrian Night color theme now? You can enable Island UI after acknowledging the restore-before-uninstall warning.',
    'Switch Theme',
    'Later'
  );

  if (action !== 'Switch Theme') {
    return;
  }

  await vscode.workspace
    .getConfiguration('workbench')
    .update('colorTheme', DEFAULT_TYRIAN_THEME_LABEL, vscode.ConfigurationTarget.Global);
}

async function applyIslandUiCommand(): Promise<void> {
  if (!(await admitIslandApplyCommand())) return;

  if (!isTyrianThemeLabel(getActiveTheme())) {
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

  const theme = getActiveTheme();

  if (!isTyrianThemeLabel(theme) || !(await ensureUninstallWarningAcknowledged())) {
    return;
  }

  await applyIslandUi(
    {
      interactive: true,
      notifyWhenUnchanged: true,
      reloadMessage: 'Tyrian Night: Island UI applied. Reload VS Code to apply it.',
    },
    theme
  );
}

async function repairIslandUi(): Promise<void> {
  if (!(await admitIslandApplyCommand())) return;

  const status = await readCurrentIslandStatus();
  if (status.registration.kind === 'unsupported') {
    vscode.window.showErrorMessage(
      'Tyrian Night: Island UI desired-state record uses an unsupported format. Run Doctor before changing app files.'
    );
    return;
  }
  const desiredThemeId =
    status.registration.kind === 'valid' ? status.registration.desiredThemeId : undefined;
  const configuredCssFile = resolveDesiredCssFile(desiredThemeId);
  const activeTheme = getActiveTheme();
  const theme = isTyrianThemeLabel(activeTheme) ? activeTheme : undefined;

  if (typeof desiredThemeId === 'string' && configuredCssFile === undefined) {
    vscode.window.showErrorMessage(
      `Tyrian Night: Island UI desires unavailable style '${desiredThemeId}'. Install a matching Tyrian Night version or restore Classic UI; repair left the shared desired style unchanged.`
    );
    return;
  }

  if (configuredCssFile === undefined && !theme) {
    vscode.window.showInformationMessage('Tyrian Night: Apply Island UI once before repairing it.');
    return;
  }

  if (!(await ensureUninstallWarningAcknowledged())) {
    return;
  }

  const options = {
    interactive: true,
    notifyWhenUnchanged: true,
    reloadMessage: 'Tyrian Night: Island UI repaired. Reload VS Code to apply it.',
  };

  if (configuredCssFile !== undefined) {
    await applyIslandCssFile(configuredCssFile, options);
  } else {
    await applyIslandUi(options, theme!);
  }
}

async function admitIslandApplyCommand(): Promise<boolean> {
  const support = readIslandApplyPlatformSupport();
  if (support.supported) return true;
  await vscode.window.showWarningMessage(`Tyrian Night: ${support.reason}`);
  return false;
}

async function applyIslandUi(
  options: {
    interactive: boolean;
    notifyWhenUnchanged: boolean;
    reloadMessage: string;
  },
  theme: string
): Promise<IslandApplyResult> {
  const cssFile = getIslandCssFileForTheme(theme)!;
  return applyIslandCssFile(cssFile, options);
}

async function applyIslandCssFile(
  cssFile: string,
  options: {
    interactive: boolean;
    notifyWhenUnchanged: boolean;
    reloadMessage: string;
  }
): Promise<IslandApplyResult> {
  const result = await runIslandCli(
    [
      'apply-supervised',
      '--app-root',
      vscode.env.appRoot,
      '--css-source',
      path.join(extContext.extensionPath, 'island', cssFile),
      '--theme-version',
      String(extContext.extension.packageJSON.version ?? 'unknown'),
    ],
    decodeIslandApplyResult
  );

  switch (result.kind) {
    case 'applied':
      if (result.physicalChanged) {
        await promptForReload(options.reloadMessage);
      } else if (options.notifyWhenUnchanged) {
        vscode.window.showInformationMessage(
          'Tyrian Night: Island UI desired state was updated; app files are already current.'
        );
      }
      return result;
    case 'already-current':
      if (options.notifyWhenUnchanged) {
        vscode.window.showInformationMessage('Tyrian Night: Island UI is already up to date.');
      }
      return result;
    case 'permission-required':
      if (options.interactive) {
        await showIslandPermissionRequired(result);
        if (result.physicalChanged) {
          await promptForReload(
            'Tyrian Night: Island UI changed app files but remains incomplete. Reload after resolving the reported failure.'
          );
        }
      }
      return result;
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
      return result;
    case 'blocked':
      if (options.interactive) {
        await vscode.window.showErrorMessage(
          `Tyrian Night: Island UI repair is blocked. ${result.reason}`
        );
        if (result.physicalChanged) {
          await promptForReload(
            'Tyrian Night: Island UI changed app files but remains incomplete. Reload after resolving the reported failure.'
          );
        }
      }
      return result;
  }
}

async function showIslandPermissionRequired(
  result: Extract<IslandApplyResult, { kind: 'permission-required' }>
): Promise<void> {
  const blockedPaths = result.writeAccess.blockedPaths
    .map(({ path: blockedPath }) => blockedPath)
    .join(', ');
  const detail = blockedPaths
    ? ` Blocked path${result.writeAccess.blockedPaths.length === 1 ? '' : 's'}: ${blockedPaths}`
    : '';
  const action = await vscode.window.showWarningMessage(
    `Tyrian Night: VS Code app files are not writable, usually after a package install or update. Fix their permissions outside Tyrian, then retry Island UI repair.${detail}`,
    ...PERMISSION_ACTIONS
  );

  if (action === TRUST_DOCS_ACTION) {
    await openIslandUiTrustDocs();
    return;
  }

  if (action === OPEN_DOCTOR_ACTION) {
    await doctorIslandUi();
  }
}

async function restoreClassicUi(): Promise<void> {
  await runIslandCommand(restoreIslandUi, 'Classic UI restore');
}

async function doctorIslandUi(): Promise<void> {
  const inventory = await runIslandCli(
    ['status-all-supervised', '--app-root', vscode.env.appRoot],
    decodeIslandSupervisorInventory
  );
  const { statuses, registryDiagnostics } = inventory;
  const currentStatus = statuses[0];
  const desiredState = typeof currentStatus?.desiredThemeId === 'string' ? 'enabled' : 'disabled';

  if (statuses.length === 0 && registryDiagnostics.length === 0) {
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
    '',
    ...registryDiagnostics.flatMap((diagnostic) => [
      `Registry diagnostic: ${diagnostic.reason}`,
      `Recommended action: ${formatRecommendedAction(diagnostic.recommendedAction)}`,
      '',
    ]),
    ...statuses.map((status) => {
      const recommendedAction = status.recommendedAction;
      const detailLines = [
        `- \`${status.appRoot}\`: ${formatDoctorClassification(status.classification)}`,
        `  Desired: ${status.desiredThemeId ? `enabled (${status.desiredThemeId})` : 'disabled'}`,
        `  Verification: ${status.verificationPassed ? 'passed' : 'failed'}`,
        `  Self-heal: ${recommendedAction === 'restore' || recommendedAction === 'prune-missing' ? 'available via Restore Classic UI' : 'not available'}`,
        `  Recommended action: ${formatRecommendedAction(recommendedAction)}`,
        `  Restore proof: ${formatRestoreProof(status.restoreProof)}`,
        `  Transaction: ${status.transaction.kind} (${status.transaction.recoverability})`,
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
        detailLines.push(`  Receipt style: ${status.receipt.desiredThemeId}`);
        detailLines.push(`  Receipt CSS hash: ${status.receipt.cssChecksum}`);
      }

      if (status.accessInspection.kind === 'available') {
        detailLines.push(`  Writable: ${status.accessInspection.writable ? 'yes' : 'no'}`);

        for (const blockedPath of status.accessInspection.blockedPaths) {
          detailLines.push(`  Blocked path: ${blockedPath.path}`);
        }
      } else {
        detailLines.push(`  Write-access inspection failed: ${status.accessInspection.reason}`);
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

  const healableStatuses = statuses.filter(
    (status) =>
      status.recommendedAction === 'restore' || status.recommendedAction === 'prune-missing'
  );
  const healableCount = healableStatuses.length;

  if (healableCount > 0) {
    const action = await vscode.window.showWarningMessage(
      `Tyrian Night Doctor found self-healable Island UI issues in ${healableCount} VS Code installation${healableCount === 1 ? '' : 's'}.`,
      'Run Restore Classic UI',
      LATER_ACTION
    );

    if (action === 'Run Restore Classic UI') {
      await restoreClassicUi();
    }
  }
}

async function restoreIslandUi(): Promise<void> {
  const result = await runIslandCli(
    ['restore-supervised', '--app-root', vscode.env.appRoot],
    decodeIslandRestoreResult
  );

  if (result.kind === 'permission-required') {
    await showIslandRestorePermissionRequired(result);

    if (result.physicalChanged) {
      await promptForReload(
        'Tyrian Night: Island UI cleanup changed some installations but remains incomplete. Reload VS Code after resolving the reported failures.'
      );
    }

    return;
  }

  if (result.kind === 'blocked') {
    await vscode.window.showErrorMessage(
      `Tyrian Night: Classic UI restore is blocked. ${result.reason}`
    );
    if (result.physicalChanged) {
      await promptForReload(
        'Tyrian Night: Island UI cleanup changed some installations but remains incomplete. Reload VS Code after resolving the reported failures.'
      );
    }

    return;
  }

  if (!result.physicalChanged) {
    vscode.window.showInformationMessage('Tyrian Night: Classic UI is already active.');
    return;
  }

  await promptForReload('Tyrian Night: Classic UI restored. Reload VS Code to finish reverting.');
}

async function showIslandRestorePermissionRequired(
  result: Extract<IslandRestoreResult, { kind: 'permission-required' }>
): Promise<void> {
  const failedRoots = result.failedAppRoots.map(({ appRoot }) => appRoot).join(', ');
  const detail = failedRoots
    ? ` Affected root${result.failedAppRoots.length === 1 ? '' : 's'}: ${failedRoots}`
    : '';
  const action = await vscode.window.showWarningMessage(
    `Tyrian Night: Classic UI restore needs write access to VS Code app files. Fix their permissions outside Tyrian, then retry cleanup.${detail}`,
    ...PERMISSION_ACTIONS
  );

  if (action === TRUST_DOCS_ACTION) {
    await openIslandUiTrustDocs();
    return;
  }

  if (action === OPEN_DOCTOR_ACTION) {
    await doctorIslandUi();
  }
}

async function openIslandUiTrustDocs(): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(ISLAND_UI_TRUST_DOCS_URL));
}

function runIslandCli<T>(argumentsList: string[], validate: (value: unknown) => T): Promise<T> {
  const cliPath = path.join(extContext.extensionPath, 'out', 'islandCli.js');

  return runIslandJsonProcess<T>([process.execPath, cliPath, ...argumentsList], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
    fallbackMessage: 'Island UI CLI failed without an error message.',
    invalidOutputMessage: (error) =>
      `Tyrian Night CLI returned invalid output: ${
        error instanceof Error ? error.message : String(error)
      }`,
    validate,
  });
}

async function readCurrentIslandStatus(): Promise<IslandReconciliationStatus> {
  return runIslandCli(
    ['status', '--app-root', vscode.env.appRoot],
    decodeIslandReconciliationStatus
  );
}

async function restoreCurrentIslandUi(): Promise<void> {
  const result = await runIslandCli(
    ['restore', '--app-root', vscode.env.appRoot],
    decodeIslandDirectRestoreResult
  );

  if (result.physicalChanged) {
    await promptForReload(
      'Tyrian Night: Incomplete Island UI state was restored. Reload VS Code to finish reverting.'
    );
  }
}

function resolveDesiredCssFile(desiredThemeId: string | null | undefined): string | undefined {
  if (desiredThemeId === undefined || desiredThemeId === null) {
    return undefined;
  }

  return TYRIAN_THEME_CATALOG.find(({ islandCssFile }) => islandCssFile === desiredThemeId)
    ?.islandCssFile;
}

function getActiveTheme(): string | undefined {
  return vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
}

function formatDoctorClassification(classification: IslandDoctorStatus['classification']): string {
  switch (classification) {
    case 'clean':
      return 'Clean';
    case 'patched':
      return 'Patched';
    case 'managed-only':
      return 'Managed-only';
    case 'transaction-pending':
      return 'Transaction pending';
    case 'transaction-blocked':
      return 'Transaction blocked';
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

function formatRecommendedAction(action: IslandUiRecommendedAction): string {
  switch (action) {
    case 'none':
      return 'None';
    case 'apply':
      return 'Apply Island UI';
    case 'repair':
      return 'Repair Island UI';
    case 'restore':
      return 'Restore Classic UI';
    case 'prune-missing':
      return 'Prune missing installation via Restore Classic UI';
    case 'fix-permissions':
      return 'Fix app-file permissions';
    case 'manual-recovery':
      return 'Inspect and recover transaction evidence manually';
  }
}

function formatRestoreProof(proof: IslandDoctorStatus['restoreProof']): string {
  switch (proof) {
    case 'none':
      return 'None';
    case 'manifest-v3-backup-pair':
      return 'Manifest v3 backup pair';
    case 'strip-tyrian-block':
      return 'Strip Tyrian block only';
  }
}

async function showIslandProcessFailure(
  failure: IslandProcessFailure,
  operation: string
): Promise<void> {
  const causeReasons = failure.causes
    .map(({ reason }) => reason)
    .filter((reason) => reason !== failure.message);
  const causeDetail = causeReasons.length > 0 ? ` Causes: ${causeReasons.join(' | ')}` : '';
  await vscode.window.showErrorMessage(
    `Tyrian Night: ${operation} failed (${failure.code}). ${failure.message}${causeDetail}`
  );

  if (failure.incompleteRecovery) {
    const action = await vscode.window.showWarningMessage(
      'Tyrian Night: Island UI recovery is incomplete and requires explicit inspection or manual recovery. Open Doctor before retrying.',
      OPEN_DOCTOR_ACTION,
      LATER_ACTION
    );
    if (action === OPEN_DOCTOR_ACTION) {
      await doctorIslandUi();
    }
  }

  if (failure.physicalChanged) {
    await promptForReload(
      'Tyrian Night: Island UI changed app files before the operation failed. Reload after reviewing the recovery guidance.'
    );
  }
}

async function promptForReload(message: string): Promise<void> {
  const action = await vscode.window.showInformationMessage(message, 'Reload Window', 'Later');

  if (action === 'Reload Window') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

async function ensureUninstallWarningAcknowledged(): Promise<boolean> {
  if (extContext.globalState.get<boolean>(UNINSTALL_WARNING_ACKNOWLEDGED_KEY, false)) {
    return true;
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
