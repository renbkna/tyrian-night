import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import {
  getTerminalDefaultThemeSource,
  normalizeThemeCatalog,
  readThemeSources,
} from '../scripts/themeSources.mjs';

const VALID_CATALOG = [
  { slug: 'tyrian-test-dark', default: true, terminalDefault: true },
  { slug: 'tyrian-test-light', terminalDefault: true },
];

const VALID_IDENTITIES = {
  'tyrian-test-dark': { name: 'Tyrian Test Dark', type: 'dark' },
  'tyrian-test-light': { name: 'Tyrian Test Light', type: 'light' },
} as const;

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
    'tyrian-test-light': { name: 'Tyrian Test Dark', type: 'light' },
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
        ? { name: 'Tyrian Second Dark', type: 'dark' }
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
    fs.writeFileSync(
      path.join(root, 'source/themeCatalog.json'),
      `${JSON.stringify(VALID_CATALOG)}\n`
    );
    for (const [slug, identity] of Object.entries(VALID_IDENTITIES)) {
      fs.writeFileSync(path.join(root, `source/themes/${slug}.json`), JSON.stringify(identity));
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
    fs.writeFileSync(
      path.join(root, 'source/themeCatalog.json'),
      `${JSON.stringify(VALID_CATALOG)}\n`
    );
    for (const [slug, identity] of Object.entries(VALID_IDENTITIES)) {
      fs.writeFileSync(path.join(root, `source/themes/${slug}.json`), JSON.stringify(identity));
    }
    fs.writeFileSync(
      path.join(root, 'source/themes/tyrian-orphan.json'),
      JSON.stringify({ name: 'Orphan', type: 'dark' })
    );

    expect(() => readThemeSources(root)).toThrow(
      'Source theme files are absent from the catalog: tyrian-orphan.json'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function readIdentity(slug: string) {
  return VALID_IDENTITIES[slug as keyof typeof VALID_IDENTITIES];
}
