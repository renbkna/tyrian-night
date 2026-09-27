import path from 'node:path';

import * as vscode from 'vscode';

import {
  DEFAULT_TYRIAN_THEME_LABEL,
  getIslandCssFileForTheme,
  isTyrianThemeLabel,
} from './generated/themeCatalog.js';
import { readIslandPlatformSupport } from './islandPlatform.js';
import { IslandProcessFailure, runIslandJsonProcess } from './islandProcess.js';
import type { IslandShellStatus } from './islandShellContract.js';
import type {
  IslandUiApplySupervisionResult,
  IslandUiConvergeResult,
  IslandUiRecommendedAction,
} from './islandSupervisor.js';
import type { IslandCliCommand, IslandCliResults } from './islandWire.js';

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
const INCOMPLETE_RELOAD_MESSAGE =
  'Tyrian Night: Island UI changed app files but remains incomplete. Reload VS Code after resolving the reported failures.';

type IslandApplyPresentation = {
  interactive: boolean;
  notifyWhenUnchanged: boolean;
  reloadMessage: string;
};

/** The extension-context capabilities Tyrian uses. */
export type TyrianExtensionContext = Pick<
  vscode.ExtensionContext,
  'extensionPath' | 'subscriptions'
> & {
  extension: Pick<vscode.ExtensionContext['extension'], 'packageJSON'>;
  globalState: Pick<vscode.Memento, 'get' | 'update'>;
};

let extContext: TyrianExtensionContext;
let syncQueue = Promise.resolve();

export async function activate(context: TyrianExtensionContext): Promise<void> {
  extContext = context;

  try {
    registerCommands();
    await enqueueSync(reconcileIslandUi);
    await maybePromptToSwitchTheme();
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
    registerIslandCommand('tyrianNight.applyIslandUi', () =>
      runIslandCommand(applyIslandUiCommand, 'Island UI apply')
    ),
    registerIslandCommand('tyrianNight.repairIslandUi', () =>
      runIslandCommand(repairIslandUi, 'Island UI repair')
    ),
    registerIslandCommand('tyrianNight.restoreClassicUi', restoreClassicUi),
    registerIslandCommand('tyrianNight.doctorIslandUi', doctorIslandUi)
  );
}

/** Every Island command is admitted by the platform capability before it runs. */
function registerIslandCommand(command: string, task: () => Promise<void>): vscode.Disposable {
  return vscode.commands.registerCommand(command, () =>
    enqueueSync(async () => {
      const support = readIslandPlatformSupport();
      if (!support.supported) {
        await vscode.window.showWarningMessage(`Tyrian Night: ${support.reason}`);
        return;
      }
      await task();
    })
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
  // Unsupported hosts can never hold an Island patch; the theme still works there.
  if (!readIslandPlatformSupport().supported) return;

  const convergence = await convergeIslandUi({ kind: 'startup' });
  switch (convergence.action) {
    case 'none':
      return;
    case 'restore':
      await promptForReloadIfRestored(convergence);
      return;
    case 'apply': {
      const { result } = convergence;
      await presentApplyResult(result, {
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
  }
}

async function maybePromptToSwitchTheme(): Promise<void> {
  const promptShown = extContext.globalState.get<boolean>(THEME_PROMPT_KEY, false);

  if (promptShown || isTyrianThemeLabel(getActiveTheme())) {
    return;
  }

  await extContext.globalState.update(THEME_PROMPT_KEY, true);

  const action = await vscode.window.showInformationMessage(
    'Tyrian Night is installed. Switch to the Tyrian Night color theme now? You can enable Island UI after acknowledging the restore-before-uninstall warning.',
    'Switch Theme',
    'Later'
  );

  if (action === 'Switch Theme') {
    await switchToTyrianTheme();
  }
}

async function switchToTyrianTheme(): Promise<void> {
  await vscode.workspace
    .getConfiguration('workbench')
    .update('colorTheme', DEFAULT_TYRIAN_THEME_LABEL, vscode.ConfigurationTarget.Global);
}

async function applyIslandUiCommand(): Promise<void> {
  if (activeIslandCssFile() === undefined) {
    const action = await vscode.window.showInformationMessage(
      'Tyrian Night: Apply Island UI with a Tyrian theme?',
      'Switch Theme',
      'Cancel'
    );

    if (action !== 'Switch Theme') {
      return;
    }

    await switchToTyrianTheme();
  }

  const cssFile = activeIslandCssFile();

  if (cssFile === undefined || !(await ensureUninstallWarningAcknowledged())) {
    return;
  }

  await applyIslandCssFile(cssFile, {
    interactive: true,
    notifyWhenUnchanged: true,
    reloadMessage: 'Tyrian Night: Island UI applied. Reload VS Code to apply it.',
  });
}

async function repairIslandUi(): Promise<void> {
  if (!(await ensureUninstallWarningAcknowledged())) {
    return;
  }

  const convergence = await convergeIslandUi({
    kind: 'repair',
    fallbackCssFile: activeIslandCssFile(),
  });
  switch (convergence.action) {
    case 'none':
      vscode.window.showInformationMessage(
        'Tyrian Night: Apply Island UI once before repairing it.'
      );
      return;
    case 'restore':
      await promptForReloadIfRestored(convergence);
      return;
    case 'apply':
      await presentApplyResult(convergence.result, {
        interactive: true,
        notifyWhenUnchanged: true,
        reloadMessage: 'Tyrian Night: Island UI repaired. Reload VS Code to apply it.',
      });
      return;
  }
}

/**
 * Converge this installation to its desired style. The CLI reads the desired
 * state and acts on it under one Island lock, so another window's change
 * between the read and the mutation is impossible.
 */
function convergeIslandUi(
  intent: { kind: 'startup' } | { kind: 'repair'; fallbackCssFile: string | undefined }
): Promise<IslandUiConvergeResult> {
  return runIslandCli('converge', [
    '--app-root',
    vscode.env.appRoot,
    '--island-dir',
    islandDirectory(),
    '--theme-version',
    themeVersion(),
    ...(intent.kind === 'repair'
      ? [
          '--repair',
          ...(intent.fallbackCssFile === undefined
            ? []
            : ['--fallback-css', intent.fallbackCssFile]),
        ]
      : []),
  ]);
}

async function promptForReloadIfRestored(
  convergence: Extract<IslandUiConvergeResult, { action: 'restore' }>
): Promise<void> {
  if (convergence.result.physicalChanged) {
    await promptForReload(
      'Tyrian Night: Incomplete Island UI state was restored. Reload VS Code to finish reverting.'
    );
  }
}

async function applyIslandCssFile(
  cssFile: string,
  presentation: IslandApplyPresentation
): Promise<void> {
  const result = await runIslandCli('apply-supervised', [
    '--app-root',
    vscode.env.appRoot,
    '--css-source',
    path.join(islandDirectory(), cssFile),
    '--theme-version',
    themeVersion(),
  ]);
  await presentApplyResult(result, presentation);
}

function islandDirectory(): string {
  return path.join(extContext.extensionPath, 'island');
}

function themeVersion(): string {
  return String(extContext.extension.packageJSON.version ?? 'unknown');
}

async function presentApplyResult(
  result: IslandUiApplySupervisionResult,
  presentation: IslandApplyPresentation
): Promise<void> {
  switch (result.kind) {
    case 'applied':
      if (result.physicalChanged) {
        await promptForReload(presentation.reloadMessage);
      } else if (presentation.notifyWhenUnchanged) {
        vscode.window.showInformationMessage(
          'Tyrian Night: Island UI desired state was updated; app files are already current.'
        );
      }
      return;
    case 'already-current':
      if (presentation.notifyWhenUnchanged) {
        vscode.window.showInformationMessage('Tyrian Night: Island UI is already up to date.');
      }
      return;
    case 'permission-required':
      if (presentation.interactive) {
        await showPermissionRequired(
          'VS Code app files are not writable, usually after a package install or update. Fix their permissions outside Tyrian, then retry Island UI repair.',
          'Blocked path',
          result.writeAccess.blockedPaths.map(({ path: blockedPath }) => blockedPath)
        );
        await promptForReloadIfIncomplete(result.physicalChanged);
      }
      return;
    case 'unsupported':
      if (presentation.interactive) {
        const action = await vscode.window.showWarningMessage(
          `Tyrian Night: This VS Code workbench layout is not supported for Island UI yet. ${result.reason}`,
          OPEN_DOCTOR_ACTION,
          LATER_ACTION
        );
        if (action === OPEN_DOCTOR_ACTION) {
          await doctorIslandUi();
        }
      }
      return;
    case 'blocked':
      if (presentation.interactive) {
        await vscode.window.showErrorMessage(
          `Tyrian Night: Island UI repair is blocked. ${result.reason}`
        );
        await promptForReloadIfIncomplete(result.physicalChanged);
      }
      return;
  }
}

async function showPermissionRequired(
  message: string,
  subjectLabel: string,
  subjects: string[]
): Promise<void> {
  const detail =
    subjects.length > 0
      ? ` ${subjectLabel}${subjects.length === 1 ? '' : 's'}: ${subjects.join(', ')}`
      : '';
  const action = await vscode.window.showWarningMessage(
    `Tyrian Night: ${message}${detail}`,
    ...PERMISSION_ACTIONS
  );

  if (action === TRUST_DOCS_ACTION) {
    await vscode.env.openExternal(vscode.Uri.parse(ISLAND_UI_TRUST_DOCS_URL));
  } else if (action === OPEN_DOCTOR_ACTION) {
    await doctorIslandUi();
  }
}

async function restoreClassicUi(): Promise<void> {
  await runIslandCommand(restoreIslandUi, 'Classic UI restore');
}

function isSelfHealable(action: IslandUiRecommendedAction): boolean {
  return action === 'restore' || action === 'prune-missing';
}

async function doctorIslandUi(): Promise<void> {
  const { statuses, registryDiagnostics } = await runIslandCli('status-all-supervised', [
    '--app-root',
    vscode.env.appRoot,
  ]);
  const currentStatus = statuses[0];
  const desiredState = typeof currentStatus?.desiredCssFile === 'string' ? 'enabled' : 'disabled';

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
        `  Desired: ${status.desiredCssFile ? `enabled (${status.desiredCssFile})` : 'disabled'}`,
        `  Verification: ${status.verificationPassed ? 'passed' : 'failed'}`,
        `  Self-heal: ${isSelfHealable(recommendedAction) ? 'available via Restore Classic UI' : 'not available'}`,
        `  Recommended action: ${formatRecommendedAction(recommendedAction)}`,
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
          `  Last receipt: Tyrian Night ${status.receipt.themeVersion} at ${status.receipt.installedAt}`
        );
        detailLines.push(`  Receipt style: ${status.receipt.desiredCssFile}`);
        detailLines.push(`  Receipt CSS hash: ${status.receipt.cssChecksum}`);
      }

      if (status.accessInspection.kind === 'available') {
        const { writeAccess } = status.accessInspection;
        detailLines.push(`  Writable: ${writeAccess.writable ? 'yes' : 'no'}`);

        for (const blockedPath of writeAccess.blockedPaths) {
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

  const healableCount = statuses.filter((status) =>
    isSelfHealable(status.recommendedAction)
  ).length;

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
  const result = await runIslandCli('restore-supervised', ['--app-root', vscode.env.appRoot]);

  if (result.kind === 'permission-required') {
    await showPermissionRequired(
      'Classic UI restore needs write access to VS Code app files. Fix their permissions outside Tyrian, then retry cleanup.',
      'Affected root',
      result.failedAppRoots.map(({ appRoot }) => appRoot)
    );
    await promptForReloadIfIncomplete(result.physicalChanged);
    return;
  }

  if (result.kind === 'blocked') {
    await vscode.window.showErrorMessage(
      `Tyrian Night: Classic UI restore is blocked. ${result.reason}`
    );
    await promptForReloadIfIncomplete(result.physicalChanged);
    return;
  }

  if (!result.physicalChanged) {
    vscode.window.showInformationMessage('Tyrian Night: Classic UI is already active.');
    return;
  }

  await promptForReload('Tyrian Night: Classic UI restored. Reload VS Code to finish reverting.');
}

function runIslandCli<Command extends IslandCliCommand>(
  command: Command,
  args: string[]
): Promise<IslandCliResults[Command]> {
  const cliPath = path.join(extContext.extensionPath, 'out', 'islandCli.js');

  return runIslandJsonProcess<IslandCliResults[Command]>(
    [process.execPath, cliPath, command, ...args],
    { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  );
}

function activeIslandCssFile(): string | undefined {
  const theme = getActiveTheme();
  return theme === undefined ? undefined : getIslandCssFileForTheme(theme);
}

function getActiveTheme(): string | undefined {
  return vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
}

function formatDoctorClassification(classification: IslandShellStatus['classification']): string {
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
      return 'Inspect the reported files manually';
  }
}

function formatRestoreProof(proof: IslandShellStatus['restoreProof']): string {
  switch (proof) {
    case 'none':
      return 'None';
    case 'manifest-backup-pair':
      return 'Manifest backup pair';
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

async function promptForReloadIfIncomplete(physicalChanged: boolean): Promise<void> {
  if (physicalChanged) await promptForReload(INCOMPLETE_RELOAD_MESSAGE);
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
