import * as vscode from 'vscode';
import * as path from 'path';

const CUSTOM_UI_EXT_ID = 'subframe7536.custom-ui-style';
const CUSTOM_UI_SETTING = 'custom-ui-style.external.imports';
const CONSENT_KEY = 'tyrianNight.islandUiConsent';

export function activate(context: vscode.ExtensionContext) {
    try {
        linkCustomUiCss(context);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Tyrian Night: activation failed — ${msg}`);
    }
}

function linkCustomUiCss(context: vscode.ExtensionContext): void {
    const customUiExt = vscode.extensions.getExtension(CUSTOM_UI_EXT_ID);
    if (!customUiExt) return;

    const consent = context.globalState.get<boolean | undefined>(CONSENT_KEY);

    if (consent === false) return;

    if (consent === undefined) {
        vscode.window.showInformationMessage(
            'Tyrian Night: Enable "Island" UI layout? (Requires Custom UI Style)',
            'Yes', 'No'
        ).then(selection => {
            if (selection === 'Yes') {
                context.globalState.update(CONSENT_KEY, true);
                applyCssLink(context);
            } else if (selection === 'No') {
                context.globalState.update(CONSENT_KEY, false);
            }
        });
        return;
    }

    applyCssLink(context);
}

function applyCssLink(context: vscode.ExtensionContext): void {
    const cssPath = path.join(context.extensionPath, 'themes', 'tyrian-night.css');
    const cssUri = vscode.Uri.file(cssPath).toString();
    const config = vscode.workspace.getConfiguration();
    const current = config.get<string[]>(CUSTOM_UI_SETTING) || [];

    // Substring match — Uri.file().toString() encoding can differ across reloads
    if (current.some(s => s.includes(context.extensionPath) && s.includes('tyrian-night.css'))) return;

    const filtered = current.filter(s => !s.includes('tyrian-night.css'));

    // Chain: persist config → then show reload prompt (prevents reload before write completes)
    config.update(CUSTOM_UI_SETTING, [...filtered, cssUri], vscode.ConfigurationTarget.Global)
        .then(() => vscode.window.showInformationMessage(
            'Tyrian Night: Island UI layout enabled. Restart VS Code to apply.',
            'Restart'
        ))
        .then(selection => {
            if (selection === 'Restart') {
                vscode.commands.executeCommand('workbench.action.quit');
            }
        });
}

export function deactivate() {
    try {
        const config = vscode.workspace.getConfiguration();
        const current = config.get<string[]>(CUSTOM_UI_SETTING) || [];
        const filtered = current.filter(s => !s.includes('tyrian-night.css'));

        if (filtered.length !== current.length) {
            config.update(CUSTOM_UI_SETTING, filtered, vscode.ConfigurationTarget.Global);
        }
    } catch {
        // Extension host is shutting down — best-effort cleanup only.
    }
}
