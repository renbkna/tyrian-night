import { expect, test } from 'bun:test';
import fs from 'node:fs';

import { themeColor } from '../scripts/themeDefinition.mjs';
import {
  buildProductionFamilyPreview,
  writeProductionFamilyPreview,
} from '../scripts/themePreview.mjs';
import { loadThemeRepository, readSourceTheme } from '../scripts/themeSources.mjs';

test('production preview projects every catalog theme from resolved source roles', () => {
  const repository = loadThemeRepository();
  const family = repository.definition.familyContract;
  const previews = buildProductionFamilyPreview();
  const catalogSources = repository.sources;

  expect(previews.map(({ id }) => id)).toEqual(catalogSources.map(({ slug }) => slug));
  expect(
    previews.filter(({ energy }) => energy === 'canonical family center').map(({ id }) => id)
  ).toEqual([family.canonical]);
  for (const source of catalogSources) {
    const theme = readSourceTheme(source, repository.root, repository.definition);
    const preview = previews.find(({ id }) => id === source.slug);
    expect(preview).toBeDefined();
    if (!preview) continue;
    expect(preview.palette.canvas).toBe(themeColor(theme, 'ui:surface.canvas'));
    expect(preview.palette.accent).toBe(themeColor(theme, 'ui:accent.primary'));
    expect(preview.palette.function).toBe(themeColor(theme, 'syntax:function'));
    expect(preview.palette.data).toBe(themeColor(theme, 'syntax:data'));
  }
});

test('production preview output is generated and current', () => {
  expect(writeProductionFamilyPreview(undefined, { check: true })).toEqual([]);
  const html = fs.readFileSync('examples/theme-preview/zed-family-lab.html', 'utf8');
  expect(html).toContain('<script src="./generated/production-family.js"></script>');
  expect(html).toContain('Current production family');
  expect(html).toContain('window.TYRIAN_PRODUCTION_FAMILY');
  expect(html).toContain('if (!Array.isArray(source))');
  expect(html).not.toContain('TYRIAN_PRODUCTION_FAMILY ?? []');
  expect(html).toContain('fixed editor and terminal scene');
  for (const forbidden of ['N1', 'N2', 'N3', 'N4', 'commit-pinned', 'location.hash', 'candidate']) {
    expect(html.toLowerCase()).not.toContain(forbidden.toLowerCase());
  }
});
