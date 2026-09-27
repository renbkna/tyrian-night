import { SOURCE_THEMES, sourceTheme } from '../support/themes.js';
import { describe, expect, test } from 'bun:test';

import { loadThemeDefinitionContext } from '../../scripts/themeDefinition.mjs';
import {
  auditThemeSafety,
  readThemeSafetyContract,
  reportThemeColorDiagnostics,
  validateThemeSafetyContract,
} from '../../scripts/themeSafety.mjs';

const contract = readThemeSafetyContract();

describe('theme safety authority', () => {
  test('every production theme clears readability and state-identity gates', () => {
    const independentLabels = contract.contrast.find(
      ({ id }) => id === 'readable-independent-state-labels'
    )!;
    expect(independentLabels.roles).toEqual(
      expect.arrayContaining([
        'terminal:ansi.brightRed',
        'terminal:ansi.brightGreen',
        'terminal:ansi.brightYellow',
        'terminal:ansi.brightBlue',
        'terminal:ansi.brightMagenta',
        'terminal:ansi.brightCyan',
      ])
    );
    expect(contract.stateComparisons.map(({ id }) => id)).toEqual(
      expect.arrayContaining(['ansi-bright-warm-states', 'ansi-bright-cool-states'])
    );
    for (const source of SOURCE_THEMES) {
      expect(auditThemeSafety(sourceTheme(source), contract)).toEqual([]);
    }
  });

  test('an emptied constraint list is rejected instead of admitting every palette', () => {
    const definition = loadThemeDefinitionContext();
    for (const list of ['contrast', 'contrastPairs', 'stateComparisons'] as const) {
      const emptied = { ...structuredClone(contract), [list]: [] };
      expect(() => validateThemeSafetyContract(emptied, definition)).toThrow(
        `${list} must not be empty`
      );
    }
  });

  test('the historical-reference theme follows the same safety gates', () => {
    const source = SOURCE_THEMES.find(({ slug }) => slug === 'tyrian-night-old')!;
    const unreadable = structuredClone(sourceTheme(source));
    unreadable.ui['text.muted'] = unreadable.ui['surface.canvas'];
    expect(auditThemeSafety(unreadable, contract)).toContainEqual(
      expect.objectContaining({
        constraint: 'readable-supporting-ui',
        kind: 'wcag-minimum-contrast',
        role: 'ui:text.muted',
      })
    );
  });

  test('readability and identical state colors fail at their owning boundary', () => {
    const source = SOURCE_THEMES.find(({ slug }) => slug === 'tyrian-nocturne')!;
    const theme = sourceTheme(source);
    const unreadable = structuredClone(theme);
    unreadable.syntax.function = unreadable.ui['surface.canvas'];
    expect(auditThemeSafety(unreadable, contract)).toContainEqual(
      expect.objectContaining({
        constraint: 'readable-syntax',
        kind: 'wcag-minimum-contrast',
        role: 'syntax:function',
      })
    );

    const collapsedState = structuredClone(theme);
    collapsedState.ui['status.success'] = collapsedState.ui['status.error'];
    expect(auditThemeSafety(collapsedState, contract)).toContainEqual(
      expect.objectContaining({
        constraint: 'status-states',
        kind: 'identical-independent-state-color',
        roles: ['ui:status.error', 'ui:status.success'],
      })
    );

    const collapsedBrightAnsi = structuredClone(theme);
    collapsedBrightAnsi.terminal['ansi.brightCyan'] =
      collapsedBrightAnsi.terminal['ansi.brightMagenta'];
    expect(auditThemeSafety(collapsedBrightAnsi, contract)).toContainEqual(
      expect.objectContaining({
        constraint: 'ansi-bright-cool-states',
        kind: 'identical-independent-state-color',
        roles: ['terminal:ansi.brightMagenta', 'terminal:ansi.brightCyan'],
      })
    );
  });

  test('construction-space observations remain advisory without conformance output', () => {
    const source = SOURCE_THEMES.find(({ slug }) => slug === 'tyrian-nocturne')!;
    const report = reportThemeColorDiagnostics(sourceTheme(source), source.slug, contract);

    expect(report).not.toHaveProperty('passed');
    expect(report).not.toHaveProperty('score');
    expect(report.roles.length).toBeGreaterThan(10);
    expect(report.stateComparisons.length).toBe(contract.stateComparisons.length);
    expect(
      report.stateComparisons.every(({ pairs }) =>
        pairs.every(
          ({ cvdOklabDelta, oklabDelta }) =>
            Number.isFinite(oklabDelta) &&
            Object.values(cvdOklabDelta).every((delta) => Number.isFinite(delta))
        )
      )
    ).toBe(true);
    expect(
      report.roles.every(
        ({
          contrast,
          oklch,
          richness,
        }: {
          contrast: number;
          oklch: { L: number };
          richness: number;
        }) =>
          Number.isFinite(contrast) && Number.isFinite(oklch.L) && richness >= 0 && richness <= 1
      )
    ).toBe(true);
  });
});
