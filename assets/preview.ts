/**
 * Tyrian preview surface.
 *
 * Use this file for screenshots because it exercises the theme family in one
 * dense TypeScript page: prose comments, TODO notes, JSON-like settings,
 * types, functions, classes, diagnostics, strings, regex, and markdown text.
 */

import path from 'node:path';

import {
  SOURCE_THEMES,
  getDefaultThemeSource,
  loadThemeRepository,
  readSourceTheme,
} from '../scripts/themeSources.mjs';

// TODO(theme): check comments, notes, and AI ghost text against Monaspace Radon.
// NOTE: JSON property names should read like attributes, not function calls.

declare const THEME_MODE: unique symbol;

export type ThemeMode = string & { readonly [THEME_MODE]: true };

export function buildThemePreviewContract(sourceThemes = SOURCE_THEMES): {
  readonly defaultMode: ThemeMode;
  readonly modes: ReadonlyArray<ThemeMode>;
} {
  return Object.freeze({
    defaultMode: previewModeForSource(getDefaultThemeSource(sourceThemes)),
    modes: Object.freeze(sourceThemes.map(previewModeForSource)),
  });
}

const DEFAULT_THEME_PREVIEW_CONTRACT = buildThemePreviewContract();

export const THEME_MODES = DEFAULT_THEME_PREVIEW_CONTRACT.modes;

export interface ThemeToken {
  readonly scope: string;
  foreground: `#${string}`;
  fontStyle?: 'bold' | 'italic' | 'strikethrough';
}

interface CachedThemePreview {
  readonly ansi: ReadonlyArray<`#${string}`>;
  readonly appearance: 'dark' | 'light';
  readonly name: string;
  readonly tokens: ReadonlyArray<ThemeToken>;
}

export enum DiagnosticSeverity {
  Hint = 'hint',
  Info = 'info',
  Warning = 'warning',
  Error = 'error',
}

const ANSI_ROLES = [
  'ansi.black',
  'ansi.red',
  'ansi.green',
  'ansi.yellow',
  'ansi.blue',
  'ansi.magenta',
  'ansi.cyan',
  'ansi.white',
] as const;

const COLOR_PATTERN = /^#(?<red>[0-9a-f]{2})(?<green>[0-9a-f]{2})(?<blue>[0-9a-f]{2})$/iu;

/** @deprecated Use readThemeManifest instead. */
export function loadLegacyThemeName(): string {
  return 'Tyrian Night Old';
}

function traceable(label: string): ClassDecorator {
  return (target) => {
    Reflect.defineProperty(target, 'traceLabel', {
      configurable: false,
      enumerable: false,
      value: label,
    });
  };
}

@traceable('theme-preview')
export class ThemePreviewController {
  static readonly defaultMode = DEFAULT_THEME_PREVIEW_CONTRACT.defaultMode;

  #cache = new Map<ThemeMode, CachedThemePreview>();

  constructor(private readonly root = process.cwd()) {}

  async readThemeManifest(mode: ThemeMode): Promise<ReadonlyArray<ThemeToken>> {
    const repository = loadThemeRepository(this.root);
    const slug = `tyrian-${mode}`;
    const source = repository.sources.find((candidate) => candidate.slug === slug);
    if (!source) throw new Error(`Unknown preview theme: ${slug}`);
    const theme = readSourceTheme(source, repository.root, repository.definition);

    if (!theme.name.includes('Tyrian') || !['dark', 'light'].includes(theme.appearance)) {
      throw new Error(`Unexpected theme name: ${theme.name}`);
    }

    const tokens: ThemeToken[] = Object.entries(theme.syntax).map(([scope, foreground]) => ({
      scope,
      foreground: foreground as `#${string}`,
    }));
    const ansi = ANSI_ROLES.map((role) => {
      const color = theme.terminal[role];
      if (!color) throw new Error(`Theme ${theme.name} is missing terminal role ${role}.`);
      return color as `#${string}`;
    });
    this.#cache.set(mode, {
      ansi,
      appearance: theme.appearance,
      name: theme.name,
      tokens,
    });
    return tokens;
  }

  summarize(mode = ThemePreviewController.defaultMode): string {
    const preview = this.#cache.get(mode);
    if (!preview) return `No cached theme for mode=${mode}.`;

    const importantScopes = preview.tokens
      .filter(({ scope }) => /comment|function|keyword|string|invalid|markup/u.test(scope))
      .map(({ scope, foreground }) => `${scope.padEnd(32)} ${foreground}`)
      .join('\n');

    return [
      `mode=${mode}`,
      `ansi=${preview.ansi.join(' ')}`,
      `settings=${JSON.stringify(buildZedSettingsPreview(preview), null, 2)}`,
      buildMarkdownPreview(preview.name),
      importantScopes || 'No cached scopes yet.',
    ].join('\n\n');
  }
}

function previewModeForSource(source: { slug: string }): ThemeMode {
  const mode = source.slug.replace(/^tyrian-/u, '');
  if (mode === source.slug || mode.length === 0) {
    throw new Error(`Theme source has no preview mode: ${source.slug}`);
  }
  return mode as ThemeMode;
}

function buildZedSettingsPreview(preview: CachedThemePreview) {
  return {
    theme: {
      mode: preview.appearance,
      [preview.appearance]: preview.name,
    },
    outline_panel: {
      dock: 'left',
    },
    inlay_hints: {
      enabled: true,
      show_background: false,
    },
    terminal: {
      font_family: 'Monaspace Neon',
      font_family_italic: 'Monaspace Radon',
      minimum_contrast: 0,
    },
  };
}

function buildMarkdownPreview(themeName: string): string {
  return String.raw`
# ${themeName}

> quoted prose should stay readable and calm

**bold foreground** and _italic Radon voice_ with \`inline code\`.

- added line
- removed line
- changed line
`;
}

export async function renderPreview(mode: ThemeMode, signal?: AbortSignal): Promise<void> {
  const controller = new ThemePreviewController();
  const tokens = await controller.readThemeManifest(mode);

  for (const token of tokens) {
    if (signal?.aborted) {
      throw new DOMException('Preview cancelled', 'AbortError');
    }

    const match = COLOR_PATTERN.exec(token.foreground);
    const redChannel = match?.groups?.red ?? '00';
    console.log(`${token.scope}: ${token.foreground} red=${Number.parseInt(redChannel, 16)}`);
  }

  console.info(controller.summarize(mode));
}

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  void renderPreview(ThemePreviewController.defaultMode).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error({
      severity: DiagnosticSeverity.Error,
      message,
      retry: true,
    });
  });
}
