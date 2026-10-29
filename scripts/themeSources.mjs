// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import {
  apcaContrast,
  contrastRatio,
  gamutRelativeRichness,
  hexToOklch,
  hueDistance,
} from './colorScience.mjs';
import {
  CANVAS_ROLE,
  loadThemeDefinitionContext,
  resolveThemeRecipe,
  themeColor,
  themeFamilyClassification,
  validateThemeRecipe,
} from './themeDefinition.mjs';
import { auditThemePigmentPolicy, readThemePigmentPolicy } from './themePigmentPolicy.mjs';
import { auditThemeSafety, readThemeSafetyContract } from './themeSafety.mjs';
import { loadSourceModule } from './sourceModule.mjs';
import { SATURATION_MEASURES, syntaxChromaCeilings } from './syntaxSolver.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

/**
 * @typedef {import('./themeDefinition.mjs').ThemeAppearance} ThemeAppearance
 * @typedef {{ slug: string; terminalDefault?: boolean; islandEffects: string }} ThemeCatalogEntry
 * @typedef {{ appearance: ThemeAppearance; isDefault: boolean }} ThemeClassification
 * @typedef {import('./themeDefinition.mjs').ThemeDefinition} ThemeDefinition
 * @typedef {import('./themeDefinition.mjs').ThemeRecipe} ThemeRecipe
 * @typedef {{
 *   appearance: ThemeAppearance;
 *   isDefault: boolean;
 *   isTerminalDefault: boolean;
 *   islandCssFile: string;
 *   islandEffects: string;
 *   label: string;
 *   paletteName: string;
 *   slug: string;
 *   vscodeUiTheme: 'vs' | 'vs-dark';
 * }} ThemeSource
 * @typedef {{
 *   definition: import('./themeDefinition.mjs').ThemeDefinitionContext;
 *   recipes: ReadonlyMap<string, ThemeRecipe>;
 *   root: string;
 *   sources: ReadonlyArray<ThemeSource>;
 *   themes: ReadonlyMap<string, ThemeDefinition>;
 * }} ThemeSnapshot
 * @typedef {ThemeSnapshot & { policy: 'admitted' }} ThemeRepository
 *   Palettes that satisfy hard safety and pigment policy; the only input generators accept.
 * @typedef {ThemeSnapshot & { policy: 'inspection' }} ThemeInspectionRepository
 *   Structurally valid palettes whose policy violations are reported, not rejected.
 * @typedef {{
 *   slug: string;
 *   safety: ReturnType<typeof auditThemeSafety>;
 *   pigment: ReturnType<typeof auditThemePigmentPolicy>;
 * }} ThemePolicyAudit
 */

/**
 * Loads the palettes admitted for generation. Throws on any hard policy violation.
 * @param {string} [root]
 * @returns {ThemeRepository}
 */
export function loadThemeRepository(root = repoRoot) {
  const snapshot = loadThemeSnapshot(root);
  for (const audit of auditThemeSnapshot(snapshot)) {
    if (audit.safety.length > 0) {
      throw new Error(
        `Theme '${audit.slug}' violates theme safety policy: ${JSON.stringify(audit.safety)}.`
      );
    }
    if (audit.pigment.length > 0) {
      throw new Error(
        `Theme '${audit.slug}' violates theme pigment policy: ${JSON.stringify(audit.pigment)}.`
      );
    }
  }
  return { ...snapshot, policy: 'admitted' };
}

/**
 * Loads structurally valid palettes without rejecting policy violations, so the
 * color audit can describe them.
 * @param {string} [root]
 * @returns {ThemeInspectionRepository}
 */
export function loadThemeInspectionRepository(root = repoRoot) {
  return { ...loadThemeSnapshot(root), policy: 'inspection' };
}

/**
 * The one hard-policy evaluation shared by production admission and the color audit.
 * @param {ThemeSnapshot} snapshot
 * @returns {ThemePolicyAudit[]}
 */
export function auditThemeSnapshot(snapshot) {
  const safetyContract = readThemeSafetyContract(snapshot.definition);
  const pigmentPolicy = readThemePigmentPolicy(snapshot.definition);
  return snapshot.sources.map(({ slug }) => {
    const theme = requireTheme(snapshot, slug);
    return {
      slug,
      safety: auditThemeSafety(theme, safetyContract),
      pigment: auditThemePigmentPolicy(theme, pigmentPolicy),
    };
  });
}

/**
 * @param {string} root
 * @returns {ReadonlyArray<ThemeSource>}
 */
export function readThemeSources(root) {
  return loadThemeRepository(root).sources;
}

/**
 * @param {ThemeSource} source
 * @param {ThemeRepository} repository
 * @returns {ThemeDefinition}
 */
export function readSourceTheme(source, repository) {
  return requireTheme(repository, source.slug);
}

/**
 * @param {ThemeSnapshot} snapshot
 * @param {string} slug
 * @returns {ThemeDefinition}
 */
function requireTheme(snapshot, slug) {
  const theme = snapshot.themes.get(slug);
  if (!theme) throw new Error(`Theme '${slug}' is not part of this repository.`);
  return theme;
}

/**
 * @param {string} root
 * @returns {ThemeSnapshot}
 */
function loadThemeSnapshot(root) {
  const resolvedRoot = path.resolve(root);
  const definition = loadThemeDefinitionContext(resolvedRoot);
  const themesDirectory = path.join(resolvedRoot, 'source/themes');
  /** @type {Map<string, ThemeDefinition>} */
  const themes = new Map();
  /** @type {Map<string, ThemeRecipe>} */
  const recipes = new Map();
  const sources = normalizeThemeCatalog(
    /** @type {ThemeCatalogEntry[]} */ (
      loadSourceModule(path.join(resolvedRoot, 'source/themeCatalog.cjs'))
    ),
    (slug) => {
      const sourcePath = path.join(themesDirectory, `${slug}.cjs`);
      const recipe = validateThemeRecipe(
        /** @type {ThemeRecipe} */ (loadSourceModule(sourcePath)),
        slug,
        definition
      );
      recipes.set(slug, recipe);
      themes.set(slug, resolveThemeRecipe(recipe, slug, definition));
      return recipe.name;
    },
    (slug) => themeFamilyClassification(definition, slug)
  );
  const expectedFiles = new Set(sources.map(({ slug }) => `${slug}.cjs`));
  const orphanFiles = fs
    .readdirSync(themesDirectory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith('.cjs') && !expectedFiles.has(entry.name))
    .map(({ name }) => name)
    .toSorted();

  if (orphanFiles.length > 0) {
    throw new Error(`Source theme files are absent from the catalog: ${orphanFiles.join(', ')}.`);
  }

  validateThemeFamilyRelationships(sources, themes, definition);
  return { definition, recipes, root: resolvedRoot, sources, themes };
}

/**
 * Validates the editable catalog. Names come from validated recipes and
 * classifications from the family contract.
 * @param {ReadonlyArray<ThemeCatalogEntry>} catalog
 * @param {(slug: string) => string} readThemeName
 * @param {(slug: string) => ThemeClassification} readThemeClassification
 * @returns {ThemeSource[]}
 */
export function normalizeThemeCatalog(catalog, readThemeName, readThemeClassification) {
  if (catalog.length === 0) {
    throw new Error('Theme catalog must not be empty.');
  }

  const labels = new Set();
  const slugs = new Set();
  const themes = catalog.map((entry, index) => {
    const { slug } = entry;
    if (!/^tyrian-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
      throw new Error(`Theme catalog entry ${index} has an invalid slug '${slug}'.`);
    }
    if (slugs.has(slug)) {
      throw new Error(`Theme catalog slug '${slug}' is duplicated.`);
    }

    const label = readThemeName(slug);
    if (labels.has(label)) {
      throw new Error(`Theme source name '${label}' is duplicated.`);
    }
    const { appearance, isDefault } = readThemeClassification(slug);

    labels.add(label);
    slugs.add(slug);

    return {
      appearance,
      isDefault,
      isTerminalDefault: entry.terminalDefault === true,
      islandCssFile: `${slug}.css`,
      islandEffects: entry.islandEffects,
      label,
      paletteName: slug.replaceAll('-', '_'),
      slug,
      vscodeUiTheme: /** @type {'vs' | 'vs-dark'} */ (appearance === 'light' ? 'vs' : 'vs-dark'),
    };
  });

  getDefaultThemeSource(themes);
  getTerminalDefaultThemeSource('dark', themes);
  getTerminalDefaultThemeSource('light', themes);
  return themes;
}

/**
 * @param {ReadonlyArray<ThemeSource>} sourceThemes
 * @returns {ThemeSource}
 */
export function getDefaultThemeSource(sourceThemes) {
  return requireSingleThemeRole(
    sourceThemes.filter((theme) => theme.isDefault),
    'default source theme'
  );
}

/**
 * @param {ThemeAppearance} appearance
 * @param {ReadonlyArray<ThemeSource>} sourceThemes
 * @returns {ThemeSource}
 */
export function getTerminalDefaultThemeSource(appearance, sourceThemes) {
  return requireSingleThemeRole(
    sourceThemes.filter((theme) => theme.appearance === appearance && theme.isTerminalDefault),
    `${appearance} terminal default source theme`
  );
}

/**
 * @param {ThemeSource[]} themes
 * @param {string} role
 * @returns {ThemeSource}
 */
function requireSingleThemeRole(themes, role) {
  const [theme, ...extra] = themes;
  if (!theme || extra.length > 0) {
    throw new Error(`Expected exactly one ${role}, found ${themes.length}.`);
  }

  return theme;
}

/**
 * Repository-bound validation for relationships no individual recipe can own.
 * @param {ThemeSource[]} sources
 * @param {ReadonlyMap<string, ThemeDefinition>} themes
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} definition
 */
function validateThemeFamilyRelationships(sources, themes, definition) {
  const family = definition.familyContract;
  const classifiedSlugs = [
    ...Object.keys(family.energyLine.variants),
    ...Object.keys(family.branches),
  ].toSorted();
  const catalogSlugs = sources.map(({ slug }) => slug).toSorted();
  if (JSON.stringify(classifiedSlugs) !== JSON.stringify(catalogSlugs)) {
    throw new Error('Theme family classifications must exactly match the theme catalog.');
  }

  const hierarchy = family.syntaxHierarchy;
  for (const { slug } of sources) {
    const theme = /** @type {ThemeDefinition} */ (themes.get(slug));
    const canvas = themeColor(theme, CANVAS_ROLE);
    /** @param {readonly string[]} pigments */
    const contrasts = (pigments) =>
      pigments.map((pigment) => apcaContrast(themeColor(theme, pigment), canvas));
    /** @param {string} pigment */
    const chroma = (pigment) => hexToOklch(themeColor(theme, pigment)).C;
    // The syntax solver keeps every capped pigment under its ceiling; the band
    // floor below is measured relative to that ceiling.
    const chromaCeilings = syntaxChromaCeilings(hierarchy, chroma);
    for (const [index, upper] of hierarchy.slice(0, -1).entries()) {
      const lower = hierarchy[index + 1];
      requireMetricRange(
        Math.min(...contrasts(upper.pigments)) - Math.max(...contrasts(lower.pigments)),
        {
          minimum: /** @type {number} */ (upper.minimumStepOverNext),
          maximum: Number.POSITIVE_INFINITY,
        },
        `Theme '${slug}' syntax tier '${upper.tier}' over '${lower.tier}' Lc step`
      );
    }
    for (const pigment of family.diagnostics.pigments) {
      requireMetricRange(
        gamutRelativeRichness(themeColor(theme, pigment)),
        { minimum: family.diagnostics.minimumRichness, maximum: 1 },
        `Theme '${slug}' diagnostic '${pigment}' richness`
      );
    }
    const stage = hexToOklch(themeColor(theme, CANVAS_ROLE)).L;
    for (const surface of family.editorStage.frame) {
      if (hexToOklch(themeColor(theme, surface)).L > stage) {
        throw new Error(
          `Theme '${slug}' frame surface '${surface}' is lighter than the editor stage.`
        );
      }
    }
    const band = themeFamilyClassification(definition, slug).syntaxSaturation;
    for (const pigment of family.syntaxSaturation.pigments) {
      const value = SATURATION_MEASURES[band.measure].of(themeColor(theme, pigment));
      const pigmentChroma = chroma(pigment);
      const ceiling = chromaCeilings.get(pigment) ?? Number.POSITIVE_INFINITY;
      // Richness scales with chroma at fixed lightness and hue, so value / chroma converts.
      const ceilingInMeasure =
        band.measure === 'chroma'
          ? ceiling
          : pigmentChroma > 0
            ? (ceiling * value) / pigmentChroma
            : band.maximum;
      const effectiveMaximum = Math.min(band.maximum, ceilingInMeasure);
      requireMetricRange(
        value,
        { minimum: (effectiveMaximum * band.minimum) / band.maximum, maximum: effectiveMaximum },
        `Theme '${slug}' syntax pigment '${pigment}' ${band.measure}`
      );
    }
  }

  let previousCanvasLightness = Number.NEGATIVE_INFINITY;
  for (const slug of family.energyLine.canvasLightnessOrder) {
    const theme = /** @type {ThemeDefinition} */ (themes.get(slug));
    const canvasLightness = hexToOklch(themeColor(theme, CANVAS_ROLE)).L;
    if (canvasLightness <= previousCanvasLightness) {
      throw new Error('Theme family canvas lightness order is violated.');
    }
    previousCanvasLightness = canvasLightness;
  }

  const canonicalProfile = family.energyLine.hueProfile;
  for (const [slug, branch] of Object.entries(family.branches)) {
    for (const pigment of family.semanticPigments) {
      const hues = family.pigmentHues[pigment];
      const distance = hueDistance(
        /** @type {number} */ (hues[canonicalProfile]),
        /** @type {number} */ (hues[branch.hueProfile])
      );
      if (distance > branch.maximumSemanticHueDistance) {
        throw new Error(
          `Theme branch '${slug}' moves semantic pigment '${pigment}' outside its family hue limit.`
        );
      }
    }
  }
}

/**
 * @param {import('./themeDefinition.mjs').ThemeDefinition} theme
 * @param {readonly string[]} semanticPigments
 */
export function meanSemanticChroma(theme, semanticPigments) {
  return mean(semanticPigments.map((pigment) => hexToOklch(themeColor(theme, pigment)).C));
}

/**
 * @param {import('./themeDefinition.mjs').ThemeDefinition} theme
 * @param {readonly string[]} semanticPigments
 */
export function meanSemanticContrast(theme, semanticPigments) {
  const canvas = themeColor(theme, CANVAS_ROLE);
  return mean(semanticPigments.map((pigment) => contrastRatio(themeColor(theme, pigment), canvas)));
}

/** @param {number[]} values */
function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * @param {number} value
 * @param {{ maximum: number; minimum: number }} range
 * @param {string} owner
 */
function requireMetricRange(value, range, owner) {
  const tolerance = 1e-9;
  if (
    !Number.isFinite(value) ||
    value < range.minimum - tolerance ||
    value > range.maximum + tolerance
  ) {
    throw new Error(`${owner} ${value.toFixed(4)} is outside ${range.minimum}..${range.maximum}.`);
  }
}
