// @ts-check

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncGeneratedAssets } from './generatedAssets.mjs';
import { loadThemeRepository, readSourceTheme } from './themeSources.mjs';
import {
  loadVscodeProjectionContext,
  syntaxColor,
  terminalColor,
  uiColor,
  vscodeColor,
} from './themeDefinition.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {import('./themeDefinition.mjs').ThemeDefinition} theme
 * @param {import('./themeDefinition.mjs').VscodeProjection} projection
 */
export function buildVscodeTheme(theme, projection) {
  /** @type {Record<string, string>} */
  const colors = {};
  projectColors(colors, projection.ui, (role) => uiColor(theme, role));
  projectColors(colors, projection.syntax, (role) => syntaxColor(theme, role));
  projectColors(colors, projection.terminal, (role) => terminalColor(theme, role));
  projectColors(colors, projection.vscode, (role) => vscodeColor(theme, role));

  const semanticTokenColors = Object.fromEntries(
    Object.entries(projection.semanticTokenColors).map(([selector, settings]) => [
      selector,
      {
        ...(settings.role ? { foreground: syntaxColor(theme, settings.role) } : {}),
        ...(settings.bold ? { bold: true } : {}),
        ...(settings.fontStyle ? { fontStyle: settings.fontStyle } : {}),
      },
    ])
  );
  const tokenColors = projection.tokenColors.map((token) => ({
    scope: token.scope,
    settings: {
      foreground: token.role.startsWith('ui:')
        ? uiColor(theme, token.role.slice(3))
        : syntaxColor(theme, token.role),
      ...(token.fontStyle ? { fontStyle: token.fontStyle } : {}),
    },
  }));

  return {
    name: theme.name,
    type: theme.appearance,
    semanticHighlighting: true,
    colors,
    semanticTokenColors,
    tokenColors,
  };
}

export function collectVscodeThemeAssets(root = repoRoot) {
  const repository = loadThemeRepository(root);
  const projection = loadVscodeProjectionContext(root, repository.definition).vscodeProjection;

  return repository.sources.map((source) => ({
    path: source.vscodeThemePath,
    content: `${JSON.stringify(
      buildVscodeTheme(readSourceTheme(source, root, repository.definition), projection),
      null,
      2
    )}\n`,
  }));
}

/**
 * @param {Record<string, string>} target
 * @param {Record<string, string[]>} projection
 * @param {(role: string) => string} resolve
 */
function projectColors(target, projection, resolve) {
  for (const [role, keys] of Object.entries(projection)) {
    const color = resolve(role);
    for (const key of keys) {
      if (Object.hasOwn(target, key))
        throw new Error(`VS Code color '${key}' has multiple owners.`);
      target[key] = color;
    }
  }
}

const args = new Set(process.argv.slice(2));
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const stale = syncGeneratedAssets(collectVscodeThemeAssets(repoRoot), repoRoot, {
    check: args.has('--check'),
    ownership: [{ directory: 'apps/vscode/themes', match: /\.json$/u }],
  });
  if (stale.length > 0) {
    throw new Error(`Generated VS Code themes are stale:\n${stale.join('\n')}`);
  }
}
