// @ts-check

import path from 'node:path';
import { contrastRatio } from './colorScience.mjs';
import { opaqueHex } from './colorUtils.mjs';
import { syncGeneratedAssets } from './generatedAssets.mjs';
import { loadThemeRepository, readSourceTheme } from './themeSources.mjs';
import {
  loadVscodeProjection,
  bracketColor,
  syntaxColor,
  terminalColor,
  uiColor,
  vscodeColor,
} from './themeDefinition.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

/**
 * @param {import('./themeDefinition.mjs').ThemeDefinition} theme
 * @param {import('./themeDefinition.mjs').VscodeProjection} projection
 */
export function buildVscodeTheme(theme, projection) {
  /** @type {Record<string, string>} */
  const colors = {};
  projectColors(colors, projection.brackets, (role) => bracketColor(theme, role));
  projectColors(colors, projection.ui, (role) => uiColor(theme, role));
  projectColors(colors, projection.syntax, (role) => syntaxColor(theme, role));
  projectColors(colors, projection.terminal, (role) => terminalColor(theme, role));
  projectColors(colors, projection.vscode, (role) => vscodeColor(theme, role));
  enforceContrastContract(colors, projection.contrastPairs, theme.name);

  const tokenColors = projection.tokenColors.map((token) => ({
    scope: token.scope,
    settings: {
      foreground: grammarColor(theme, token.role),
      ...(token.fontStyle ? { fontStyle: token.fontStyle } : {}),
    },
  }));

  return {
    name: theme.name,
    type: theme.appearance,
    semanticHighlighting: false,
    colors,
    tokenColors,
  };
}

/** @param {import('./themeDefinition.mjs').ThemeDefinition} theme @param {string | undefined} role */
function grammarColor(theme, role) {
  if (!role) throw new Error('VS Code grammar projection has no role.');
  return role.startsWith('ui:') ? uiColor(theme, role.slice(3)) : syntaxColor(theme, role);
}

/**
 * @param {Record<string, string>} colors
 * @param {import('./themeDefinition.mjs').VscodeProjection['contrastPairs']} pairs
 * @param {string} themeName
 */
function enforceContrastContract(colors, pairs, themeName) {
  for (const pair of pairs) {
    const backdrop = pair.backdrop ? opaqueHex(colors[pair.backdrop]) : undefined;
    const background = opaqueHex(colors[pair.background], backdrop);
    const foreground = opaqueHex(colors[pair.foreground], background);
    const actual = contrastRatio(foreground, background);
    if (actual < pair.minimum) {
      throw new Error(
        `VS Code contrast contract failed for '${themeName}' at ` +
          `${pair.foreground}/${pair.background}: ${actual.toFixed(2)} < ${pair.minimum}.`
      );
    }
  }
}

export function collectVscodeThemeAssets(root = repoRoot) {
  const repository = loadThemeRepository(root);
  const projection = loadVscodeProjection(root, repository.definition);

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

if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  const stale = syncGeneratedAssets(collectVscodeThemeAssets(repoRoot), repoRoot, {
    check: process.argv.includes('--check'),
    ownership: [{ directory: 'apps/vscode/themes', match: /\.json$/u }],
  });
  if (stale.length > 0) {
    throw new Error(`Generated VS Code themes are stale:\n${stale.join('\n')}`);
  }
}
