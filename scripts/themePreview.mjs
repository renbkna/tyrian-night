// @ts-check

import path from 'node:path';

import { syncGeneratedAssets } from './generatedAssets.mjs';
import { themeColor } from './themeDefinition.mjs';
import {
  loadThemeRepository,
  meanSemanticChroma,
  meanSemanticContrast,
  readSourceTheme,
} from './themeSources.mjs';

const defaultRepoRoot = path.resolve(import.meta.dirname, '..');
const OUTPUT_PATH = 'examples/theme-preview/generated/production-family.js';

/**
 * Builds the browser preview from the same resolved definitions consumed by
 * editor, terminal, and desktop generators.
 * @param {string} [repoRoot]
 */
export function buildProductionFamilyPreview(repoRoot = defaultRepoRoot) {
  const repository = loadThemeRepository(repoRoot);
  const family = repository.definition.familyContract;

  return repository.sources.map((source) => {
    const theme = readSourceTheme(source, repository);
    const energyVariant = family.energyLine.variants[source.slug];
    const branch = family.branches[source.slug];
    if (!energyVariant && !branch) {
      throw new Error(`Theme '${source.slug}' has no preview classification.`);
    }
    const canvas = themeColor(theme, 'ui:surface.canvas');
    const semanticChroma = meanSemanticChroma(theme, family.semanticPigments);
    const semanticContrast = meanSemanticContrast(theme, family.semanticPigments);
    const classification = source.isDefault
      ? 'canonical family center'
      : energyVariant
        ? 'energy-line variant'
        : `${branch.kind} branch`;

    return {
      id: source.slug,
      name: theme.name,
      energy: classification,
      description:
        `${classification}; mean semantic chroma ${semanticChroma.toFixed(3)}, ` +
        `mean semantic contrast ${semanticContrast.toFixed(2)}.`,
      palette: {
        canvas,
        sidebar: themeColor(theme, 'ui:surface.sidebar'),
        raised: themeColor(theme, 'ui:surface.raised'),
        field: themeColor(theme, 'ui:surface.field'),
        hover: themeColor(theme, 'ui:surface.hover'),
        border: themeColor(theme, 'ui:border.default'),
        text: themeColor(theme, 'ui:text.primary'),
        secondary: themeColor(theme, 'ui:text.secondary'),
        muted: themeColor(theme, 'ui:text.muted'),
        accent: themeColor(theme, 'ui:accent.primary'),
        glow: themeColor(theme, 'ui:accent.effect'),
        control: themeColor(theme, 'syntax:control'),
        declaration: themeColor(theme, 'syntax:declaration'),
        function: themeColor(theme, 'syntax:function'),
        type: themeColor(theme, 'syntax:type'),
        data: themeColor(theme, 'syntax:data'),
        string: themeColor(theme, 'syntax:string'),
        comment: themeColor(theme, 'syntax:comment'),
        punctuation: themeColor(theme, 'syntax:punctuation'),
        literal: themeColor(theme, 'syntax:literal'),
        variable: themeColor(theme, 'syntax:variable'),
        error: themeColor(theme, 'ui:status.error'),
        warning: themeColor(theme, 'ui:status.warning'),
        info: themeColor(theme, 'ui:status.info'),
        success: themeColor(theme, 'ui:status.success'),
      },
    };
  });
}

/**
 * @param {string} [repoRoot]
 * @param {{ check?: boolean }} [options]
 */
export function syncProductionFamilyPreview(repoRoot = defaultRepoRoot, options = {}) {
  const content =
    '// biome-ignore format: generated production palette\n' +
    'window.TYRIAN_PRODUCTION_FAMILY = Object.freeze(' +
    `${JSON.stringify(buildProductionFamilyPreview(repoRoot), null, 2)});\n`;

  return syncGeneratedAssets([{ path: OUTPUT_PATH, content }], repoRoot, {
    check: options.check,
    ownership: [{ directory: 'examples/theme-preview/generated' }],
  });
}
