/**
 * Tyrian preview surface.
 *
 * Use this file for screenshots because it exercises the theme family in one
 * dense TypeScript page: prose comments, TODO notes, JSON-like settings,
 * types, functions, classes, diagnostics, strings, regex, and markdown text.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

// TODO(theme): check comments, notes, and AI ghost text against Monaspace Radon.
// NOTE: JSON property names should read like attributes, not function calls.

export type ThemeMode = 'abyss' | 'night' | 'nocturne' | 'night-old' | 'dawn';

export interface ThemeToken {
  readonly scope: string;
  foreground: `#${string}`;
  fontStyle?: 'bold' | 'italic' | 'strikethrough';
}

export enum DiagnosticSeverity {
  Hint = 'hint',
  Info = 'info',
  Warning = 'warning',
  Error = 'error',
}

const ANSI_SAMPLE = {
  black: '#2A2433',
  red: '#B63A3A',
  green: '#2B7A4F',
  yellow: '#8A5D00',
  blue: '#235EAA',
  magenta: '#6F35B8',
  cyan: '#1B7885',
  white: '#FCFAFF',
} as const;

const zedSettingsPreview = {
  theme: {
    mode: 'light',
    light: 'Tyrian Dawn',
    dark: 'Tyrian Night',
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

const markdownPreview = String.raw`
# Tyrian Night

> quoted prose should stay readable and calm

**bold foreground** and _italic Radon voice_ with \`inline code\`.

- added line
- removed line
- changed line
`;

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

  #cache = new Map<ThemeMode, ThemeToken[]>();

  constructor(private readonly root = process.cwd()) {}

  async readThemeManifest(mode: ThemeMode): Promise<ReadonlyArray<ThemeToken>> {
    const sourceFile = path.join(this.root, 'source', 'themes', `tyrian-${mode}.json`);
    const payload = await fs.readFile(sourceFile, 'utf8');
    const theme = JSON.parse(payload) as { name: string; tokenColors: ThemeToken[] };

    if (!theme.name.includes('Tyrian')) {
      throw new Error(`Unexpected theme name: ${theme.name}`);
    }

    this.#cache.set(mode, theme.tokenColors);
    return theme.tokenColors;
  }

  summarize(mode = ThemePreviewController.defaultMode): string {
    const tokens = this.#cache.get(mode) ?? [];
    const importantScopes = tokens
      .filter(({ scope }) => /comment|function|keyword|string|invalid|markup/u.test(scope))
      .map(({ scope, foreground }) => `${scope.padEnd(32)} ${foreground}`)
      .join('\n');

    return [
      `mode=${mode}`,
      `ansi=${Object.values(ANSI_SAMPLE).join(' ')}`,
      `settings=${JSON.stringify(zedSettingsPreview, null, 2)}`,
      markdownPreview,
      importantScopes || 'No cached scopes yet.',
    ].join('\n\n');
  }
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

void renderPreview('night').catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error({
    severity: DiagnosticSeverity.Error,
    message,
    retry: true,
  });
});
