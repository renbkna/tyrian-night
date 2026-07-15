// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @typedef {'dark' | 'light'} ThemeAppearance */
/**
 * @typedef {{
 *   appearance: ThemeAppearance;
 *   brackets: Record<string, string>;
 *   name: string;
 *   schemaVersion: 2;
 *   syntax: Record<string, string>;
 *   terminal: Record<string, string>;
 *   ui: Record<string, string>;
 *   vscode: Record<string, string>;
 * }} ThemeDefinition
 */
/**
 * @typedef {{ pigment: string; opacity: string }} DerivedThemeColorBinding
 * @typedef {string | DerivedThemeColorBinding} ThemeColorBinding
 * @typedef {{
 *   bindings: Record<'brackets' | 'ui' | 'syntax' | 'terminal' | 'vscode', Record<string, ThemeColorBinding>>;
 * }} ThemeColorBindingProfile
 * @typedef {{ aliases: Record<string, string>; derived: Record<string, string> }} ThemeColorBindingProfileSource
 * @typedef {{ schemaVersion: 1; profiles: Record<string, ThemeColorBindingProfileSource> }} ThemeColorBindingContractSource
 * @typedef {{ schemaVersion: 1; profiles: Record<string, ThemeColorBindingProfile> }} ThemeColorBindingContract
 * @typedef {{
 *   appearance: ThemeAppearance;
 *   bindingProfile: string;
 *   name: string;
 *   opacities: Record<string, string>;
 *   pigments: Record<string, string>;
 *   schemaVersion: 3;
 * }} ThemeRecipe
 */
/**
 * @typedef {{
 *   schemaVersion: 3;
 *   contrastPairs: Array<{ background: string; backdrop?: string; foreground: string; minimum: number }>;
 *   brackets: Record<string, string[]>;
 *   ui: Record<string, string[]>;
 *   syntax: Record<string, string[]>;
 *   terminal: Record<string, string[]>;
 *   vscode: Record<string, string[]>;
 *   semanticTokenColors: Record<string, { role?: string; bold?: boolean; fontStyle?: string }>;
 *   tokenColors: Array<{ scope: string[]; role: string; fontStyle?: string }>;
 * }} VscodeProjection
 */
/** @typedef {{ schemaVersion: 2; brackets: string[]; ui: string[]; syntax: string[]; terminal: string[]; vscode: string[] }} ThemeRoleContract */
/**
 * @typedef {{
 *   colorBindingProfiles: Readonly<Record<string, ThemeColorBindingProfile>>;
 *   root: string;
 *   requiredThemeRoles: Readonly<{ brackets: readonly string[]; ui: readonly string[]; syntax: readonly string[]; terminal: readonly string[]; vscode: readonly string[] }>;
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
    brackets: roleContract.brackets,
    ui: roleContract.ui,
    syntax: roleContract.syntax,
    terminal: roleContract.terminal,
    vscode: roleContract.vscode,
  });

  const colorBindingContract = validateThemeColorBindingContract(
    JSON.parse(fs.readFileSync(path.join(resolvedRoot, 'source/themeColorBindings.json'), 'utf8')),
    requiredThemeRoles
  );
  const colorBindingProfiles = deepFreeze(colorBindingContract.profiles);

  return Object.freeze({ colorBindingProfiles, root: resolvedRoot, requiredThemeRoles });
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
  return resolveThemeRecipe(validateThemeRecipe(value, sourceName, context), sourceName, context);
}

/**
 * Validates the editable source representation without exposing it to generators.
 * @param {unknown} value
 * @param {string} sourceName
 * @param {ThemeDefinitionContext} [context]
 * @returns {ThemeRecipe}
 */
export function validateThemeRecipe(value, sourceName, context = defaultDefinitionContext) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Theme recipe '${sourceName}' must be an object.`);
  }

  const recipe = /** @type {Partial<ThemeRecipe> & Record<string, unknown>} */ (value);
  const allowedFields = new Set([
    'schemaVersion',
    'name',
    'appearance',
    'bindingProfile',
    'pigments',
    'opacities',
  ]);
  const unsupportedFields = Object.keys(recipe).filter((field) => !allowedFields.has(field));
  if (unsupportedFields.length > 0) {
    throw new Error(
      `Theme recipe '${sourceName}' has unsupported fields: ${unsupportedFields.join(', ')}.`
    );
  }
  if (recipe.schemaVersion !== 3) {
    throw new Error(`Theme recipe '${sourceName}' must use schemaVersion 3.`);
  }
  if (typeof recipe.name !== 'string' || recipe.name.trim() !== recipe.name || !recipe.name) {
    throw new Error(`Theme recipe '${sourceName}' must have a non-empty name.`);
  }
  if (recipe.appearance !== 'dark' && recipe.appearance !== 'light') {
    throw new Error(`Theme recipe '${sourceName}' has an invalid appearance.`);
  }
  if (
    typeof recipe.bindingProfile !== 'string' ||
    !Object.hasOwn(context.colorBindingProfiles, recipe.bindingProfile)
  ) {
    throw new Error(`Theme recipe '${sourceName}' references an unknown binding profile.`);
  }

  const profile = context.colorBindingProfiles[recipe.bindingProfile];
  const requiredPigments = new Set();
  const requiredOpacities = new Set();
  for (const bindings of Object.values(profile.bindings)) {
    for (const binding of Object.values(bindings)) {
      requiredPigments.add(typeof binding === 'string' ? binding : binding.pigment);
      if (typeof binding === 'object') requiredOpacities.add(binding.opacity);
    }
  }

  validateExactValueMap(
    recipe.pigments,
    [...requiredPigments].toSorted(),
    sourceName,
    'pigments',
    /^#[0-9A-F]{6}$/u
  );
  validateExactValueMap(
    recipe.opacities,
    [...requiredOpacities].toSorted(),
    sourceName,
    'opacities',
    /^[0-9A-F]{2}$/u
  );

  return /** @type {ThemeRecipe} */ (recipe);
}

/**
 * Resolves the source recipe through the family binding authority.
 * @param {ThemeRecipe} recipe
 * @param {string} sourceName
 * @param {ThemeDefinitionContext} [context]
 * @returns {ThemeDefinition}
 */
export function resolveThemeRecipe(recipe, sourceName, context = defaultDefinitionContext) {
  const profile = context.colorBindingProfiles[recipe.bindingProfile];
  if (!profile) {
    throw new Error(`Theme recipe '${sourceName}' references an unknown binding profile.`);
  }

  /** @param {'brackets' | 'ui' | 'syntax' | 'terminal' | 'vscode'} namespace */
  const resolveNamespace = (namespace) =>
    Object.fromEntries(
      Object.entries(profile.bindings[namespace]).map(([role, binding]) => {
        const pigment = typeof binding === 'string' ? binding : binding.pigment;
        const base = recipe.pigments[pigment];
        const opacity = typeof binding === 'string' ? 'FF' : recipe.opacities[binding.opacity];
        return [role, opacity === 'FF' ? base : `${base}${opacity}`];
      })
    );

  return {
    appearance: recipe.appearance,
    brackets: resolveNamespace('brackets'),
    name: recipe.name,
    schemaVersion: 2,
    syntax: resolveNamespace('syntax'),
    terminal: resolveNamespace('terminal'),
    ui: resolveNamespace('ui'),
    vscode: resolveNamespace('vscode'),
  };
}

/**
 * Returns the pigment slot that owns one resolved role.
 * @param {ThemeDefinitionContext} context
 * @param {string} bindingProfile
 * @param {string} qualifiedRole
 */
export function themePigmentOwner(context, bindingProfile, qualifiedRole) {
  const separator = qualifiedRole.indexOf(':');
  const namespace = qualifiedRole.slice(0, separator);
  const role = qualifiedRole.slice(separator + 1);
  const profile = context.colorBindingProfiles[bindingProfile];
  if (!profile || separator <= 0 || !Object.hasOwn(profile.bindings, namespace)) {
    throw new Error(`Invalid theme role '${qualifiedRole}'.`);
  }
  const bindings = /** @type {Record<string, Record<string, ThemeColorBinding>>} */ (
    profile.bindings
  );
  const binding = bindings[namespace][role];
  if (binding === undefined) throw new Error(`Invalid theme role '${qualifiedRole}'.`);
  return typeof binding === 'string' ? binding : binding.pigment;
}

/** @param {ThemeDefinition} theme @param {string} role */
export function bracketColor(theme, role) {
  return requireRole(theme.brackets, role, theme.name, 'brackets');
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
  if (namespace === 'brackets') return bracketColor(theme, role);
  if (namespace === 'ui') return uiColor(theme, role);
  if (namespace === 'syntax') return syntaxColor(theme, role);
  if (namespace === 'terminal') return terminalColor(theme, role);
  if (namespace === 'vscode') return vscodeColor(theme, role);
  throw new Error(`Invalid theme role namespace '${namespace}'.`);
}

/**
 * @param {unknown} value
 * @param {readonly string[]} requiredKeys
 * @param {string} sourceName
 * @param {string} owner
 * @param {RegExp} format
 */
function validateExactValueMap(value, requiredKeys, sourceName, owner, format) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Theme recipe '${sourceName}' must define ${owner}.`);
  }
  const values = /** @type {Record<string, unknown>} */ (value);
  const actual = Object.keys(values).toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(requiredKeys)) {
    const required = new Set(requiredKeys);
    const missing = requiredKeys.filter((key) => !Object.hasOwn(values, key));
    const unsupported = actual.filter((key) => !required.has(key));
    throw new Error(
      `Theme recipe '${sourceName}' has invalid ${owner}` +
        `${missing.length ? `; missing: ${missing.join(', ')}` : ''}` +
        `${unsupported.length ? `; unsupported: ${unsupported.join(', ')}` : ''}.`
    );
  }
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string' || !format.test(value)) {
      throw new Error(`Theme recipe '${sourceName}' has invalid ${owner} value '${key}'.`);
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
  if (contract.schemaVersion !== 2)
    throw new Error('Theme role contract must use schemaVersion 2.');
  const fields = Object.keys(contract).toSorted();
  if (
    JSON.stringify(fields) !==
    JSON.stringify(['brackets', 'schemaVersion', 'syntax', 'terminal', 'ui', 'vscode'])
  ) {
    throw new Error('Theme role contract has unsupported or missing namespaces.');
  }

  return {
    schemaVersion: 2,
    brackets: validateRoleNames(contract.brackets, 'brackets'),
    ui: validateRoleNames(contract.ui, 'ui'),
    syntax: validateRoleNames(contract.syntax, 'syntax'),
    terminal: validateRoleNames(contract.terminal, 'terminal'),
    vscode: validateRoleNames(contract.vscode, 'vscode'),
  };
}

/**
 * @param {unknown} value
 * @param {ThemeDefinitionContext['requiredThemeRoles']} requiredThemeRoles
 * @returns {ThemeColorBindingContract}
 */
function validateThemeColorBindingContract(value, requiredThemeRoles) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Theme color binding contract must be an object.');
  }
  const contract =
    /** @type {Partial<ThemeColorBindingContractSource> & Record<string, unknown>} */ (value);
  requireExactFields(contract, ['schemaVersion', 'profiles'], 'Theme color binding contract');
  if (contract.schemaVersion !== 1) {
    throw new Error('Theme color binding contract must use schemaVersion 1.');
  }
  const profiles = requirePlainObject(contract.profiles, 'Theme color binding profiles');
  if (Object.keys(profiles).length === 0) {
    throw new Error('Theme color binding contract must define profiles.');
  }

  const namespaces = /** @type {const} */ (['brackets', 'ui', 'syntax', 'terminal', 'vscode']);
  const knownRoles = new Set(
    namespaces.flatMap((namespace) =>
      requiredThemeRoles[namespace].map((role) => `${namespace}:${role}`)
    )
  );
  /** @type {Record<string, ThemeColorBindingProfile>} */
  const validatedProfiles = {};

  for (const [profileName, profileValue] of Object.entries(profiles)) {
    if (!/^[a-z][a-z0-9-]*$/u.test(profileName)) {
      throw new Error(`Theme color binding profile '${profileName}' has an invalid name.`);
    }
    const profile = requirePlainObject(
      profileValue,
      `Theme color binding profile '${profileName}'`
    );
    requireExactFields(
      profile,
      ['aliases', 'derived'],
      `Theme color binding profile '${profileName}'`
    );
    const aliases = requirePlainObject(
      profile.aliases,
      `Theme color binding profile '${profileName}' aliases`
    );
    const derived = requirePlainObject(
      profile.derived,
      `Theme color binding profile '${profileName}' derived roles`
    );
    const aliasPigments = /** @type {Record<string, string>} */ (aliases);
    const derivedPigments = /** @type {Record<string, string>} */ (derived);
    const configuredRoles = new Set();
    for (const [qualifiedRole, pigment] of Object.entries(aliasPigments)) {
      requireKnownBindingRole(qualifiedRole, knownRoles, profileName);
      requireKnownPigment(pigment, knownRoles, profileName, qualifiedRole);
      if (qualifiedRole === pigment) {
        throw new Error(
          `Theme color binding profile '${profileName}' has redundant alias '${qualifiedRole}'.`
        );
      }
      configuredRoles.add(qualifiedRole);
    }
    for (const [qualifiedRole, pigment] of Object.entries(derivedPigments)) {
      requireKnownBindingRole(qualifiedRole, knownRoles, profileName);
      requireKnownPigment(pigment, knownRoles, profileName, qualifiedRole);
      if (configuredRoles.has(qualifiedRole)) {
        throw new Error(
          `Theme color binding profile '${profileName}' configures '${qualifiedRole}' twice.`
        );
      }
      configuredRoles.add(qualifiedRole);
    }

    /** @type {ThemeColorBindingProfile['bindings']} */
    const bindings = /** @type {any} */ ({});
    for (const namespace of namespaces) {
      bindings[namespace] = Object.fromEntries(
        requiredThemeRoles[namespace].map((role) => {
          const qualifiedRole = `${namespace}:${role}`;
          const pigment =
            aliasPigments[qualifiedRole] ?? derivedPigments[qualifiedRole] ?? qualifiedRole;
          return [
            role,
            Object.hasOwn(derivedPigments, qualifiedRole)
              ? { opacity: qualifiedRole, pigment }
              : pigment,
          ];
        })
      );
    }
    validatedProfiles[profileName] = { bindings };
  }

  return { schemaVersion: 1, profiles: validatedProfiles };
}

/**
 * @param {string} qualifiedRole
 * @param {Set<string>} knownRoles
 * @param {string} profileName
 */
function requireKnownBindingRole(qualifiedRole, knownRoles, profileName) {
  if (!knownRoles.has(qualifiedRole)) {
    throw new Error(
      `Theme color binding profile '${profileName}' configures unknown role '${qualifiedRole}'.`
    );
  }
}

/**
 * @param {unknown} pigment
 * @param {Set<string>} knownRoles
 * @param {string} profileName
 * @param {string} qualifiedRole
 */
function requireKnownPigment(pigment, knownRoles, profileName, qualifiedRole) {
  if (typeof pigment !== 'string' || !knownRoles.has(pigment)) {
    throw new Error(
      `Theme color binding profile '${profileName}' role '${qualifiedRole}' references an unknown pigment.`
    );
  }
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
    [
      'brackets',
      'contrastPairs',
      'schemaVersion',
      'semanticTokenColors',
      'syntax',
      'terminal',
      'tokenColors',
      'ui',
      'vscode',
    ],
    'VS Code projection'
  );
  if (projection.schemaVersion !== 3) {
    throw new Error('VS Code projection must use schemaVersion 3.');
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
