import { expect, test } from 'bun:test';

import { contrastRatio } from '../scripts/colorScience.mjs';
import { opaqueHex } from '../scripts/colorUtils.mjs';
import { VSCODE_PROJECTION, syntaxColor, uiColor } from '../scripts/themeDefinition.mjs';
import { SOURCE_THEMES, readSourceTheme } from '../scripts/themeSources.mjs';
import { buildVscodeTheme } from '../scripts/vscodeThemes.mjs';

const REQUIRED_PUBLIC_KEYS = [
  'actionBar.toggledBackground',
  'activityBarBadge.background',
  'agentSessionReadIndicator.foreground',
  'agentSessionSelectedBadge.border',
  'agentStatusIndicator.background',
  'button.border',
  'button.secondaryBorder',
  'chat.requestBubbleBackground',
  'chat.requestBubbleHoverBackground',
  'checkbox.disabled.background',
  'checkbox.disabled.foreground',
  'checkbox.foreground',
  'checkbox.selectBackground',
  'checkbox.selectBorder',
  'editorActionList.focusBackground',
  'editorHoverWidget.highlightForeground',
  'editorMultiCursor.primary.foreground',
  'editorMultiCursor.secondary.foreground',
  'gauge.errorBackground',
  'gauge.warningBackground',
  'extensionBadge.remoteBackground',
  'inlineChat.background',
  'inlineChat.border',
  'inlineChatInput.background',
  'inlineChatInput.focusBorder',
  'inputOption.activeBackground',
  'inputOption.hoverBackground',
  'list.activeSelectionIconForeground',
  'list.focusAndSelectionOutline',
  'quickInputList.focusIconForeground',
  'list.focusOutline',
  'list.inactiveFocusOutline',
  'list.inactiveSelectionIconForeground',
  'listFilterWidget.noMatchesOutline',
  'listFilterWidget.outline',
  'notebook.cellEditorBackground',
  'notebook.cellHoverBackground',
  'notebook.cellInsertionIndicator',
  'notebook.focusedCellBorder',
  'notebook.focusedEditorBorder',
  'notebookEditorOverviewRuler.runningCellForeground',
  'radio.activeBackground',
  'radio.activeBorder',
  'radio.activeForeground',
  'radio.inactiveHoverBackground',
  'statusBarItem.activeBackground',
  'statusBarItem.errorBackground',
  'statusBarItem.offlineBackground',
  'statusBarItem.offlineForeground',
  'statusBarItem.prominentBackground',
  'statusBarItem.remoteHoverForeground',
  'statusBarItem.warningBackground',
  'settings.checkboxForeground',
  'terminalSymbolIcon.argumentForeground',
  'terminalSymbolIcon.branchForeground',
  'terminalSymbolIcon.fileForeground',
  'terminalSymbolIcon.methodForeground',
  'terminalSymbolIcon.stashForeground',
  'terminalSymbolIcon.symbolicLinkFolderForeground',
  'terminalSymbolIcon.tagForeground',
  'testing.iconFailed',
  'testing.iconPassed',
  'testing.iconQueued',
  'toolbar.activeBackground',
  'toolbar.hoverBackground',
  'toolbar.hoverOutline',
  'window.activeBorder',
  'window.inactiveBorder',
] as const;

const INTENTIONAL_DEFAULTS = [
  'contrastBorder',
  'contrastActiveBorder',
  'widget.shadow',
  'scrollbar.shadow',
  'inlineChat.shadow',
  'sideBarStickyScroll.shadow',
  'panelStickyScroll.shadow',
  'minimap.foregroundOpacity',
  'listFilterWidget.shadow',
  'terminal.selectionForeground',
  'statusBarItem.errorHoverBackground',
  'statusBarItem.errorHoverForeground',
  'statusBarItem.offlineHoverBackground',
  'statusBarItem.offlineHoverForeground',
  'statusBarItem.warningHoverBackground',
  'statusBarItem.warningHoverForeground',
] as const;

const FOCUS_OUTLINES = [
  'focusBorder',
  'activityBar.activeFocusBorder',
  'list.focusOutline',
  'list.focusAndSelectionOutline',
  'notebook.focusedCellBorder',
  'notebook.focusedEditorBorder',
  'settings.focusedRowBorder',
  'statusBar.focusBorder',
  'statusBarItem.focusBorder',
  'inlineChatInput.focusBorder',
] as const;

const HOVER_OUTLINES = [
  'sash.hoverBorder',
  'toolbar.hoverOutline',
  'tab.hoverBorder',
  'tab.unfocusedHoverBorder',
] as const;

const QUIET_SECONDARY_OUTLINES = [
  'checkbox.selectBorder',
  'radio.activeBorder',
  'list.inactiveFocusOutline',
  'notebook.inactiveFocusedCellBorder',
  'notebook.inactiveSelectedCellBorder',
  'notebook.selectedCellBorder',
  'tab.unfocusedActiveBorder',
  'tab.unfocusedActiveBorderTop',
  'agentSessionSelectedBadge.border',
  'simpleFindWidget.sashBorder',
  'inlineEdit.gutterIndicator.secondaryBorder',
] as const;

const CONTROL_INDICATOR_PAIRS = [
  ['checkbox.foreground', 'checkbox.background'],
  ['checkbox.foreground', 'checkbox.selectBackground'],
  ['radio.activeForeground', 'radio.activeBackground'],
  ['settings.checkboxForeground', 'settings.checkboxBackground'],
] as const;

const OWNED_TEXT_PAIRS = [
  ['activityBarBadge.foreground', 'activityBarBadge.background'],
  ['extensionBadge.remoteForeground', 'extensionBadge.remoteBackground'],
  ['statusBarItem.errorForeground', 'statusBarItem.errorBackground'],
  ['statusBarItem.warningForeground', 'statusBarItem.warningBackground'],
  ['statusBarItem.offlineForeground', 'statusBarItem.offlineBackground'],
  ['statusBarItem.prominentForeground', 'statusBarItem.prominentBackground'],
  ['statusBarItem.prominentHoverForeground', 'statusBarItem.prominentHoverBackground'],
  ['statusBarItem.remoteForeground', 'statusBarItem.remoteBackground'],
  ['statusBarItem.remoteHoverForeground', 'statusBarItem.remoteHoverBackground'],
] as const;

test('VS Code projection covers required state, chat, notebook, testing, terminal-symbol, gauge, and agent colors', () => {
  for (const source of SOURCE_THEMES) {
    const projected = buildVscodeTheme(readSourceTheme(source), VSCODE_PROJECTION);

    for (const key of REQUIRED_PUBLIC_KEYS) expect(projected.colors[key]).toBeDefined();
    for (const key of INTENTIONAL_DEFAULTS) expect(projected.colors[key]).toBeUndefined();
  }
});

test('VS Code projection reserves maximum-accent outlines for focus and primary indicators', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme(source);
    const projected = buildVscodeTheme(theme, VSCODE_PROJECTION);
    const focus = uiColor(theme, 'accent.primary');
    const hover = uiColor(theme, 'border.hover');
    const quiet = uiColor(theme, 'border.default');

    expect(focus).not.toBe(quiet);
    expect(hover).not.toBe(quiet);
    expect(hover).not.toBe(focus);
    for (const key of FOCUS_OUTLINES) expect(projected.colors[key]).toBe(focus);
    for (const key of HOVER_OUTLINES) expect(projected.colors[key]).toBe(hover);
    for (const key of QUIET_SECONDARY_OUTLINES) expect(projected.colors[key]).toBe(quiet);
  }
});

test('VS Code control indicators and owned status pairs remain visible on their backgrounds', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme(source);
    const projected = buildVscodeTheme(theme, VSCODE_PROJECTION);
    const statusBarBackground = uiColor(theme, 'surface.navigation');

    for (const [foregroundKey, backgroundKey] of CONTROL_INDICATOR_PAIRS) {
      const foreground = projected.colors[foregroundKey]!;
      const background = opaqueHex(projected.colors[backgroundKey]!, statusBarBackground);

      expect(foreground).toBe(uiColor(theme, 'accent.primary'));
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(3);
    }

    for (const [foregroundKey, backgroundKey] of OWNED_TEXT_PAIRS) {
      const foreground = projected.colors[foregroundKey]!;
      const background = opaqueHex(projected.colors[backgroundKey]!, statusBarBackground);

      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test('VS Code categorical editor colors resolve directly from neutral owners', () => {
  for (const source of SOURCE_THEMES) {
    const theme = readSourceTheme(source);
    const projected = buildVscodeTheme(theme, VSCODE_PROJECTION);

    expect(projected.colors['editorBracketHighlight.foreground3']).toBe(
      syntaxColor(theme, 'function')
    );
    expect(projected.colors['editorBracketHighlight.foreground6']).toBe(
      syntaxColor(theme, 'emphasis')
    );
    expect(projected.colors['debugIcon.stopForeground']).toBe(uiColor(theme, 'status.error'));
    expect(projected.colors['debugIcon.pauseForeground']).toBe(uiColor(theme, 'status.warning'));
    expect(projected.colors['debugIcon.startForeground']).toBe(uiColor(theme, 'status.success'));
  }
});
