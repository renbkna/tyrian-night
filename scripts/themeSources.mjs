// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadThemeDefinitionContext,
  resolveThemeRecipe,
  themeFamilyClassification,
  themeColor,
  validateThemeDefinition,
  validateThemeRecipe,
} from './themeDefinition.mjs';
import { contrastRatio, hexToOklch, hueDistance } from './colorScience.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const defaultThemeRepository = loadThemeRepository(repoRoot);

/** @type {ReadonlyArray<ThemeSource>} */
export const SOURCE_THEMES = Object.freeze(
  defaultThemeRepository.sources.map((theme) => Object.freeze(theme))
);

/**
 * Loads one role-membership context and every catalog member for a repository root.
 * @param {string} [root]
 * @returns {ThemeRepository}
 */
export function loadThemeRepository(root = repoRoot) {
  const resolvedRoot = path.resolve(root);
  const definition = loadThemeDefinitionContext(resolvedRoot);
  const sources = Object.freeze(
    readThemeSources(resolvedRoot, definition).map((source) => Object.freeze(source))
  );

  return Object.freeze({ definition, root: resolvedRoot, sources });
}

/**
 * @param {string} [root]
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} [definition]
 * @returns {ThemeSource[]}
 */
export function readThemeSources(root = repoRoot, definition = loadThemeDefinitionContext(root)) {
  const resolvedRoot = requireContextRoot(root, definition);
  const themesDirectory = path.join(resolvedRoot, 'source/themes');
  /** @type {Map<string, import('./themeDefinition.mjs').ThemeDefinition>} */
  const resolvedThemes = new Map();
  const themes = normalizeThemeCatalog(
    readJson(path.join(resolvedRoot, 'source/themeCatalog.json')),
    (slug) => {
      const sourcePath = path.join(themesDirectory, `${slug}.json`);
      const stats = fs.lstatSync(sourcePath);

      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error(`Theme source '${slug}' must be a regular file.`);
      }

      const recipe = validateThemeRecipe(readJson(sourcePath), slug, definition);
      const resolvedTheme = resolveThemeRecipe(recipe, slug, definition);
      resolvedThemes.set(slug, resolvedTheme);
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
  return themes;
}

/**
 * @template T
 * @param {string} filePath
 * @returns {T}
 */
export function readJson(filePath) {
  return /** @type {T} */ (JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

/**
 * @param {ThemeSource} source
 * @param {string} [root]
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} [definition]
 * @returns {import('./themeDefinition.mjs').ThemeDefinition}
 */
export function readSourceTheme(
  source,
  root = repoRoot,
  definition = loadThemeDefinitionContext(root)
) {
  const resolvedRoot = requireContextRoot(root, definition);
  return validateThemeDefinition(
    readJson(path.join(resolvedRoot, source.sourcePath)),
    source.slug,
    definition
  );
}

/**
 * Reads the editable pigment recipe for tooling that deliberately operates at the owner boundary.
 * Generators should continue to consume readSourceTheme().
 * @param {ThemeSource} source
 * @param {string} [root]
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} [definition]
 * @returns {import('./themeDefinition.mjs').ThemeRecipe}
 */
export function readSourceThemeRecipe(
  source,
  root = repoRoot,
  definition = loadThemeDefinitionContext(root)
) {
  const resolvedRoot = requireContextRoot(root, definition);
  return validateThemeRecipe(
    readJson(path.join(resolvedRoot, source.sourcePath)),
    source.slug,
    definition
  );
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
 * @param {string} root
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} definition
 */
function requireContextRoot(root, definition) {
  const resolvedRoot = path.resolve(root);
  if (definition.root !== resolvedRoot) {
    throw new Error('Theme definition context does not belong to the requested repository root.');
  }
  return resolvedRoot;
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
  if (value < range.minimum - tolerance || value > range.maximum + tolerance) {
    throw new Error(`${owner} ${value.toFixed(4)} is outside ${range.minimum}..${range.maximum}.`);
  }
}
