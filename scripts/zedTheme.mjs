import fs from 'node:fs';
import path from 'node:path';

const SOURCE_THEMES = [
  {
    sourcePath: 'themes/tyrian-night.json',
    appearance: 'dark',
  },
  {
    sourcePath: 'themes/tyrian-dusk.json',
    appearance: 'dark',
  },
  {
    sourcePath: 'themes/tyrian-dawn.json',
    appearance: 'light',
  },
];

const OUTPUT_PATH = 'zed/themes/tyrian-night.json';

export const ZED_THEME_STYLE_KEYS = [
  'accents',
  'background',
  'background.appearance',
  'border',
  'border.disabled',
  'border.focused',
  'border.selected',
  'border.transparent',
  'border.variant',
  'conflict',
  'conflict.background',
  'conflict.border',
  'created',
  'created.background',
  'created.border',
  'deleted',
  'deleted.background',
  'deleted.border',
  'drop_target.background',
  'editor.active_line.background',
  'editor.active_line_number',
  'editor.active_wrap_guide',
  'editor.background',
  'editor.document_highlight.bracket_background',
  'editor.document_highlight.read_background',
  'editor.document_highlight.write_background',
  'editor.foreground',
  'editor.gutter.background',
  'editor.highlighted_line.background',
  'editor.indent_guide',
  'editor.indent_guide_active',
  'editor.invisible',
  'editor.line_number',
  'editor.subheader.background',
  'editor.wrap_guide',
  'element.active',
  'element.background',
  'element.disabled',
  'element.hover',
  'element.selected',
  'elevated_surface.background',
  'error',
  'error.background',
  'error.border',
  'ghost_element.active',
  'ghost_element.background',
  'ghost_element.disabled',
  'ghost_element.hover',
  'ghost_element.selected',
  'hidden',
  'hidden.background',
  'hidden.border',
  'hint',
  'hint.background',
  'hint.border',
  'icon',
  'icon.accent',
  'icon.disabled',
  'icon.muted',
  'icon.placeholder',
  'ignored',
  'ignored.background',
  'ignored.border',
  'info',
  'info.background',
  'info.border',
  'link_text.hover',
  'modified',
  'modified.background',
  'modified.border',
  'pane.focused_border',
  'pane_group.border',
  'panel.background',
  'panel.focused_border',
  'panel.indent_guide',
  'panel.indent_guide_active',
  'panel.indent_guide_hover',
  'players',
  'predictive',
  'predictive.background',
  'predictive.border',
  'renamed',
  'renamed.background',
  'renamed.border',
  'scrollbar.thumb.background',
  'scrollbar.thumb.border',
  'scrollbar.thumb.hover_background',
  'scrollbar.track.background',
  'scrollbar.track.border',
  'search.active_match_background',
  'search.match_background',
  'status_bar.background',
  'success',
  'success.background',
  'success.border',
  'surface.background',
  'syntax',
  'tab.active_background',
  'tab.inactive_background',
  'tab_bar.background',
  'terminal.ansi.background',
  'terminal.ansi.black',
  'terminal.ansi.blue',
  'terminal.ansi.bright_black',
  'terminal.ansi.bright_blue',
  'terminal.ansi.bright_cyan',
  'terminal.ansi.bright_green',
  'terminal.ansi.bright_magenta',
  'terminal.ansi.bright_red',
  'terminal.ansi.bright_white',
  'terminal.ansi.bright_yellow',
  'terminal.ansi.cyan',
  'terminal.ansi.dim_black',
  'terminal.ansi.dim_blue',
  'terminal.ansi.dim_cyan',
  'terminal.ansi.dim_green',
  'terminal.ansi.dim_magenta',
  'terminal.ansi.dim_red',
  'terminal.ansi.dim_white',
  'terminal.ansi.dim_yellow',
  'terminal.ansi.green',
  'terminal.ansi.magenta',
  'terminal.ansi.red',
  'terminal.ansi.white',
  'terminal.ansi.yellow',
  'terminal.background',
  'terminal.bright_foreground',
  'terminal.dim_foreground',
  'terminal.foreground',
  'text',
  'text.accent',
  'text.disabled',
  'text.muted',
  'text.placeholder',
  'title_bar.background',
  'title_bar.inactive_background',
  'toolbar.background',
  'unreachable',
  'unreachable.background',
  'unreachable.border',
  'warning',
  'warning.background',
  'warning.border',
  'version_control.added',
  'version_control.conflict_marker.ours',
  'version_control.conflict_marker.theirs',
  'version_control.deleted',
  'version_control.modified',
  'version_control.word_added',
  'version_control.word_deleted',
];

export const ZED_SYNTAX_CAPTURE_KEYS = [
  'attribute',
  'boolean',
  'class',
  'comment',
  'comment.doc',
  'comment.documentation',
  'constant',
  'constant.builtin',
  'constructor',
  'decorator',
  'diff.minus',
  'diff.plus',
  'embedded',
  'emphasis',
  'emphasis.strong',
  'enum',
  'enum.member',
  'enumMember',
  'error',
  'function',
  'function.builtin',
  'function.method',
  'hint',
  'invalid.deprecated',
  'keyword',
  'label',
  'link_text',
  'link_uri',
  'macro',
  'markup.quote',
  'method',
  'method.builtin',
  'module',
  'namespace',
  'number',
  'operator',
  'parameter',
  'preproc',
  'predictive',
  'primary',
  'property',
  'property.css',
  'property.json_key',
  'property.readonly',
  'punctuation',
  'punctuation.bracket',
  'punctuation.delimiter',
  'punctuation.list_marker',
  'punctuation.markup',
  'punctuation.special',
  'regexp',
  'selector',
  'selector.pseudo',
  'string',
  'string.escape',
  'string.regex',
  'string.special',
  'string.special.symbol',
  'strong',
  'tag',
  'tag.doctype',
  'text.literal',
  'title',
  'type',
  'type.builtin',
  'type.class',
  'type.enum',
  'type.interface',
  'type.parameter',
  'typeParameter',
  'variable',
  'variable.builtin',
  'variable.parameter',
  'variable.readonly',
  'variable.special',
  'variant',
];

export function buildZedThemeFamily(repoRoot = process.cwd()) {
  return {
    $schema: 'https://zed.dev/schema/themes/v0.2.0.json',
    name: 'Tyrian Night',
    author: 'renbkna',
    themes: SOURCE_THEMES.map(({ sourcePath, appearance }) =>
      buildZedTheme(readJson(path.join(repoRoot, sourcePath)), appearance)
    ),
  };
}

export function writeZedThemeFamily(repoRoot = process.cwd()) {
  const outputPath = path.join(repoRoot, OUTPUT_PATH);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    `${JSON.stringify(buildZedThemeFamily(repoRoot), null, 2)}\n`,
    'utf8'
  );
}

function buildZedTheme(vscodeTheme, appearance) {
  const colors = vscodeTheme.colors;
  const semantic = vscodeTheme.semanticTokenColors;
  const syntax = buildSyntax(vscodeTheme);
  const dimAnsi = buildDimAnsi(colors);

  return clean({
    name: vscodeTheme.name,
    appearance,
    style: {
      accents: [
        semantic.namespace.foreground,
        semantic.type.foreground,
        semantic.function.foreground,
        tokenColor(vscodeTheme, 'string'),
        semantic['variable.readonly'].foreground,
        semantic.parameter.foreground,
      ],
      background: colors['editor.background'],
      'background.appearance': 'opaque',
      border: colors['tab.border'],
      'border.disabled': colors['tab.border'],
      'border.focused': colors['activityBar.activeBorder'],
      'border.selected': colors['tab.activeBorder'],
      'border.transparent': `${colors['tab.border']}00`,
      'border.variant': colors['sideBar.border'],
      conflict: colors['editorWarning.foreground'],
      'conflict.background': colors['inputValidation.warningBackground'],
      'conflict.border': colors['inputValidation.warningBorder'],
      created: colors['editorGutter.addedBackground'],
      'created.background': colors['merge.incomingContentBackground'],
      'created.border': colors['editorGutter.addedBackground'],
      deleted: colors['editorGutter.deletedBackground'],
      'deleted.background': withHexAlpha(
        colors['editorGutter.deletedBackground'],
        isLightHex(colors['editor.background']) ? '18' : '20'
      ),
      'deleted.border': colors['editorGutter.deletedBackground'],
      'drop_target.background': colors['editor.selectionBackground'],
      'editor.active_line.background': colors['editor.lineHighlightBackground'],
      'editor.active_line_number': colors['editorLineNumber.activeForeground'],
      'editor.active_wrap_guide': colors['editorIndentGuide.activeBackground1'],
      'editor.background': colors['editor.background'],
      'editor.document_highlight.bracket_background': zedBracketMatchBackground(colors),
      'editor.document_highlight.read_background': colors['editor.wordHighlightBackground'],
      'editor.document_highlight.write_background': colors['editor.wordHighlightStrongBackground'],
      'editor.foreground': colors['editor.foreground'],
      'editor.gutter.background': colors['editorGutter.background'],
      'editor.highlighted_line.background':
        colors['editor.rangeHighlightBackground'] ?? colors['editor.lineHighlightBackground'],
      'editor.indent_guide': colors['editorIndentGuide.background1'],
      'editor.indent_guide_active': colors['editorIndentGuide.activeBackground1'],
      'editor.invisible': colors['editorLineNumber.foreground'],
      'editor.line_number': colors['editorLineNumber.foreground'],
      'editor.subheader.background': colors['editorGroupHeader.tabsBackground'],
      'editor.wrap_guide': colors['editorRuler.foreground'],
      'element.active': colors['list.activeSelectionBackground'],
      'element.background': colors['input.background'],
      'element.disabled': colors['editorGroupHeader.tabsBackground'],
      'element.hover': colors['list.hoverBackground'],
      'element.selected': colors['list.activeSelectionBackground'],
      'elevated_surface.background': colors['menu.background'],
      error: colors['editorError.foreground'],
      'error.background': colors['inputValidation.errorBackground'],
      'error.border': colors['inputValidation.errorBorder'],
      'ghost_element.active': colors['list.activeSelectionBackground'],
      'ghost_element.background': colors['editor.background'],
      'ghost_element.disabled': colors['editorLineNumber.foreground'],
      'ghost_element.hover': colors['list.hoverBackground'],
      'ghost_element.selected': colors['list.inactiveSelectionBackground'],
      hidden: colors['editorLineNumber.foreground'],
      'hidden.background': colors['editorGroupHeader.tabsBackground'],
      'hidden.border': colors['tab.border'],
      hint: colors['editorHint.foreground'],
      'hint.background': withHexAlpha(
        colors['editorHint.foreground'],
        isLightHex(colors['editor.background']) ? '18' : '20'
      ),
      'hint.border': colors['editorHint.foreground'],
      icon: colors['activityBar.foreground'],
      'icon.accent': colors['activityBar.activeBorder'],
      'icon.disabled': colors['editorLineNumber.foreground'],
      'icon.muted': colors['breadcrumb.foreground'],
      'icon.placeholder': colors['input.placeholderForeground'],
      ignored: colors['editorLineNumber.foreground'],
      'ignored.background': colors['editorGroupHeader.tabsBackground'],
      'ignored.border': colors['tab.border'],
      info: colors['editorInfo.foreground'],
      'info.background': colors['inputValidation.infoBackground'],
      'info.border': colors['inputValidation.infoBorder'],
      'link_text.hover': colors['notificationLink.foreground'],
      modified: colors['editorGutter.modifiedBackground'],
      'modified.background': colors['merge.currentContentBackground'],
      'modified.border': colors['editorGutter.modifiedBackground'],
      'pane.focused_border': semantic.namespace.foreground,
      'pane_group.border': colors['tab.border'],
      'panel.background': colors['panel.background'],
      'panel.focused_border': semantic.namespace.foreground,
      'panel.indent_guide': colors['editorIndentGuide.background1'],
      'panel.indent_guide_active': colors['editorIndentGuide.activeBackground1'],
      'panel.indent_guide_hover': colors['editorIndentGuide.activeBackground1'],
      players: [
        {
          background: colors['editor.background'],
          cursor: colors['editorCursor.foreground'],
          selection: colors['editor.selectionBackground'],
        },
      ],
      predictive: colors['editorInlayHint.foreground'],
      'predictive.background': colors['editorInlayHint.background'],
      'predictive.border': colors['editorInlayHint.typeForeground'],
      renamed: semantic.type.foreground,
      'renamed.background': colors['merge.currentContentBackground'],
      'renamed.border': semantic.type.foreground,
      'scrollbar.thumb.background': colors['scrollbarSlider.background'],
      'scrollbar.thumb.border': colors['scrollbarSlider.background'],
      'scrollbar.thumb.hover_background': colors['scrollbarSlider.hoverBackground'],
      'scrollbar.track.background': colors['editor.background'],
      'scrollbar.track.border': colors['tab.border'],
      'search.active_match_background': colors['editor.findMatchBackground'],
      'search.match_background':
        colors['editor.findMatchHighlightBackground'] ?? colors['editor.findMatchBackground'],
      'status_bar.background': colors['statusBar.background'],
      success: colors['editorGutter.addedBackground'],
      'success.background': colors['merge.incomingContentBackground'],
      'success.border': colors['editorGutter.addedBackground'],
      'surface.background': colors['sideBar.background'],
      syntax,
      'tab.active_background': colors['tab.activeBackground'],
      'tab.inactive_background': colors['tab.inactiveBackground'],
      'tab_bar.background': colors['editorGroupHeader.tabsBackground'],
      'terminal.ansi.background': colors['terminal.background'],
      'terminal.ansi.black': colors['terminal.ansiBlack'],
      'terminal.ansi.blue': colors['terminal.ansiBlue'],
      'terminal.ansi.bright_black': colors['terminal.ansiBrightBlack'],
      'terminal.ansi.bright_blue': colors['terminal.ansiBrightBlue'],
      'terminal.ansi.bright_cyan': colors['terminal.ansiBrightCyan'],
      'terminal.ansi.bright_green': colors['terminal.ansiBrightGreen'],
      'terminal.ansi.bright_magenta': colors['terminal.ansiBrightMagenta'],
      'terminal.ansi.bright_red': colors['terminal.ansiBrightRed'],
      'terminal.ansi.bright_white': colors['terminal.ansiBrightWhite'],
      'terminal.ansi.bright_yellow': colors['terminal.ansiBrightYellow'],
      'terminal.ansi.cyan': colors['terminal.ansiCyan'],
      'terminal.ansi.dim_black': dimAnsi.black,
      'terminal.ansi.dim_blue': dimAnsi.blue,
      'terminal.ansi.dim_cyan': dimAnsi.cyan,
      'terminal.ansi.dim_green': dimAnsi.green,
      'terminal.ansi.dim_magenta': dimAnsi.magenta,
      'terminal.ansi.dim_red': dimAnsi.red,
      'terminal.ansi.dim_white': dimAnsi.white,
      'terminal.ansi.dim_yellow': dimAnsi.yellow,
      'terminal.ansi.green': colors['terminal.ansiGreen'],
      'terminal.ansi.magenta': colors['terminal.ansiMagenta'],
      'terminal.ansi.red': colors['terminal.ansiRed'],
      'terminal.ansi.white': colors['terminal.ansiWhite'],
      'terminal.ansi.yellow': colors['terminal.ansiYellow'],
      'terminal.background': colors['terminal.background'],
      'terminal.bright_foreground': colors['terminal.ansiBrightWhite'],
      'terminal.dim_foreground': colors['breadcrumb.foreground'],
      'terminal.foreground': colors['terminal.foreground'],
      text: colors['editor.foreground'],
      'text.accent': colors['inputOption.activeForeground'],
      'text.disabled': colors['editorLineNumber.foreground'],
      'text.muted': colors['breadcrumb.foreground'],
      'text.placeholder': colors['input.placeholderForeground'],
      'title_bar.background': colors['titleBar.activeBackground'],
      'title_bar.inactive_background': colors['titleBar.inactiveBackground'],
      'toolbar.background': colors['editorGroupHeader.tabsBackground'],
      unreachable: colors['editorLineNumber.foreground'],
      'unreachable.background': colors['editorGroupHeader.tabsBackground'],
      'unreachable.border': colors['tab.border'],
      warning: colors['editorWarning.foreground'],
      'warning.background': colors['inputValidation.warningBackground'],
      'warning.border': colors['inputValidation.warningBorder'],
      'version_control.added': colors['editorGutter.addedBackground'],
      'version_control.conflict_marker.ours': colors['merge.incomingContentBackground'],
      'version_control.conflict_marker.theirs': colors['merge.currentContentBackground'],
      'version_control.deleted': colors['editorGutter.deletedBackground'],
      'version_control.modified': colors['editorGutter.modifiedBackground'],
      'version_control.word_added': colors['merge.incomingContentBackground'],
      'version_control.word_deleted': withHexAlpha(
        colors['editorGutter.deletedBackground'],
        isLightHex(colors['editor.background']) ? '18' : '20'
      ),
    },
  });
}

function buildSyntax(vscodeTheme) {
  const semantic = vscodeTheme.semanticTokenColors;
  const comment = tokenSettings(vscodeTheme, 'comment');
  const docComment = tokenSettings(vscodeTheme, 'comment.block.documentation');
  const constant = tokenSettings(vscodeTheme, 'constant.numeric');
  const functionStyle = semantic.function;
  const heading = tokenSettings(vscodeTheme, 'markup.heading');
  const keyword = tokenSettings(vscodeTheme, 'keyword');
  const link = tokenSettings(vscodeTheme, 'markup.underline.link');
  const punctuation = tokenSettings(vscodeTheme, 'punctuation');
  const string = tokenSettings(vscodeTheme, 'string');
  const cssProperty = tokenSettings(vscodeTheme, 'support.type.property-name.css');
  const jsonProperty = tokenSettings(vscodeTheme, 'support.type.property-name.json');
  const cssSelector = tokenSettings(vscodeTheme, 'entity.other.attribute-name.class.css');
  const variable = semantic['variable.local'];

  return {
    attribute: highlight(semantic.parameter),
    boolean: highlight(semantic['variable.readonly']),
    class: highlight(semantic.class),
    comment: highlight(comment),
    'comment.doc': highlight(docComment),
    'comment.documentation': highlight(docComment),
    constant: highlight(semantic['variable.readonly']),
    'constant.builtin': highlight(semantic['variable.defaultLibrary']),
    constructor: highlight(semantic.type),
    decorator: highlight(semantic.decorator),
    embedded: highlight(string),
    emphasis: highlight(tokenSettings(vscodeTheme, 'markup.italic')),
    'emphasis.strong': highlight(tokenSettings(vscodeTheme, 'markup.bold')),
    enum: highlight(semantic.enum),
    'enum.member': highlight(semantic.enumMember),
    enumMember: highlight(semantic.enumMember),
    error: highlight(tokenSettings(vscodeTheme, 'invalid')),
    function: highlight(functionStyle),
    'function.builtin': highlight(semantic['function.defaultLibrary']),
    'function.method': highlight(semantic.method),
    hint: highlight(semantic.function),
    'invalid.deprecated': highlight(tokenSettings(vscodeTheme, 'invalid.deprecated')),
    keyword: highlight(keyword),
    label: highlight(semantic.decorator),
    link_text: highlight(link),
    link_uri: highlight(link),
    macro: highlight(semantic.macro),
    'markup.quote': highlight(tokenSettings(vscodeTheme, 'markup.quote')),
    method: highlight(semantic.method),
    'method.builtin': highlight(semantic['function.defaultLibrary']),
    module: highlight(semantic.namespace),
    namespace: highlight(semantic.namespace),
    number: highlight(constant),
    operator: highlight(keyword),
    parameter: highlight(semantic.parameter),
    preproc: highlight(semantic.macro),
    predictive: highlight(functionStyle),
    primary: highlight(variable),
    property: highlight(semantic.property),
    'property.css': highlight(cssProperty),
    'property.json_key': highlight(jsonProperty),
    'property.readonly': highlight(semantic['property.readonly']),
    punctuation: highlight(punctuation),
    'punctuation.bracket': highlight(punctuation),
    'punctuation.delimiter': highlight(punctuation),
    'punctuation.list_marker': highlight(semantic['variable.readonly']),
    'punctuation.markup': highlight(semantic['variable.readonly']),
    'punctuation.special': highlight(semantic.decorator),
    regexp: highlight(semantic.regexp),
    selector: highlight(cssSelector),
    'selector.pseudo': highlight(semantic.parameter),
    string: highlight(string),
    'string.escape': highlight(tokenSettings(vscodeTheme, 'constant.character.escape')),
    'string.regex': highlight(tokenSettings(vscodeTheme, 'string.regexp')),
    'string.special': highlight(semantic.parameter),
    'string.special.symbol': highlight(semantic.parameter),
    strong: highlight(tokenSettings(vscodeTheme, 'markup.bold')),
    tag: highlight(keyword),
    'tag.doctype': highlight(semantic.macro),
    'text.literal': highlight(tokenSettings(vscodeTheme, 'markup.inline.raw')),
    title: highlight(heading),
    type: highlight(semantic.type),
    'type.builtin': highlight(semantic['class.defaultLibrary']),
    'type.class': highlight(semantic.class),
    'type.enum': highlight(semantic.enum),
    'type.interface': highlight(semantic.interface),
    'type.parameter': highlight(semantic.typeParameter),
    typeParameter: highlight(semantic.typeParameter),
    variable: highlight(variable),
    'variable.builtin': highlight(semantic['variable.defaultLibrary']),
    'variable.parameter': highlight(semantic.parameter),
    'variable.readonly': highlight(semantic['variable.readonly']),
    'variable.special': highlight(semantic['variable.defaultLibrary']),
    variant: highlight(semantic.enumMember),
    'diff.plus': highlight({ foreground: vscodeTheme.colors['editorGutter.addedBackground'] }),
    'diff.minus': highlight({ foreground: vscodeTheme.colors['editorGutter.deletedBackground'] }),
  };
}

function highlight(settings) {
  const style = {
    color: settings.foreground,
  };

  if (settings.italic || String(settings.fontStyle ?? '').includes('italic')) {
    style.font_style = 'italic';
  }

  if (settings.bold || String(settings.fontStyle ?? '').includes('bold')) {
    style.font_weight = 700;
  }

  return clean(style);
}

function tokenColor(vscodeTheme, scope) {
  return tokenSettings(vscodeTheme, scope).foreground;
}

function tokenSettings(vscodeTheme, scope) {
  for (const token of vscodeTheme.tokenColors) {
    const scopes = Array.isArray(token.scope) ? token.scope : [token.scope];

    if (scopes.includes(scope)) {
      return token.settings;
    }
  }

  throw new Error(`Missing token scope '${scope}' in ${vscodeTheme.name}`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function buildDimAnsi(colors) {
  return {
    black: colors['terminal.ansiBlack'],
    red: colors['editorError.foreground'],
    green: colors['editorHint.foreground'],
    yellow: colors['editorWarning.foreground'],
    blue: colors['editorInfo.foreground'],
    magenta: colors['terminal.ansiMagenta'],
    cyan: colors['terminal.ansiCyan'],
    white: colors['breadcrumb.foreground'],
  };
}

function zedBracketMatchBackground(colors) {
  const background = colors['editorBracketMatch.background'];

  if (background && !isTransparentHex(background)) {
    return background;
  }

  const border =
    colors['editorBracketMatch.border'] ?? colors['editorBracketHighlight.foreground1'];
  const alpha = isLightHex(colors['editor.background']) ? '1F' : '35';

  return withHexAlpha(border, alpha);
}

function isTransparentHex(color) {
  const parsed = parseHexColor(color);

  return parsed.alpha === 0;
}

function isLightHex(color) {
  const { red, green, blue } = parseHexColor(color);
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;

  return luminance > 0.5;
}

function withHexAlpha(color, alpha) {
  const parsed = parseHexColor(color);

  return `#${parsed.hex}${alpha.toUpperCase()}`;
}

function parseHexColor(color) {
  const normalized = color.replace(/^#/, '');

  if (![3, 4, 6, 8].includes(normalized.length)) {
    throw new Error(`Unsupported hex color '${color}'`);
  }

  const expanded =
    normalized.length <= 4
      ? [...normalized].map((character) => `${character}${character}`).join('')
      : normalized;

  return {
    hex: expanded.slice(0, 6).toUpperCase(),
    red: Number.parseInt(expanded.slice(0, 2), 16),
    green: Number.parseInt(expanded.slice(2, 4), 16),
    blue: Number.parseInt(expanded.slice(4, 6), 16),
    alpha: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) : 255,
  };
}

function clean(value) {
  if (Array.isArray(value)) {
    return value.map(clean);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .map(([key, entryValue]) => [key, clean(entryValue)])
    );
  }

  return value;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  writeZedThemeFamily();
}
