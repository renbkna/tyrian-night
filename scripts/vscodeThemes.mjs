// @ts-check

import path from 'node:path';
import { contrastRatio } from './colorScience.mjs';
import { opaqueHex } from './colorUtils.mjs';
import { syncGeneratedAssets } from './generatedAssets.mjs';
import { loadThemeRepository, readSourceTheme } from './themeSources.mjs';
import { themeColor } from './themeDefinition.mjs';
import { loadVscodeProjection } from './vscodeProjection.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

/**
 * @param {import('./themeDefinition.mjs').ThemeDefinition} theme
 * @param {import('./vscodeProjection.mjs').VscodeProjection} projection
 */
export function buildVscodeTheme(theme, projection) {
  /** @type {Record<string, string>} */
  const colors = {};
  for (const namespace of /** @type {const} */ ([
    'brackets',
    'ui',
    'syntax',
    'terminal',
    'vscode',
  ])) {
    projectColors(colors, projection[namespace], (role) =>
      themeColor(theme, `${namespace}:${role}`)
    );
  }
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
  return themeColor(theme, role.startsWith('ui:') ? role : `syntax:${role}`);
}

/**
 * @param {Record<string, string>} colors
 * @param {import('./vscodeProjection.mjs').VscodeProjection['contrastPairs']} pairs
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
  const projection = loadVscodeProjection(repository.definition);

  return repository.sources.map((source) => ({
    path: source.vscodeThemePath,
    content: `${JSON.stringify(
      buildVscodeTheme(readSourceTheme(source, repository), projection),
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

/**
 * @param {string} [root]
 * @param {{ check?: boolean }} [options]
 * @returns {string[]}
 */
export function syncVscodeThemes(root = repoRoot, options = {}) {
  return syncGeneratedAssets(collectVscodeThemeAssets(root), root, {
    check: options.check,
    ownership: [{ directory: 'apps/vscode/themes', match: /\.json$/u }],
  });
}
