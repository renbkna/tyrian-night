import * as vscode from 'vscode';

const CUSTOM_UI_EXT_ID = 'subframe7536.custom-ui-style';
const CUSTOM_UI_IMPORTS = 'custom-ui-style.external.imports';
const CUSTOM_UI_RELOAD = 'custom-ui-style.reload';

const CONSENT_KEY = 'tyrianNight.islandUiConsent';

let extContext: vscode.ExtensionContext;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extContext = context;
  
  try {
    registerCommands();
    await checkCustomUiDependency();
    await setupIslandUi();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Tyrian Night: ${message}`);
  }
}

function registerCommands(): void {
  extContext.subscriptions.push(
    vscode.commands.registerCommand('tyrianNight.restoreClassicUi', restoreClassicUi),
    vscode.commands.registerCommand('tyrianNight.prepareUninstall', prepareUninstall)
  );
}

async function checkCustomUiDependency(): Promise<void> {
  const customUi = vscode.extensions.getExtension(CUSTOM_UI_EXT_ID);
  const imports = getImports();
  const hasOurImport = imports.some(i => i.includes('tyrian-night.css'));
  
  if (!customUi && hasOurImport) {
    const action = await vscode.window.showWarningMessage(
      'Custom UI Style is missing but CSS imports remain. Clean up?',
      'Clean Up',
      'Ignore'
    );
    
    if (action === 'Clean Up') {
      await removeTyrianNightImports();
    }
  }
}

async function setupIslandUi(): Promise<void> {
  const customUi = vscode.extensions.getExtension(CUSTOM_UI_EXT_ID);
  if (!customUi) return;
  
  const consent = extContext.globalState.get<boolean | undefined>(CONSENT_KEY);
  
  if (consent === false) return;
  
  if (consent === undefined) {
    const action = await vscode.window.showInformationMessage(
      'Tyrian Night: Enable "Island" UI layout? (Requires Custom UI Style)',
      'Yes',
      'No'
    );
    
    if (action === 'Yes') {
      await extContext.globalState.update(CONSENT_KEY, true);
      await applyIslandUi();
    } else if (action === 'No') {
      await extContext.globalState.update(CONSENT_KEY, false);
    }
    return;
  }
  
  await applyIslandUi();
}

async function applyIslandUi(): Promise<void> {
  const customUi = vscode.extensions.getExtension(CUSTOM_UI_EXT_ID);
  if (!customUi) return;
  
  const sourceUri = vscode.Uri.joinPath(extContext.extensionUri, 'themes', 'tyrian-night.css');
  const targetDir = extContext.globalStorageUri.fsPath;
  const targetPath = `${targetDir}/tyrian-night.css`;
  const targetUri = vscode.Uri.file(targetPath);
  
  try {
    await vscode.workspace.fs.createDirectory(extContext.globalStorageUri);
  } catch {
    // Directory may already exist
  }
  
  const content = await vscode.workspace.fs.readFile(sourceUri);
  await vscode.workspace.fs.writeFile(targetUri, content);
  
  // Use file:// scheme for Custom UI Style compatibility
  const stableUri = targetUri.toString();
  const currentImports = getImports();
  const imports = currentImports.filter(i => !isTyrianNightImport(i));
  
  if (!imports.includes(stableUri)) {
    imports.push(stableUri);
  }
  
  const importsChanged = JSON.stringify(currentImports) !== JSON.stringify(imports);
  
  if (importsChanged) {
    await vscode.workspace.getConfiguration().update(
      CUSTOM_UI_IMPORTS,
      imports,
      vscode.ConfigurationTarget.Global
    );
    
    await customUi.activate();
    await vscode.commands.executeCommand(CUSTOM_UI_RELOAD);
  }
}

async function restoreClassicUi(): Promise<void> {
  const removed = await removeTyrianNightImports();
  
  if (!removed) {
    vscode.window.showInformationMessage('Tyrian Night: No CSS imports to remove.');
    return;
  }
  
  await extContext.globalState.update(CONSENT_KEY, false);
  vscode.window.showInformationMessage('Tyrian Night: Classic UI restored.');
}

async function prepareUninstall(): Promise<void> {
  await removeTyrianNightImports();
  await extContext.globalState.update(CONSENT_KEY, undefined);
  
  try {
    const cssPath = `${extContext.globalStorageUri.fsPath}/tyrian-night.css`;
    const cssUri = vscode.Uri.file(cssPath);
    await vscode.workspace.fs.delete(cssUri);
  } catch {
    // File may not exist, ignore
  }
  
  vscode.window.showInformationMessage(
    'Tyrian Night: Ready to uninstall. Please reload VSCode before uninstalling.'
  );
}

async function removeTyrianNightImports(): Promise<boolean> {
  const imports = getImports();
  const filtered = imports.filter(i => !isTyrianNightImport(i));
  
  if (filtered.length === imports.length) {
    return false;
  }
  
  await vscode.workspace.getConfiguration().update(
    CUSTOM_UI_IMPORTS,
    filtered,
    vscode.ConfigurationTarget.Global
  );
  
  const customUi = vscode.extensions.getExtension(CUSTOM_UI_EXT_ID);
  if (customUi) {
    await customUi.activate();
    await vscode.commands.executeCommand(CUSTOM_UI_RELOAD);
  }
  
  return true;
}

function getImports(): string[] {
  return vscode.workspace.getConfiguration().get<string[]>(CUSTOM_UI_IMPORTS) ?? [];
}

function isTyrianNightImport(importPath: string): boolean {
  return importPath.includes('tyrian-night.css');
}

export function deactivate(): void {
  // Cleanup happens automatically via prepareUninstall or orphaned import detection
}
