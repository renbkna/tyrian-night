// @ts-check

import path from 'node:path';

import { loadThemeDefinitionContext } from './themeDefinition.mjs';
import { loadSourceModule } from './sourceModule.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

/**
 * @typedef {{
 *   contrastPairs: Array<{ background: string; backdrop?: string; foreground: string; minimum: number }>;
 *   brackets: Record<string, string[]>;
 *   ui: Record<string, string[]>;
 *   syntax: Record<string, string[]>;
 *   terminal: Record<string, string[]>;
 *   vscode: Record<string, string[]>;
 *   tokenColors: Array<{ scope: string[]; role: string; fontStyle?: 'bold' | 'italic' | 'strikethrough' | 'underline' }>;
 *   semanticTokenColors: Array<VscodeSemanticTokenRule>;
 * }} VscodeProjection
 * @typedef {{
 *   selector: string;
 *   role?: string;
 *   bold?: boolean;
 *   italic?: boolean;
 *   underline?: boolean;
 *   strikethrough?: boolean;
 * }} VscodeSemanticTokenRule
 */

/**
 * Loads the type-checked VS Code consumer projection from the root that owns
 * `definition` and validates what types cannot: role references, single
 * ownership of each VS Code key and grammar scope, and contrast bounds.
 *
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} [definition]
 * @returns {VscodeProjection}
 */
export function loadVscodeProjection(definition = loadThemeDefinitionContext(repoRoot)) {
  const projection = /** @type {VscodeProjection} */ (
    loadSourceModule(path.join(definition.root, 'scripts/projections/vscodeColors.cjs'))
  );
  const { requiredThemeRoles } = definition;

  /** @type {Map<string, string>} */
  const consumerKeys = new Map();
  for (const namespace of /** @type {const} */ ([
    'brackets',
    'ui',
    'syntax',
    'terminal',
    'vscode',
  ])) {
    const allowedRoles = new Set(requiredThemeRoles[namespace]);
    for (const [role, keys] of Object.entries(projection[namespace])) {
      if (!allowedRoles.has(role)) {
        throw new Error(`VS Code projection references unknown ${namespace} role '${role}'.`);
      }
      requireNames(keys, `VS Code projection ${namespace}:${role}`);
      for (const key of keys) {
        const previousOwner = consumerKeys.get(key);
        if (previousOwner) {
          throw new Error(
            `VS Code color '${key}' has multiple owners: ${previousOwner} and ${namespace}:${role}.`
          );
        }
        consumerKeys.set(key, `${namespace}:${role}`);
      }
    }
  }

  if (projection.contrastPairs.length === 0) {
    throw new Error('VS Code projection contrast contract must not be empty.');
  }
  const contrastPairKeys = new Set();
  for (const [index, pair] of projection.contrastPairs.entries()) {
    for (const key of [
      pair.foreground,
      pair.background,
      ...(pair.backdrop ? [pair.backdrop] : []),
    ]) {
      if (!consumerKeys.has(key)) {
        throw new Error(`VS Code contrast pair ${index} references unowned color '${key}'.`);
      }
    }
    if (pair.minimum < 1 || pair.minimum > 21) {
      throw new Error(`VS Code contrast pair ${index} has an invalid minimum.`);
    }
    const pairKey = `${pair.foreground}\u0000${pair.background}\u0000${pair.backdrop ?? ''}`;
    if (contrastPairKeys.has(pairKey)) {
      throw new Error(`VS Code contrast pair ${index} duplicates an earlier pair.`);
    }
    contrastPairKeys.add(pairKey);
  }

  /** @type {Map<string, number>} */
  const grammarScopes = new Map();
  if (projection.tokenColors.length === 0) {
    throw new Error('VS Code grammar projection must not be empty.');
  }
  for (const [index, token] of projection.tokenColors.entries()) {
    requireNames(token.scope, `VS Code grammar projection entry ${index} scopes`);
    for (const scope of token.scope) {
      const previousOwner = grammarScopes.get(scope);
      if (previousOwner !== undefined) {
        throw new Error(
          `VS Code grammar scope '${scope}' has multiple owners: entries ${previousOwner} and ${index}.`
        );
      }
      grammarScopes.set(scope, index);
    }
    requireGrammarRole(token.role, requiredThemeRoles);
  }

  const semanticSelectors = new Set();
  for (const [index, rule] of projection.semanticTokenColors.entries()) {
    requireNames([rule.selector], `VS Code semantic token rule ${index} selector`);
    if (semanticSelectors.has(rule.selector)) {
      throw new Error(`VS Code semantic token selector '${rule.selector}' has multiple owners.`);
    }
    semanticSelectors.add(rule.selector);
    const styled = ['bold', 'italic', 'underline', 'strikethrough'].some(
      (property) => property in rule
    );
    if (rule.role === undefined && !styled) {
      throw new Error(`VS Code semantic token selector '${rule.selector}' sets no role or style.`);
    }
    if (rule.role !== undefined) requireGrammarRole(rule.role, requiredThemeRoles);
  }

  return projection;
}

/**
 * @param {readonly string[]} names
 * @param {string} owner
 */
function requireNames(names, owner) {
  if (names.length === 0 || names.some((name) => name.length === 0 || name.trim() !== name)) {
    throw new Error(`${owner} must be a non-empty list of trimmed, non-empty names.`);
  }
}

/**
 * @param {string} qualifiedRole
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext['requiredThemeRoles']} requiredThemeRoles
 */
function requireGrammarRole(qualifiedRole, requiredThemeRoles) {
  const separator = qualifiedRole.indexOf(':');
  const namespace = separator === -1 ? 'syntax' : qualifiedRole.slice(0, separator);
  const role = separator === -1 ? qualifiedRole : qualifiedRole.slice(separator + 1);

  if (
    !role ||
    (namespace !== 'ui' && namespace !== 'syntax') ||
    !requiredThemeRoles[namespace].includes(role)
  ) {
    throw new Error(`VS Code grammar projection references unknown role '${qualifiedRole}'.`);
  }
}
