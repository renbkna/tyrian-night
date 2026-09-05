import { expect, test } from 'bun:test';

import { contrastRatio, hexToOklch, hueDistance } from '../scripts/colorScience.mjs';
import {
  SOURCE_THEMES,
  loadThemeRepository,
  readSourceTheme,
  loadThemeInspectionRepository,
  readInspectionThemeRecipe,
} from '../scripts/themeSources.mjs';
import { syntaxColor, themeColor, uiColor } from '../scripts/themeDefinition.mjs';
import { buildVscodeTheme } from '../scripts/vscodeThemes.mjs';
import { VSCODE_PROJECTION } from '../scripts/vscodeProjection.mjs';
import { buildZedThemeFamily } from '../scripts/zedTheme.mjs';

const inspectionRepository = loadThemeInspectionRepository();

function readDefaultThemeRecipe(source: (typeof SOURCE_THEMES)[number]) {
  const inspectedSource = inspectionRepository.sources.find(({ slug }) => slug === source.slug);
  if (!inspectedSource) throw new Error(`Missing inspection source '${source.slug}'.`);
  return readInspectionThemeRecipe(inspectedSource, inspectionRepository);
}

test('the family exposes six schema-v5 palettes through one current recipe path', () => {
  expect(SOURCE_THEMES.map(({ slug }) => slug)).toEqual([
    'tyrian-night',
    'tyrian-nocturne',
    'tyrian-pastel',
    'tyrian-abyss',
    'tyrian-dawn',
    'tyrian-night-old',
  ]);

  expect(
    SOURCE_THEMES.every((source) => {
      const recipe = readDefaultThemeRecipe(source);
      return (
        recipe.schemaVersion === 5 &&
        !Object.hasOwn(recipe, 'appearance') &&
        !Object.hasOwn(recipe, 'hueProfile') &&
        !Object.hasOwn(recipe, 'pigments')
      );
    })
  ).toBe(true);
  expect(
    loadThemeRepository().definition.familyContract.branches['tyrian-night-old']!.hueProfile
  ).toBe('core');

  const themes = SOURCE_THEMES.map((source) => readSourceTheme(source));
  expect(new Set(themes.map((theme) => uiColor(theme, 'surface.canvas'))).size).toBe(themes.length);
  const paletteFingerprints = themes.map(({ brackets, syntax, terminal, ui, vscode }) =>
    JSON.stringify({ brackets, syntax, terminal, ui, vscode })
  );
  expect(new Set(paletteFingerprints).size).toBe(themes.length);
});

test('the family contract fixes hue identity and proves each declared energy tier', () => {
  const repository = loadThemeRepository();
  const family = repository.definition.familyContract;
  expect(family.canonical).toBe('tyrian-nocturne');
  expect(repository.sources.find(({ isDefault }) => isDefault)?.slug).toBe(family.canonical);
  expect(family.energyLine.hueProfile).toBe('core');
  expect(
    Object.values(family.energyLine.variants).every((variant) => !('hueProfile' in variant))
  ).toBe(true);
  expect(family.semanticPigments).toEqual([
    'ui:accent.primary',
    'syntax:keyword',
    'syntax:function',
    'syntax:type',
    'syntax:data',
    'syntax:string',
    'syntax:regexp',
  ]);
  expect(family.syntaxBalance).toEqual({
    functionTypeLightnessDelta: { minimum: -0.05, maximum: 0.05 },
    keywordFunctionChromaDelta: { minimum: -0.005, maximum: 0.5 },
    keywordTypeChromaDelta: { minimum: -0.03, maximum: 0.03 },
    typeFunctionChromaDelta: { minimum: -0.005, maximum: 0.5 },
  });
  expect(family.energyLine.variants['tyrian-night'].semanticChromaRatio).toEqual({
    minimum: 0.6,
    maximum: 0.7,
  });
  expect(family.energyLine.variants['tyrian-nocturne'].semanticChromaRatio).toEqual({
    minimum: 1,
    maximum: 1,
  });
  expect(family.energyLine.variants['tyrian-abyss'].semanticChromaRatio).toEqual({
    minimum: 1.3,
    maximum: 1.45,
  });

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
  const canvasLightness = (slug: string) => hexToOklch(uiColor(themes[slug], 'surface.canvas')).L;
  const semanticContrast = (slug: string) => {
    const canvas = uiColor(themes[slug], 'surface.canvas');
    const colors = semanticColors(slug);
    return colors.reduce((sum, color) => sum + contrastRatio(color, canvas), 0) / colors.length;
  };
  const nocturneHues = semanticColors('tyrian-nocturne').map((color) => hexToOklch(color).h);

  for (const slug of ['tyrian-night', 'tyrian-abyss']) {
    const hueDistances = semanticColors(slug).map((color, index) =>
      hueDistance(nocturneHues[index], hexToOklch(color).h)
    );
    expect(Math.max(...hueDistances)).toBeLessThan(1);
  }
  for (const slug of ['tyrian-pastel', 'tyrian-dawn']) {
    const hueDistances = semanticColors(slug).map((color, index) =>
      hueDistance(nocturneHues[index], hexToOklch(color).h)
    );
    expect(Math.max(...hueDistances)).toBeLessThan(12);
  }

  const nocturneChroma = semanticChroma('tyrian-nocturne');
  expectWithin(semanticChroma('tyrian-night') / nocturneChroma, 0.6, 0.7);
  expectWithin(semanticChroma('tyrian-abyss') / nocturneChroma, 1.3, 1.45);
  expectWithin(semanticContrast('tyrian-night'), 4.8, 5.3);
  expectWithin(semanticContrast('tyrian-nocturne'), 5.8, 6.4);
  expectWithin(semanticContrast('tyrian-abyss'), 6.6, 7.3);
  expect(canvasLightness('tyrian-abyss')).toBeLessThan(canvasLightness('tyrian-nocturne'));
  expect(canvasLightness('tyrian-nocturne')).toBeLessThan(canvasLightness('tyrian-night'));
  expect(canvasLightness('tyrian-dawn')).toBeGreaterThan(0.95);
});

test('each maintained palette balances saturated keywords, types, and functions', () => {
  const family = loadThemeRepository().definition.familyContract;
  const balance = family.syntaxBalance;
  for (const source of SOURCE_THEMES.filter(
    ({ slug }) => family.branches[slug]?.kind !== 'historical-reference'
  )) {
    const syntax = readSourceTheme(source).syntax;
    const keyword = hexToOklch(syntax.keyword);
    const type = hexToOklch(syntax.type);
    const method = hexToOklch(syntax.function);

    expectWithin(
      method.L - type.L,
      balance.functionTypeLightnessDelta.minimum,
      balance.functionTypeLightnessDelta.maximum
    );
    expectWithin(
      keyword.C - method.C,
      balance.keywordFunctionChromaDelta.minimum,
      balance.keywordFunctionChromaDelta.maximum
    );
    expectWithin(
      keyword.C - type.C,
      balance.keywordTypeChromaDelta.minimum,
      balance.keywordTypeChromaDelta.maximum
    );
    expectWithin(
      type.C - method.C,
      balance.typeFunctionChromaDelta.minimum,
      balance.typeFunctionChromaDelta.maximum
    );
  }
});

test('the historical-reference branch uses current bindings and opacity policy', () => {
  const source = SOURCE_THEMES.find(({ slug }) => slug === 'tyrian-night-old');
  expect(source).toBeDefined();
  const historical = readSourceTheme(source!);
  const repository = loadThemeRepository();
  const recipe = readDefaultThemeRecipe(source!);
  expect(recipe).toEqual(expect.objectContaining({ schemaVersion: 5 }));
  expect(recipe).not.toHaveProperty('appearance');
  expect(recipe).not.toHaveProperty('hueProfile');
  expect(repository.definition.familyContract.branches['tyrian-night-old']).toEqual({
    frozenPaletteSha256: '28f3736a9afd2536cc5667f0bec8684317155a759329c8148c574ea5e51fb789',
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
  const currentTheme = readSourceTheme(currentSource);
  const historicalSource = SOURCE_THEMES.find(({ slug }) => slug === 'tyrian-night-old')!;
  const historicalTheme = readSourceTheme(historicalSource);
  const currentVscode = buildVscodeTheme(currentTheme, VSCODE_PROJECTION);
  const historicalVscode = buildVscodeTheme(historicalTheme, VSCODE_PROJECTION);
  const grammarColor = (theme: typeof currentVscode, scope: string) =>
    theme.tokenColors.find((token) => token.scope.includes(scope))!.settings.foreground;

  expect(current.style.syntax.link_uri.color).toBe(syntaxColor(currentTheme, 'file'));
  expect(current.style.syntax.link_uri.color).not.toBe(current.style.syntax.type.color);
  expect(current.style.syntax['constant.builtin'].color).toBe(syntaxColor(currentTheme, 'null'));
  expect(current.style.syntax.boolean.color).toBe(syntaxColor(currentTheme, 'constantLanguage'));
  expect(historical.style.syntax.link_uri.color).toBe(syntaxColor(historicalTheme, 'file'));
  expect(historical.style.syntax['constant.builtin'].color).toBe(
    syntaxColor(historicalTheme, 'null')
  );
  expect(grammarColor(currentVscode, 'constant.language.null')).toBe(
    syntaxColor(currentTheme, 'null')
  );
  expect(grammarColor(historicalVscode, 'constant.language.null')).toBe(
    syntaxColor(historicalTheme, 'null')
  );
  expect(grammarColor(currentVscode, 'markup.underline.link')).toBe(
    syntaxColor(currentTheme, 'file')
  );
  expect(grammarColor(historicalVscode, 'markup.underline.link')).toBe(
    syntaxColor(historicalTheme, 'file')
  );
});

function expectWithin(value: number, minimum: number, maximum: number): void {
  expect(value).toBeGreaterThanOrEqual(minimum);
  expect(value).toBeLessThanOrEqual(maximum);
}
