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

const repoRoot = path.resolve(import.meta.dirname, '..');

/**
 * @typedef {'dark' | 'light'} ThemeAppearance
 * @typedef {{
 *   slug: string;
 *   terminalDefault?: boolean;
 * }} ThemeCatalogEntry
 * @typedef {{ name: string }} ThemeIdentity
 * @typedef {{ appearance: ThemeAppearance; isDefault: boolean }} ThemeClassification
 * @typedef {{
 *   appearance: ThemeAppearance;
 *   isDefault: boolean;
 *   isTerminalDefault: boolean;
 *   islandCssFile: string;
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
 *   root: string;
 *   sources: ReadonlyArray<ThemeSource>;
 * }} ThemeRepository
 */
/**
 * @typedef {{
 *   definition: import('./themeDefinition.mjs').ThemeDefinitionContext;
 *   root: string;
 *   sources: ReadonlyArray<ThemeSource>;
 * }} ThemeInspectionRepository
 */

/** @typedef {{ mode: 'inspection' | 'production'; repository: ThemeInspectionRepository | ThemeRepository; recipe: import('./themeDefinition.mjs').ThemeRecipe; theme: import('./themeDefinition.mjs').ThemeDefinition }} ThemeSourceSnapshot */
/** @typedef {{ mode: 'inspection' | 'production'; productionAdmitted: boolean; resolvedThemes: ReadonlyMap<string, import('./themeDefinition.mjs').ThemeDefinition> }} ThemeRepositorySnapshot */

/** @type {WeakMap<object, ThemeRepositorySnapshot>} */
const repositorySnapshots = new WeakMap();
/** @type {WeakMap<object, ThemeSourceSnapshot>} */
const sourceSnapshots = new WeakMap();

const defaultInspectionRepository = loadThemeInspectionRepository(repoRoot);

/**
 * The default catalog is an immutable structural snapshot. Its palette remains
 * unavailable to production callers until it is admitted against hard policy,
 * so inspection tooling can still import this module for an invalid checkout.
 */
export const SOURCE_THEMES = defaultInspectionRepository.sources;

/**
 * Loads the immutable production snapshot for a repository root. The snapshot
 * admits only themes that satisfy structural, family, safety, and pigment policy.
 * @param {string} [root]
 * @returns {ThemeRepository}
 */
export function loadThemeRepository(root = repoRoot) {
  return /** @type {ThemeRepository} */ (loadThemeSnapshot(root, 'production'));
}

/**
 * Loads an explicit inspect-only snapshot. It preserves the same structural and
 * family validation as production, but does not reject a theme for hard rendered
 * policy so the color-audit command can describe those violations.
 * @param {string} [root]
 * @returns {ThemeInspectionRepository}
 */
export function loadThemeInspectionRepository(root = repoRoot) {
  return /** @type {ThemeInspectionRepository} */ (loadThemeSnapshot(root, 'inspection'));
}

/**
 * Establishes that a repository is the owner-issued snapshot admitted for
 * production use. Consumers that receive an injectable repository must ask
 * this boundary rather than treating matching roots as admission.
 * @param {ThemeRepository | ThemeInspectionRepository} repository
 * @returns {ThemeRepository}
 */
export function requireProductionThemeRepository(repository) {
  const snapshot = repositorySnapshots.get(repository);
  if (!snapshot?.productionAdmitted) {
    throw new Error('Theme generation requires a production-admitted repository snapshot.');
  }
  return /** @type {ThemeRepository} */ (repository);
}

/**
 * Convenience metadata read for consumers that do not need a resolved palette.
 * A consumer that needs colors must retain the repository and call readSourceTheme.
 * @param {string} [root]
 * @returns {ReadonlyArray<ThemeSource>}
 */
export function readThemeSources(root = repoRoot) {
  return loadThemeRepository(root).sources;
}

/**
 * Reads a resolved palette from the production snapshot that created its source.
 * This never re-reads an editable recipe from disk.
 * @param {ThemeSource} source
 * @param {ThemeRepository} [repository]
 * @returns {import('./themeDefinition.mjs').ThemeDefinition}
 */
export function readSourceTheme(source, repository) {
  if (repository === undefined) {
    const sourceSnapshot = sourceSnapshots.get(source);
    if (!sourceSnapshot || sourceSnapshot.repository !== defaultInspectionRepository) {
      throw new Error(
        'Theme reads outside the default catalog require an explicit repository snapshot.'
      );
    }
    promoteDefaultThemeSnapshot();
    return readProductionTheme(source, defaultInspectionRepository);
  }
  return readProductionTheme(source, repository);
}

/**
 * Admits the already-captured default snapshot. This deliberately validates
 * the same frozen definition and resolved themes that produced SOURCE_THEMES;
 * it must never reopen editable recipes and match a replacement by slug.
 */
function promoteDefaultThemeSnapshot() {
  const snapshot = repositorySnapshots.get(defaultInspectionRepository);
  if (!snapshot) throw new Error('Default theme snapshot is unavailable.');
  if (snapshot.productionAdmitted) return;

  validateProductionThemePolicy(
    defaultInspectionRepository.sources,
    snapshot.resolvedThemes,
    defaultInspectionRepository.root,
    defaultInspectionRepository.definition
  );
  snapshot.productionAdmitted = true;
}

/**
 * Reads a resolved palette from an explicit inspection snapshot.
 * @param {ThemeSource} source
 * @param {ThemeInspectionRepository} repository
 * @returns {import('./themeDefinition.mjs').ThemeDefinition}
 */
export function readInspectionTheme(source, repository) {
  return readSnapshotValue(source, repository, 'inspection', 'theme');
}

/**
 * Reads the editable recipe captured by an explicit inspection snapshot.
 * Production generation has no recipe reader.
 * @param {ThemeSource} source
 * @param {ThemeInspectionRepository} repository
 * @returns {import('./themeDefinition.mjs').ThemeRecipe}
 */
export function readInspectionThemeRecipe(source, repository) {
  return readSnapshotValue(source, repository, 'inspection', 'recipe');
}

/**
 * @param {string} root
 * @param {'inspection' | 'production'} mode
 * @returns {ThemeInspectionRepository | ThemeRepository}
 */
function loadThemeSnapshot(root, mode) {
  const resolvedRoot = path.resolve(root);
  const definition = loadThemeDefinitionContext(resolvedRoot);
  const themesDirectory = path.join(resolvedRoot, 'source/themes');
  /** @type {Map<string, import('./themeDefinition.mjs').ThemeDefinition>} */
  const resolvedThemes = new Map();
  /** @type {Map<string, import('./themeDefinition.mjs').ThemeRecipe>} */
  const recipes = new Map();
  const themes = normalizeThemeCatalog(
    readJson(path.join(resolvedRoot, 'source/themeCatalog.json')),
    (slug) => {
      const sourcePath = path.join(themesDirectory, `${slug}.json`);
      const stats = fs.lstatSync(sourcePath);

      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error(`Theme source '${slug}' must be a regular file.`);
      }

      const recipe = validateThemeRecipe(readJson(sourcePath), slug, definition);
      validateFrozenThemePalette(recipe, slug, definition);
      const resolvedTheme = deepFreeze(resolveThemeRecipe(recipe, slug, definition));
      resolvedThemes.set(slug, resolvedTheme);
      recipes.set(slug, deepFreeze(recipe));
      return { name: resolvedTheme.name };
    },
    (slug) => themeFamilyClassification(definition, slug)
  );
  const expectedFiles = new Set(themes.map(({ slug }) => `${slug}.json`));
  const orphanFiles = fs
    .readdirSync(themesDirectory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith('.json') && !expectedFiles.has(entry.name))
    .map(({ name }) => name)
    .toSorted();

  if (orphanFiles.length > 0) {
    throw new Error(`Source theme files are absent from the catalog: ${orphanFiles.join(', ')}.`);
  }

  validateThemeFamilyRelationships(themes, resolvedThemes, definition);
  if (mode === 'production') {
    validateProductionThemePolicy(themes, resolvedThemes, resolvedRoot, definition);
  }

  const sources = Object.freeze(themes.map((source) => deepFreeze(source)));
  const repository = Object.freeze({ definition, root: resolvedRoot, sources });
  repositorySnapshots.set(repository, {
    mode,
    productionAdmitted: mode === 'production',
    resolvedThemes,
  });
  for (const source of sources) {
    const recipe = recipes.get(source.slug);
    const theme = resolvedThemes.get(source.slug);
    if (!recipe || !theme) throw new Error(`Theme '${source.slug}' was not resolved.`);
    sourceSnapshots.set(source, { mode, repository, recipe, theme });
  }
  return repository;
}

/**
 * @template T
 * @param {string} filePath
 * @returns {T}
 */
function readJson(filePath) {
  return /** @type {T} */ (JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

/**
 * @param {import('./themeDefinition.mjs').ThemeRecipe} recipe
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
 * @template {'recipe' | 'theme'} T
 * @param {ThemeSource} source
 * @param {ThemeInspectionRepository | ThemeRepository} repository
 * @param {'inspection' | 'production'} mode
 * @param {T} property
 * @returns {T extends 'recipe' ? import('./themeDefinition.mjs').ThemeRecipe : import('./themeDefinition.mjs').ThemeDefinition}
 */
function readSnapshotValue(source, repository, mode, property) {
  const repositorySnapshot = repositorySnapshots.get(repository);
  const sourceSnapshot = sourceSnapshots.get(source);
  if (!repositorySnapshot || !sourceSnapshot || sourceSnapshot.repository !== repository) {
    throw new Error('Theme source must come from the requested repository snapshot.');
  }
  if (repositorySnapshot.mode !== mode || sourceSnapshot.mode !== mode) {
    throw new Error(`Theme ${mode} reads require a ${mode} repository snapshot.`);
  }
  return /** @type {any} */ (sourceSnapshot[property]);
}

/**
 * @param {ThemeSource} source
 * @param {ThemeInspectionRepository | ThemeRepository} repository
 * @returns {import('./themeDefinition.mjs').ThemeDefinition}
 */
function readProductionTheme(source, repository) {
  const sourceSnapshot = sourceSnapshots.get(source);
  if (!sourceSnapshot || sourceSnapshot.repository !== repository) {
    throw new Error('Theme source must come from the requested repository snapshot.');
  }
  requireProductionThemeRepository(repository);
  return sourceSnapshot.theme;
}

/**
 * @param {unknown} catalog
 * @param {(slug: string) => unknown} readThemeIdentity
 * @param {(slug: string) => unknown} readThemeClassification
 * @returns {ThemeSource[]}
 */
export function normalizeThemeCatalog(catalog, readThemeIdentity, readThemeClassification) {
  if (!Array.isArray(catalog) || catalog.length === 0) {
    throw new Error('Theme catalog must be a non-empty array.');
  }

  const labels = new Set();
  const slugs = new Set();
  const themes = catalog.map((value, index) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`Theme catalog entry ${index} must be an object.`);
    }

    const entry = /** @type {Partial<ThemeCatalogEntry>} */ (value);
    const slug = requireCatalogString(entry.slug, index, 'slug');
    const unsupportedFields = Object.keys(entry).filter(
      (field) => field !== 'slug' && field !== 'terminalDefault'
    );

    if (unsupportedFields.length > 0) {
      throw new Error(
        `Theme catalog entry '${slug}' has unsupported fields: ${unsupportedFields.join(', ')}.`
      );
    }

    if (!/^tyrian-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
      throw new Error(`Theme catalog entry ${index} has an invalid slug '${slug}'.`);
    }

    if (slugs.has(slug)) {
      throw new Error(`Theme catalog slug '${slug}' is duplicated.`);
    }

    if (entry.terminalDefault !== undefined && typeof entry.terminalDefault !== 'boolean') {
      throw new Error(`Theme catalog entry '${slug}' has a non-boolean terminal default flag.`);
    }

    const identityValue = readThemeIdentity(slug);
    if (
      typeof identityValue !== 'object' ||
      identityValue === null ||
      Array.isArray(identityValue)
    ) {
      throw new Error(`Theme source '${slug}' must be an object.`);
    }

    const identity = /** @type {Partial<ThemeIdentity>} */ (identityValue);
    const label = requireThemeName(identity.name, slug);
    const classificationValue = readThemeClassification(slug);
    if (
      typeof classificationValue !== 'object' ||
      classificationValue === null ||
      Array.isArray(classificationValue)
    ) {
      throw new Error(`Theme family classification '${slug}' must be an object.`);
    }
    const classification = /** @type {Partial<ThemeClassification>} */ (classificationValue);
    if (classification.appearance !== 'dark' && classification.appearance !== 'light') {
      throw new Error(`Theme family classification '${slug}' has an invalid appearance.`);
    }
    if (typeof classification.isDefault !== 'boolean') {
      throw new Error(`Theme family classification '${slug}' has an invalid default flag.`);
    }

    const appearance = classification.appearance;
    const vscodeUiTheme = /** @type {'vs' | 'vs-dark'} */ (
      appearance === 'light' ? 'vs' : 'vs-dark'
    );

    if (labels.has(label)) {
      throw new Error(`Theme source name '${label}' is duplicated.`);
    }

    labels.add(label);
    slugs.add(slug);

    return {
      appearance,
      isDefault: classification.isDefault,
      isTerminalDefault: entry.terminalDefault === true,
      islandCssFile: `${slug}.css`,
      islandCssPath: `apps/vscode/island/${slug}.css`,
      label,
      paletteName: slug.replaceAll('-', '_'),
      slug,
      sourcePath: `source/themes/${slug}.json`,
      vscodeContributionPath: `./themes/${slug}.json`,
      vscodeThemePath: `apps/vscode/themes/${slug}.json`,
      vscodeUiTheme,
    };
  });
  const defaultThemes = themes.filter((theme) => theme.isDefault);

  if (defaultThemes.length !== 1) {
    throw new Error(`Expected exactly one default source theme, found ${defaultThemes.length}.`);
  }

  for (const appearance of /** @type {const} */ (['dark', 'light'])) {
    const terminalDefaults = themes.filter(
      (theme) => theme.appearance === appearance && theme.isTerminalDefault
    );

    if (terminalDefaults.length !== 1) {
      throw new Error(
        `Expected exactly one ${appearance} terminal default source theme, found ${terminalDefaults.length}.`
      );
    }
  }

  return themes;
}

/**
 * @param {ReadonlyArray<ThemeSource>} sourceThemes
 * @returns {ThemeSource}
 */
export function getDefaultThemeSource(sourceThemes = SOURCE_THEMES) {
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
export function getTerminalDefaultThemeSource(appearance, sourceThemes = SOURCE_THEMES) {
  return requireSingleThemeRole(
    sourceThemes.filter((theme) => theme.appearance === appearance && theme.isTerminalDefault),
    `${appearance} terminal default source theme`
  );
}

/**
 * @param {unknown} value
 * @param {number} index
 * @param {'slug'} field
 * @returns {string}
 */
function requireCatalogString(value, index, field) {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`Theme catalog entry ${index} must have a non-empty ${field}.`);
  }

  return value;
}

/**
 * @param {unknown} value
 * @param {string} slug
 * @returns {string}
 */
function requireThemeName(value, slug) {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`Theme source '${slug}' must have a non-empty name.`);
  }

  return value;
}

/**
 * @param {ThemeSource[]} themes
 * @param {string} role
 * @returns {ThemeSource}
 */
function requireSingleThemeRole(themes, role) {
  if (themes.length !== 1) {
    throw new Error(`Expected exactly one ${role}, found ${themes.length}.`);
  }

  return /** @type {ThemeSource} */ (themes[0]);
}

/**
 * The production admission gate owns hard color policy. The inspect-only
 * repository intentionally omits this step so diagnostics can explain an
 * invalid editable palette without offering it to generators.
 * @param {ReadonlyArray<ThemeSource>} sources
 * @param {ReadonlyMap<string, import('./themeDefinition.mjs').ThemeDefinition>} themes
 * @param {string} root
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} definition
 */
function validateProductionThemePolicy(sources, themes, root, definition) {
  const safetyContract = readThemeSafetyContract(
    path.join(root, 'source/themeSafetyContract.json'),
    definition
  );
  const pigmentPolicy = readThemePigmentPolicy(
    path.join(root, 'source/themePigmentPolicy.json'),
    definition
  );
  for (const source of sources) {
    const theme = themes.get(source.slug);
    if (!theme) throw new Error(`Theme '${source.slug}' was not resolved.`);
    const safetyViolations = auditThemeSafety(theme, safetyContract);
    if (safetyViolations.length > 0) {
      throw new Error(
        `Theme '${source.slug}' violates theme safety policy: ${JSON.stringify(safetyViolations)}.`
      );
    }
    const pigmentViolations = auditThemePigmentPolicy(theme, pigmentPolicy);
    if (pigmentViolations.length > 0) {
      throw new Error(
        `Theme '${source.slug}' violates theme pigment policy: ${JSON.stringify(pigmentViolations)}.`
      );
    }
  }
}

/**
 * Repository-bound validation for relationships no individual recipe can own.
 * @param {ThemeSource[]} sources
 * @param {Map<string, import('./themeDefinition.mjs').ThemeDefinition>} themes
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
    const theme = /** @type {import('./themeDefinition.mjs').ThemeDefinition} */ (themes.get(slug));
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
    const theme = /** @type {import('./themeDefinition.mjs').ThemeDefinition} */ (themes.get(slug));
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
    const theme = /** @type {import('./themeDefinition.mjs').ThemeDefinition} */ (themes.get(slug));
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
function meanSemanticChroma(theme, semanticPigments) {
  return mean(semanticPigments.map((pigment) => hexToOklch(themeColor(theme, pigment)).C));
}

/**
 * @param {import('./themeDefinition.mjs').ThemeDefinition} theme
 * @param {readonly string[]} semanticPigments
 */
function meanSemanticContrast(theme, semanticPigments) {
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

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
