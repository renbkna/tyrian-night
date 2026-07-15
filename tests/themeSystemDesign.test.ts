import { expect, test } from 'bun:test';

import { COLOR_VISION_MODES, simulateColorVision } from '../scripts/colorVision.mjs';
import {
  auditRolePairs,
  colorMetrics,
  compareColors,
  contrastRatio,
  themeRoleColors,
} from '../scripts/colorScience.mjs';
import { SOURCE_THEMES, readSourceTheme } from '../scripts/themeSources.mjs';
import { syntaxColor, terminalColor, uiColor } from '../scripts/themeDefinition.mjs';

const AA_TEXT_CONTRAST = 4.5;
const AAA_TEXT_CONTRAST = 7;

test('the current family exposes four deliberate visual poles plus one exact legacy theme', () => {
  expect(SOURCE_THEMES.map(({ slug }) => slug)).toEqual([
    'tyrian-night',
    'tyrian-nocturne',
    'tyrian-abyss',
    'tyrian-dawn',
    'tyrian-night-old',
  ]);

  const legacySource = SOURCE_THEMES.find(({ slug }) => slug === 'tyrian-night-old');
  expect(legacySource).toBeDefined();
  const legacy = readSourceTheme(legacySource!);
  expect(uiColor(legacy, 'surface.canvas')).toBe('#0C0C0C');
  expect(syntaxColor(legacy, 'keyword')).toBe('#8B6ABD');
  expect(syntaxColor(legacy, 'function')).toBe('#3A9690');

  const current = SOURCE_THEMES.filter(({ slug }) => slug !== 'tyrian-night-old').map((source) =>
    readSourceTheme(source)
  );
  const canvases = new Set(current.map((theme) => uiColor(theme, 'surface.canvas')));
  const accents = new Set(current.map((theme) => uiColor(theme, 'accent.primary')));

  expect(canvases.size).toBe(current.length);
  expect(accents.size).toBe(current.length);
});

test('surface ladders are perceptibly layered instead of aliases', () => {
  const adjacentPairs = [
    ['surface.canvas', 'surface.navigation', 2],
    ['surface.navigation', 'surface.chrome', 1.5],
    ['surface.chrome', 'surface.sidebar', 1.2],
    ['surface.field', 'surface.raised', 1.8],
    ['surface.raised', 'surface.hover', 2],
  ] as const;

  for (const source of SOURCE_THEMES) {
    if (source.slug === 'tyrian-night-old') continue;
    const theme = readSourceTheme(source);

    for (const [leftRole, rightRole, minimum] of adjacentPairs) {
      const left = uiColor(theme, leftRole);
      const right = uiColor(theme, rightRole);
      expect(left).not.toBe(right);
      expect(compareColors({ left, right }).oklabDelta).toBeGreaterThanOrEqual(minimum);
    }
  }
});

test('all current syntax and supporting text roles clear the load-bearing contrast floor', () => {
  for (const source of SOURCE_THEMES) {
    if (source.slug === 'tyrian-night-old') continue;
    const theme = readSourceTheme(source);
    const background = uiColor(theme, 'surface.canvas');

    expect(contrastRatio(uiColor(theme, 'text.primary'), background)).toBeGreaterThanOrEqual(
      AAA_TEXT_CONTRAST
    );

    for (const role of [
      'text.secondary',
      'text.muted',
      'text.chrome',
      'text.sidebar',
      'text.status',
    ]) {
      expect(contrastRatio(uiColor(theme, role), background)).toBeGreaterThanOrEqual(
        AA_TEXT_CONTRAST
      );
    }

    for (const role of Object.keys(theme.syntax)) {
      expect(contrastRatio(syntaxColor(theme, role), background)).toBeGreaterThanOrEqual(
        AA_TEXT_CONTRAST
      );
    }
  }
});

test('supporting text stays subordinate and focus remains visible against adjacent surfaces', () => {
  for (const source of SOURCE_THEMES) {
    if (source.slug === 'tyrian-night-old') continue;
    const theme = readSourceTheme(source);
    const background = uiColor(theme, 'surface.canvas');
    const primaryContrast = contrastRatio(uiColor(theme, 'text.primary'), background);
    const secondaryContrast = contrastRatio(uiColor(theme, 'text.secondary'), background);
    const mutedContrast = contrastRatio(uiColor(theme, 'text.muted'), background);

    expect(primaryContrast).toBeGreaterThan(secondaryContrast);
    expect(secondaryContrast).toBeGreaterThan(mutedContrast);
    for (const role of ['text.chrome', 'text.sidebar', 'text.status']) {
      expect(primaryContrast).toBeGreaterThan(contrastRatio(uiColor(theme, role), background));
    }

    const focus = uiColor(theme, 'accent.primary');
    for (const surface of ['surface.canvas', 'surface.field', 'surface.raised', 'surface.hover']) {
      expect(contrastRatio(focus, uiColor(theme, surface))).toBeGreaterThanOrEqual(3);
    }

    const field = uiColor(theme, 'surface.field');
    const quietBorder = uiColor(theme, 'border.default');
    const hoverBorder = uiColor(theme, 'border.hover');
    const quietContrast = contrastRatio(quietBorder, field);
    const hoverContrast = contrastRatio(hoverBorder, field);
    const focusContrast = contrastRatio(focus, field);

    expect(hoverContrast).toBeGreaterThan(quietContrast);
    expect(focusContrast).toBeGreaterThan(hoverContrast);
    expect(colorMetrics(hoverBorder, field).oklch.C).toBeLessThan(
      colorMetrics(focus, field).oklch.C
    );
  }
});

test('categorical ANSI colors and semantic status colors no longer collide', () => {
  for (const source of SOURCE_THEMES) {
    if (source.slug === 'tyrian-night-old') continue;
    const theme = readSourceTheme(source);

    expect(
      compareColors({
        left: terminalColor(theme, 'ansi.red'),
        right: terminalColor(theme, 'ansi.cyan'),
      }).oklabDelta
    ).toBeGreaterThanOrEqual(20);

    expect(
      compareColors({
        left: syntaxColor(theme, 'function'),
        right: uiColor(theme, 'status.error'),
      }).oklabDelta
    ).toBeGreaterThanOrEqual(20);
  }
});

test('current themes have no pair-specific syntax collision warnings', () => {
  for (const source of SOURCE_THEMES) {
    if (source.slug === 'tyrian-night-old') continue;
    const theme = readSourceTheme(source);

    expect(auditRolePairs(themeRoleColors(theme))).toEqual([]);
  }
});

test('critical adjacent roles remain distinguishable through complete dichromacy simulations', () => {
  const rules = [
    ['syntax', 'function', 'syntax', 'string', 10, 3],
    ['syntax', 'keyword', 'syntax', 'type', 10, 5],
    ['syntax', 'data', 'syntax', 'keyword', 10, 8],
    ['syntax', 'regexp', 'syntax', 'string', 12, 3],
    ['ui', 'status.error', 'ui', 'status.success', 19, 4],
    ['ui', 'status.warning', 'ui', 'status.success', 12, 3],
  ] as const;

  for (const source of SOURCE_THEMES) {
    if (source.slug === 'tyrian-night-old') continue;
    const theme = readSourceTheme(source);
    const background = uiColor(theme, 'surface.canvas');

    for (const [
      leftNamespace,
      leftRole,
      rightNamespace,
      rightRole,
      normalMinimum,
      cvdMinimum,
    ] of rules) {
      const left = leftNamespace === 'ui' ? uiColor(theme, leftRole) : syntaxColor(theme, leftRole);
      const right =
        rightNamespace === 'ui' ? uiColor(theme, rightRole) : syntaxColor(theme, rightRole);

      expect(compareColors({ left, right }).oklabDelta).toBeGreaterThanOrEqual(normalMinimum);
      for (const mode of COLOR_VISION_MODES) {
        const simulatedLeft = simulateColorVision(left, mode, background);
        const simulatedRight = simulateColorVision(right, mode, background);
        expect(
          compareColors({ left: simulatedLeft, right: simulatedRight }).oklabDelta
        ).toBeGreaterThanOrEqual(cvdMinimum);
      }
    }
  }
});

test('hover, active, checked, and focus surfaces remain separate state signals', () => {
  for (const source of SOURCE_THEMES) {
    if (source.slug === 'tyrian-night-old') continue;
    const theme = readSourceTheme(source);
    const roles = [
      'effect.hoverSurface',
      'effect.activeSurface',
      'effect.checkedSurface',
      'effect.focusSurface',
      'effect.strongAccent',
    ];
    const colors = roles.map((role) => uiColor(theme, role));

    expect(new Set(colors).size).toBe(colors.length);
    expect(compareColors({ left: colors[0]!, right: colors[1]! }).oklabDelta).toBeGreaterThan(2);
    expect(compareColors({ left: colors[2]!, right: colors[4]! }).oklabDelta).toBeGreaterThan(8);
  }
});
