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
  test('the safety contract guards the bright ANSI labels and warm and cool states', () => {
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

  test('each contrast floor names a known metric and a minimum within that metric range', () => {
    const definition = loadThemeDefinitionContext();
    const cases: Array<[(entry: any) => void, string]> = [
      [
        (entry) => {
          delete entry.metric;
        },
        "metric must be 'apca' or 'wcag'",
      ],
      [
        (entry) => {
          entry.metric = 'apca';
          entry.minimum = 4.5;
        },
        'apca minimum must be within 15..106',
      ],
      [
        (entry) => {
          entry.metric = 'wcag';
          entry.minimum = 60;
        },
        'wcag minimum must be within 3..7',
      ],
    ];
    for (const [mutate, message] of cases) {
      const changed = structuredClone(contract);
      mutate(changed.contrast[0]);
      expect(() => validateThemeSafetyContract(changed, definition)).toThrow(message);
    }
  });

  test('supporting UI text below its WCAG floor fails', () => {
    const source = SOURCE_THEMES.find(({ slug }) => slug === 'tyrian-nocturne')!;
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
        constraint: 'readable-code',
        kind: 'apca-minimum-contrast',
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
    expect(report.contrastPairs.map(({ id }) => id)).toEqual(
      contract.contrastPairs.map(({ id }) => id)
    );
    // Admitted themes clear every pair floor, so the report must show that.
    for (const [index, pair] of report.contrastPairs.entries()) {
      expect(pair.contrast).toBeGreaterThanOrEqual(contract.contrastPairs[index]!.minimum);
    }
  });
});
