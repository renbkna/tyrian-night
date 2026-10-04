import { SOURCE_THEMES, sourceTheme, VSCODE_PROJECTION } from '../support/themes.js';
import { expect, test } from 'bun:test';

import { hexToOklch, hueDistance } from '../../scripts/colorScience.mjs';
import {
  loadThemeInspectionRepository,
  loadThemeRepository,
  readSourceTheme,
} from '../../scripts/themeSources.mjs';
import { themeColor, themeFamilyClassification } from '../../scripts/themeDefinition.mjs';
import { buildVscodeTheme } from '../../scripts/vscodeThemes.mjs';
import { buildZedThemeFamily } from '../../scripts/zedTheme.mjs';

const inspectionRepository = loadThemeInspectionRepository();

function readDefaultThemeRecipe(source: (typeof SOURCE_THEMES)[number]) {
  const inspectedSource = inspectionRepository.sources.find(({ slug }) => slug === source.slug);
  if (!inspectedSource) throw new Error(`Missing inspection source '${source.slug}'.`);
  return inspectionRepository.recipes.get(inspectedSource.slug)!;
}

test('the family exposes six palettes through one recipe path', () => {
  expect(SOURCE_THEMES.map(({ slug }) => slug)).toEqual([
    'tyrian-night',
    'tyrian-nocturne',
    'tyrian-pastel',
    'tyrian-abyss',
    'tyrian-dawn',
    'tyrian-night-old',
  ]);

  expect(
    loadThemeRepository().definition.familyContract.branches['tyrian-night-old']!.hueProfile
  ).toBe('core');

  const themes = SOURCE_THEMES.map((source) => sourceTheme(source));
  expect(new Set(themes.map((theme) => themeColor(theme, 'ui:surface.canvas'))).size).toBe(
    themes.length
  );
  const paletteFingerprints = themes.map(({ brackets, syntax, terminal, ui, vscode }) =>
    JSON.stringify({ brackets, syntax, terminal, ui, vscode })
  );
  expect(new Set(paletteFingerprints).size).toBe(themes.length);
});

test('the family contract fixes hue identity and proves each declared energy tier', () => {
  const repository = loadThemeRepository();
  const family = repository.definition.familyContract;
  expect(family.canonical).toBe('tyrian-abyss');
  expect(repository.sources.find(({ isDefault }) => isDefault)?.slug).toBe(family.canonical);
  expect(family.energyLine.hueProfile).toBe('core');
  expect(
    Object.values(family.energyLine.variants).every((variant) => !('hueProfile' in variant))
  ).toBe(true);
  expect(family.semanticPigments).toEqual([
    'ui:accent.primary',
    'syntax:control',
    'syntax:function',
    'syntax:type',
    'syntax:data',
    'syntax:string',
    'syntax:literal',
  ]);
  const themes = Object.fromEntries(
    repository.sources
      .filter(({ slug }) => slug !== 'tyrian-night-old')
      .map((source) => [source.slug, readSourceTheme(source, repository)])
  );
  const semanticColors = (slug: string) => {
    const theme = themes[slug];
    return family.semanticPigments.map((pigment) => themeColor(theme, pigment));
  };
  const semanticChroma = (slug: string) => {
    const colors = semanticColors(slug);
    return colors.reduce((sum, color) => sum + hexToOklch(color).C, 0) / colors.length;
  };
  const canvasLightness = (slug: string) =>
    hexToOklch(themeColor(themes[slug], 'ui:surface.canvas')).L;
  // Energy variants share the family hue profile by construction; rendered hex hue
  // drifts with 8-bit quantization at low chroma, so it cannot prove identity.
  for (const slug of Object.keys(family.energyLine.variants)) {
    expect(themeFamilyClassification(repository.definition, slug).hueProfile).toBe(
      family.energyLine.hueProfile
    );
  }
  const canonicalHues = semanticColors(family.canonical).map((color) => hexToOklch(color).h);
  for (const slug of ['tyrian-pastel', 'tyrian-dawn']) {
    const hueDistances = semanticColors(slug).map((color, index) =>
      hueDistance(canonicalHues[index], hexToOklch(color).h)
    );
    expect(Math.max(...hueDistances)).toBeLessThan(12);
  }

  const energyOrder = ['tyrian-night', 'tyrian-nocturne', 'tyrian-abyss'] as const;
  for (const [lower, higher] of [energyOrder.slice(0, 2), energyOrder.slice(1)]) {
    const lowerBand = family.energyLine.variants[lower].syntaxSaturation;
    const higherBand = family.energyLine.variants[higher].syntaxSaturation;
    expect([lowerBand.measure, higherBand.measure]).toEqual(['richness', 'richness']);
    expect(lowerBand.maximum).toBeLessThan(higherBand.minimum);
    expect(semanticChroma(lower)).toBeLessThan(semanticChroma(higher));
  }
  expect(canvasLightness('tyrian-abyss')).toBeLessThan(canvasLightness('tyrian-nocturne'));
  expect(canvasLightness('tyrian-nocturne')).toBeLessThan(canvasLightness('tyrian-night'));
  expect(canvasLightness('tyrian-dawn')).toBeGreaterThan(0.95);
});

test('the historical-reference branch uses current bindings and opacity policy', () => {
  const source = SOURCE_THEMES.find(({ slug }) => slug === 'tyrian-night-old');
  expect(source).toBeDefined();
  const historical = sourceTheme(source!);
  const repository = loadThemeRepository();
  const recipe = readDefaultThemeRecipe(source!);
  expect(recipe).not.toHaveProperty('appearance');
  expect(recipe).not.toHaveProperty('hueProfile');
  expect(repository.definition.familyContract.branches['tyrian-night-old']).toEqual({
    frozenPaletteSha256: 'a317b824a281dd989af90bcce1f2db48d38e0c3f67e8749bd3ee4010f6a9e607',
    hueProfile: 'core',
    kind: 'historical-reference',
    maximumSemanticHueDistance: 0,
  });
  expect(historical.vscode['chrome.statusBar.offlineForeground']).toBe(
    historical.ui['text.primary']
  );
  const vscode = buildVscodeTheme(historical, VSCODE_PROJECTION).colors;
  expect(vscode['statusBarItem.offlineForeground']).toBe(historical.ui['text.primary']);
  expect(vscode['inputValidation.errorForeground']).toBe(historical.ui['text.primary']);
  expect(vscode['inputValidation.infoForeground']).toBe(historical.ui['text.primary']);
  expect(vscode['inputValidation.warningForeground']).toBe(historical.ui['text.primary']);
});

test('all editor projections share the current semantic bindings', () => {
  const family = buildZedThemeFamily() as {
    themes: Array<{ name: string; style: { syntax: Record<string, { color: string }> } }>;
  };
  const current = family.themes.find(({ name }) => name === 'Tyrian Nocturne')!;
  const historical = family.themes.find(({ name }) => name === 'Tyrian Night Old')!;
  const currentSource = SOURCE_THEMES.find(({ slug }) => slug === 'tyrian-nocturne')!;
  const currentTheme = sourceTheme(currentSource);
  const historicalSource = SOURCE_THEMES.find(({ slug }) => slug === 'tyrian-night-old')!;
  const historicalTheme = sourceTheme(historicalSource);
  const currentVscode = buildVscodeTheme(currentTheme, VSCODE_PROJECTION);
  const historicalVscode = buildVscodeTheme(historicalTheme, VSCODE_PROJECTION);
  const grammarColor = (theme: typeof currentVscode, scope: string) =>
    theme.tokenColors.find((token) => token.scope.includes(scope))!.settings.foreground;

  expect(current.style.syntax.link_uri.color).toBe(themeColor(currentTheme, 'syntax:file'));
  expect(current.style.syntax.link_uri.color).not.toBe(current.style.syntax.type.color);
  for (const [zed, vscode, theme] of [
    [current, currentVscode, currentTheme],
    [historical, historicalVscode, historicalTheme],
  ] as const) {
    const literal = themeColor(theme, 'syntax:literal');
    const punctuation = themeColor(theme, 'syntax:punctuation');
    const control = themeColor(theme, 'syntax:control');
    const declaration = themeColor(theme, 'syntax:declaration');
    for (const capture of ['constant.builtin', 'boolean', 'number', 'string.regex']) {
      expect(zed.style.syntax[capture]!.color).toBe(literal);
    }
    for (const scope of ['constant.language', 'constant.numeric', 'string.regexp']) {
      expect(grammarColor(vscode, scope)).toBe(literal);
    }
    expect(zed.style.syntax.operator.color).toBe(punctuation);
    expect(grammarColor(vscode, 'keyword.operator')).toBe(punctuation);
    expect(zed.style.syntax['keyword.control']!.color).toBe(control);
    expect(grammarColor(vscode, 'keyword.control')).toBe(control);
    expect(zed.style.syntax.keyword.color).toBe(declaration);
    for (const scope of ['keyword', 'keyword.control.import', 'keyword.operator.expression']) {
      expect(grammarColor(vscode, scope)).toBe(declaration);
    }
    expect(grammarColor(vscode, 'variable.other.constant')).toBe(
      themeColor(theme, 'syntax:variable')
    );
    // One role per concept across both editors.
    const parity: Array<[string, string, string]> = [
      ['keyword.control.directive', 'preproc', 'syntax:declaration'],
      ['support.type.property-name.json', 'property.json_key', 'syntax:variable'],
      ['string.other.link', 'link_text', 'syntax:file'],
      ['entity.name.namespace', 'namespace', 'syntax:type'],
      ['meta.decorator', 'function.decorator', 'syntax:type'],
    ];
    for (const [scope, capture, role] of parity) {
      expect(grammarColor(vscode, scope)).toBe(themeColor(theme, role));
      expect(zed.style.syntax[capture]!.color).toBe(themeColor(theme, role));
    }
  }
  expect(historical.style.syntax.link_uri.color).toBe(themeColor(historicalTheme, 'syntax:file'));
  expect(grammarColor(currentVscode, 'markup.underline.link')).toBe(
    themeColor(currentTheme, 'syntax:file')
  );
  expect(grammarColor(historicalVscode, 'markup.underline.link')).toBe(
    themeColor(historicalTheme, 'syntax:file')
  );
});
