// @ts-check

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { contrastRatio, hexToOklch, hueDistance } from './colorScience.mjs';
import {
  loadThemeDefinitionContext,
  resolveThemeRecipe,
  themeColor,
  themeFamilyClassification,
  validateThemeRecipe,
} from './themeDefinition.mjs';
import { auditThemePigmentPolicy, readThemePigmentPolicy } from './themePigmentPolicy.mjs';
import { auditThemeSafety, readThemeSafetyContract } from './themeSafety.mjs';
import { loadSourceModule } from './sourceModule.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');

/**
 * @typedef {'dark' | 'light'} ThemeAppearance
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
 *   islandCssPath: string;
 *   label: string;
 *   paletteName: string;
 *   slug: string;
 *   sourcePath: string;
 *   vscodeContributionPath: string;
 *   vscodeThemePath: string;
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
 * @typedef {{ slug: string; safety: unknown[]; pigment: unknown[] }} ThemePolicyAudit
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
 * @param {string} [root]
 * @returns {ReadonlyArray<ThemeSource>}
 */
export function readThemeSources(root = repoRoot) {
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
      validateFrozenThemePalette(recipe, slug, definition);
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
 * @param {ThemeRecipe} recipe
 * @param {string} slug
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} definition
 */
function validateFrozenThemePalette(recipe, slug, definition) {
  const expected = definition.familyContract.branches[slug]?.frozenPaletteSha256;
  if (!expected) return;

  const palette = Object.entries(recipe.oklch).toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  const actual = createHash('sha256').update(JSON.stringify(palette)).digest('hex');
  if (actual !== expected) {
    throw new Error(`Historical-reference theme '${slug}' palette is frozen.`);
  }
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
      islandCssPath: `apps/vscode/island/${slug}.css`,
      islandEffects: entry.islandEffects,
      label,
      paletteName: slug.replaceAll('-', '_'),
      slug,
      sourcePath: `source/themes/${slug}.cjs`,
      vscodeContributionPath: `./themes/${slug}.json`,
      vscodeThemePath: `apps/vscode/themes/${slug}.json`,
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

  for (const { slug } of sources) {
    if (family.branches[slug]?.kind === 'historical-reference') continue;
    const theme = /** @type {ThemeDefinition} */ (themes.get(slug));
    const keyword = hexToOklch(themeColor(theme, 'syntax:keyword'));
    const type = hexToOklch(themeColor(theme, 'syntax:type'));
    const method = hexToOklch(themeColor(theme, 'syntax:function'));
    const balance = family.syntaxBalance;
    requireMetricRange(
      method.L - type.L,
      balance.functionTypeLightnessDelta,
      `Theme '${slug}' function/type lightness delta`
    );
    requireMetricRange(
      keyword.C - method.C,
      balance.keywordFunctionChromaDelta,
      `Theme '${slug}' keyword/function chroma delta`
    );
    requireMetricRange(
      keyword.C - type.C,
      balance.keywordTypeChromaDelta,
      `Theme '${slug}' keyword/type chroma delta`
    );
    requireMetricRange(
      type.C - method.C,
      balance.typeFunctionChromaDelta,
      `Theme '${slug}' type/function chroma delta`
    );
  }

  const canonicalTheme = themes.get(family.canonical);
  if (!canonicalTheme) throw new Error('Theme family canonical theme is absent.');
  const canonicalChroma = meanSemanticChroma(canonicalTheme, family.semanticPigments);
  for (const [slug, variant] of Object.entries(family.energyLine.variants)) {
    const theme = /** @type {ThemeDefinition} */ (themes.get(slug));
    const chromaRatio = meanSemanticChroma(theme, family.semanticPigments) / canonicalChroma;
    requireMetricRange(
      chromaRatio,
      variant.semanticChromaRatio,
      `Energy variant '${slug}' semantic chroma ratio`
    );
    requireMetricRange(
      meanSemanticContrast(theme, family.semanticPigments),
      variant.semanticContrast,
      `Energy variant '${slug}' semantic contrast`
    );
  }

  let previousCanvasLightness = Number.NEGATIVE_INFINITY;
  for (const slug of family.energyLine.canvasLightnessOrder) {
    const theme = /** @type {ThemeDefinition} */ (themes.get(slug));
    const canvasLightness = hexToOklch(themeColor(theme, 'ui:surface.canvas')).L;
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
  const canvas = themeColor(theme, 'ui:surface.canvas');
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
