import { describe, expect, test } from 'bun:test';

import {
  auditThemePigmentPolicy,
  readThemePigmentPolicy,
  validateThemePigmentPolicy,
} from '../scripts/themePigmentPolicy.mjs';
import { SOURCE_THEMES, readSourceTheme } from '../scripts/themeSources.mjs';

const policy = readThemePigmentPolicy();

describe('theme pigment policy authority', () => {
  test('rejects the retired sole-current schema version', () => {
    const retired = structuredClone(policy);
    retired.schemaVersion = 1;
    expect(() => validateThemePigmentPolicy(retired)).toThrow('schemaVersion must be 2');
  });

  test('every production recipe satisfies the family hue reservation', () => {
    for (const source of SOURCE_THEMES) {
      expect(auditThemePigmentPolicy(readSourceTheme(source), policy)).toEqual([]);
    }
  });

  test('green and cyan are rejected for important code roles', () => {
    const source = SOURCE_THEMES.find(({ slug }) => slug === 'tyrian-nocturne')!;
    const theme = structuredClone(readSourceTheme(source));
    theme.syntax.function = theme.syntax.string;

    expect(auditThemePigmentPolicy(theme, policy)).toEqual([
      expect.objectContaining({
        role: 'syntax:function',
        reservation: 'green-cyan-reserved',
      }),
    ]);
  });

  test('reservation roles are the only allowed hue occupants across every catalog theme', () => {
    const reservation = policy.reservations.find(({ id }) => id === 'green-cyan-reserved')!;
    const withoutAllowedRoles = structuredClone(policy);
    withoutAllowedRoles.reservations[0].allowedRoles = [];
    const observedGreenRoles = new Set(
      SOURCE_THEMES.flatMap((source) =>
        auditThemePigmentPolicy(readSourceTheme(source), withoutAllowedRoles).map(
          ({ role }) => role
        )
      )
    );
    expect([...observedGreenRoles].toSorted()).toEqual([...reservation.allowedRoles].toSorted());
  });
});
