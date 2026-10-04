// @ts-check

import path from 'node:path';
import { oklchToHex } from './colorScience.mjs';
import { loadSourceModule } from './sourceModule.mjs';
import { PLAIN_TARGET, solveSyntaxPigments } from './syntaxSolver.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

/** @typedef {'dark' | 'light'} ThemeAppearance */
/**
 * @typedef {{
 *   appearance: ThemeAppearance;
 *   brackets: Record<string, string>;
 *   name: string;
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
 * @typedef {{ aliases: Record<string, string>; derived: Record<string, string> }} ThemeColorBindingContractSource
 * A recipe authors every pigment except syntax and bracket colors, which the
 * syntax solver derives from `syntax` targets.
 * @typedef {{
 *   name: string;
 *   oklch: Record<string, readonly [number, number]>;
 *   syntax: import('./syntaxSolver.mjs').SyntaxTargets;
 * }} OklchThemeRecipe
 * @typedef {OklchThemeRecipe} ThemeRecipe
 */
/**
 * @typedef {{ maximum: number; minimum: number }} NumericRange
 * A theme's syntax saturation band. `richness` is the share of the sRGB chroma
 * available at each pigment's own lightness and hue, so every hue is equally
 * vivid for what it can reach; `chroma` is absolute OKLCH chroma, so every hue
 * is equally colorful (soft tints, where gamut room differs widely by hue).
 * @typedef {NumericRange & { measure: 'chroma' | 'richness' }} SaturationBand
 * @typedef {{ syntaxSaturation: SaturationBand }} EnergyVariantContract
 * Every colored syntax pigment of a maintained theme sits in the band's relative
 * width below its effective maximum: the band maximum, lowered to its tier's
 * colorfulness ceiling when that ceiling is smaller.
 * @typedef {{ pigments: string[] }} SyntaxSaturationContract
 * One syntax weight tier. Tiers run from most to least prominent, measured as
 * APCA lightness contrast (absolute Lc) against `ui:surface.canvas` so dark and
 * light appearances share one rule: the weakest pigment of a tier must exceed
 * the strongest pigment of the next tier by `minimumStepOverNext` Lc points.
 * Only the last tier omits it. Readability floors live in the safety contract.
 * Lightness alone does not set prominence: a vivid color reads louder than its
 * contrast. `maximumChromaShareOfLead` caps every pigment of a lower tier at
 * that share of the most colorful lead pigment's OKLCH chroma.
 * @typedef {{
 *   tier: string;
 *   pigments: string[];
 *   minimumStepOverNext?: number;
 *   maximumChromaShareOfLead?: number;
 * }} SyntaxHierarchyTier
 * Diagnostics interrupt code through saturation, not brightness: each pigment
 * must use at least `minimumRichness` of the sRGB chroma available at its own
 * lightness and hue. Their visibility floor lives in the safety contract.
 * @typedef {{ pigments: string[]; minimumRichness: number }} DiagnosticsContract
 * The editor canvas is the lit stage: no frame surface around it may have a
 * higher OKLCH lightness than `stage` in any maintained theme. Near-black
 * editors keep the frame flat with the stage; lighter ones frame it darker.
 * @typedef {{ stage: string; frame: string[] }} EditorStageContract
 * @typedef {{
 *   hueProfile: string;
 *   kind: 'light-counterpart' | 'soft-focus';
 *   maximumSemanticHueDistance: number;
 *   syntaxSaturation: SaturationBand;
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
 *   semanticPigments: string[];
 *   syntaxHierarchy: SyntaxHierarchyTier[];
 *   plainSyntaxPigment: string;
 *   syntaxSaturation: SyntaxSaturationContract;
 *   diagnostics: DiagnosticsContract;
 *   editorStage: EditorStageContract;
 * }} ThemeFamilyContract
 */
/**
 * @typedef {{ opacities: Record<string, string>; overrides: Partial<Record<ThemeAppearance, Record<string, string>>> }} ThemeOpacityContractSource
 * @typedef {Record<ThemeAppearance, Readonly<Record<string, string>>>} ThemeOpacityPolicy
 */
/** @typedef {{ appearance: ThemeAppearance; hueProfile: string; isDefault: boolean; syntaxSaturation: SaturationBand }} ThemeFamilyClassification */
/** @typedef {{ brackets: string[]; ui: string[]; syntax: string[]; terminal: string[]; vscode: string[] }} ThemeRoleContract */
/**
 * @typedef {{
 *   colorBindings: Readonly<ThemeColorBindings>;
 *   familyContract: Readonly<ThemeFamilyContract>;
 *   opacityPolicy: Readonly<ThemeOpacityPolicy>;
 *   root: string;
 *   requiredThemeRoles: Readonly<{ brackets: readonly string[]; ui: readonly string[]; syntax: readonly string[]; terminal: readonly string[]; vscode: readonly string[] }>;
 * }} ThemeDefinitionContext
 */
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
 * Loads the role-membership authority for one repository root. Contract shapes
 * are type-checked source modules; this validates their cross-file references.
 * @param {string} [root]
 * @returns {ThemeDefinitionContext}
 */
export function loadThemeDefinitionContext(root = repoRoot) {
  const resolvedRoot = path.resolve(root);
  /** @param {string} name */
  const load = (name) => loadSourceModule(path.join(resolvedRoot, 'source', `${name}.cjs`));
  const requiredThemeRoles = validateThemeRoleContract(
    /** @type {ThemeRoleContract} */ (load('themeRoleContract'))
  );
  const colorBindings = validateThemeColorBindingContract(
    /** @type {ThemeColorBindingContractSource} */ (load('themeColorBindings')),
    requiredThemeRoles
  );
  const opacityPolicy = validateThemeOpacityContract(
    /** @type {ThemeOpacityContractSource} */ (load('themeOpacityContract')),
    colorBindings
  );
  const familyContract = validateThemeFamilyContract(
    /** @type {ThemeFamilyContract} */ (load('themeFamilyContract')),
    requiredPigmentsForBindings(colorBindings)
  );

  return {
    colorBindings,
    familyContract,
    opacityPolicy,
    root: resolvedRoot,
    requiredThemeRoles,
  };
}

/**
 * Validates a type-checked recipe against the family pigment vocabulary.
 * @param {ThemeRecipe} recipe
 * @param {string} sourceName
 * @param {ThemeDefinitionContext} context
 * @returns {ThemeRecipe}
 */
export function validateThemeRecipe(recipe, sourceName, context) {
  if (recipe.name.length === 0 || recipe.name.trim() !== recipe.name) {
    throw new Error(`Theme recipe '${sourceName}' must have a trimmed, non-empty name.`);
  }
  const classification = themeFamilyClassification(context, sourceName);
  const solved = solvedSyntaxPigments(context.familyContract);
  validateOklchMap(
    recipe.oklch,
    requiredPigmentsForBindings(context.colorBindings).filter((pigment) => !solved.has(pigment)),
    classification.hueProfile,
    sourceName,
    context.familyContract
  );
  validateSyntaxTargets(recipe.syntax, classification, sourceName, context.familyContract);
  return recipe;
}

/**
 * Syntax and bracket pigments the solver derives: every hierarchy tier plus plain text.
 * @param {Readonly<ThemeFamilyContract>} familyContract
 * @returns {Set<string>}
 */
function solvedSyntaxPigments(familyContract) {
  return new Set([
    ...familyContract.syntaxHierarchy.flatMap(({ pigments }) => pigments),
    familyContract.plainSyntaxPigment,
  ]);
}

/**
 * @param {import('./syntaxSolver.mjs').SyntaxTargets} targets
 * @param {ThemeFamilyClassification} classification
 * @param {string} sourceName
 * @param {Readonly<ThemeFamilyContract>} familyContract
 */
function validateSyntaxTargets(targets, classification, sourceName, familyContract) {
  const owner = `Theme recipe '${sourceName}' syntax targets`;
  if (!targets || typeof targets !== 'object') throw new Error(`${owner} are missing.`);
  requireSameMembers(
    Object.keys(targets),
    ['chroma', 'contrast', 'saturation'],
    owner,
    'syntax target fields'
  );
  const ceiling = SATURATION_MEASURE_CEILINGS[classification.syntaxSaturation.measure];
  if (!(targets.saturation > 0 && targets.saturation <= ceiling)) {
    throw new Error(`${owner} saturation must be within 0 (exclusive) and ${ceiling}.`);
  }
  requireSameMembers(
    Object.keys(targets.contrast),
    [...familyContract.syntaxHierarchy.map(({ tier }) => tier), PLAIN_TARGET],
    `${owner} contrast`,
    'syntax tiers and plain text'
  );
  for (const [tier, target] of Object.entries(targets.contrast)) {
    if (!(Number.isFinite(target) && target > 0 && target <= 108)) {
      throw new Error(
        `${owner} contrast '${tier}' must be an APCA Lc within 0 (exclusive) and 108.`
      );
    }
  }
  const colored = new Set(familyContract.syntaxSaturation.pigments);
  const neutral = [...solvedSyntaxPigments(familyContract)].filter(
    (pigment) => !colored.has(pigment)
  );
  requireSameMembers(
    Object.keys(targets.chroma),
    neutral,
    `${owner} chroma`,
    'neutral syntax pigments'
  );
  for (const [pigment, chroma] of Object.entries(targets.chroma)) {
    if (!(chroma >= 0 && chroma <= 0.4)) {
      throw new Error(`${owner} chroma '${pigment}' must be within 0 and 0.4.`);
    }
    if (familyContract.pigmentHues[pigment]?.[classification.hueProfile] === null && chroma > 0) {
      throw new Error(`${owner} chroma '${pigment}' has chroma without an owned hue.`);
    }
  }
}

/**
 * Resolves the source recipe through the family binding authority.
 * @param {ThemeRecipe} recipe
 * @param {string} sourceName
 * @param {ThemeDefinitionContext} context
 * @returns {ThemeDefinition}
 */
export function resolveThemeRecipe(recipe, sourceName, context) {
  const classification = themeFamilyClassification(context, sourceName);
  const opacities = context.opacityPolicy[classification.appearance];
  if (!opacities) {
    throw new Error(`Theme recipe '${sourceName}' has no opacity policy.`);
  }

  const family = context.familyContract;
  /** @param {string} pigment */
  const hue = (pigment) => family.pigmentHues[pigment]?.[classification.hueProfile] ?? null;
  /** @type {Record<string, string>} */
  const resolvedPigments = Object.fromEntries(
    Object.entries(recipe.oklch).map(([pigment, [lightness, chroma]]) => [
      pigment,
      resolveOklchColor(lightness, chroma, hue(pigment), pigment, sourceName),
    ])
  );
  const solved = solveSyntaxPigments({
    appearance: classification.appearance,
    canvas: /** @type {string} */ (resolvedPigments['ui:surface.canvas']),
    coloredPigments: new Set(family.syntaxSaturation.pigments),
    hierarchy: family.syntaxHierarchy,
    hue,
    measure: classification.syntaxSaturation.measure,
    owner: `Theme recipe '${sourceName}'`,
    plainPigment: family.plainSyntaxPigment,
    targets: recipe.syntax,
  });
  for (const [pigment, [lightness, chroma]] of Object.entries(solved)) {
    resolvedPigments[pigment] = resolveOklchColor(
      lightness,
      chroma,
      hue(pigment),
      pigment,
      sourceName
    );
  }

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
    syntax: resolveNamespace('syntax'),
    terminal: resolveNamespace('terminal'),
    ui: resolveNamespace('ui'),
    vscode: resolveNamespace('vscode'),
  };
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
      syntaxSaturation: family.energyLine.variants[slug].syntaxSaturation,
    };
  }

  const branch = family.branches[slug];
  if (!branch) throw new Error(`Theme '${slug}' has no family classification.`);
  return {
    appearance: branch.kind === 'light-counterpart' ? 'light' : 'dark',
    hueProfile: branch.hueProfile,
    isDefault: slug === family.canonical,
    syntaxSaturation: branch.syntaxSaturation,
  };
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
  if (
    separator <= 0 ||
    !role ||
    !['brackets', 'ui', 'syntax', 'terminal', 'vscode'].includes(namespace)
  ) {
    throw new Error(`Invalid theme role '${qualifiedRole}'.`);
  }
  const color =
    theme[/** @type {'brackets' | 'ui' | 'syntax' | 'terminal' | 'vscode'} */ (namespace)][role];
  if (color === undefined) {
    throw new Error(`Theme '${theme.name}' does not define ${namespace} role '${role}'.`);
  }
  return color;
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
 * @param {ThemeFamilyContract} contract
 * @param {readonly string[]} requiredPigments
 * @returns {ThemeFamilyContract}
 */
function validateThemeFamilyContract(contract, requiredPigments) {
  const {
    branches,
    canonical,
    energyLine,
    hueProfiles,
    pigmentHues,
    semanticPigments,
    syntaxHierarchy,
    syntaxSaturation,
    diagnostics,
    editorStage,
  } = contract;
  requireUnique(semanticPigments, 'Theme family semantic pigments');
  const requiredPigmentSet = new Set(requiredPigments);
  for (const pigment of semanticPigments) {
    if (!requiredPigmentSet.has(pigment)) {
      throw new Error(`Theme family semantic pigment '${pigment}' is not owned by current themes.`);
    }
  }

  if (syntaxHierarchy.length < 2) {
    throw new Error('Theme family syntax hierarchy must order at least two tiers.');
  }
  requireUnique(
    syntaxHierarchy.map(({ tier }) => tier),
    'Theme family syntax hierarchy tiers'
  );
  requireUnique(
    syntaxHierarchy.flatMap(({ pigments }) => pigments),
    'Theme family syntax hierarchy'
  );
  for (const [
    index,
    { tier, pigments, minimumStepOverNext, maximumChromaShareOfLead },
  ] of syntaxHierarchy.entries()) {
    if (pigments.length === 0) {
      throw new Error(`Theme family syntax hierarchy tier '${tier}' must not be empty.`);
    }
    for (const pigment of pigments) {
      if (!/^(?:syntax|brackets):/u.test(pigment) || !requiredPigmentSet.has(pigment)) {
        throw new Error(
          `Theme family syntax hierarchy pigment '${pigment}' is not a recipe-owned syntax or bracket pigment.`
        );
      }
    }
    const last = index === syntaxHierarchy.length - 1;
    if (last !== (minimumStepOverNext === undefined)) {
      throw new Error(
        `Theme family syntax hierarchy tier '${tier}' must declare a step over the next tier exactly when one follows.`
      );
    }
    if (
      minimumStepOverNext !== undefined &&
      !(Number.isFinite(minimumStepOverNext) && minimumStepOverNext > 0)
    ) {
      throw new Error(
        `Theme family syntax hierarchy tier '${tier}' step must be a positive, finite Lc difference.`
      );
    }
    if (
      maximumChromaShareOfLead !== undefined &&
      (index === 0 || !(maximumChromaShareOfLead > 0 && maximumChromaShareOfLead <= 1))
    ) {
      throw new Error(
        `Theme family syntax hierarchy tier '${tier}' chroma share of the lead must be within 0 (exclusive) and 1, below the lead tier.`
      );
    }
  }

  const tierPigments = new Set(syntaxHierarchy.flatMap(({ pigments }) => pigments));
  if (
    !contract.plainSyntaxPigment.startsWith('syntax:') ||
    !requiredPigmentSet.has(contract.plainSyntaxPigment) ||
    tierPigments.has(contract.plainSyntaxPigment)
  ) {
    throw new Error(
      'Theme family plain syntax pigment must be a recipe-owned syntax pigment outside the hierarchy.'
    );
  }
  requireUnique(syntaxSaturation.pigments, 'Theme family syntax saturation');
  for (const pigment of syntaxSaturation.pigments) {
    if (!tierPigments.has(pigment)) {
      throw new Error(
        `Theme family syntax saturation pigment '${pigment}' is not in a syntax hierarchy tier.`
      );
    }
  }

  requireUnique(diagnostics.pigments, 'Theme family diagnostics');
  for (const pigment of diagnostics.pigments) {
    if (!requiredPigmentSet.has(pigment)) {
      throw new Error(`Theme family diagnostic pigment '${pigment}' is not recipe-owned.`);
    }
  }
  if (!(diagnostics.minimumRichness > 0 && diagnostics.minimumRichness <= 1)) {
    throw new Error(
      'Theme family diagnostics minimum richness must be within 0 (exclusive) and 1.'
    );
  }

  requireUnique(editorStage.frame, 'Theme family editor stage frame');
  for (const pigment of [editorStage.stage, ...editorStage.frame]) {
    if (!pigment.startsWith('ui:') || !requiredPigmentSet.has(pigment)) {
      throw new Error(
        `Theme family editor stage surface '${pigment}' is not a recipe-owned UI pigment.`
      );
    }
  }
  if (editorStage.frame.includes(editorStage.stage)) {
    throw new Error('Theme family editor stage must not frame itself.');
  }

  requireUnique(hueProfiles, 'Theme family hue profiles');
  for (const profile of hueProfiles) {
    if (!/^[a-z][a-z0-9-]*$/u.test(profile)) {
      throw new Error(`Theme family hue profile '${profile}' has an invalid name.`);
    }
  }
  requireSameMembers(
    Object.keys(pigmentHues),
    requiredPigments,
    'Theme family pigment hues',
    'current theme pigments'
  );
  for (const [pigment, hues] of Object.entries(pigmentHues)) {
    requireSameMembers(
      Object.keys(hues),
      hueProfiles,
      `Theme family pigment '${pigment}' hue profiles`,
      'family hue profiles'
    );
    for (const [profile, hue] of Object.entries(hues)) {
      if (hue !== null && (hue < 0 || hue >= 360)) {
        throw new Error(`Theme family pigment '${pigment}' has an invalid '${profile}' hue.`);
      }
      if (hue === null && semanticPigments.includes(pigment)) {
        throw new Error(`Theme family semantic pigment '${pigment}' must define every hue.`);
      }
    }
  }

  requireHueProfile(energyLine.hueProfile, hueProfiles, 'Theme family energy line');
  const variantNames = Object.keys(energyLine.variants);
  if (!variantNames.includes(canonical)) {
    throw new Error('Theme family energy line must include its canonical theme.');
  }
  requireUnique(energyLine.canvasLightnessOrder, 'Theme family canvas lightness order');
  requireSameMembers(
    energyLine.canvasLightnessOrder,
    variantNames,
    'Theme family canvas lightness order',
    'energy variants'
  );
  for (const [slug, variant] of Object.entries(energyLine.variants)) {
    requireSaturationBand(variant.syntaxSaturation, `Theme family energy variant '${slug}'`);
  }

  for (const [slug, branch] of Object.entries(branches)) {
    requireHueProfile(branch.hueProfile, hueProfiles, `Theme family branch '${slug}'`);
    if (branch.maximumSemanticHueDistance < 0 || branch.maximumSemanticHueDistance > 180) {
      throw new Error(`Theme family branch '${slug}' has an invalid hue-distance limit.`);
    }
    requireSaturationBand(branch.syntaxSaturation, `Theme family branch '${slug}'`);
  }

  const classified = [...variantNames, ...Object.keys(branches)];
  if (new Set(classified).size !== classified.length) {
    throw new Error('Theme family classifications must not overlap.');
  }
  const usedHueProfiles = new Set([
    energyLine.hueProfile,
    ...Object.values(branches).map(({ hueProfile }) => hueProfile),
  ]);
  const unusedHueProfiles = hueProfiles.filter((profile) => !usedHueProfiles.has(profile));
  if (unusedHueProfiles.length > 0) {
    throw new Error(`Theme family hue profiles are unused: ${unusedHueProfiles.join(', ')}.`);
  }

  return contract;
}

/**
 * @param {ThemeRecipe['oklch']} values
 * @param {readonly string[]} requiredPigments
 * @param {string} hueProfile
 * @param {string} sourceName
 * @param {Readonly<ThemeFamilyContract>} familyContract
 */
function validateOklchMap(values, requiredPigments, hueProfile, sourceName, familyContract) {
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
  for (const [pigment, [lightness, chroma]] of Object.entries(values)) {
    if (lightness < 0 || lightness > 1 || chroma < 0 || chroma > 0.5) {
      throw new Error(`Theme recipe '${sourceName}' has invalid oklch value '${pigment}'.`);
    }
    if (familyContract.pigmentHues[pigment]?.[hueProfile] === null && chroma > 0.000004) {
      throw new Error(
        `Theme recipe '${sourceName}' pigment '${pigment}' has chroma without an owned hue.`
      );
    }
  }
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
 * @param {string} profile
 * @param {readonly string[]} hueProfiles
 * @param {string} owner
 */
function requireHueProfile(profile, hueProfiles, owner) {
  if (!hueProfiles.includes(profile)) {
    throw new Error(`${owner} references unknown hue profile '${profile}'.`);
  }
}

/**
 * @param {NumericRange} range
 * @param {string} owner
 * @param {number} floor
 * @param {number} ceiling
 */
function requireRange(range, owner, floor, ceiling) {
  if (range.minimum < floor || range.maximum > ceiling || range.minimum > range.maximum) {
    throw new Error(`${owner} is invalid.`);
  }
}

/** OKLCH chroma beyond 0.4 lies outside sRGB at every lightness and hue. */
const SATURATION_MEASURE_CEILINGS = { chroma: 0.4, richness: 1 };

/** @param {SaturationBand} band @param {string} owner */
function requireSaturationBand(band, owner) {
  if (!band) throw new Error(`${owner} must define a syntax saturation band.`);
  if (!Object.hasOwn(SATURATION_MEASURE_CEILINGS, band.measure)) {
    throw new Error(`${owner} syntax saturation measure '${band.measure}' is unsupported.`);
  }
  requireRange(
    band,
    `${owner} syntax saturation band`,
    0,
    SATURATION_MEASURE_CEILINGS[band.measure]
  );
}

/** @param {readonly string[]} values @param {string} owner */
function requireUnique(values, owner) {
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error(`${owner} must be non-empty and contain no duplicate values.`);
  }
}

/**
 * @param {readonly string[]} actual
 * @param {readonly string[]} expected
 * @param {string} owner
 * @param {string} expectedLabel
 */
function requireSameMembers(actual, expected, owner, expectedLabel) {
  if (JSON.stringify(actual.toSorted()) !== JSON.stringify(expected.toSorted())) {
    throw new Error(`${owner} must exactly match ${expectedLabel}.`);
  }
}

/** @param {ThemeRoleContract} contract @returns {ThemeRoleContract} */
function validateThemeRoleContract(contract) {
  for (const [namespace, roles] of Object.entries(contract)) {
    requireUnique(roles, `Theme role contract ${namespace} roles`);
    if (roles.some((role) => role.length === 0 || role.trim() !== role)) {
      throw new Error(`Theme role contract has an invalid ${namespace} role.`);
    }
  }
  return {
    brackets: contract.brackets.toSorted(),
    ui: contract.ui.toSorted(),
    syntax: contract.syntax.toSorted(),
    terminal: contract.terminal.toSorted(),
    vscode: contract.vscode.toSorted(),
  };
}

/**
 * @param {ThemeColorBindingContractSource} contract
 * @param {ThemeDefinitionContext['requiredThemeRoles']} requiredThemeRoles
 * @returns {ThemeColorBindings}
 */
function validateThemeColorBindingContract(contract, requiredThemeRoles) {
  const namespaces = /** @type {const} */ (['brackets', 'ui', 'syntax', 'terminal', 'vscode']);
  const knownRoles = new Set(
    namespaces.flatMap((namespace) =>
      requiredThemeRoles[namespace].map((role) => `${namespace}:${role}`)
    )
  );
  const { aliases: aliasPigments, derived: derivedPigments } = contract;
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

  return { bindings };
}

/**
 * @param {ThemeOpacityContractSource} contract
 * @param {ThemeColorBindings} colorBindings
 * @returns {ThemeOpacityPolicy}
 */
function validateThemeOpacityContract(contract, colorBindings) {
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
  const { overrides } = contract;
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
 * @param {Record<string, string>} values
 * @param {readonly string[]} requiredKeys
 * @param {string} owner
 * @param {boolean} exact
 * @returns {Record<string, string>}
 */
function validateOpacityMap(values, requiredKeys, owner, exact) {
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
    if (!/^[0-9A-F]{2}$/u.test(opacity)) {
      throw new Error(`${owner} has invalid value '${role}'.`);
    }
  }
  return values;
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
 * @param {string} pigment
 * @param {Set<string>} knownRoles
 * @param {string} qualifiedRole
 */
function requireKnownPigment(pigment, knownRoles, qualifiedRole) {
  if (!knownRoles.has(pigment)) {
    throw new Error(`Theme color binding role '${qualifiedRole}' references an unknown pigment.`);
  }
}
