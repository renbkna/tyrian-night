import path from 'node:path';

import * as vscode from 'vscode';

import {
  DEFAULT_TYRIAN_THEME_LABEL,
  TYRIAN_THEME_CATALOG,
  getIslandCssFileForTheme,
  isTyrianThemeLabel,
} from './generated/themeCatalog.js';
import type { IslandShellStatus } from './islandShell.js';
import { isIslandApplyPlatformSupported } from './islandPlatform.js';
import type {
  IslandUiApplySupervisionResult as IslandApplyResult,
  IslandUiRestoreSupervisionResult as IslandRestoreResult,
  IslandUiSupervisorInventory,
  IslandUiRecommendedAction,
} from './islandSupervisor.js';
import { runIslandJsonProcess } from './islandProcess.js';

const OPEN_DOCTOR_ACTION = 'Open Doctor';
const TRUST_DOCS_ACTION = 'Why This Is Needed';
const LATER_ACTION = 'Later';
const PERMISSION_ACTIONS = [TRUST_DOCS_ACTION, OPEN_DOCTOR_ACTION, LATER_ACTION] as const;
const ISLAND_UI_TRUST_DOCS_URL =
  'https://github.com/renbkna/tyrian-night/blob/main/apps/vscode/README.md#island-ui';
const LEGACY_ISLAND_UI_ENABLED_KEY = 'tyrianNight.islandUiEnabled';
const LEGACY_ISLAND_UI_CONFIG_KEY_PREFIX = 'tyrianNight.islandUi:';
const THEME_PROMPT_KEY = 'tyrianNight.themePrompted';
const UNINSTALL_WARNING_ACKNOWLEDGED_KEY = 'tyrianNight.uninstallWarningAcknowledged';
const UNINSTALL_WARNING_MESSAGE =
  'Tyrian Night: Island UI patches VS Code workbench files. Before uninstalling this extension, you must run "Tyrian Night: Restore Classic UI". Uninstalling the extension alone will not remove the custom UI.';

let extContext: vscode.ExtensionContext;
let syncQueue = Promise.resolve();

type LegacyStateMigration = {
  theme: string;
  keys: string[];
};

function isTyrianTheme(theme: string | undefined): theme is string {
  return isTyrianThemeLabel(theme);
}

function getCssFileForTheme(theme: string): string {
  return getIslandCssFileForTheme(theme) ?? getIslandCssFileForTheme(DEFAULT_TYRIAN_THEME_LABEL)!;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extContext = context;

  try {
    const legacyMigration = await consumeLegacyState();
    registerCommands();
    await enqueueSync(() => reconcileIslandUi(legacyMigration));
    await maybePromptToSwitchTheme(getActiveTheme());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Tyrian Night: ${message}`);
  }
}

async function consumeLegacyState(): Promise<LegacyStateMigration | undefined> {
  const configKey = legacyIslandUiConfigKey(vscode.env.appRoot);
  const storedConfig = extContext.globalState.get<unknown>(configKey);
  const legacyEnabled = extContext.globalState.get<boolean | undefined>(
    LEGACY_ISLAND_UI_ENABLED_KEY
  );
  let legacyTheme: string | undefined;

  if (
    typeof storedConfig === 'object' &&
    storedConfig !== null &&
    !Array.isArray(storedConfig) &&
    'theme' in storedConfig &&
    typeof storedConfig.theme === 'string' &&
    isTyrianTheme(storedConfig.theme)
  ) {
    legacyTheme = storedConfig.theme;
  } else if (legacyEnabled) {
    legacyTheme = DEFAULT_TYRIAN_THEME_LABEL;
  }

  const keys = [
    ...(storedConfig === undefined ? [] : [configKey]),
    ...(legacyEnabled === undefined ? [] : [LEGACY_ISLAND_UI_ENABLED_KEY]),
  ];

  if (legacyTheme !== undefined) {
    return { theme: legacyTheme, keys };
  }

  for (const key of keys) {
    await extContext.globalState.update(key, undefined);
  }
  return undefined;
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

async function reconcileIslandUi(legacyMigration: LegacyStateMigration | undefined): Promise<void> {
  if (!isIslandApplyPlatformSupported()) {
    const status = await readCurrentIslandStatus();

    if (status.registered || status.managed || status.active) {
      await restoreCurrentIslandUi();
    }

    if (legacyMigration !== undefined) {
      for (const key of legacyMigration.keys) {
        await extContext.globalState.update(key, undefined);
      }
    }
    return;
  }

  if (legacyMigration !== undefined) {
    const desiredThemeId = getCssFileForTheme(legacyMigration.theme);
    const result = await runIslandCli<{
      kind: 'seeded' | 'existing';
      desiredThemeId: string | null;
    }>([
      'seed-desired-supervised',
      '--app-root',
      vscode.env.appRoot,
      '--desired-theme-id',
      desiredThemeId,
    ]);

    if (result.kind === 'seeded' || result.kind === 'existing') {
      for (const key of legacyMigration.keys) {
        await extContext.globalState.update(key, undefined);
      }
    }
  }

  const status = await readCurrentIslandStatus();

  if (status.registrationState === 'corrupt') {
    throw new Error(
      'Island UI desired-state record is corrupt. Run Doctor before changing app files.'
    );
  }

  if (status.registrationState === 'legacy') {
    await restoreCurrentIslandUi();
    return;
  }

  if (status.registrationState === 'absent') {
    if (status.managed || status.active) {
      await restoreCurrentIslandUi();
    }
    return;
  }

  if (status.desiredThemeId === null) {
    if (status.managed || status.active) {
      await restoreCurrentIslandUi();
    }
    return;
  }

  const desiredCssFile = resolveDesiredCssFile(status.desiredThemeId);

  if (desiredCssFile !== undefined) {
    const result = await applyIslandCssFile(desiredCssFile, {
      interactive: false,
      notifyWhenUnchanged: false,
      reloadMessage: 'Tyrian Night: Island UI was updated. Reload VS Code to apply it.',
    });
    if (result.kind !== 'applied' && result.kind !== 'already-current') {
      throw new Error(`Island UI startup reconciliation is ${result.kind}. ${result.reason}`);
    }
    return;
  }

  if (status.desiredThemeId !== undefined) {
    throw new Error(
      `Island UI desires unavailable style '${status.desiredThemeId}'. Install a matching Tyrian Night version or restore Classic UI.`
    );
  }

  throw new Error('Island UI has no valid desired state. Run Doctor before changing app files.');
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

  const theme = getActiveTheme();

  if (!isTyrianTheme(theme) || !(await ensureUninstallWarningAcknowledged({ interactive: true }))) {
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
  const status = await readCurrentIslandStatus();
  const configuredCssFile = resolveDesiredCssFile(status.desiredThemeId);
  const activeTheme = getActiveTheme();
  const theme = isTyrianTheme(activeTheme) ? activeTheme : undefined;

  if (typeof status.desiredThemeId === 'string' && configuredCssFile === undefined) {
    vscode.window.showErrorMessage(
      `Tyrian Night: Island UI desires unavailable style '${status.desiredThemeId}'. Install a matching Tyrian Night version or restore Classic UI; repair left the shared desired style unchanged.`
    );
    return;
  }

  if (configuredCssFile === undefined && !theme) {
    vscode.window.showInformationMessage('Tyrian Night: Apply Island UI once before repairing it.');
    return;
  }

  if (!(await ensureUninstallWarningAcknowledged({ interactive: true }))) {
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

async function applyIslandUi(
  options: {
    interactive: boolean;
    notifyWhenUnchanged: boolean;
    reloadMessage: string;
  },
  theme: string
): Promise<IslandApplyResult> {
  const cssFile = getCssFileForTheme(theme);
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
  const result = await runIslandCli<IslandApplyResult>([
    'apply-supervised',
    '--app-root',
    vscode.env.appRoot,
    '--css-source',
    path.join(extContext.extensionPath, 'island', cssFile),
    '--theme-version',
    String(extContext.extension.packageJSON.version ?? 'unknown'),
  ]);

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
  await restoreIslandUi({
    interactive: true,
    notifyWhenUnchanged: true,
    reloadMessage: 'Tyrian Night: Classic UI restored. Reload VS Code to finish reverting.',
  });
}

async function doctorIslandUi(): Promise<void> {
  const inventory = await runIslandCli<IslandUiSupervisorInventory>([
    'status-all-supervised',
    '--app-root',
    vscode.env.appRoot,
  ]);
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

async function restoreIslandUi(options: {
  interactive: boolean;
  notifyWhenUnchanged: boolean;
  reloadMessage: string;
}): Promise<IslandRestoreResult> {
  const result = await runIslandCli<IslandRestoreResult>([
    'restore-supervised',
    '--app-root',
    vscode.env.appRoot,
  ]);

  if (result.kind === 'permission-required') {
    if (options.interactive) {
      await showIslandRestorePermissionRequired(result);
    }

    if (result.physicalChanged) {
      await promptForReload(
        'Tyrian Night: Island UI cleanup changed some installations but remains incomplete. Reload VS Code after resolving the reported failures.'
      );
    }

    return result;
  }

  if (result.kind === 'blocked') {
    if (result.physicalChanged) {
      await promptForReload(
        'Tyrian Night: Island UI cleanup changed some installations but remains incomplete. Reload VS Code after resolving the reported failures.'
      );
    }

    throw new Error(`Tyrian Night cleanup is incomplete. ${result.reason}`);
  }

  if (!result.physicalChanged) {
    if (options.notifyWhenUnchanged) {
      vscode.window.showInformationMessage('Tyrian Night: Classic UI is already active.');
    }
    return result;
  }

  await promptForReload(options.reloadMessage);
  return result;
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

function runIslandCli<T>(argumentsList: string[]): Promise<T> {
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
  });
}

async function readCurrentIslandStatus(): Promise<IslandShellStatus> {
  return runIslandCli<IslandShellStatus>(['status', '--app-root', vscode.env.appRoot]);
}

async function restoreCurrentIslandUi(): Promise<void> {
  const result = await runIslandCli<{
    physicalChanged: boolean;
    incompleteRecovery: boolean;
    active: false;
  }>(['restore', '--app-root', vscode.env.appRoot]);

  if (result.physicalChanged) {
    await promptForReload(
      'Tyrian Night: Incomplete legacy Island UI state was restored. Reload VS Code to finish reverting.'
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

function formatDoctorClassification(
  classification:
    | 'clean'
    | 'patched'
    | 'managed-only'
    | 'transaction-pending'
    | 'transaction-blocked'
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

function formatRestoreProof(proof: IslandShellStatus['restoreProof']): string {
  switch (proof) {
    case 'none':
      return 'None';
    case 'manifest-v3-backup-pair':
      return 'Manifest v3 backup pair';
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

function legacyIslandUiConfigKey(appRoot: string): string {
  return `${LEGACY_ISLAND_UI_CONFIG_KEY_PREFIX}${appRoot}`;
}

export function deactivate(): void {
  // No-op.
}
