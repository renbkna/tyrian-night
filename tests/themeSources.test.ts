import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import {
  getTerminalDefaultThemeSource,
  loadThemeRepository,
  normalizeThemeCatalog,
  readSourceTheme,
  readSourceThemeRecipe,
  readThemeSources,
} from '../scripts/themeSources.mjs';
import {
  loadThemeDefinitionContext,
  loadVscodeProjection,
  themeColor,
  themePigmentOwner,
  validateThemeRecipe,
} from '../scripts/themeDefinition.mjs';
import { collectVscodeThemeAssets } from '../scripts/vscodeThemes.mjs';

const VALID_CATALOG = [
  { slug: 'tyrian-test-dark', terminalDefault: true },
  { slug: 'tyrian-test-light', terminalDefault: true },
];

const VALID_IDENTITIES = {
  'tyrian-test-dark': { name: 'Tyrian Test Dark' },
  'tyrian-test-light': { name: 'Tyrian Test Light' },
} as const;
const VALID_CLASSIFICATIONS = {
  'tyrian-test-dark': { appearance: 'dark', isDefault: true },
  'tyrian-test-light': { appearance: 'light', isDefault: false },
} as const;
const DEFAULT_DEFINITION = loadThemeDefinitionContext();

test('theme catalog derives identity from recipes and classification from family authority', () => {
  const themes = normalizeThemeCatalog(VALID_CATALOG, readIdentity, readClassification);

  expect(
    themes.map(({ label, appearance, vscodeUiTheme }) => [label, appearance, vscodeUiTheme])
  ).toEqual([
    ['Tyrian Test Dark', 'dark', 'vs-dark'],
    ['Tyrian Test Light', 'light', 'vs'],
  ]);
  expect(getTerminalDefaultThemeSource('dark', themes).slug).toBe('tyrian-test-dark');
  expect(getTerminalDefaultThemeSource('light', themes).slug).toBe('tyrian-test-light');
});

test('theme catalog rejects split identity and invalid role cardinality at its boundary', () => {
  const splitIdentity = structuredClone(VALID_CATALOG) as Array<Record<string, unknown>>;
  splitIdentity[0]!.label = 'Duplicate authority';
  expect(() => normalizeThemeCatalog(splitIdentity, readIdentity, readClassification)).toThrow(
    'unsupported fields: label'
  );

  const duplicateSlug = structuredClone(VALID_CATALOG);
  duplicateSlug[1]!.slug = duplicateSlug[0]!.slug;
  expect(() => normalizeThemeCatalog(duplicateSlug, readIdentity, readClassification)).toThrow(
    "slug 'tyrian-test-dark' is duplicated"
  );

  const duplicateNameIdentities = {
    ...VALID_IDENTITIES,
    'tyrian-test-light': { name: 'Tyrian Test Dark' },
  };
  expect(() =>
    normalizeThemeCatalog(
      VALID_CATALOG,
      (slug) => duplicateNameIdentities[slug as keyof typeof duplicateNameIdentities],
      readClassification
    )
  ).toThrow("source name 'Tyrian Test Dark' is duplicated");

  const retiredCatalogDefault = structuredClone(VALID_CATALOG) as Array<Record<string, unknown>>;
  retiredCatalogDefault[0]!.default = true;
  expect(() =>
    normalizeThemeCatalog(retiredCatalogDefault, readIdentity, readClassification)
  ).toThrow('unsupported fields: default');

  const missingLightTerminalDefault = structuredClone(VALID_CATALOG);
  missingLightTerminalDefault[1]!.terminalDefault = false;
  expect(() =>
    normalizeThemeCatalog(missingLightTerminalDefault, readIdentity, readClassification)
  ).toThrow('Expected exactly one light terminal default source theme, found 0');

  const missingLightAppearance = [structuredClone(VALID_CATALOG[0]!)];
  expect(() =>
    normalizeThemeCatalog(missingLightAppearance, readIdentity, readClassification)
  ).toThrow('Expected exactly one light terminal default source theme, found 0');

  const duplicateDarkTerminalDefault = [
    ...structuredClone(VALID_CATALOG),
    { slug: 'tyrian-second-dark', terminalDefault: true },
  ];
  expect(() =>
    normalizeThemeCatalog(
      duplicateDarkTerminalDefault,
      (slug) =>
        slug === 'tyrian-second-dark' ? { name: 'Tyrian Second Dark' } : readIdentity(slug),
      (slug) =>
        slug === 'tyrian-second-dark'
          ? { appearance: 'dark', isDefault: false }
          : readClassification(slug)
    )
  ).toThrow('Expected exactly one dark terminal default source theme, found 2');

  const nonTyrianSlug = structuredClone(VALID_CATALOG);
  nonTyrianSlug[0]!.slug = 'other-dark';
  expect(() =>
    normalizeThemeCatalog(
      nonTyrianSlug,
      (slug) => (slug === 'other-dark' ? VALID_IDENTITIES['tyrian-test-dark'] : readIdentity(slug)),
      readClassification
    )
  ).toThrow("invalid slug 'other-dark'");
});

test('theme source reader resolves catalog and identity from the injected repository root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-theme-sources-'));

  try {
    fs.mkdirSync(path.join(root, 'source/themes'), { recursive: true });
    copyThemeContracts(root);
    fs.writeFileSync(
      path.join(root, 'source/themeCatalog.json'),
      `${JSON.stringify(VALID_CATALOG)}\n`
    );
    for (const [slug, identity] of Object.entries(VALID_IDENTITIES)) {
      fs.writeFileSync(
        path.join(root, `source/themes/${slug}.json`),
        JSON.stringify(definitionFor(identity, readClassification(slug).appearance))
      );
    }

    expect(
      readThemeSources(root).map(({ label, appearance, isDefault }) => [
        label,
        appearance,
        isDefault,
      ])
    ).toEqual([
      ['Tyrian Test Dark', 'dark', true],
      ['Tyrian Test Light', 'light', false],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source outputs derive appearance and canonical default from the family contract', () => {
  const repository = loadThemeRepository();
  const family = repository.definition.familyContract;

  for (const source of repository.sources) {
    const expectedAppearance = Object.hasOwn(family.energyLine.variants, source.slug)
      ? 'dark'
      : family.branches[source.slug]!.kind === 'light-counterpart'
        ? 'light'
        : 'dark';
    const recipe = readSourceThemeRecipe(source, repository.root, repository.definition);

    expect(source.appearance).toBe(expectedAppearance);
    expect(source.isDefault).toBe(source.slug === family.canonical);
    expect(recipe).not.toHaveProperty('appearance');
    expect(recipe).not.toHaveProperty('hueProfile');
  }
});

test('theme catalog is the exact authority for source JSON membership', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-theme-membership-'));

  try {
    fs.mkdirSync(path.join(root, 'source/themes'), { recursive: true });
    copyThemeContracts(root);
    fs.writeFileSync(
      path.join(root, 'source/themeCatalog.json'),
      `${JSON.stringify(VALID_CATALOG)}\n`
    );
    for (const [slug, identity] of Object.entries(VALID_IDENTITIES)) {
      fs.writeFileSync(
        path.join(root, `source/themes/${slug}.json`),
        JSON.stringify(definitionFor(identity, readClassification(slug).appearance))
      );
    }
    fs.writeFileSync(
      path.join(root, 'source/themes/tyrian-orphan.json'),
      JSON.stringify(definitionFor({ name: 'Orphan' }, 'dark'))
    );

    expect(() => readThemeSources(root)).toThrow(
      'Source theme files are absent from the catalog: tyrian-orphan.json'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('injected repository role membership is validated by that repository context', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-theme-context-'));

  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const contractPath = path.join(root, 'source/themeRoleContract.json');
    const contract = readJson<Record<string, unknown>>(contractPath) as {
      ui: string[];
    };
    contract.ui.push('injected.owner.role');
    fs.writeFileSync(contractPath, `${JSON.stringify(contract)}\n`);
    const familyPath = path.join(root, 'source/themeFamilyContract.json');
    const family = readJson<any>(familyPath);
    family.pigmentHues['ui:injected.owner.role'] = Object.fromEntries(
      family.hueProfiles.map((profile: string) => [profile, 250])
    );
    for (const fileName of fs.readdirSync(path.join(root, 'source/themes'))) {
      const themePath = path.join(root, 'source/themes', fileName);
      const theme = readJson<any>(themePath);
      theme.oklch['ui:injected.owner.role'] = [0.5, 0.02];
      fs.writeFileSync(themePath, `${JSON.stringify(theme)}\n`);
      if (fileName === 'tyrian-night-old.json') {
        const palette = Object.entries(theme.oklch).toSorted(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0
        );
        family.branches['tyrian-night-old'].frozenPaletteSha256 = createHash('sha256')
          .update(JSON.stringify(palette))
          .digest('hex');
      }
    }
    fs.writeFileSync(familyPath, `${JSON.stringify(family)}\n`);

    const repository = loadThemeRepository(root);
    expect(repository.definition.requiredThemeRoles.ui).toContain('injected.owner.role');
    expect(repository.sources).toHaveLength(6);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source recipes own pigments once and resolve family-derived alpha projections', () => {
  const repository = loadThemeRepository();
  const source = repository.sources.find(({ slug }) => slug === 'tyrian-nocturne');
  expect(source).toBeDefined();
  const recipe = readSourceThemeRecipe(source!, repository.root, repository.definition);
  const theme = readSourceTheme(source!, repository.root, repository.definition);

  expect(recipe).not.toHaveProperty('ui');
  expect(recipe).not.toHaveProperty('opacities');
  expect(recipe.schemaVersion).toBe(5);
  expect(recipe).not.toHaveProperty('appearance');
  expect(recipe).not.toHaveProperty('hueProfile');
  if (recipe.schemaVersion !== 5) throw new Error('Expected a current OKLCH recipe.');
  expect(recipe.oklch['ui:status.success']).toHaveLength(2);
  const success = themeColor(theme, 'ui:status.success');
  expect(success).toMatch(/^#[0-9A-F]{6}$/);
  expect(repository.definition.opacityPolicy.dark['ui:status.successBackground']).toBe('1C');
  expect(theme.ui['status.successBackground']).toBe(`${success}1C`);
  expect(themePigmentOwner(repository.definition, 'syntax:function')).toBe('syntax:function');
  expect(
    themePigmentOwner(repository.definition, 'vscode:diff.editor.inserted.text.background')
  ).toBe('ui:status.success');
  expect(themePigmentOwner(repository.definition, 'terminal:ansi.green')).toBe('ui:status.success');
  expect(themePigmentOwner(repository.definition, 'ui:badges.foreground')).toBe('ui:text.onAccent');
  expect(themePigmentOwner(repository.definition, 'ui:border.tab')).toBe('ui:border.default');
  expect(
    themePigmentOwner(repository.definition, 'vscode:editor.overviewRuler.bracketMatchForeground')
  ).toBe('ui:accent.glow');
  expect(
    themePigmentOwner(repository.definition, 'vscode:editor.overviewRuler.deletedForeground')
  ).toBe('ui:status.error');
  expect(
    themePigmentOwner(repository.definition, 'vscode:editor.overviewRuler.infoForeground')
  ).toBe('ui:status.info');
  expect(
    themePigmentOwner(repository.definition, 'vscode:editor.overviewRuler.warningForeground')
  ).toBe('ui:status.warning');
  expect(themePigmentOwner(repository.definition, 'vscode:preview.result.file.foreground')).toBe(
    'ui:text.sidebar'
  );
  for (const role of [
    'vscode:input.validation.errorForeground',
    'vscode:input.validation.infoForeground',
    'vscode:input.validation.warningForeground',
  ]) {
    expect(themePigmentOwner(repository.definition, role)).toBe('ui:text.primary');
  }
});

test('color bindings contain only aliases and alpha-derived exceptions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-color-bindings-'));
  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const bindingsPath = path.join(root, 'source/themeColorBindings.json');
    const bindings = readJson<any>(bindingsPath);
    bindings.aliases['syntax:function'] = 'syntax:function';
    fs.writeFileSync(bindingsPath, `${JSON.stringify(bindings)}\n`);

    expect(() => loadThemeRepository(root)).toThrow("has redundant alias 'syntax:function'");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('theme source contracts reject non-current schema versions', () => {
  const cases: Array<[string, string, number, string]> = [
    [
      'themeColorBindings.json',
      'source/themeColorBindings.json',
      1,
      'Theme color binding contract must use schemaVersion 2.',
    ],
    [
      'themeOpacityContract.json',
      'source/themeOpacityContract.json',
      1,
      'Theme opacity contract must use schemaVersion 2.',
    ],
    [
      'themeFamilyContract.json',
      'source/themeFamilyContract.json',
      1,
      'Theme family contract must use schemaVersion 2.',
    ],
  ];

  for (const [, relativePath, schemaVersion, message] of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-source-schema-'));
    try {
      fs.cpSync('source', path.join(root, 'source'), { recursive: true });
      const target = path.join(root, relativePath);
      const source = readJson<Record<string, unknown>>(target);
      source.schemaVersion = schemaVersion;
      fs.writeFileSync(target, `${JSON.stringify(source)}\n`);

      expect(() => loadThemeDefinitionContext(root)).toThrow(message);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('theme recipe validation rejects split or incomplete color authority', () => {
  const source = loadThemeRepository().sources.find(({ slug }) => slug === 'tyrian-night');
  expect(source).toBeDefined();
  const recipe = readSourceThemeRecipe(source!);

  const split = structuredClone(recipe) as any;
  split.ui = { 'surface.canvas': '#000000' };
  expect(() => validateThemeRecipe(split, source!.slug)).toThrow('unsupported fields: ui');

  const splitOpacity = structuredClone(recipe) as any;
  splitOpacity.opacities = { 'ui:selection.primary': 'FF' };
  expect(() => validateThemeRecipe(splitOpacity, source!.slug)).toThrow(
    'unsupported fields: opacities'
  );

  const splitHue = structuredClone(recipe) as any;
  splitHue.hues = { 'syntax:function': 260 };
  expect(() => validateThemeRecipe(splitHue, source!.slug)).toThrow('unsupported fields: hues');

  const splitAppearance = structuredClone(recipe) as any;
  splitAppearance.appearance = 'light';
  expect(() => validateThemeRecipe(splitAppearance, source!.slug)).toThrow(
    'unsupported fields: appearance'
  );

  const splitHueProfile = structuredClone(recipe) as any;
  splitHueProfile.hueProfile = 'dawn';
  expect(() => validateThemeRecipe(splitHueProfile, source!.slug)).toThrow(
    'unsupported fields: hueProfile'
  );

  const missing = structuredClone(recipe);
  if (missing.schemaVersion !== 5) throw new Error('Expected a current OKLCH recipe.');
  delete missing.oklch['syntax:function'];
  expect(() => validateThemeRecipe(missing, source!.slug)).toThrow(
    'invalid oklch; missing: syntax:function'
  );

  const splitBindingAuthority = structuredClone(recipe);
  splitBindingAuthority.bindingAuthority = 'shadow-authority';
  expect(() => validateThemeRecipe(splitBindingAuthority, source!.slug)).toThrow(
    'unsupported fields: bindingAuthority'
  );

  const outOfGamut = structuredClone(recipe);
  if (outOfGamut.schemaVersion !== 5) throw new Error('Expected a current OKLCH recipe.');
  outOfGamut.oklch['ui:accent.primary'] = [0.5, 0.5];
  expect(() => validateThemeRecipe(outOfGamut, source!.slug)).toThrow('outside the sRGB gamut');

  const retiredHexRecipe = {
    schemaVersion: 4,
    name: recipe.name,
    pigments: {},
  };
  expect(() => validateThemeRecipe(retiredHexRecipe, source!.slug)).toThrow('schemaVersion 5');
});

test('family relationship validation rejects palette energy drift', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-family-energy-'));
  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const familyPath = path.join(root, 'source/themeFamilyContract.json');
    const family = readJson<any>(familyPath);
    family.energyLine.variants['tyrian-night'].semanticChromaRatio.maximum = 0.61;
    fs.writeFileSync(familyPath, `${JSON.stringify(family)}\n`);

    expect(() => loadThemeRepository(root)).toThrow(
      "Energy variant 'tyrian-night' semantic chroma ratio"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('family relationship validation rejects syntax balance drift', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-family-syntax-balance-'));
  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const themePath = path.join(root, 'source/themes/tyrian-night.json');
    const theme = readJson<any>(themePath);
    theme.oklch['syntax:type'][0] = 0.7;
    fs.writeFileSync(themePath, `${JSON.stringify(theme)}\n`);

    expect(() => loadThemeRepository(root)).toThrow(
      "Theme 'tyrian-night' function/type lightness delta"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('historical-reference palette rejects drift', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-frozen-palette-'));
  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const themePath = path.join(root, 'source/themes/tyrian-night-old.json');
    const theme = readJson<any>(themePath);
    theme.oklch['syntax:function'][0] = 0.7;
    fs.writeFileSync(themePath, `${JSON.stringify(theme)}\n`);

    expect(() => loadThemeRepository(root)).toThrow(
      "Historical-reference theme 'tyrian-night-old' palette is frozen."
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('family relationship validation rejects undefined chroma ratios', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-family-zero-chroma-'));
  try {
    fs.mkdirSync(path.join(root, 'source/themes'), { recursive: true });
    copyThemeContracts(root);
    fs.writeFileSync(
      path.join(root, 'source/themeCatalog.json'),
      `${JSON.stringify(VALID_CATALOG)}\n`
    );
    const family = readJson<any>(path.join(root, 'source/themeFamilyContract.json'));

    for (const [slug, identity] of Object.entries(VALID_IDENTITIES)) {
      const definition = definitionFor(identity, readClassification(slug).appearance);
      if (slug === family.canonical) {
        for (const pigment of family.semanticPigments as string[]) {
          definition.oklch[pigment] = [0, 0];
        }
      }
      fs.writeFileSync(path.join(root, `source/themes/${slug}.json`), JSON.stringify(definition));
    }

    expect(() => loadThemeRepository(root)).toThrow(
      "Energy variant 'tyrian-test-dark' semantic chroma ratio"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('family classification rejects absent and overlapping recipe classifications', () => {
  const cases: Array<[string, (family: any) => void, string]> = [
    [
      'absent branch',
      (family) => {
        delete family.branches['tyrian-dawn'];
        family.branches['tyrian-night-old'].hueProfile = 'dawn';
        family.branches['tyrian-night-old'].maximumSemanticHueDistance = 180;
      },
      "Theme 'tyrian-dawn' has no family classification.",
    ],
    [
      'overlapping branch',
      (family) => {
        family.branches['tyrian-night'] = {
          frozenPaletteSha256: '28f3736a9afd2536cc5667f0bec8684317155a759329c8148c574ea5e51fb789',
          hueProfile: 'core',
          kind: 'historical-reference',
          maximumSemanticHueDistance: 0,
        };
      },
      'Theme family classifications must not overlap.',
    ],
  ];

  for (const [, mutate, message] of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-family-classification-'));
    try {
      fs.cpSync('source', path.join(root, 'source'), { recursive: true });
      const familyPath = path.join(root, 'source/themeFamilyContract.json');
      const family = readJson<any>(familyPath);
      mutate(family);
      fs.writeFileSync(familyPath, `${JSON.stringify(family)}\n`);

      expect(() => loadThemeRepository(root)).toThrow(message);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('family hue mappings are invariant under profile and JSON key reordering', () => {
  const baseline = loadThemeRepository();
  const resolved = (repository: ReturnType<typeof loadThemeRepository>) =>
    repository.sources.map((source) => ({
      slug: source.slug,
      theme: readSourceTheme(source, repository.root, repository.definition),
    }));
  const expected = resolved(baseline);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-family-hue-order-'));

  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const familyPath = path.join(root, 'source/themeFamilyContract.json');
    const family = readJson<any>(familyPath);
    family.hueProfiles.reverse();
    family.pigmentHues = Object.fromEntries(
      Object.entries(family.pigmentHues)
        .reverse()
        .map(([pigment, hues]) => [pigment, Object.fromEntries(Object.entries(hues).reverse())])
    );
    fs.writeFileSync(familyPath, `${JSON.stringify(family)}\n`);

    expect(resolved(loadThemeRepository(root))).toEqual(expected);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('family hue mappings require exactly the declared profile keys', () => {
  const cases: Array<[string, (family: any) => void, string]> = [
    [
      'missing profile',
      (family) => {
        delete family.pigmentHues['syntax:function'].dawn;
      },
      "Theme family pigment 'syntax:function' hue profiles must exactly match family hue profiles.",
    ],
    [
      'extra profile',
      (family) => {
        family.pigmentHues['syntax:function'].unowned = 42;
      },
      "Theme family pigment 'syntax:function' hue profiles must exactly match family hue profiles.",
    ],
    [
      'positional profile array',
      (family) => {
        family.pigmentHues['syntax:function'] = [262.31849, 262.202658, 258.609429];
      },
      "Theme family pigment 'syntax:function' hue mapping must be an object.",
    ],
  ];

  for (const [, mutate, message] of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-family-hue-keys-'));
    try {
      fs.cpSync('source', path.join(root, 'source'), { recursive: true });
      const familyPath = path.join(root, 'source/themeFamilyContract.json');
      const family = readJson<any>(familyPath);
      mutate(family);
      fs.writeFileSync(familyPath, `${JSON.stringify(family)}\n`);

      expect(() => loadThemeDefinitionContext(root)).toThrow(message);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('opacity policy owns every derived alpha once and exposes only appearance overrides', () => {
  const definition = loadThemeDefinitionContext();
  expect(definition.opacityPolicy.dark['ui:border.tab']).toBe('FF');
  expect(definition.opacityPolicy.light['ui:border.tab']).toBe('00');
  expect(definition.opacityPolicy.dark['ui:selection.primary']).toBe('47');
  expect(definition.opacityPolicy.light['ui:selection.primary']).toBe('47');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-opacity-contract-'));
  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const opacityPath = path.join(root, 'source/themeOpacityContract.json');
    const opacity = readJson<any>(opacityPath);
    delete opacity.opacities['ui:selection.primary'];
    fs.writeFileSync(opacityPath, `${JSON.stringify(opacity)}\n`);

    expect(() => loadThemeDefinitionContext(root)).toThrow(
      'Theme opacity opacities is invalid; missing: ui:selection.primary'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('VS Code projection rejects invalid shapes and competing consumer ownership', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-vscode-projection-'));

  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts/projections'), { recursive: true });
    const projectionPath = path.join(root, 'scripts/projections/vscodeColors.json');
    const validProjection = readJson<Record<string, unknown>>(
      'scripts/projections/vscodeColors.json'
    );

    const invalidCases: Array<[string, (projection: any) => void, string]> = [
      [
        'schema version',
        (projection) => {
          projection.schemaVersion = 1;
        },
        'schemaVersion 6',
      ],
      [
        'top-level namespace',
        (projection) => {
          delete projection.vscode;
        },
        'unsupported or missing fields',
      ],
      [
        'mapping array',
        (projection) => {
          projection.ui['accent.primary'] = 'focusBorder';
        },
        'non-empty string array',
      ],
      [
        'grammar scope array',
        (projection) => {
          projection.tokenColors[0].scope = 'comment';
        },
        'non-empty string array',
      ],
      [
        'consumer key owner',
        (projection) => {
          projection.ui['surface.navigation'].push('focusBorder');
        },
        "color 'focusBorder' has multiple owners",
      ],
      [
        'contrast color owner',
        (projection) => {
          projection.contrastPairs[0].foreground = 'unowned.foreground';
        },
        "references unowned color 'unowned.foreground'",
      ],
      [
        'grammar scope owner',
        (projection) => {
          projection.tokenColors[1].scope.push('comment');
        },
        "grammar scope 'comment' has multiple owners",
      ],
      [
        'font style',
        (projection) => {
          projection.tokenColors[0].fontStyle = 'italic sparkle';
        },
        'invalid fontStyle',
      ],
      [
        'grammar entry fields',
        (projection) => {
          projection.tokenColors[0].foreground = '#FFFFFF';
        },
        'has unsupported fields: foreground',
      ],
      [
        'grammar role presence',
        (projection) => {
          delete projection.tokenColors[0].role;
        },
        'must define a role',
      ],
      [
        'grammar split role authority',
        (projection) => {
          projection.tokenColors[0].roles = { current: 'comment' };
        },
        'has unsupported fields: roles',
      ],
    ];

    for (const [, mutate, message] of invalidCases) {
      const projection = structuredClone(validProjection);
      mutate(projection);
      fs.writeFileSync(projectionPath, `${JSON.stringify(projection)}\n`);
      expect(() => loadVscodeProjection(root)).toThrow(message);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('VS Code generation consumes the projection from the injected repository root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-vscode-context-'));

  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts/projections'), { recursive: true });
    const projection = readJson<any>('scripts/projections/vscodeColors.json');
    projection.ui['surface.canvas'].push('injectedOwner.background');
    fs.writeFileSync(
      path.join(root, 'scripts/projections/vscodeColors.json'),
      `${JSON.stringify(projection)}\n`
    );

    const nightAsset = collectVscodeThemeAssets(root).find(
      (asset) => asset.path === 'apps/vscode/themes/tyrian-night.json'
    );
    const generated = JSON.parse(nightAsset!.content) as {
      colors: Record<string, string>;
    };
    const repository = loadThemeRepository(root);
    const source = repository.sources.find(({ slug }) => slug === 'tyrian-night')!;
    const theme = readSourceTheme(source, root, repository.definition);
    expect(generated.colors['injectedOwner.background']).toBe(
      themeColor(theme, 'ui:surface.canvas')
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function readIdentity(slug: string) {
  return VALID_IDENTITIES[slug as keyof typeof VALID_IDENTITIES];
}

function readClassification(slug: string) {
  return VALID_CLASSIFICATIONS[slug as keyof typeof VALID_CLASSIFICATIONS];
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function definitionFor(identity: { name: string }, appearance: 'dark' | 'light') {
  const bindings = DEFAULT_DEFINITION.colorBindings.bindings;
  const hueProfile = appearance === 'light' ? 'dawn' : 'core';
  const bindingValues = Object.values(bindings).flatMap((roles) => Object.values(roles));
  const oklch = Object.fromEntries(
    [
      ...new Set(
        bindingValues.map((binding) => (typeof binding === 'string' ? binding : binding.pigment))
      ),
    ]
      .toSorted()
      .map((pigment) => [
        pigment,
        [
          0.5,
          DEFAULT_DEFINITION.familyContract.pigmentHues[pigment][hueProfile] === null ? 0 : 0.02,
        ],
      ])
  );
  return {
    schemaVersion: 5,
    ...identity,
    oklch,
  };
}

function copyThemeContracts(root: string) {
  for (const fileName of [
    'themeRoleContract.json',
    'themeColorBindings.json',
    'themeOpacityContract.json',
    'themeFamilyContract.json',
  ]) {
    fs.copyFileSync(path.join('source', fileName), path.join(root, 'source', fileName));
  }
  const familyPath = path.join(root, 'source/themeFamilyContract.json');
  const family = readJson<any>(familyPath);
  family.canonical = 'tyrian-test-dark';
  family.energyLine = {
    hueProfile: 'core',
    canvasLightnessOrder: ['tyrian-test-dark'],
    variants: {
      'tyrian-test-dark': {
        semanticChromaRatio: { minimum: 1, maximum: 1 },
        semanticContrast: { minimum: 1, maximum: 21 },
      },
    },
  };
  family.branches = {
    'tyrian-test-light': {
      hueProfile: 'dawn',
      kind: 'light-counterpart',
      maximumSemanticHueDistance: 180,
    },
  };
  family.hueProfiles = ['core', 'dawn'];
  for (const hues of Object.values(family.pigmentHues) as Array<Record<string, number | null>>) {
    delete hues.pastel;
  }
  fs.writeFileSync(familyPath, `${JSON.stringify(family)}\n`);
}
