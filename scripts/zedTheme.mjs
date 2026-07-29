// @ts-check

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { contrastRatio } from './colorScience.mjs';
import { isTransparentHex, opaqueHex, withHexAlpha } from './colorUtils.mjs';
import { syncGeneratedAssets } from './generatedAssets.mjs';
import { bracketColor, syntaxColor, terminalColor, uiColor } from './themeDefinition.mjs';
import { loadThemeRepository, readSourceTheme } from './themeSources.mjs';

/**
 * @typedef {import('./themeDefinition.mjs').ThemeDefinition} ThemeDefinition
 * @typedef {{ color: string; italic?: boolean; bold?: boolean; weight?: number }} ZedHighlight
 */

const OUTPUT_PATH = 'apps/zed/themes/tyrian-night.json';
const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZED_FUNCTION_FONT_WEIGHT = 500;

/**
 * @param {string} [repoRoot]
 * @returns {{ $schema: string; name: string; author: string; themes: unknown[] }}
 */
export function buildZedThemeFamily(repoRoot = defaultRepoRoot) {
  const repository = loadThemeRepository(repoRoot);

  return {
    $schema: 'https://zed.dev/schema/themes/v0.2.0.json',
    name: 'Tyrian Night',
    author: 'renbkna',
    themes: repository.sources.map((source) =>
      buildZedTheme(
        /** @type {ThemeDefinition} */ (readSourceTheme(source, repoRoot, repository.definition)),
        repository.definition.requiredThemeRoles.brackets
      )
    ),
  };
}

/**
 * @param {string} [repoRoot]
 * @param {{ check?: boolean }} [options]
 * @returns {string[]}
 */
export function writeZedThemeFamily(repoRoot = defaultRepoRoot, options = {}) {
  return syncGeneratedAssets(
    [
      {
        path: OUTPUT_PATH,
        content: `${JSON.stringify(buildZedThemeFamily(repoRoot), null, 2)}\n`,
      },
    ],
    repoRoot,
    {
      check: options.check,
      ownership: [{ directory: 'apps/zed/themes' }],
    }
  );
}

/**
 * @param {ThemeDefinition} theme
 * @param {readonly string[]} bracketRoles
 * @returns {unknown}
 */
export function buildZedTheme(theme, bracketRoles) {
  /** @param {string} role */
  const ui = (role) => uiColor(theme, role);
  /** @param {string} role */
  const syntaxRole = (role) => syntaxColor(theme, role);
  /** @param {string} role */
  const terminal = (role) => terminalColor(theme, role);
  const dimAnsi = buildDimAnsi(theme);
  const syntax = buildSyntax(theme);
  const subtleWashAlpha = theme.appearance === 'light' ? '18' : '20';
  const editorBackground = ui('surface.canvas');
  const accents = bracketRoles.map((role) => bracketColor(theme, role));

  return {
    name: theme.name,
    appearance: theme.appearance,
    style: {
      accents,
      background: editorBackground,
      'background.appearance': 'opaque',
      border: ui('border.tab'),
      'border.disabled': ui('border.tab'),
      'border.focused': ui('accent.primary'),
      'border.selected': ui('accent.primary'),
      'border.transparent': withHexAlpha(ui('border.tab'), '00'),
      'border.variant': ui('border.default'),
      conflict: ui('status.warning'),
      'conflict.background': ui('status.warningBackground'),
      'conflict.border': ui('status.warning'),
      created: ui('status.success'),
      'created.background': ui('status.successBackground'),
      'created.border': ui('status.success'),
      deleted: ui('status.removed'),
      'deleted.background': withHexAlpha(ui('status.removed'), subtleWashAlpha),
      'deleted.border': ui('status.removed'),
      'drop_target.background': ui('selection.primary'),
      'editor.active_line.background': ui('surface.hover'),
      'editor.active_line_number': ui('editor.lineNumber.active'),
      'editor.active_wrap_guide': ui('editor.indentGuide.active'),
      'editor.background': editorBackground,
      'editor.document_highlight.bracket_background': zedBracketMatchBackground(theme),
      'editor.document_highlight.read_background': ui('editor.reference.read'),
      'editor.document_highlight.write_background': ui('editor.reference.write'),
      'editor.foreground': ui('text.primary'),
      'editor.gutter.background': ui('editor.gutter.background'),
      'editor.highlighted_line.background': ui('editor.highlight'),
      'editor.indent_guide': ui('editor.indentGuide.normal'),
      'editor.indent_guide_active': ui('editor.indentGuide.active'),
      'editor.invisible': ui('editor.lineNumber.normal'),
      'editor.line_number': ui('editor.lineNumber.normal'),
      'editor.subheader.background': ui('surface.chrome'),
      'editor.wrap_guide': ui('editor.guide'),
      'element.active': ui('selection.active'),
      'element.background': ui('surface.field'),
      'element.disabled': ui('surface.chrome'),
      'element.hover': ui('surface.hover'),
      'element.selected': ui('selection.active'),
      'elevated_surface.background': ui('surface.raised'),
      error: ui('status.error'),
      'error.background': ui('status.errorBackground'),
      'error.border': ui('status.error'),
      'ghost_element.active': ui('selection.active'),
      'ghost_element.background': ui('surface.canvas'),
      'ghost_element.disabled': ui('editor.lineNumber.normal'),
      'ghost_element.hover': ui('surface.hover'),
      'ghost_element.selected': ui('selection.inactive'),
      hidden: ui('editor.lineNumber.normal'),
      'hidden.background': ui('surface.chrome'),
      'hidden.border': ui('border.tab'),
      hint: ui('editor.hint'),
      'hint.background': withHexAlpha(ui('editor.hint'), subtleWashAlpha),
      'hint.border': ui('editor.hint'),
      icon: ui('text.chrome'),
      'icon.accent': ui('accent.primary'),
      'icon.disabled': ui('editor.lineNumber.normal'),
      'icon.muted': ui('text.muted'),
      'icon.placeholder': ui('text.muted'),
      ignored: ui('editor.lineNumber.normal'),
      'ignored.background': ui('surface.chrome'),
      'ignored.border': ui('border.tab'),
      info: ui('status.info'),
      'info.background': ui('status.infoBackground'),
      'info.border': ui('status.info'),
      'link_text.hover': ui('link.primary'),
      modified: ui('status.modified'),
      'modified.background': ui('status.modifiedBackground'),
      'modified.border': ui('status.modified'),
      'pane.focused_border': ui('accent.primary'),
      'pane_group.border': ui('border.tab'),
      'panel.background': ui('surface.chrome'),
      'panel.focused_border': ui('accent.primary'),
      'panel.indent_guide': ui('editor.indentGuide.normal'),
      'panel.indent_guide_active': ui('editor.indentGuide.active'),
      'panel.indent_guide_hover': ui('editor.indentGuide.active'),
      players: [
        {
          background: ui('surface.canvas'),
          cursor: ui('accent.cursor'),
          selection: ui('selection.primary'),
        },
      ],
      predictive: ui('text.hint'),
      'predictive.background': ui('editor.predictive.background'),
      'predictive.border': ui('editor.predictive.border'),
      renamed: syntaxRole('type'),
      'renamed.background': ui('status.modifiedBackground'),
      'renamed.border': syntaxRole('type'),
      'scrollbar.thumb.background': ui('scrollbar.background'),
      'scrollbar.thumb.border': ui('scrollbar.background'),
      'scrollbar.thumb.hover_background': ui('scrollbar.hover.background'),
      'scrollbar.track.background': ui('surface.canvas'),
      'scrollbar.track.border': ui('border.tab'),
      'search.active_match_background': ui('search.match.active'),
      'search.match_background': ui('search.match.passive'),
      'status_bar.background': ui('surface.navigation'),
      success: ui('status.success'),
      'success.background': ui('status.successBackground'),
      'success.border': ui('status.success'),
      'surface.background': ui('surface.sidebar'),
      syntax,
      'tab.active_background': ui('surface.tab.active'),
      'tab.inactive_background': ui('surface.tab.inactive'),
      'tab_bar.background': ui('surface.chrome'),
      'terminal.ansi.background': terminal('background'),
      'terminal.ansi.black': terminal('ansi.black'),
      'terminal.ansi.blue': terminal('ansi.blue'),
      'terminal.ansi.bright_black': terminal('ansi.brightBlack'),
      'terminal.ansi.bright_blue': terminal('ansi.brightBlue'),
      'terminal.ansi.bright_cyan': terminal('ansi.brightCyan'),
      'terminal.ansi.bright_green': terminal('ansi.brightGreen'),
      'terminal.ansi.bright_magenta': terminal('ansi.brightMagenta'),
      'terminal.ansi.bright_red': terminal('ansi.brightRed'),
      'terminal.ansi.bright_white': terminal('ansi.brightWhite'),
      'terminal.ansi.bright_yellow': terminal('ansi.brightYellow'),
      'terminal.ansi.cyan': terminal('ansi.cyan'),
      'terminal.ansi.dim_black': dimAnsi.black,
      'terminal.ansi.dim_blue': dimAnsi.blue,
      'terminal.ansi.dim_cyan': dimAnsi.cyan,
      'terminal.ansi.dim_green': dimAnsi.green,
      'terminal.ansi.dim_magenta': dimAnsi.magenta,
      'terminal.ansi.dim_red': dimAnsi.red,
      'terminal.ansi.dim_white': dimAnsi.white,
      'terminal.ansi.dim_yellow': dimAnsi.yellow,
      'terminal.ansi.green': terminal('ansi.green'),
      'terminal.ansi.magenta': terminal('ansi.magenta'),
      'terminal.ansi.red': terminal('ansi.red'),
      'terminal.ansi.white': terminal('ansi.white'),
      'terminal.ansi.yellow': terminal('ansi.yellow'),
      'terminal.background': terminal('background'),
      'terminal.bright_foreground': terminal('ansi.brightWhite'),
      'terminal.dim_foreground': dimAnsi.white,
      'terminal.foreground': terminal('foreground'),
      text: ui('text.primary'),
      'text.accent': ui('text.accentActive'),
      'text.disabled': ui('editor.lineNumber.normal'),
      'text.muted': ui('text.muted'),
      'text.placeholder': ui('text.muted'),
      'title_bar.background': ui('surface.chrome'),
      'title_bar.inactive_background': ui('surface.canvas'),
      'toolbar.background': ui('surface.chrome'),
      unreachable: ui('editor.lineNumber.normal'),
      'unreachable.background': ui('surface.chrome'),
      'unreachable.border': ui('border.tab'),
      warning: ui('status.warning'),
      'warning.background': ui('status.warningBackground'),
      'warning.border': ui('status.warning'),
      'version_control.added': ui('status.success'),
      'version_control.conflict_marker.ours': ui('status.successBackground'),
      'version_control.conflict_marker.theirs': ui('status.modifiedBackground'),
      'version_control.deleted': ui('status.removed'),
      'version_control.modified': ui('status.modified'),
      'version_control.word_added': ui('status.successBackground'),
      'version_control.word_deleted': withHexAlpha(ui('status.removed'), subtleWashAlpha),
    },
  };
}

/**
 * Zed owns capture names and font styling. Colors come only from neutral theme roles.
 * @param {ThemeDefinition} theme
 * @returns {Record<string, unknown>}
 */
function buildSyntax(theme) {
  /** @param {string} role @param {Omit<ZedHighlight, 'color'>} [options] */
  const syntax = (role, options = {}) => highlight({ color: syntaxColor(theme, role), ...options });
  /** @param {string} role @param {Omit<ZedHighlight, 'color'>} [options] */
  const ui = (role, options = {}) => highlight({ color: uiColor(theme, role), ...options });

  return {
    attribute: syntax('data'),
    boolean: syntax('constantLanguage'),
    class: syntax('type'),
    comment: syntax('comment', {
      italic: true,
    }),
    'comment.doc': syntax('documentation', {
      italic: true,
    }),
    'comment.documentation': syntax('documentation', { italic: true }),
    constant: syntax('data'),
    'constant.builtin': syntax('null'),
    constructor: syntax('type'),
    decorator: syntax('type'),
    embedded: syntax('string'),
    emphasis: syntax('emphasis', {
      italic: true,
    }),
    'emphasis.strong': syntax('variable', { bold: true }),
    enum: syntax('type'),
    'enum.member': syntax('data'),
    enumMember: syntax('data'),
    error: ui('status.error'),
    function: syntax('function', {
      weight: ZED_FUNCTION_FONT_WEIGHT,
    }),
    'function.builtin': syntax('function', { weight: ZED_FUNCTION_FONT_WEIGHT }),
    'function.method': syntax('function', { weight: ZED_FUNCTION_FONT_WEIGHT }),
    hint: ui('text.hint', { italic: true }),
    'invalid.deprecated': syntax('data'),
    keyword: syntax('keyword'),
    label: syntax('type'),
    link_text: syntax('type'),
    link_uri: syntax('file'),
    macro: syntax('type'),
    'markup.quote': syntax('string', { italic: true }),
    method: syntax('function', { weight: ZED_FUNCTION_FONT_WEIGHT }),
    'method.builtin': syntax('function', { weight: ZED_FUNCTION_FONT_WEIGHT }),
    module: syntax('type'),
    namespace: syntax('type'),
    number: syntax('data'),
    operator: syntax('keyword'),
    parameter: syntax('data'),
    preproc: syntax('type'),
    predictive: ui('text.hint'),
    primary: syntax('variable'),
    property: syntax('variable'),
    'property.css': syntax('variable'),
    'property.json_key': syntax('data'),
    'property.readonly': syntax('data'),
    punctuation: syntax('punctuation'),
    'punctuation.bracket': syntax('type'),
    'punctuation.delimiter': syntax('punctuation'),
    'punctuation.list_marker': syntax('data'),
    'punctuation.markup': syntax('data'),
    'punctuation.special': syntax('type'),
    regexp: syntax('regexp'),
    selector: syntax('variable'),
    'selector.pseudo': syntax('keyword'),
    string: syntax('string'),
    'string.escape': syntax('data'),
    'string.regex': syntax('regexp'),
    'string.special': syntax('data'),
    'string.special.symbol': syntax('data'),
    strong: syntax('variable', { bold: true }),
    tag: syntax('keyword'),
    'tag.doctype': syntax('type'),
    'text.literal': syntax('function'),
    title: syntax('keyword', { bold: true }),
    type: syntax('type'),
    'type.builtin': syntax('type'),
    'type.class': syntax('type'),
    'type.enum': syntax('type'),
    'type.interface': syntax('type'),
    'type.parameter': syntax('type'),
    typeParameter: syntax('type'),
    variable: syntax('variable'),
    'variable.builtin': syntax('data'),
    'variable.parameter': syntax('data'),
    'variable.readonly': syntax('data'),
    'variable.special': syntax('data', { italic: true }),
    variant: syntax('data'),
    'diff.plus': ui('status.success'),
    'diff.minus': ui('status.removed'),
  };
}

/**
 * @param {ZedHighlight} settings
 * @returns {{ color: string; font_style?: string; font_weight?: number }}
 */
function highlight(settings) {
  /** @type {{ color: string; font_style?: string; font_weight?: number }} */
  const style = { color: settings.color };
  if (settings.italic) style.font_style = 'italic';
  if (settings.bold) style.font_weight = 700;
  if (settings.weight !== undefined) style.font_weight = settings.weight;
  return style;
}

/**
 * @param {ThemeDefinition} theme
 * @returns {Record<string, string>}
 */
function buildDimAnsi(theme) {
  const background = terminalColor(theme, 'background');
  const targetContrast = contrastRatio(uiColor(theme, 'text.muted'), background);
  /** @param {string} role */
  const dim = (role) =>
    dimTerminalColor(terminalColor(theme, `ansi.${role}`), background, targetContrast);

  return {
    black: dim('black'),
    red: dim('red'),
    green: dim('green'),
    yellow: dim('yellow'),
    blue: dim('blue'),
    magenta: dim('magenta'),
    cyan: dim('cyan'),
    white: dim('white'),
  };
}

/**
 * Preserve the ANSI hue while reducing it to the authored muted-text contrast envelope.
 * Colors already below that envelope, notably ANSI black, remain unchanged.
 * @param {string} color
 * @param {string} background
 * @param {number} targetContrast
 * @returns {string}
 */
function dimTerminalColor(color, background, targetContrast) {
  const opaqueColor = opaqueHex(color, background);

  if (contrastRatio(opaqueColor, background) <= targetContrast) {
    return opaqueColor;
  }

  let closestDimmed = opaqueColor;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (let alpha = 1; alpha < 255; alpha += 1) {
    const alphaHex = alpha.toString(16).padStart(2, '0');
    const candidate = opaqueHex(withHexAlpha(opaqueColor, alphaHex), background);
    if (candidate === opaqueColor) continue;

    const distance = Math.abs(contrastRatio(candidate, background) - targetContrast);
    if (distance < closestDistance) {
      closestDimmed = candidate;
      closestDistance = distance;
    }
  }

  return closestDimmed;
}

/**
 * @param {ThemeDefinition} theme
 * @returns {string}
 */
function zedBracketMatchBackground(theme) {
  const background = uiColor(theme, 'editor.bracket.matchBackground');

  if (!isTransparentHex(background)) {
    return background;
  }

  const border = uiColor(theme, 'editor.bracket.matchBorder');
  const alpha = theme.appearance === 'light' ? '1F' : '35';

  return withHexAlpha(border, alpha);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const staleFiles = writeZedThemeFamily(defaultRepoRoot, {
    check: process.argv.includes('--check'),
  });

  if (staleFiles.length > 0) {
    console.error(`Zed theme assets are stale: ${staleFiles.join(', ')}`);
    process.exit(1);
  }
}
