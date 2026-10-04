import { readSourceData, writeSourceData } from '../support/sourceData.js';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import {
  getTerminalDefaultThemeSource,
  loadThemeInspectionRepository,
  loadThemeRepository,
  normalizeThemeCatalog,
  readSourceTheme,
} from '../../scripts/themeSources.mjs';
import {
  loadThemeDefinitionContext,
  resolveThemeRecipe,
  themeColor,
  validateThemeRecipe,
} from '../../scripts/themeDefinition.mjs';
import { collectVscodeThemeAssets } from '../../scripts/vscodeThemes.mjs';
import { loadVscodeProjection } from '../../scripts/vscodeProjection.mjs';
import {
  auditThemePigmentPolicy,
  readThemePigmentPolicy,
} from '../../scripts/themePigmentPolicy.mjs';
import { auditThemeSafety, readThemeSafetyContract } from '../../scripts/themeSafety.mjs';
import { buildTerminalThemeAssets } from '../../scripts/terminalThemes.mjs';
import { buildZedThemeFamily } from '../../scripts/zedTheme.mjs';

const VALID_CATALOG = [
  { slug: 'tyrian-test-dark', terminalDefault: true, islandEffects: 'test' },
  { slug: 'tyrian-test-light', terminalDefault: true, islandEffects: 'test' },
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
const DEFAULT_INSPECTION_REPOSITORY = loadThemeInspectionRepository();

function readDefaultThemeRecipe(source: { slug: string }) {
  return DEFAULT_INSPECTION_REPOSITORY.recipes.get(source.slug)!;
}

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
      (slug) => duplicateNameIdentities[slug as keyof typeof duplicateNameIdentities].name,
      readClassification
    )
  ).toThrow("source name 'Tyrian Test Dark' is duplicated");

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
    { slug: 'tyrian-second-dark', terminalDefault: true, islandEffects: 'test' },
  ];
  expect(() =>
    normalizeThemeCatalog(
      duplicateDarkTerminalDefault,
      (slug) => (slug === 'tyrian-second-dark' ? 'Tyrian Second Dark' : readIdentity(slug)),
      (slug) =>
        slug === 'tyrian-second-dark'
          ? { appearance: 'dark' as const, isDefault: false }
          : readClassification(slug)
    )
  ).toThrow('Expected exactly one dark terminal default source theme, found 2');

  const nonTyrianSlug = structuredClone(VALID_CATALOG);
  nonTyrianSlug[0]!.slug = 'other-dark';
  expect(() =>
    normalizeThemeCatalog(
      nonTyrianSlug,
      (slug) => (slug === 'other-dark' ? 'Tyrian Test Dark' : readIdentity(slug)),
      readClassification
    )
  ).toThrow("invalid slug 'other-dark'");
});

test('theme source reader resolves catalog and identity from the injected repository root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-theme-sources-'));

  try {
    fs.mkdirSync(path.join(root, 'source/themes'), { recursive: true });
    copyThemeContracts(root);
    writeSourceData(path.join(root, 'source/themeCatalog.cjs'), VALID_CATALOG);
    for (const [slug, identity] of Object.entries(VALID_IDENTITIES)) {
      writeSourceData(
        path.join(root, `source/themes/${slug}.cjs`),
        definitionFor(identity, readClassification(slug).appearance)
      );
    }

    expect(
      loadThemeInspectionRepository(root).sources.map(({ label, appearance, isDefault }) => [
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

    expect(source.appearance).toBe(expectedAppearance);
    expect(source.isDefault).toBe(source.slug === family.canonical);
  }
});

test('theme catalog is the exact authority for source recipe membership', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-theme-membership-'));

  try {
    fs.mkdirSync(path.join(root, 'source/themes'), { recursive: true });
    copyThemeContracts(root);
    writeSourceData(path.join(root, 'source/themeCatalog.cjs'), VALID_CATALOG);
    for (const [slug, identity] of Object.entries(VALID_IDENTITIES)) {
      writeSourceData(
        path.join(root, `source/themes/${slug}.cjs`),
        definitionFor(identity, readClassification(slug).appearance)
      );
    }
    writeSourceData(
      path.join(root, 'source/themes/tyrian-orphan.cjs'),
      definitionFor({ name: 'Orphan' }, 'dark')
    );

    expect(() => loadThemeInspectionRepository(root)).toThrow(
      'Source theme files are absent from the catalog: tyrian-orphan.cjs'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('injected repository role membership is validated by that repository context', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-theme-context-'));

  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const contractPath = path.join(root, 'source/themeRoleContract.cjs');
    const contract = readSourceData<Record<string, unknown>>(contractPath) as {
      ui: string[];
    };
    contract.ui.push('injected.owner.role');
    writeSourceData(contractPath, contract);
    const familyPath = path.join(root, 'source/themeFamilyContract.cjs');
    const family = readSourceData<any>(familyPath);
    family.pigmentHues['ui:injected.owner.role'] = Object.fromEntries(
      family.hueProfiles.map((profile: string) => [profile, 250])
    );
    for (const fileName of fs.readdirSync(path.join(root, 'source/themes'))) {
      const themePath = path.join(root, 'source/themes', fileName);
      const theme = readSourceData<any>(themePath);
      theme.oklch['ui:injected.owner.role'] = [0.5, 0.02];
      writeSourceData(themePath, theme);
    }
    writeSourceData(familyPath, family);

    const repository = loadThemeRepository(root);
    expect(repository.definition.requiredThemeRoles.ui).toContain('injected.owner.role');
    expect(repository.sources).toHaveLength(5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source recipes own pigments once and resolve family-derived alpha projections', () => {
  const repository = loadThemeRepository();
  const source = repository.sources.find(({ slug }) => slug === 'tyrian-nocturne');
  expect(source).toBeDefined();
  const recipe = readDefaultThemeRecipe(source!);
  const theme = readSourceTheme(source!, repository);

  expect(recipe).not.toHaveProperty('ui');
  expect(recipe).not.toHaveProperty('opacities');
  expect(recipe).not.toHaveProperty('appearance');
  expect(recipe).not.toHaveProperty('hueProfile');
  expect(recipe.oklch['ui:status.success']).toHaveLength(2);
  const success = themeColor(theme, 'ui:status.success');
  expect(success).toMatch(/^#[0-9A-F]{6}$/);
  expect(repository.definition.opacityPolicy.dark['ui:status.successBackground']).toBe('1C');
  expect(theme.ui['status.successBackground']).toBe(`${success}1C`);
  const expectResolvedFrom = (role: string, owner: string) =>
    expect(themeColor(theme, role).slice(0, 7)).toBe(themeColor(theme, owner).slice(0, 7));
  expectResolvedFrom('vscode:diff.editor.inserted.text.background', 'ui:status.success');
  expectResolvedFrom('terminal:ansi.green', 'ui:status.success');
  expectResolvedFrom('ui:badges.foreground', 'ui:text.onAccent');
  expectResolvedFrom('ui:border.tab', 'ui:border.default');
  expectResolvedFrom('vscode:editor.overviewRuler.bracketMatchForeground', 'ui:accent.glow');
  expectResolvedFrom('vscode:editor.overviewRuler.deletedForeground', 'ui:status.error');
  expectResolvedFrom('vscode:editor.overviewRuler.infoForeground', 'ui:status.info');
  expectResolvedFrom('vscode:editor.overviewRuler.warningForeground', 'ui:status.warning');
  expectResolvedFrom('vscode:preview.result.file.foreground', 'ui:text.sidebar');
  for (const role of [
    'vscode:input.validation.errorForeground',
    'vscode:input.validation.infoForeground',
    'vscode:input.validation.warningForeground',
  ]) {
    expectResolvedFrom(role, 'ui:text.primary');
  }
});

test('color bindings contain only aliases and alpha-derived exceptions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-color-bindings-'));
  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const bindingsPath = path.join(root, 'source/themeColorBindings.cjs');
    const bindings = readSourceData<any>(bindingsPath);
    bindings.aliases['syntax:function'] = 'syntax:function';
    writeSourceData(bindingsPath, bindings);

    expect(() => loadThemeRepository(root)).toThrow("has redundant alias 'syntax:function'");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('theme recipe validation rejects incomplete or out-of-gamut color authority', () => {
  const source = loadThemeRepository().sources.find(({ slug }) => slug === 'tyrian-night');
  expect(source).toBeDefined();
  const recipe = readDefaultThemeRecipe(source!);

  const missing = structuredClone(recipe);
  delete missing.oklch['ui:accent.primary'];
  expect(() => validateThemeRecipe(missing, source!.slug, DEFAULT_DEFINITION)).toThrow(
    'invalid oklch; missing: ui:accent.primary'
  );

  // Syntax colors are solved from targets; a recipe cannot author them.
  const authored = structuredClone(recipe);
  authored.oklch['syntax:function'] = [0.8, 0.1];
  expect(() => validateThemeRecipe(authored, source!.slug, DEFAULT_DEFINITION)).toThrow(
    'invalid oklch; unsupported: syntax:function'
  );

  const neutralChromaMissing = structuredClone(recipe);
  delete neutralChromaMissing.syntax.chroma['syntax:comment'];
  expect(() => validateThemeRecipe(neutralChromaMissing, source!.slug, DEFAULT_DEFINITION)).toThrow(
    'syntax targets chroma'
  );

  const unnamed = structuredClone(recipe);
  unnamed.name = ' Tyrian Night';
  expect(() => validateThemeRecipe(unnamed, source!.slug, DEFAULT_DEFINITION)).toThrow(
    'must have a trimmed, non-empty name'
  );

  const outOfGamut = structuredClone(recipe);
  outOfGamut.oklch['ui:accent.primary'] = [0.5, 0.5];
  expect(() => resolveThemeRecipe(outOfGamut, source!.slug, DEFAULT_DEFINITION)).toThrow(
    'outside the sRGB gamut'
  );
});

test('production snapshots reject unreadable palettes while inspection snapshots preserve the violation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-theme-safety-gate-'));
  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const themePath = path.join(root, 'source/themes/tyrian-nocturne.cjs');
    const recipe = readSourceData<any>(themePath);
    recipe.syntax.contrast.plain = 50;
    writeSourceData(themePath, recipe);

    expect(() => loadThemeRepository(root)).toThrow(
      "Theme 'tyrian-nocturne' violates theme safety policy"
    );
    expect(() => collectVscodeThemeAssets(root)).toThrow(
      "Theme 'tyrian-nocturne' violates theme safety policy"
    );

    const inspection = loadThemeInspectionRepository(root);
    const source = inspection.sources.find(({ slug }) => slug === 'tyrian-nocturne')!;
    const theme = inspection.themes.get(source.slug)!;
    const contract = readThemeSafetyContract(inspection.definition);
    expect(auditThemeSafety(theme, contract)).toContainEqual(
      expect.objectContaining({
        constraint: 'readable-plain-code',
        kind: 'apca-minimum-contrast',
        role: 'syntax:variable',
      })
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('color audit loads an inspection snapshot when production admission rejects the palette', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-theme-audit-'));
  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const themePath = path.join(root, 'source/themes/tyrian-nocturne.cjs');
    const recipe = readSourceData<any>(themePath);
    recipe.syntax.contrast.plain = 50;
    writeSourceData(themePath, recipe);

    const audit = spawnSync(
      process.execPath,
      ['scripts/themeColorAudit.mjs', `--root=${root}`, '--theme=tyrian-nocturne'],
      { cwd: process.cwd(), encoding: 'utf8' }
    );

    expect(audit.status).toBe(1);
    expect(audit.stdout).toContain('tyrian-nocturne: accessibility=1 violation(s)');
    expect(audit.stdout).toContain('"role":"syntax:variable"');
    expect(audit.stderr).toBe('');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production snapshots reject every duplicate bracket depth, including non-adjacent depths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-theme-bracket-gate-'));
  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const themePath = path.join(root, 'source/themes/tyrian-nocturne.cjs');
    const recipe = readSourceData<any>(themePath);
    // Gray brackets at one contrast target solve to one color.
    recipe.syntax.chroma['brackets:depth1'] = 0;
    recipe.syntax.chroma['brackets:depth3'] = 0;
    writeSourceData(themePath, recipe);

    expect(() => loadThemeRepository(root)).toThrow(
      "Theme 'tyrian-nocturne' violates theme safety policy"
    );
    expect(() => buildZedThemeFamily(root)).toThrow(
      "Theme 'tyrian-nocturne' violates theme safety policy"
    );

    const inspection = loadThemeInspectionRepository(root);
    const source = inspection.sources.find(({ slug }) => slug === 'tyrian-nocturne')!;
    const contract = readThemeSafetyContract(inspection.definition);
    expect(auditThemeSafety(inspection.themes.get(source.slug)!, contract)).toContainEqual({
      constraint: 'bracket-depths',
      kind: 'identical-independent-state-color',
      roles: ['brackets:depth1', 'brackets:depth3'],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production snapshots reject pigment-reservation violations while inspection can report them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-theme-pigment-gate-'));
  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const familyPath = path.join(root, 'source/themeFamilyContract.cjs');
    const family = readSourceData<any>(familyPath);
    family.pigmentHues['syntax:comment'].core = 146;
    writeSourceData(familyPath, family);

    expect(() => loadThemeRepository(root)).toThrow('violates theme pigment policy');

    const inspection = loadThemeInspectionRepository(root);
    const source = inspection.sources.find(({ slug }) => slug === 'tyrian-nocturne')!;
    const policy = readThemePigmentPolicy(inspection.definition);
    expect(auditThemePigmentPolicy(inspection.themes.get(source.slug)!, policy)).toContainEqual(
      expect.objectContaining({
        reservation: 'green-cyan-reserved',
        role: 'syntax:comment',
      })
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production source reads keep the validated snapshot when editable files change', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-theme-snapshot-'));
  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const repository = loadThemeRepository(root);
    const source = repository.sources.find(({ slug }) => slug === 'tyrian-nocturne')!;
    const theme = readSourceTheme(source, repository);
    const themePath = path.join(root, source.sourcePath);
    const recipe = readSourceData<any>(themePath);
    recipe.syntax.contrast.plain = 50;
    writeSourceData(themePath, recipe);

    expect(readSourceTheme(source, repository)).toBe(theme);
    expect(() => loadThemeRepository(root)).toThrow(
      "Theme 'tyrian-nocturne' violates theme safety policy"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('family relationship validation rejects syntax saturation drift', () => {
  const cases: Array<[(family: any) => void, string]> = [
    // Gamut-share band: Night's control flow is more vivid than a 0.45 ceiling allows.
    [
      (family) => {
        family.energyLine.variants['tyrian-night'].syntaxSaturation = {
          measure: 'richness',
          minimum: 0.4,
          maximum: 0.45,
        };
      },
      "Theme 'tyrian-night' syntax pigment 'syntax:control' richness",
    ],
    // Absolute-chroma band: Pastel's tints are more colorful than a 0.085 ceiling allows.
    [
      (family) => {
        family.branches['tyrian-pastel'].syntaxSaturation.maximum = 0.085;
      },
      "Theme 'tyrian-pastel' syntax pigment 'syntax:control' chroma",
    ],
    [
      (family) => {
        delete family.branches['tyrian-dawn'].syntaxSaturation;
      },
      "Theme family branch 'tyrian-dawn' must define a syntax saturation band.",
    ],
  ];

  for (const [mutate, message] of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-family-saturation-'));
    try {
      fs.cpSync('source', path.join(root, 'source'), { recursive: true });
      const familyPath = path.join(root, 'source/themeFamilyContract.cjs');
      const family = readSourceData<any>(familyPath);
      mutate(family);
      writeSourceData(familyPath, family);

      expect(() => loadThemeRepository(root)).toThrow(message);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('family relationship validation rejects syntax hierarchy drift', () => {
  const cases: Array<[string, string, number, string]> = [
    // Leads one point above supports no longer lead.
    ['tyrian-nocturne', 'lead', 50.5, "Theme 'tyrian-nocturne' syntax tier 'lead' over 'support'"],
    // On a light canvas higher contrast is darker, so these declarations outrank supports.
    ['tyrian-dawn', 'structure', 74, "Theme 'tyrian-dawn' syntax tier 'support' over 'structure'"],
    // Comments as strong as declaration keywords no longer recede.
    ['tyrian-night', 'quiet', 43, "Theme 'tyrian-night' syntax tier 'structure' over 'quiet'"],
  ];
  for (const [slug, tier, target, message] of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-family-syntax-hierarchy-'));
    try {
      fs.cpSync('source', path.join(root, 'source'), { recursive: true });
      const themePath = path.join(root, `source/themes/${slug}.cjs`);
      const theme = readSourceData<any>(themePath);
      theme.syntax.contrast[tier] = target;
      writeSourceData(themePath, theme);

      expect(() => loadThemeRepository(root)).toThrow(message);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('family relationship validation keeps the editor the lit stage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-family-editor-stage-'));
  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const themePath = path.join(root, 'source/themes/tyrian-nocturne.cjs');
    const theme = readSourceData<any>(themePath);
    theme.oklch['ui:surface.sidebar'][0] = 0.2;
    writeSourceData(themePath, theme);

    expect(() => loadThemeRepository(root)).toThrow(
      "Theme 'tyrian-nocturne' frame surface 'ui:surface.sidebar' is lighter than the editor stage."
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('family relationship validation keeps diagnostics at full saturation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-family-diagnostics-'));
  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const themePath = path.join(root, 'source/themes/tyrian-nocturne.cjs');
    const theme = readSourceData<any>(themePath);
    theme.oklch['ui:status.error'][1] = 0.05;
    writeSourceData(themePath, theme);

    expect(() => loadThemeRepository(root)).toThrow(
      "Theme 'tyrian-nocturne' diagnostic 'ui:status.error' richness"
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
        family.hueProfiles = family.hueProfiles.filter((profile: string) => profile !== 'dawn');
        for (const hues of Object.values(family.pigmentHues) as Array<Record<string, number>>) {
          delete hues.dawn;
        }
      },
      "Theme 'tyrian-dawn' has no family classification.",
    ],
    [
      'overlapping branch',
      (family) => {
        family.branches['tyrian-night'] = {
          hueProfile: 'core',
          kind: 'soft-focus',
          maximumSemanticHueDistance: 0,
          syntaxSaturation: { measure: 'richness', minimum: 0, maximum: 1 },
        };
      },
      'Theme family classifications must not overlap.',
    ],
  ];

  for (const [, mutate, message] of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-family-classification-'));
    try {
      fs.cpSync('source', path.join(root, 'source'), { recursive: true });
      const familyPath = path.join(root, 'source/themeFamilyContract.cjs');
      const family = readSourceData<any>(familyPath);
      mutate(family);
      writeSourceData(familyPath, family);

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
      theme: readSourceTheme(source, repository),
    }));
  const expected = resolved(baseline);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-family-hue-order-'));

  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const familyPath = path.join(root, 'source/themeFamilyContract.cjs');
    const family = readSourceData<any>(familyPath);
    family.hueProfiles.reverse();
    family.pigmentHues = Object.fromEntries(
      Object.entries(family.pigmentHues)
        .reverse()
        .map(([pigment, hues]) => [
          pigment,
          Object.fromEntries(Object.entries(hues as Record<string, unknown>).reverse()),
        ])
    );
    writeSourceData(familyPath, family);

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
  ];

  for (const [, mutate, message] of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-family-hue-keys-'));
    try {
      fs.cpSync('source', path.join(root, 'source'), { recursive: true });
      const familyPath = path.join(root, 'source/themeFamilyContract.cjs');
      const family = readSourceData<any>(familyPath);
      mutate(family);
      writeSourceData(familyPath, family);

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
  expect(definition.opacityPolicy.light['ui:selection.primary']).toBe(
    definition.opacityPolicy.dark['ui:selection.primary']
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-opacity-contract-'));
  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const opacityPath = path.join(root, 'source/themeOpacityContract.cjs');
    const opacity = readSourceData<any>(opacityPath);
    delete opacity.opacities['ui:selection.primary'];
    writeSourceData(opacityPath, opacity);

    expect(() => loadThemeDefinitionContext(root)).toThrow(
      'Theme opacity opacities is invalid; missing: ui:selection.primary'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('terminal and Zed generation do not require the VS Code projection file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-neutral-projection-boundary-'));
  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });

    expect(fs.existsSync(path.join(root, 'scripts/projections/vscodeColors.cjs'))).toBe(false);
    expect(() => buildTerminalThemeAssets(root)).not.toThrow();
    expect(() => buildZedThemeFamily(root)).not.toThrow();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('VS Code projection rejects invalid shapes and competing consumer ownership', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-vscode-projection-'));

  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts/projections'), { recursive: true });
    const projectionPath = path.join(root, 'scripts/projections/vscodeColors.cjs');
    const validProjection = readSourceData<Record<string, unknown>>(
      'scripts/projections/vscodeColors.cjs'
    );

    const invalidCases: Array<[string, (projection: any) => void, string]> = [
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
        'empty consumer key list',
        (projection) => {
          projection.ui['surface.navigation'] = [];
        },
        'must be a non-empty list of trimmed, non-empty names',
      ],
      [
        'empty grammar scope list',
        (projection) => {
          projection.tokenColors[0].scope = [];
        },
        'must be a non-empty list of trimmed, non-empty names',
      ],
      [
        'empty contrast contract',
        (projection) => {
          projection.contrastPairs = [];
        },
        'contrast contract must not be empty',
      ],
      [
        'semantic selector owner',
        (projection) => {
          projection.semanticTokenColors.push({ selector: 'parameter', role: 'type' });
        },
        "semantic token selector 'parameter' has multiple owners",
      ],
      [
        'semantic rule without effect',
        (projection) => {
          projection.semanticTokenColors.push({ selector: 'label' });
        },
        "semantic token selector 'label' sets no role or style",
      ],
      [
        'semantic rule role',
        (projection) => {
          projection.semanticTokenColors.push({ selector: 'label', role: 'keyword' });
        },
        "grammar projection references unknown role 'keyword'",
      ],
    ];

    for (const [, mutate, message] of invalidCases) {
      const projection = structuredClone(validProjection);
      mutate(projection);
      writeSourceData(projectionPath, projection);
      expect(() => loadVscodeProjection(loadThemeDefinitionContext(root))).toThrow(message);
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
    const projection = readSourceData<any>('scripts/projections/vscodeColors.cjs');
    projection.ui['surface.canvas'].push('injectedOwner.background');
    writeSourceData(path.join(root, 'scripts/projections/vscodeColors.cjs'), projection);

    const nightAsset = collectVscodeThemeAssets(root).find(
      (asset) => asset.path === 'apps/vscode/themes/tyrian-night.json'
    );
    const generated = JSON.parse(nightAsset!.content) as {
      colors: Record<string, string>;
    };
    const repository = loadThemeRepository(root);
    const source = repository.sources.find(({ slug }) => slug === 'tyrian-night')!;
    const theme = readSourceTheme(source, repository);
    expect(generated.colors['injectedOwner.background']).toBe(
      themeColor(theme, 'ui:surface.canvas')
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function readIdentity(slug: string) {
  return VALID_IDENTITIES[slug as keyof typeof VALID_IDENTITIES].name;
}

function readClassification(slug: string) {
  return VALID_CLASSIFICATIONS[slug as keyof typeof VALID_CLASSIFICATIONS];
}

function definitionFor(identity: { name: string }, appearance: 'dark' | 'light') {
  const family = DEFAULT_DEFINITION.familyContract;
  const bindings = DEFAULT_DEFINITION.colorBindings.bindings;
  const hueProfile = appearance === 'light' ? 'dawn' : 'core';
  const bindingValues = Object.values(bindings).flatMap((roles) => Object.values(roles));
  const solved = new Set([
    ...family.syntaxHierarchy.flatMap(({ pigments }) => pigments),
    family.plainSyntaxPigment,
  ]);
  const colored = new Set(family.syntaxSaturation.pigments);
  const hasHue = (pigment: string) => family.pigmentHues[pigment][hueProfile] !== null;
  // Authored pigments sit at L 0.5; the canvas and the frame around it sit at
  // the appearance's end so every solved syntax target is reachable.
  const { frame, stage } = family.editorStage;
  const lightness = (pigment: string) => {
    if (pigment === stage) return appearance === 'light' ? 0.95 : 0.2;
    if (frame.includes(pigment)) return appearance === 'light' ? 0.9 : 0.18;
    return 0.5;
  };
  const pigments = [
    ...new Set(
      bindingValues.map((binding) => (typeof binding === 'string' ? binding : binding.pigment))
    ),
  ].toSorted();
  const oklch = Object.fromEntries(
    pigments
      .filter((pigment) => !solved.has(pigment))
      .map((pigment) => [pigment, [lightness(pigment), hasHue(pigment) ? 0.02 : 0]])
  );
  // Tier targets are spaced past every family step so the fixture keeps the ladder.
  const contrast = Object.fromEntries([
    ...family.syntaxHierarchy.map(({ tier }, index) => [tier, 65 - index * 10]),
    ['plain', 75],
  ]);
  const chroma = Object.fromEntries(
    [...solved]
      .filter((pigment) => !colored.has(pigment))
      .map((pigment) => [pigment, hasHue(pigment) ? 0.02 : 0])
  );
  return {
    ...identity,
    syntax: { saturation: 0.02, contrast, chroma },
    oklch,
  };
}

function copyThemeContracts(root: string) {
  for (const fileName of [
    'themeRoleContract.cjs',
    'themeColorBindings.cjs',
    'themeOpacityContract.cjs',
    'themeFamilyContract.cjs',
  ]) {
    fs.copyFileSync(path.join('source', fileName), path.join(root, 'source', fileName));
  }
  const familyPath = path.join(root, 'source/themeFamilyContract.cjs');
  const family = readSourceData<any>(familyPath);
  family.canonical = 'tyrian-test-dark';
  // Fixture pigments share one low chroma; saturation relationships are proved on real recipes.
  family.diagnostics.minimumRichness = 0.01;
  for (const tier of family.syntaxHierarchy) delete tier.maximumChromaShareOfLead;
  const anySaturation = { measure: 'chroma', minimum: 0, maximum: 0.4 };
  family.energyLine = {
    hueProfile: 'core',
    canvasLightnessOrder: ['tyrian-test-dark'],
    variants: {
      'tyrian-test-dark': { syntaxSaturation: anySaturation },
    },
  };
  family.branches = {
    'tyrian-test-light': {
      hueProfile: 'dawn',
      kind: 'light-counterpart',
      maximumSemanticHueDistance: 180,
      syntaxSaturation: anySaturation,
    },
  };
  family.hueProfiles = ['core', 'dawn'];
  for (const hues of Object.values(family.pigmentHues) as Array<Record<string, number | null>>) {
    delete hues.pastel;
  }
  writeSourceData(familyPath, family);
}

test('a source module that is a symbolic link is rejected before it runs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-source-module-link-'));
  const marker = path.join(root, 'ran');

  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const outside = path.join(root, 'outside.cjs');
    fs.writeFileSync(
      outside,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '');\nmodule.exports = {};\n`
    );
    const contractPath = path.join(root, 'source/themeSafetyContract.cjs');
    fs.rmSync(contractPath);
    fs.symlinkSync(outside, contractPath);

    expect(() => loadThemeRepository(root)).toThrow('Source module must be a regular file');
    expect(fs.existsSync(marker)).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
