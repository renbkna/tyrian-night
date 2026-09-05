// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { oklchToHex } from './colorScience.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

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
 * }} ThemeColorBindings
 * @typedef {{ aliases: Record<string, string>; derived: Record<string, string>; schemaVersion: 2 }} ThemeColorBindingContractSource
 * @typedef {{ bindings: ThemeColorBindings['bindings']; schemaVersion: 2 }} ThemeColorBindingContract
 * @typedef {{
 *   name: string;
 *   oklch: Record<string, readonly [number, number]>;
 *   schemaVersion: 5;
 * }} OklchThemeRecipe
 * @typedef {OklchThemeRecipe} ThemeRecipe
 */
/**
 * @typedef {{ maximum: number; minimum: number }} NumericRange
 * @typedef {{
 *   semanticChromaRatio: NumericRange;
 *   semanticContrast: NumericRange;
 * }} EnergyVariantContract
 * @typedef {{
 *   hueProfile: string;
 *   kind: 'historical-reference' | 'light-counterpart' | 'soft-focus';
 *   maximumSemanticHueDistance: number;
 *   frozenPaletteSha256?: string;
 * }} ThemeBranchContract
 * @typedef {{
 *   branches: Record<string, ThemeBranchContract>;
 *   canonical: string;
 *   energyLine: {
 *     canvasLightnessOrder: string[];
 *     hueProfile: string;
 *     variants: Record<string, EnergyVariantContract>;
 *   };
 *   hueProfiles: string[];
 *   pigmentHues: Record<string, Record<string, number | null>>;
 *   schemaVersion: 2;
 *   semanticPigments: string[];
 *   syntaxBalance: {
 *     functionTypeLightnessDelta: NumericRange;
 *     keywordFunctionChromaDelta: NumericRange;
 *     keywordTypeChromaDelta: NumericRange;
 *     typeFunctionChromaDelta: NumericRange;
 *   };
 * }} ThemeFamilyContract
 */
/**
 * @typedef {{ opacities: Record<string, string>; overrides: Partial<Record<ThemeAppearance, Record<string, string>>>; schemaVersion: 2 }} ThemeOpacityContractSource
 * @typedef {Record<ThemeAppearance, Readonly<Record<string, string>>>} ThemeOpacityPolicy
 */
/** @typedef {{ appearance: ThemeAppearance; hueProfile: string; isDefault: boolean }} ThemeFamilyClassification */
/** @typedef {{ schemaVersion: 2; brackets: string[]; ui: string[]; syntax: string[]; terminal: string[]; vscode: string[] }} ThemeRoleContract */
/**
 * @typedef {{
 *   colorBindings: Readonly<ThemeColorBindings>;
 *   familyContract: Readonly<ThemeFamilyContract>;
 *   opacityPolicy: Readonly<ThemeOpacityPolicy>;
 *   root: string;
 *   requiredThemeRoles: Readonly<{ brackets: readonly string[]; ui: readonly string[]; syntax: readonly string[]; terminal: readonly string[]; vscode: readonly string[] }>;
 * }} ThemeDefinitionContext
 */
const defaultDefinitionContext = loadThemeDefinitionContext(repoRoot);

export const REQUIRED_THEME_ROLES = defaultDefinitionContext.requiredThemeRoles;

/** Canonical ANSI palette order shared by terminal-compatible projections. */
export const TERMINAL_ANSI_ROLES = Object.freeze([
  'terminal:ansi.black',
  'terminal:ansi.red',
  'terminal:ansi.green',
  'terminal:ansi.yellow',
  'terminal:ansi.blue',
  'terminal:ansi.magenta',
  'terminal:ansi.cyan',
  'terminal:ansi.white',
  'terminal:ansi.brightBlack',
  'terminal:ansi.brightRed',
  'terminal:ansi.brightGreen',
  'terminal:ansi.brightYellow',
  'terminal:ansi.brightBlue',
  'terminal:ansi.brightMagenta',
  'terminal:ansi.brightCyan',
  'terminal:ansi.brightWhite',
]);

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
  const colorBindings = deepFreeze(colorBindingContract);

  const opacityContract = validateThemeOpacityContract(
    JSON.parse(
      fs.readFileSync(path.join(resolvedRoot, 'source/themeOpacityContract.json'), 'utf8')
    ),
    colorBindings
  );
  const opacityPolicy = deepFreeze(opacityContract);
  const familyContract = deepFreeze(
    validateThemeFamilyContract(
      JSON.parse(
        fs.readFileSync(path.join(resolvedRoot, 'source/themeFamilyContract.json'), 'utf8')
      ),
      requiredPigmentsForBindings(colorBindings)
    )
  );

  return Object.freeze({
    colorBindings,
    familyContract,
    opacityPolicy,
    root: resolvedRoot,
    requiredThemeRoles,
  });
}

/**
 * Validates the editable source representation without exposing it to generators.
 * @param {unknown} value
 * @param {string} sourceName
 * @param {ThemeDefinitionContext} [context]
 * @returns {ThemeRecipe}
 */
export function validateThemeRecipe(value, sourceName, context = defaultDefinitionContext) {
  const recipe = requirePlainObject(value, `Theme recipe '${sourceName}'`);
  if (recipe.schemaVersion !== 5) {
    throw new Error(`Theme recipe '${sourceName}' must use schemaVersion 5.`);
  }
  const allowedFields = ['name', 'oklch', 'schemaVersion'];
  const unsupportedFields = Object.keys(recipe).filter((field) => !allowedFields.includes(field));
  if (unsupportedFields.length > 0) {
    throw new Error(
      `Theme recipe '${sourceName}' has unsupported fields: ${unsupportedFields.join(', ')}.`
    );
  }
  if (typeof recipe.name !== 'string' || recipe.name.trim() !== recipe.name || !recipe.name) {
    throw new Error(`Theme recipe '${sourceName}' must have a non-empty name.`);
  }
  const requiredPigments = requiredPigmentsForBindings(context.colorBindings);
  const classification = themeFamilyClassification(context, sourceName);

  requireExactFields(recipe, ['name', 'oklch', 'schemaVersion'], `Theme recipe '${sourceName}'`);
  validateOklchMap(
    recipe.oklch,
    requiredPigments,
    classification.hueProfile,
    sourceName,
    context.familyContract
  );
  return /** @type {OklchThemeRecipe} */ (/** @type {unknown} */ (recipe));
}

/**
 * Resolves the source recipe through the family binding authority.
 * @param {ThemeRecipe} recipe
 * @param {string} sourceName
 * @param {ThemeDefinitionContext} [context]
 * @returns {ThemeDefinition}
 */
export function resolveThemeRecipe(recipe, sourceName, context = defaultDefinitionContext) {
  const classification = themeFamilyClassification(context, sourceName);
  const opacities = context.opacityPolicy[classification.appearance];
  if (!opacities) {
    throw new Error(`Theme recipe '${sourceName}' has no opacity policy.`);
  }

  const resolvedPigments = Object.fromEntries(
    Object.keys(recipe.oklch).map((pigment) => [
      pigment,
      resolveOklchPigment(
        recipe,
        pigment,
        classification.hueProfile,
        sourceName,
        context.familyContract
      ),
    ])
  );

  /** @param {'brackets' | 'ui' | 'syntax' | 'terminal' | 'vscode'} namespace */
  const resolveNamespace = (namespace) =>
    Object.fromEntries(
      Object.entries(context.colorBindings.bindings[namespace]).map(([role, binding]) => {
        const pigment = typeof binding === 'string' ? binding : binding.pigment;
        const base = resolvedPigments[pigment];
        const opacity = typeof binding === 'string' ? 'FF' : opacities[binding.opacity];
        return [role, opacity === 'FF' ? base : `${base}${opacity}`];
      })
    );

  return {
    appearance: classification.appearance,
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
 * @param {string} qualifiedRole
 */
export function themePigmentOwner(context, qualifiedRole) {
  const separator = qualifiedRole.indexOf(':');
  const namespace = qualifiedRole.slice(0, separator);
  const role = qualifiedRole.slice(separator + 1);
  if (separator <= 0 || !Object.hasOwn(context.colorBindings.bindings, namespace)) {
    throw new Error(`Invalid theme role '${qualifiedRole}'.`);
  }
  const bindings = /** @type {Record<string, Record<string, ThemeColorBinding>>} */ (
    context.colorBindings.bindings
  );
  const binding = bindings[namespace][role];
  if (binding === undefined) throw new Error(`Invalid theme role '${qualifiedRole}'.`);
  return typeof binding === 'string' ? binding : binding.pigment;
}

/**
 * Returns the family-owned hue for one current pigment and hue profile.
 * @param {ThemeDefinitionContext} context
 * @param {string} hueProfile
 * @param {string} pigment
 */
export function themePigmentHue(context, hueProfile, pigment) {
  const hues = context.familyContract.pigmentHues[pigment];
  if (!hues || !Object.hasOwn(hues, hueProfile)) {
    throw new Error(`Unknown theme pigment hue '${hueProfile}:${pigment}'.`);
  }
  return hues[hueProfile];
}

/**
 * Returns the sole family-owned classification for a catalog theme slug.
 * @param {ThemeDefinitionContext} context
 * @param {string} slug
 * @returns {ThemeFamilyClassification}
 */
export function themeFamilyClassification(context, slug) {
  const family = context.familyContract;
  if (Object.hasOwn(family.energyLine.variants, slug)) {
    return {
      appearance: 'dark',
      hueProfile: family.energyLine.hueProfile,
      isDefault: slug === family.canonical,
    };
  }

  const branch = family.branches[slug];
  if (!branch) throw new Error(`Theme '${slug}' has no family classification.`);
  return {
    appearance: branch.kind === 'light-counterpart' ? 'light' : 'dark',
    hueProfile: branch.hueProfile,
    isDefault: slug === family.canonical,
  };
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
 * @param {ThemeColorBindings} bindings
 * @returns {string[]}
 */
function requiredPigmentsForBindings(bindings) {
  const requiredPigments = new Set();
  for (const namespaceBindings of Object.values(bindings.bindings)) {
    for (const binding of Object.values(namespaceBindings)) {
      requiredPigments.add(typeof binding === 'string' ? binding : binding.pigment);
    }
  }
  return [...requiredPigments].toSorted();
}

/**
 * @param {unknown} value
 * @param {readonly string[]} requiredPigments
 * @returns {ThemeFamilyContract}
 */
function validateThemeFamilyContract(value, requiredPigments) {
  const contract = requirePlainObject(value, 'Theme family contract');
  requireExactFields(
    contract,
    [
      'branches',
      'canonical',
      'energyLine',
      'hueProfiles',
      'pigmentHues',
      'schemaVersion',
      'semanticPigments',
      'syntaxBalance',
    ],
    'Theme family contract'
  );
  if (contract.schemaVersion !== 2) {
    throw new Error('Theme family contract must use schemaVersion 2.');
  }

  const canonical = requireNonEmptyString(contract.canonical, 'Theme family canonical theme');
  const semanticPigments = requireUniqueStrings(
    contract.semanticPigments,
    'Theme family semantic pigments'
  );
  const requiredPigmentSet = new Set(requiredPigments);
  for (const pigment of semanticPigments) {
    if (!requiredPigmentSet.has(pigment)) {
      throw new Error(`Theme family semantic pigment '${pigment}' is not owned by current themes.`);
    }
  }

  const syntaxBalanceValue = requirePlainObject(
    contract.syntaxBalance,
    'Theme family syntax balance'
  );
  requireExactFields(
    syntaxBalanceValue,
    [
      'functionTypeLightnessDelta',
      'keywordFunctionChromaDelta',
      'keywordTypeChromaDelta',
      'typeFunctionChromaDelta',
    ],
    'Theme family syntax balance'
  );
  const syntaxBalance = {
    functionTypeLightnessDelta: validateNumericRange(
      syntaxBalanceValue.functionTypeLightnessDelta,
      'Theme family function/type lightness delta',
      -1,
      1
    ),
    keywordFunctionChromaDelta: validateNumericRange(
      syntaxBalanceValue.keywordFunctionChromaDelta,
      'Theme family keyword/function chroma delta',
      -0.5,
      0.5
    ),
    keywordTypeChromaDelta: validateNumericRange(
      syntaxBalanceValue.keywordTypeChromaDelta,
      'Theme family keyword/type chroma delta',
      -0.5,
      0.5
    ),
    typeFunctionChromaDelta: validateNumericRange(
      syntaxBalanceValue.typeFunctionChromaDelta,
      'Theme family type/function chroma delta',
      -0.5,
      0.5
    ),
  };

  const hueProfiles = requireUniqueStrings(contract.hueProfiles, 'Theme family hue profiles');
  for (const profile of hueProfiles) {
    if (!/^[a-z][a-z0-9-]*$/u.test(profile)) {
      throw new Error(`Theme family hue profile '${profile}' has an invalid name.`);
    }
  }
  const pigmentHuesValue = requirePlainObject(contract.pigmentHues, 'Theme family pigment hues');
  const actualPigments = Object.keys(pigmentHuesValue).toSorted();
  if (JSON.stringify(actualPigments) !== JSON.stringify(requiredPigments)) {
    throw new Error('Theme family pigment hues must exactly match current theme pigments.');
  }
  /** @type {Record<string, Record<string, number | null>>} */
  const pigmentHues = {};
  const expectedHueProfiles = [...hueProfiles].toSorted();
  for (const pigment of requiredPigments) {
    const huesValue = requirePlainObject(
      pigmentHuesValue[pigment],
      `Theme family pigment '${pigment}' hue mapping`
    );
    const actualHueProfiles = Object.keys(huesValue).toSorted();
    if (JSON.stringify(actualHueProfiles) !== JSON.stringify(expectedHueProfiles)) {
      throw new Error(
        `Theme family pigment '${pigment}' hue profiles must exactly match family hue profiles.`
      );
    }
    /** @type {Record<string, number | null>} */
    const hues = {};
    for (const profile of hueProfiles) {
      const hue = huesValue[profile];
      if (
        hue !== null &&
        (typeof hue !== 'number' || !Number.isFinite(hue) || hue < 0 || hue >= 360)
      ) {
        throw new Error(`Theme family pigment '${pigment}' has an invalid '${profile}' hue.`);
      }
      if (semanticPigments.includes(pigment) && hue === null) {
        throw new Error(`Theme family semantic pigment '${pigment}' must define every hue.`);
      }
      hues[profile] = hue;
    }
    pigmentHues[pigment] = hues;
  }

  const energyLine = requirePlainObject(contract.energyLine, 'Theme family energy line');
  requireExactFields(
    energyLine,
    ['canvasLightnessOrder', 'hueProfile', 'variants'],
    'Theme family energy line'
  );
  const energyHueProfile = requireHueProfile(
    energyLine.hueProfile,
    hueProfiles,
    'Theme family energy line'
  );
  const canvasLightnessOrder = requireUniqueStrings(
    energyLine.canvasLightnessOrder,
    'Theme family canvas lightness order'
  );
  const variantsValue = requirePlainObject(energyLine.variants, 'Theme family energy variants');
  const variantNames = Object.keys(variantsValue);
  if (variantNames.length === 0 || !variantNames.includes(canonical)) {
    throw new Error('Theme family energy line must include its canonical theme.');
  }
  if (
    JSON.stringify([...variantNames].toSorted()) !==
    JSON.stringify([...canvasLightnessOrder].toSorted())
  ) {
    throw new Error('Theme family canvas lightness order must exactly match energy variants.');
  }
  /** @type {Record<string, EnergyVariantContract>} */
  const variants = {};
  for (const [slug, variantValue] of Object.entries(variantsValue)) {
    const variant = requirePlainObject(variantValue, `Theme family energy variant '${slug}'`);
    requireExactFields(
      variant,
      ['semanticChromaRatio', 'semanticContrast'],
      `Theme family energy variant '${slug}'`
    );
    variants[slug] = {
      semanticChromaRatio: validateNumericRange(
        variant.semanticChromaRatio,
        `Theme family energy variant '${slug}' chroma ratio`,
        0,
        Number.POSITIVE_INFINITY
      ),
      semanticContrast: validateNumericRange(
        variant.semanticContrast,
        `Theme family energy variant '${slug}' contrast`,
        1,
        21
      ),
    };
  }
  const branchesValue = requirePlainObject(contract.branches, 'Theme family branches');
  /** @type {Record<string, ThemeBranchContract>} */
  const branches = {};
  for (const [slug, branchValue] of Object.entries(branchesValue)) {
    const branch = requirePlainObject(branchValue, `Theme family branch '${slug}'`);
    const kind =
      branch.kind === 'soft-focus' ||
      branch.kind === 'light-counterpart' ||
      branch.kind === 'historical-reference'
        ? branch.kind
        : undefined;
    if (!kind) throw new Error(`Theme family branch '${slug}' has an invalid kind.`);
    requireExactFields(
      branch,
      kind === 'historical-reference'
        ? ['frozenPaletteSha256', 'hueProfile', 'kind', 'maximumSemanticHueDistance']
        : ['hueProfile', 'kind', 'maximumSemanticHueDistance'],
      `Theme family branch '${slug}'`
    );
    if (
      typeof branch.maximumSemanticHueDistance !== 'number' ||
      !Number.isFinite(branch.maximumSemanticHueDistance) ||
      branch.maximumSemanticHueDistance < 0 ||
      branch.maximumSemanticHueDistance > 180
    ) {
      throw new Error(`Theme family branch '${slug}' has an invalid hue-distance limit.`);
    }
    const frozenPaletteSha256 =
      kind === 'historical-reference'
        ? requireNonEmptyString(
            branch.frozenPaletteSha256,
            `Theme family branch '${slug}' frozen palette digest`
          )
        : undefined;
    if (frozenPaletteSha256 && !/^[a-f0-9]{64}$/u.test(frozenPaletteSha256)) {
      throw new Error(`Theme family branch '${slug}' has an invalid frozen palette digest.`);
    }
    branches[slug] = {
      hueProfile: requireHueProfile(
        branch.hueProfile,
        hueProfiles,
        `Theme family branch '${slug}'`
      ),
      kind,
      maximumSemanticHueDistance: branch.maximumSemanticHueDistance,
      ...(frozenPaletteSha256 ? { frozenPaletteSha256 } : {}),
    };
  }

  const classified = [...variantNames, ...Object.keys(branches)];
  if (new Set(classified).size !== classified.length) {
    throw new Error('Theme family classifications must not overlap.');
  }
  const usedHueProfiles = new Set([
    energyHueProfile,
    ...Object.values(branches).map(({ hueProfile }) => hueProfile),
  ]);
  const unusedHueProfiles = hueProfiles.filter((profile) => !usedHueProfiles.has(profile));
  if (unusedHueProfiles.length > 0) {
    throw new Error(`Theme family hue profiles are unused: ${unusedHueProfiles.join(', ')}.`);
  }

  return {
    branches,
    canonical,
    energyLine: { canvasLightnessOrder, hueProfile: energyHueProfile, variants },
    hueProfiles,
    pigmentHues,
    schemaVersion: 2,
    semanticPigments,
    syntaxBalance,
  };
}

/**
 * @param {unknown} value
 * @param {readonly string[]} requiredPigments
 * @param {string} hueProfile
 * @param {string} sourceName
 * @param {Readonly<ThemeFamilyContract>} familyContract
 */
function validateOklchMap(value, requiredPigments, hueProfile, sourceName, familyContract) {
  const values = requirePlainObject(value, `Theme recipe '${sourceName}' oklch`);
  const actual = Object.keys(values).toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(requiredPigments)) {
    const required = new Set(requiredPigments);
    const missing = requiredPigments.filter((pigment) => !Object.hasOwn(values, pigment));
    const unsupported = actual.filter((pigment) => !required.has(pigment));
    throw new Error(
      `Theme recipe '${sourceName}' has invalid oklch` +
        `${missing.length ? `; missing: ${missing.join(', ')}` : ''}` +
        `${unsupported.length ? `; unsupported: ${unsupported.join(', ')}` : ''}.`
    );
  }
  for (const pigment of requiredPigments) {
    const coordinates = values[pigment];
    if (
      !Array.isArray(coordinates) ||
      coordinates.length !== 2 ||
      coordinates.some(
        (coordinate) => typeof coordinate !== 'number' || !Number.isFinite(coordinate)
      )
    ) {
      throw new Error(`Theme recipe '${sourceName}' has invalid oklch value '${pigment}'.`);
    }
    const [lightness, chroma] = coordinates;
    if (lightness < 0 || lightness > 1 || chroma < 0 || chroma > 0.5) {
      throw new Error(`Theme recipe '${sourceName}' has invalid oklch value '${pigment}'.`);
    }
    const hue = familyContract.pigmentHues[pigment][hueProfile];
    if (hue === null && chroma > 0.000004) {
      throw new Error(
        `Theme recipe '${sourceName}' pigment '${pigment}' has chroma without an owned hue.`
      );
    }
    resolveOklchColor(lightness, chroma, hue, pigment, sourceName);
  }
}

/**
 * @param {OklchThemeRecipe} recipe
 * @param {string} pigment
 * @param {string} hueProfile
 * @param {string} sourceName
 * @param {Readonly<ThemeFamilyContract>} familyContract
 */
function resolveOklchPigment(recipe, pigment, hueProfile, sourceName, familyContract) {
  const [lightness, chroma] = recipe.oklch[pigment];
  const hue = familyContract.pigmentHues[pigment][hueProfile];
  return resolveOklchColor(lightness, chroma, hue, pigment, sourceName);
}

/**
 * @param {number} lightness
 * @param {number} chroma
 * @param {number | null} hue
 * @param {string} pigment
 * @param {string} sourceName
 */
function resolveOklchColor(lightness, chroma, hue, pigment, sourceName) {
  try {
    return oklchToHex({ C: chroma, L: lightness, h: hue ?? 0 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Theme recipe '${sourceName}' has invalid oklch value '${pigment}': ${detail}`);
  }
}

/**
 * @param {unknown} value
 * @param {readonly string[]} hueProfiles
 * @param {string} owner
 */
function requireHueProfile(value, hueProfiles, owner) {
  const profile = requireNonEmptyString(value, `${owner} hue profile`);
  if (!hueProfiles.includes(profile)) {
    throw new Error(`${owner} references unknown hue profile '${profile}'.`);
  }
  return profile;
}

/**
 * @param {unknown} value
 * @param {string} owner
 * @param {number} floor
 * @param {number} ceiling
 * @returns {NumericRange}
 */
function validateNumericRange(value, owner, floor, ceiling) {
  const range = requirePlainObject(value, owner);
  requireExactFields(range, ['maximum', 'minimum'], owner);
  if (
    typeof range.minimum !== 'number' ||
    !Number.isFinite(range.minimum) ||
    typeof range.maximum !== 'number' ||
    !Number.isFinite(range.maximum) ||
    range.minimum < floor ||
    range.maximum > ceiling ||
    range.minimum > range.maximum
  ) {
    throw new Error(`${owner} is invalid.`);
  }
  return { maximum: range.maximum, minimum: range.minimum };
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
  const contract = /** @type {Partial<ThemeRoleContract> & Record<string, unknown>} */ (
    requirePlainObject(value, 'Theme role contract')
  );
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
  const contract =
    /** @type {Partial<ThemeColorBindingContractSource> & Record<string, unknown>} */ (
      requirePlainObject(value, 'Theme color binding contract')
    );
  requireExactFields(
    contract,
    ['aliases', 'derived', 'schemaVersion'],
    'Theme color binding contract'
  );
  if (contract.schemaVersion !== 2) {
    throw new Error('Theme color binding contract must use schemaVersion 2.');
  }

  const namespaces = /** @type {const} */ (['brackets', 'ui', 'syntax', 'terminal', 'vscode']);
  const knownRoles = new Set(
    namespaces.flatMap((namespace) =>
      requiredThemeRoles[namespace].map((role) => `${namespace}:${role}`)
    )
  );
  const aliases = requirePlainObject(contract.aliases, 'Theme color binding aliases');
  const derived = requirePlainObject(contract.derived, 'Theme color binding derived roles');
  const aliasPigments = /** @type {Record<string, string>} */ (aliases);
  const derivedPigments = /** @type {Record<string, string>} */ (derived);
  const configuredRoles = new Set();
  for (const [qualifiedRole, pigment] of Object.entries(aliasPigments)) {
    requireKnownBindingRole(qualifiedRole, knownRoles);
    requireKnownPigment(pigment, knownRoles, qualifiedRole);
    if (qualifiedRole === pigment) {
      throw new Error(`Theme color binding has redundant alias '${qualifiedRole}'.`);
    }
    configuredRoles.add(qualifiedRole);
  }
  for (const [qualifiedRole, pigment] of Object.entries(derivedPigments)) {
    requireKnownBindingRole(qualifiedRole, knownRoles);
    requireKnownPigment(pigment, knownRoles, qualifiedRole);
    if (configuredRoles.has(qualifiedRole)) {
      throw new Error(`Theme color binding configures '${qualifiedRole}' twice.`);
    }
    configuredRoles.add(qualifiedRole);
  }

  /** @type {ThemeColorBindings['bindings']} */
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

  return { bindings, schemaVersion: 2 };
}

/**
 * @param {unknown} value
 * @param {ThemeColorBindings} colorBindings
 * @returns {ThemeOpacityPolicy}
 */
function validateThemeOpacityContract(value, colorBindings) {
  const contract = /** @type {Partial<ThemeOpacityContractSource> & Record<string, unknown>} */ (
    requirePlainObject(value, 'Theme opacity contract')
  );
  requireExactFields(
    contract,
    ['opacities', 'overrides', 'schemaVersion'],
    'Theme opacity contract'
  );
  if (contract.schemaVersion !== 2) {
    throw new Error('Theme opacity contract must use schemaVersion 2.');
  }
  const requiredOpacities = Object.values(colorBindings.bindings)
    .flatMap((bindings) => Object.values(bindings))
    .filter((binding) => typeof binding === 'object')
    .map((binding) => binding.opacity)
    .toSorted();
  const opacities = validateOpacityMap(
    contract.opacities,
    requiredOpacities,
    'Theme opacity opacities',
    true
  );
  const overrides = requirePlainObject(contract.overrides, 'Theme opacity overrides');
  const unsupportedAppearances = Object.keys(overrides).filter(
    (appearance) => appearance !== 'dark' && appearance !== 'light'
  );
  if (unsupportedAppearances.length > 0) {
    throw new Error(
      `Theme opacity has unsupported appearance overrides: ${unsupportedAppearances.join(', ')}.`
    );
  }
  const requiredSet = new Set(requiredOpacities);
  /** @type {ThemeOpacityPolicy} */
  const expanded = /** @type {any} */ ({});
  for (const appearance of /** @type {const} */ (['dark', 'light'])) {
    const appearanceOverrides = validateOpacityMap(
      overrides[appearance] ?? {},
      requiredOpacities,
      `Theme opacity ${appearance} overrides`,
      false
    );
    const unknown = Object.keys(appearanceOverrides).filter((role) => !requiredSet.has(role));
    if (unknown.length > 0) {
      throw new Error(
        `Theme opacity ${appearance} overrides unknown roles: ${unknown.join(', ')}.`
      );
    }
    expanded[appearance] = { ...opacities, ...appearanceOverrides };
  }

  return expanded;
}

/**
 * @param {unknown} value
 * @param {readonly string[]} requiredKeys
 * @param {string} owner
 * @param {boolean} exact
 * @returns {Record<string, string>}
 */
function validateOpacityMap(value, requiredKeys, owner, exact) {
  const values = requirePlainObject(value, owner);
  const actual = Object.keys(values).toSorted();
  const expected = [...new Set(requiredKeys)].toSorted();
  if (exact && JSON.stringify(actual) !== JSON.stringify(expected)) {
    const actualSet = new Set(actual);
    const expectedSet = new Set(expected);
    const missing = expected.filter((role) => !actualSet.has(role));
    const extra = actual.filter((role) => !expectedSet.has(role));
    throw new Error(
      `${owner} is invalid; missing: ${missing.join(', ') || 'none'}; ` +
        `extra: ${extra.join(', ') || 'none'}.`
    );
  }
  for (const [role, opacity] of Object.entries(values)) {
    if (typeof opacity !== 'string' || !/^[0-9A-F]{2}$/u.test(opacity)) {
      throw new Error(`${owner} has invalid value '${role}'.`);
    }
  }
  return /** @type {Record<string, string>} */ (values);
}

/**
 * @param {string} qualifiedRole
 * @param {Set<string>} knownRoles
 */
function requireKnownBindingRole(qualifiedRole, knownRoles) {
  if (!knownRoles.has(qualifiedRole)) {
    throw new Error(`Theme color binding configures unknown role '${qualifiedRole}'.`);
  }
}

/**
 * @param {unknown} pigment
 * @param {Set<string>} knownRoles
 * @param {string} qualifiedRole
 */
function requireKnownPigment(pigment, knownRoles, qualifiedRole) {
  if (typeof pigment !== 'string' || !knownRoles.has(pigment)) {
    throw new Error(`Theme color binding role '${qualifiedRole}' references an unknown pigment.`);
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
