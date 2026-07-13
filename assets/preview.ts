/**
 * Tyrian preview surface.
 *
 * Use this file for screenshots because it exercises the theme family in one
 * dense TypeScript page: prose comments, TODO notes, JSON-like settings,
 * types, functions, classes, diagnostics, strings, regex, and markdown text.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// TODO(theme): check comments, notes, and AI ghost text against Monaspace Radon.
// NOTE: JSON property names should read like attributes, not function calls.

export type ThemeMode = 'abyss' | 'night' | 'nocturne' | 'night-old' | 'dawn';

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
  static readonly defaultMode: ThemeMode = 'night';

  #cache = new Map<ThemeMode, CachedThemePreview>();

  constructor(private readonly root = process.cwd()) {}

  async readThemeManifest(mode: ThemeMode): Promise<ReadonlyArray<ThemeToken>> {
    const sourceFile = path.join(this.root, 'source', 'themes', `tyrian-${mode}.json`);
    const payload = await fs.readFile(sourceFile, 'utf8');
    const theme = JSON.parse(payload) as {
      appearance: 'dark' | 'light';
      name: string;
      syntax: Record<string, `#${string}`>;
      terminal: Record<string, `#${string}`>;
    };

    if (!theme.name.includes('Tyrian') || !['dark', 'light'].includes(theme.appearance)) {
      throw new Error(`Unexpected theme name: ${theme.name}`);
    }

    const tokens = Object.entries(theme.syntax).map(([scope, foreground]) => ({
      scope,
      foreground,
    }));
    const ansi = ANSI_ROLES.map((role) => {
      const color = theme.terminal[role];
      if (!color) throw new Error(`Theme ${theme.name} is missing terminal role ${role}.`);
      return color;
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

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void renderPreview(ThemePreviewController.defaultMode).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error({
      severity: DiagnosticSeverity.Error,
      message,
      retry: true,
    });
  });
}
