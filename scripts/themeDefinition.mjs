// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @typedef {'dark' | 'light'} ThemeAppearance */
/**
 * @typedef {{
 *   appearance: ThemeAppearance;
 *   name: string;
 *   schemaVersion: 1;
 *   syntax: Record<string, string>;
 *   terminal: Record<string, string>;
 *   ui: Record<string, string>;
 *   vscode: Record<string, string>;
 * }} ThemeDefinition
 */
/**
 * @typedef {{
 *   schemaVersion: 1;
 *   ui: Record<string, string[]>;
 *   syntax: Record<string, string[]>;
 *   terminal: Record<string, string[]>;
 *   vscode: Record<string, string[]>;
 *   semanticTokenColors: Record<string, { role?: string; bold?: boolean; fontStyle?: string }>;
 *   tokenColors: Array<{ scope: string[]; role: string; fontStyle?: string }>;
 * }} VscodeProjection
 */
/** @typedef {{ schemaVersion: 1; ui: string[]; syntax: string[]; terminal: string[]; vscode: string[] }} ThemeRoleContract */
/**
 * @typedef {{
 *   root: string;
 *   requiredThemeRoles: Readonly<{ ui: readonly string[]; syntax: readonly string[]; terminal: readonly string[]; vscode: readonly string[] }>;
 * }} ThemeDefinitionContext
 */
/**
 * @typedef {{
 *   definition: ThemeDefinitionContext;
 *   root: string;
 *   vscodeProjection: Readonly<VscodeProjection>;
 * }} VscodeProjectionContext
 */

const defaultDefinitionContext = loadThemeDefinitionContext(repoRoot);
const defaultVscodeProjectionContext = loadVscodeProjectionContext(
  repoRoot,
  defaultDefinitionContext
);

export const REQUIRED_THEME_ROLES = defaultDefinitionContext.requiredThemeRoles;
export const VSCODE_PROJECTION = defaultVscodeProjectionContext.vscodeProjection;

/**
 * Loads the role-membership authority for one repository root.
 * @param {string} [root]
 * @returns {ThemeDefinitionContext}
 */
export function loadThemeDefinitionContext(root = repoRoot) {
  const resolvedRoot = path.resolve(root);
  const roleContract = validateThemeRoleContract(
    JSON.parse(fs.readFileSync(path.join(resolvedRoot, 'source/themeRoleContract.json'), 'utf8'))
  );
  const requiredThemeRoles = deepFreeze({
    ui: roleContract.ui,
    syntax: roleContract.syntax,
    terminal: roleContract.terminal,
    vscode: roleContract.vscode,
  });

  return Object.freeze({ root: resolvedRoot, requiredThemeRoles });
}

/**
 * Loads the VS Code consumer projection against the role authority from the same root.
 * @param {string} [root]
 * @param {ThemeDefinitionContext} [definition]
 * @returns {VscodeProjectionContext}
 */
export function loadVscodeProjectionContext(
  root = repoRoot,
  definition = loadThemeDefinitionContext(root)
) {
  const resolvedRoot = path.resolve(root);
  if (definition.root !== resolvedRoot) {
    throw new Error('Theme definition and VS Code projection roots must match.');
  }

  const vscodeProjection = validateVscodeProjection(
    JSON.parse(
      fs.readFileSync(path.join(resolvedRoot, 'scripts/projections/vscodeColors.json'), 'utf8')
    ),
    definition.requiredThemeRoles
  );

  return Object.freeze({ definition, root: resolvedRoot, vscodeProjection });
}

/**
 * @param {unknown} value
 * @param {string} sourceName
 * @param {ThemeDefinitionContext} [context]
 * @returns {ThemeDefinition}
 */
export function validateThemeDefinition(value, sourceName, context = defaultDefinitionContext) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Theme definition '${sourceName}' must be an object.`);
  }

  const theme = /** @type {Partial<ThemeDefinition> & Record<string, unknown>} */ (value);
  const allowedFields = new Set([
    'schemaVersion',
    'name',
    'appearance',
    'ui',
    'syntax',
    'terminal',
    'vscode',
  ]);
  const unsupportedFields = Object.keys(theme).filter((field) => !allowedFields.has(field));
  if (unsupportedFields.length > 0) {
    throw new Error(
      `Theme definition '${sourceName}' has unsupported fields: ${unsupportedFields.join(', ')}.`
    );
  }
  if (theme.schemaVersion !== 1) {
    throw new Error(`Theme definition '${sourceName}' must use schemaVersion 1.`);
  }
  if (typeof theme.name !== 'string' || theme.name.trim() !== theme.name || !theme.name) {
    throw new Error(`Theme definition '${sourceName}' must have a non-empty name.`);
  }
  if (theme.appearance !== 'dark' && theme.appearance !== 'light') {
    throw new Error(`Theme definition '${sourceName}' has an invalid appearance.`);
  }

  validateRoleSet(theme.ui, context.requiredThemeRoles.ui, sourceName, 'ui');
  validateRoleSet(theme.syntax, context.requiredThemeRoles.syntax, sourceName, 'syntax');
  validateRoleSet(theme.terminal, context.requiredThemeRoles.terminal, sourceName, 'terminal');
  validateRoleSet(theme.vscode, context.requiredThemeRoles.vscode, sourceName, 'vscode');
  return /** @type {ThemeDefinition} */ (theme);
}

/** @param {ThemeDefinition} theme @param {string} role */
export function uiColor(theme, role) {
  return requireRole(theme.ui, role, theme.name, 'ui');
}

/** @param {ThemeDefinition} theme @param {string} role */
export function syntaxColor(theme, role) {
  return requireRole(theme.syntax, role, theme.name, 'syntax');
}

/** @param {ThemeDefinition} theme @param {string} role */
export function terminalColor(theme, role) {
  return requireRole(theme.terminal, role, theme.name, 'terminal');
}

/** @param {ThemeDefinition} theme @param {string} role */
export function vscodeColor(theme, role) {
  return requireRole(theme.vscode, role, theme.name, 'vscode');
}

/**
 * Reads one stable semantic role without exposing the source representation.
 * @param {ThemeDefinition} theme
 * @param {string} qualifiedRole
 */
export function themeColor(theme, qualifiedRole) {
  const separator = qualifiedRole.indexOf(':');
  const namespace = qualifiedRole.slice(0, separator);
  const role = qualifiedRole.slice(separator + 1);
  if (separator <= 0 || !role) throw new Error(`Invalid theme role '${qualifiedRole}'.`);
  if (namespace === 'ui') return uiColor(theme, role);
  if (namespace === 'syntax') return syntaxColor(theme, role);
  if (namespace === 'terminal') return terminalColor(theme, role);
  throw new Error(`Invalid theme role namespace '${namespace}'.`);
}

/**
 * @param {unknown} value
 * @param {readonly string[]} requiredRoles
 * @param {string} sourceName
 * @param {string} namespace
 */
function validateRoleSet(value, requiredRoles, sourceName, namespace) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Theme definition '${sourceName}' must define ${namespace} roles.`);
  }
  const roles = /** @type {Record<string, unknown>} */ (value);
  const actual = Object.keys(roles).toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(requiredRoles)) {
    const required = new Set(requiredRoles);
    const missing = requiredRoles.filter((role) => !Object.hasOwn(roles, role));
    const unsupported = actual.filter((role) => !required.has(role));
    throw new Error(
      `Theme definition '${sourceName}' has invalid ${namespace} roles` +
        `${missing.length ? `; missing: ${missing.join(', ')}` : ''}` +
        `${unsupported.length ? `; unsupported: ${unsupported.join(', ')}` : ''}.`
    );
  }
  for (const [role, color] of Object.entries(roles)) {
    if (typeof color !== 'string' || !/^#[0-9A-F]{6}(?:[0-9A-F]{2})?$/u.test(color)) {
      throw new Error(`Theme definition '${sourceName}' has invalid ${namespace} color '${role}'.`);
    }
  }
}

/**
 * @param {Record<string, string>} roles
 * @param {string} role
 * @param {string} themeName
 * @param {string} namespace
 */
function requireRole(roles, role, themeName, namespace) {
  const color = roles[role];
  if (color === undefined) {
    throw new Error(`Theme '${themeName}' does not define ${namespace} role '${role}'.`);
  }
  return color;
}

/** @param {unknown} value @returns {ThemeRoleContract} */
function validateThemeRoleContract(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Theme role contract must be an object.');
  }
  const contract = /** @type {Partial<ThemeRoleContract> & Record<string, unknown>} */ (value);
  if (contract.schemaVersion !== 1)
    throw new Error('Theme role contract must use schemaVersion 1.');
  const fields = Object.keys(contract).toSorted();
  if (
    JSON.stringify(fields) !==
    JSON.stringify(['schemaVersion', 'syntax', 'terminal', 'ui', 'vscode'])
  ) {
    throw new Error('Theme role contract has unsupported or missing namespaces.');
  }

  return {
    schemaVersion: 1,
    ui: validateRoleNames(contract.ui, 'ui'),
    syntax: validateRoleNames(contract.syntax, 'syntax'),
    terminal: validateRoleNames(contract.terminal, 'terminal'),
    vscode: validateRoleNames(contract.vscode, 'vscode'),
  };
}

/** @param {unknown} value @param {string} namespace @returns {string[]} */
function validateRoleNames(value, namespace) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Theme role contract must define ${namespace} roles.`);
  }
  const roles = value.map((role) => {
    if (typeof role !== 'string' || role.length === 0 || role.trim() !== role) {
      throw new Error(`Theme role contract has an invalid ${namespace} role.`);
    }
    return role;
  });
  if (new Set(roles).size !== roles.length) {
    throw new Error(`Theme role contract has duplicate ${namespace} roles.`);
  }
  return roles.toSorted();
}

/**
 * @param {unknown} value
 * @param {ThemeDefinitionContext['requiredThemeRoles']} requiredThemeRoles
 * @returns {Readonly<VscodeProjection>}
 */
function validateVscodeProjection(value, requiredThemeRoles) {
  const projection = requirePlainObject(value, 'VS Code projection');
  requireExactFields(
    projection,
    ['schemaVersion', 'semanticTokenColors', 'syntax', 'terminal', 'tokenColors', 'ui', 'vscode'],
    'VS Code projection'
  );
  if (projection.schemaVersion !== 1) {
    throw new Error('VS Code projection must use schemaVersion 1.');
  }

  const consumerKeys = new Map();
  for (const namespace of /** @type {const} */ (['ui', 'syntax', 'terminal', 'vscode'])) {
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

  const semanticTokenColors = requirePlainObject(
    projection.semanticTokenColors,
    'VS Code semantic token projection'
  );
  for (const [selector, settingsValue] of Object.entries(semanticTokenColors)) {
    requireNonEmptyString(selector, 'VS Code semantic token selector');
    const settings = requirePlainObject(
      settingsValue,
      `VS Code semantic token selector '${selector}'`
    );
    requireAllowedFields(
      settings,
      ['bold', 'fontStyle', 'role'],
      `VS Code semantic token selector '${selector}'`
    );
    if (Object.keys(settings).length === 0) {
      throw new Error(`VS Code semantic token selector '${selector}' must define settings.`);
    }
    if (settings.bold !== undefined && typeof settings.bold !== 'boolean') {
      throw new Error(`VS Code semantic token selector '${selector}' has a non-boolean bold flag.`);
    }
    if (settings.fontStyle !== undefined) {
      validateFontStyle(settings.fontStyle, `VS Code semantic token selector '${selector}'`);
    }
    if (settings.role !== undefined) {
      const role = requireNonEmptyString(
        settings.role,
        `VS Code semantic token selector '${selector}' role`
      );
      if (!requiredThemeRoles.syntax.includes(role)) {
        throw new Error(`VS Code semantic projection references unknown syntax role '${role}'.`);
      }
    }
  }

  if (!Array.isArray(projection.tokenColors) || projection.tokenColors.length === 0) {
    throw new Error('VS Code grammar projection must be a non-empty array.');
  }
  const grammarScopes = new Map();
  for (const [index, tokenValue] of projection.tokenColors.entries()) {
    const token = requirePlainObject(tokenValue, `VS Code grammar projection entry ${index}`);
    requireExactFields(
      token,
      token.fontStyle === undefined ? ['role', 'scope'] : ['fontStyle', 'role', 'scope'],
      `VS Code grammar projection entry ${index}`
    );
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
 * @param {ThemeDefinitionContext['requiredThemeRoles']} requiredThemeRoles
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

/** @param {Record<string, unknown>} value @param {string[]} fields @param {string} owner */
function requireExactFields(value, fields, owner) {
  const actual = Object.keys(value).toSorted();
  const expected = fields.toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${owner} has unsupported or missing fields.`);
  }
}

/** @param {Record<string, unknown>} value @param {string[]} fields @param {string} owner */
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

/** @param {unknown} value @param {string} owner @returns {string[]} */
function requireUniqueStrings(value, owner) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${owner} must be a non-empty string array.`);
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
