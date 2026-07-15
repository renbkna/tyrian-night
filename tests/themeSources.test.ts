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
  loadVscodeProjectionContext,
  themePigmentOwner,
  validateThemeRecipe,
} from '../scripts/themeDefinition.mjs';
import { collectVscodeThemeAssets } from '../scripts/vscodeThemes.mjs';

const VALID_CATALOG = [
  { slug: 'tyrian-test-dark', default: true, terminalDefault: true },
  { slug: 'tyrian-test-light', terminalDefault: true },
];

const VALID_IDENTITIES = {
  'tyrian-test-dark': { appearance: 'dark', name: 'Tyrian Test Dark' },
  'tyrian-test-light': { appearance: 'light', name: 'Tyrian Test Light' },
} as const;
const DEFAULT_DEFINITION = loadThemeDefinitionContext();

test('theme catalog derives identity and appearance from theme sources', () => {
  const themes = normalizeThemeCatalog(VALID_CATALOG, readIdentity);

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
  expect(() => normalizeThemeCatalog(splitIdentity, readIdentity)).toThrow(
    'unsupported fields: label'
  );

  const duplicateSlug = structuredClone(VALID_CATALOG);
  duplicateSlug[1]!.slug = duplicateSlug[0]!.slug;
  expect(() => normalizeThemeCatalog(duplicateSlug, readIdentity)).toThrow(
    "slug 'tyrian-test-dark' is duplicated"
  );

  const duplicateNameIdentities = {
    ...VALID_IDENTITIES,
    'tyrian-test-light': { appearance: 'light', name: 'Tyrian Test Dark' },
  };
  expect(() =>
    normalizeThemeCatalog(
      VALID_CATALOG,
      (slug) => duplicateNameIdentities[slug as keyof typeof duplicateNameIdentities]
    )
  ).toThrow("source name 'Tyrian Test Dark' is duplicated");

  const duplicateDefault = structuredClone(VALID_CATALOG);
  duplicateDefault[1]!.default = true;
  expect(() => normalizeThemeCatalog(duplicateDefault, readIdentity)).toThrow(
    'Expected exactly one default source theme, found 2'
  );

  const missingLightTerminalDefault = structuredClone(VALID_CATALOG);
  missingLightTerminalDefault[1]!.terminalDefault = false;
  expect(() => normalizeThemeCatalog(missingLightTerminalDefault, readIdentity)).toThrow(
    'Expected exactly one light terminal default source theme, found 0'
  );

  const missingLightAppearance = [structuredClone(VALID_CATALOG[0]!)];
  expect(() => normalizeThemeCatalog(missingLightAppearance, readIdentity)).toThrow(
    'Expected exactly one light terminal default source theme, found 0'
  );

  const duplicateDarkTerminalDefault = [
    ...structuredClone(VALID_CATALOG),
    { slug: 'tyrian-second-dark', terminalDefault: true },
  ];
  expect(() =>
    normalizeThemeCatalog(duplicateDarkTerminalDefault, (slug) =>
      slug === 'tyrian-second-dark'
        ? { appearance: 'dark', name: 'Tyrian Second Dark' }
        : readIdentity(slug)
    )
  ).toThrow('Expected exactly one dark terminal default source theme, found 2');

  const nonTyrianSlug = structuredClone(VALID_CATALOG);
  nonTyrianSlug[0]!.slug = 'other-dark';
  expect(() =>
    normalizeThemeCatalog(nonTyrianSlug, (slug) =>
      slug === 'other-dark' ? VALID_IDENTITIES['tyrian-test-dark'] : readIdentity(slug)
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
        JSON.stringify(definitionFor(identity))
      );
    }

    expect(readThemeSources(root).map(({ label }) => label)).toEqual([
      'Tyrian Test Dark',
      'Tyrian Test Light',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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
        JSON.stringify(definitionFor(identity))
      );
    }
    fs.writeFileSync(
      path.join(root, 'source/themes/tyrian-orphan.json'),
      JSON.stringify(definitionFor({ name: 'Orphan', appearance: 'dark' }))
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

    for (const fileName of fs.readdirSync(path.join(root, 'source/themes'))) {
      const themePath = path.join(root, 'source/themes', fileName);
      const theme = readJson<Record<string, unknown>>(themePath) as {
        pigments: Record<string, string>;
      };
      theme.pigments['ui:injected.owner.role'] = '#123456';
      fs.writeFileSync(themePath, `${JSON.stringify(theme)}\n`);
    }

    const repository = loadThemeRepository(root);
    expect(repository.definition.requiredThemeRoles.ui).toContain('injected.owner.role');
    expect(repository.sources).toHaveLength(6);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source recipes own pigments once and resolve declared alpha projections', () => {
  const repository = loadThemeRepository();
  const source = repository.sources.find(({ slug }) => slug === 'tyrian-nocturne');
  expect(source).toBeDefined();
  const recipe = readSourceThemeRecipe(source!, repository.root, repository.definition);
  const theme = readSourceTheme(source!, repository.root, repository.definition);

  expect(recipe).not.toHaveProperty('ui');
  expect(recipe.pigments['ui:status.success']).toBe('#9D769F');
  expect(recipe.opacities['ui:status.successBackground']).toBe('1C');
  expect(theme.ui['status.successBackground']).toBe('#9D769F1C');
  expect(themePigmentOwner(repository.definition, recipe.bindingProfile, 'syntax:function')).toBe(
    'syntax:function'
  );
  expect(
    themePigmentOwner(
      repository.definition,
      recipe.bindingProfile,
      'vscode:diff.editor.inserted.text.background'
    )
  ).toBe('ui:status.success');
});

test('color bindings contain only aliases and alpha-derived exceptions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-color-bindings-'));
  try {
    fs.cpSync('source', path.join(root, 'source'), { recursive: true });
    const bindingsPath = path.join(root, 'source/themeColorBindings.json');
    const bindings = readJson<any>(bindingsPath);
    bindings.profiles.current.aliases['syntax:function'] = 'syntax:function';
    fs.writeFileSync(bindingsPath, `${JSON.stringify(bindings)}\n`);

    expect(() => loadThemeRepository(root)).toThrow("has redundant alias 'syntax:function'");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('theme recipe validation rejects split or incomplete color authority', () => {
  const source = loadThemeRepository().sources.find(({ slug }) => slug === 'tyrian-night');
  expect(source).toBeDefined();
  const recipe = readSourceThemeRecipe(source!);

  const split = structuredClone(recipe) as any;
  split.ui = { 'surface.canvas': '#000000' };
  expect(() => validateThemeRecipe(split, source!.slug)).toThrow('unsupported fields: ui');

  const missing = structuredClone(recipe);
  delete missing.pigments['syntax:function'];
  expect(() => validateThemeRecipe(missing, source!.slug)).toThrow(
    'invalid pigments; missing: syntax:function'
  );

  const unknownProfile = structuredClone(recipe);
  unknownProfile.bindingProfile = 'shadow-authority';
  expect(() => validateThemeRecipe(unknownProfile, source!.slug)).toThrow(
    'unknown binding profile'
  );
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
        'schemaVersion 3',
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
        'semantic boolean',
        (projection) => {
          projection.semanticTokenColors['*.declaration'].bold = 'true';
        },
        'non-boolean bold flag',
      ],
      [
        'semantic role',
        (projection) => {
          projection.semanticTokenColors.parameter.role = 42;
        },
        'must be a non-empty string',
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
        'unsupported or missing fields',
      ],
    ];

    for (const [, mutate, message] of invalidCases) {
      const projection = structuredClone(validProjection);
      mutate(projection);
      fs.writeFileSync(projectionPath, `${JSON.stringify(projection)}\n`);
      expect(() => loadVscodeProjectionContext(root)).toThrow(message);
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
    expect(generated.colors['injectedOwner.background']).toBe('#0F0E13');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function readIdentity(slug: string) {
  return VALID_IDENTITIES[slug as keyof typeof VALID_IDENTITIES];
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function definitionFor(identity: { appearance: 'dark' | 'light'; name: string }) {
  const profile = DEFAULT_DEFINITION.colorBindingProfiles.current;
  const bindings = Object.values(profile.bindings).flatMap((roles) => Object.values(roles));
  const pigments = Object.fromEntries(
    [
      ...new Set(
        bindings.map((binding) => (typeof binding === 'string' ? binding : binding.pigment))
      ),
    ]
      .toSorted()
      .map((pigment) => [pigment, '#123456'])
  );
  const opacities = Object.fromEntries(
    bindings
      .filter(
        (binding): binding is { opacity: string; pigment: string } => typeof binding === 'object'
      )
      .map((binding) => binding.opacity)
      .toSorted()
      .map((opacity) => [opacity, 'FF'])
  );
  return {
    schemaVersion: 3,
    ...identity,
    bindingProfile: 'current',
    pigments,
    opacities,
  };
}

function copyThemeContracts(root: string) {
  for (const fileName of ['themeRoleContract.json', 'themeColorBindings.json']) {
    fs.copyFileSync(path.join('source', fileName), path.join(root, 'source', fileName));
  }
}
