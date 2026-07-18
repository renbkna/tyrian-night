import { describe, expect, test } from 'bun:test';

import { auditThemePigmentPolicy, readThemePigmentPolicy } from '../scripts/themePigmentPolicy.mjs';
import { SOURCE_THEMES, readSourceTheme } from '../scripts/themeSources.mjs';

const policy = readThemePigmentPolicy();

describe('theme pigment policy authority', () => {
  test('every production recipe satisfies the family hue reservation', () => {
    for (const source of SOURCE_THEMES) {
      expect(auditThemePigmentPolicy(readSourceTheme(source), source.slug, policy)).toEqual([]);
    }
  });

  test('green and cyan are rejected for important code roles', () => {
    const source = SOURCE_THEMES.find(({ slug }) => slug === 'tyrian-nocturne')!;
    const theme = structuredClone(readSourceTheme(source));
    theme.syntax.function = theme.syntax.string;

    expect(auditThemePigmentPolicy(theme, source.slug, policy)).toEqual([
      expect.objectContaining({
        role: 'syntax:function',
        reservation: 'green-cyan-reserved',
      }),
    ]);

    const legacy = readSourceTheme(SOURCE_THEMES.find(({ slug }) => slug === 'tyrian-night-old')!);
    theme.syntax.function = legacy.syntax.function;
    expect(auditThemePigmentPolicy(theme, source.slug, policy)).toEqual([
      expect.objectContaining({
        role: 'syntax:function',
        reservation: 'green-cyan-reserved',
      }),
    ]);
  });

  test('every exemption is an exact live frozen-legacy violation', () => {
    const reservation = policy.reservations.find(({ id }) => id === 'green-cyan-reserved')!;
    expect(reservation.exemptions.map(({ role, theme }) => ({ role, theme }))).toEqual([
      { role: 'brackets:depth2', theme: 'tyrian-night-old' },
      { role: 'brackets:depth4', theme: 'tyrian-night-old' },
      { role: 'syntax:function', theme: 'tyrian-night-old' },
      { role: 'terminal:ansi.brightCyan', theme: 'tyrian-night-old' },
      { role: 'terminal:ansi.cyan', theme: 'tyrian-night-old' },
    ]);
    const withoutExemptions = structuredClone(policy);
    withoutExemptions.reservations[0].allowedRoles = [];
    withoutExemptions.reservations[0].exemptions = [];
    const observedGreenRoles = new Set(
      SOURCE_THEMES.flatMap((source) =>
        auditThemePigmentPolicy(readSourceTheme(source), source.slug, withoutExemptions).map(
          ({ role }) => role
        )
      )
    );
    expect([...observedGreenRoles].toSorted()).toEqual(
      [...reservation.allowedRoles, ...reservation.exemptions.map(({ role }) => role)].toSorted()
    );
  });
});
