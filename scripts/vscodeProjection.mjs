// @ts-check

import fs from 'node:fs';
import path from 'node:path';

import { loadThemeDefinitionContext } from './themeDefinition.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

/**
 * @typedef {{
 *   schemaVersion: 6;
 *   contrastPairs: Array<{ background: string; backdrop?: string; foreground: string; minimum: number }>;
 *   brackets: Record<string, string[]>;
 *   ui: Record<string, string[]>;
 *   syntax: Record<string, string[]>;
 *   terminal: Record<string, string[]>;
 *   vscode: Record<string, string[]>;
 *   tokenColors: Array<{ scope: string[]; role: string; fontStyle?: string }>;
 * }} VscodeProjection
 */

const defaultDefinitionContext = loadThemeDefinitionContext(repoRoot);

/** The checked VS Code-specific projection for the repository default root. */
export const VSCODE_PROJECTION = loadVscodeProjection(repoRoot, defaultDefinitionContext);

/**
 * Loads the VS Code consumer projection against the role authority from the same root.
 * @param {string} [root]
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} [definition]
 * @returns {Readonly<VscodeProjection>}
 */
export function loadVscodeProjection(
  root = repoRoot,
  definition = loadThemeDefinitionContext(root)
) {
  const resolvedRoot = path.resolve(root);
  if (definition.root !== resolvedRoot) {
    throw new Error('Theme definition and VS Code projection roots must match.');
  }

  return validateVscodeProjection(
    JSON.parse(
      fs.readFileSync(path.join(resolvedRoot, 'scripts/projections/vscodeColors.json'), 'utf8')
    ),
    definition.requiredThemeRoles
  );
}

/**
 * @param {unknown} value
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext['requiredThemeRoles']} requiredThemeRoles
 * @returns {Readonly<VscodeProjection>}
 */
function validateVscodeProjection(value, requiredThemeRoles) {
  const projection = requirePlainObject(value, 'VS Code projection');
  requireExactFields(
    projection,
    [
      'brackets',
      'contrastPairs',
      'schemaVersion',
      'syntax',
      'terminal',
      'tokenColors',
      'ui',
      'vscode',
    ],
    'VS Code projection'
  );
  if (projection.schemaVersion !== 6) {
    throw new Error('VS Code projection must use schemaVersion 6.');
  }

  const consumerKeys = new Map();
  for (const namespace of /** @type {const} */ ([
    'brackets',
    'ui',
    'syntax',
    'terminal',
    'vscode',
  ])) {
    const mapping = requirePlainObject(projection[namespace], `VS Code ${namespace} projection`);
    const allowedRoles = new Set(requiredThemeRoles[namespace]);
    for (const [role, keysValue] of Object.entries(mapping)) {
      if (!allowedRoles.has(role)) {
        throw new Error(`VS Code projection references unknown ${namespace} role '${role}'.`);
      }
      const keys = requireUniqueStrings(
        keysValue,
        `VS Code ${namespace} projection role '${role}'`
      );
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

  if (!Array.isArray(projection.contrastPairs) || projection.contrastPairs.length === 0) {
    throw new Error('VS Code projection contrast contract must be a non-empty array.');
  }
  const contrastPairKeys = new Set();
  for (const [index, pairValue] of projection.contrastPairs.entries()) {
    const pair = requirePlainObject(pairValue, `VS Code contrast pair ${index}`);
    requireExactFields(
      pair,
      pair.backdrop === undefined
        ? ['background', 'foreground', 'minimum']
        : ['background', 'backdrop', 'foreground', 'minimum'],
      `VS Code contrast pair ${index}`
    );
    const foreground = requireNonEmptyString(
      pair.foreground,
      `VS Code contrast pair ${index} foreground`
    );
    const background = requireNonEmptyString(
      pair.background,
      `VS Code contrast pair ${index} background`
    );
    const backdrop =
      pair.backdrop === undefined
        ? undefined
        : requireNonEmptyString(pair.backdrop, `VS Code contrast pair ${index} backdrop`);
    for (const key of [foreground, background, ...(backdrop ? [backdrop] : [])]) {
      if (!consumerKeys.has(key)) {
        throw new Error(`VS Code contrast pair ${index} references unowned color '${key}'.`);
      }
    }
    if (
      typeof pair.minimum !== 'number' ||
      !Number.isFinite(pair.minimum) ||
      pair.minimum < 1 ||
      pair.minimum > 21
    ) {
      throw new Error(`VS Code contrast pair ${index} has an invalid minimum.`);
    }
    const pairKey = `${foreground}\u0000${background}\u0000${backdrop ?? ''}`;
    if (contrastPairKeys.has(pairKey)) {
      throw new Error(`VS Code contrast pair ${index} duplicates an earlier pair.`);
    }
    contrastPairKeys.add(pairKey);
  }

  if (!Array.isArray(projection.tokenColors) || projection.tokenColors.length === 0) {
    throw new Error('VS Code grammar projection must be a non-empty array.');
  }
  const grammarScopes = new Map();
  for (const [index, tokenValue] of projection.tokenColors.entries()) {
    const token = requirePlainObject(tokenValue, `VS Code grammar projection entry ${index}`);
    requireAllowedFields(
      token,
      ['fontStyle', 'role', 'scope'],
      `VS Code grammar projection entry ${index}`
    );
    if (token.role === undefined) {
      throw new Error(`VS Code grammar projection entry ${index} must define a role.`);
    }
    const scopes = requireUniqueStrings(
      token.scope,
      `VS Code grammar projection entry ${index} scope`
    );
    for (const scope of scopes) {
      const previousOwner = grammarScopes.get(scope);
      if (previousOwner !== undefined) {
        throw new Error(
          `VS Code grammar scope '${scope}' has multiple owners: entries ${previousOwner} and ${index}.`
        );
      }
      grammarScopes.set(scope, index);
    }
    if (token.fontStyle !== undefined) {
      validateFontStyle(token.fontStyle, `VS Code grammar projection entry ${index}`);
    }
    validateGrammarRole(token.role, requiredThemeRoles);
  }

  return deepFreeze(/** @type {VscodeProjection} */ (projection));
}

/**
 * @param {unknown} value
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext['requiredThemeRoles']} requiredThemeRoles
 */
function validateGrammarRole(value, requiredThemeRoles) {
  const qualifiedRole = requireNonEmptyString(value, 'VS Code grammar projection role');
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

/** @param {unknown} value @param {string} owner */
function validateFontStyle(value, owner) {
  const fontStyle = requireNonEmptyString(value, `${owner} fontStyle`);
  const styles = fontStyle.split(/\s+/u);
  const allowedStyles = new Set(['bold', 'italic', 'strikethrough', 'underline']);
  if (new Set(styles).size !== styles.length || styles.some((style) => !allowedStyles.has(style))) {
    throw new Error(`${owner} has an invalid fontStyle '${fontStyle}'.`);
  }
}

/** @param {unknown} value @param {string} owner @returns {Record<string, unknown>} */
function requirePlainObject(value, owner) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${owner} must be an object.`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {Record<string, unknown>} value @param {readonly string[]} fields @param {string} owner */
function requireExactFields(value, fields, owner) {
  const actual = Object.keys(value).toSorted();
  const expected = fields.toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${owner} has unsupported or missing fields.`);
  }
}

/** @param {Record<string, unknown>} value @param {readonly string[]} fields @param {string} owner */
function requireAllowedFields(value, fields, owner) {
  const allowed = new Set(fields);
  const unsupported = Object.keys(value).filter((field) => !allowed.has(field));
  if (unsupported.length > 0) {
    throw new Error(`${owner} has unsupported fields: ${unsupported.join(', ')}.`);
  }
}

/** @param {unknown} value @param {string} owner @returns {string} */
function requireNonEmptyString(value, owner) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`${owner} must be a non-empty string.`);
  }
  return value;
}

/** @param {unknown} value @param {string} owner @param {boolean} [allowEmpty] @returns {string[]} */
function requireUniqueStrings(value, owner, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${owner} must be a ${allowEmpty ? '' : 'non-empty '}string array.`);
  }
  const strings = value.map((entry) => requireNonEmptyString(entry, owner));
  if (new Set(strings).size !== strings.length) {
    throw new Error(`${owner} contains duplicate values.`);
  }
  return strings;
}

/** @template T @param {T} value @returns {Readonly<T>} */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}
