import { expect, test } from 'bun:test';

import { VSCODE_PROJECTION } from '../scripts/themeDefinition.mjs';
import { SOURCE_THEMES, readSourceTheme } from '../scripts/themeSources.mjs';
import { buildVscodeTheme } from '../scripts/vscodeThemes.mjs';

const REQUIRED_PUBLIC_KEYS = [
  'actionBar.toggledBackground',
  'agentSessionReadIndicator.foreground',
  'agentSessionSelectedBadge.border',
  'agentStatusIndicator.background',
  'button.border',
  'button.secondaryBorder',
  'chat.requestBubbleBackground',
  'chat.requestBubbleHoverBackground',
  'checkbox.disabled.background',
  'checkbox.disabled.foreground',
  'checkbox.selectBackground',
  'checkbox.selectBorder',
  'editorActionList.focusBackground',
  'editorMultiCursor.primary.foreground',
  'editorMultiCursor.secondary.foreground',
  'gauge.errorBackground',
  'gauge.warningBackground',
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
  'notebook.cellHoverBackground',
  'notebook.cellInsertionIndicator',
  'notebook.focusedCellBorder',
  'notebook.focusedEditorBorder',
  'radio.activeBackground',
  'radio.activeBorder',
  'radio.inactiveHoverBackground',
  'statusBarItem.activeBackground',
  'terminalSymbolIcon.argumentForeground',
  'terminalSymbolIcon.branchForeground',
  'terminalSymbolIcon.fileForeground',
  'terminalSymbolIcon.methodForeground',
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
] as const;

test('VS Code projection covers public state, chat, notebook, testing, terminal-symbol, gauge, and agent colors', () => {
  for (const source of SOURCE_THEMES) {
    const projected = buildVscodeTheme(readSourceTheme(source), VSCODE_PROJECTION);

    for (const key of REQUIRED_PUBLIC_KEYS) expect(projected.colors[key]).toBeDefined();
    for (const key of INTENTIONAL_DEFAULTS) expect(projected.colors[key]).toBeUndefined();
  }
});
