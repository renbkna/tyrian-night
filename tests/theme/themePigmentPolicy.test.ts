import { SOURCE_THEMES, sourceTheme } from '../support/themes.js';
import { describe, expect, test } from 'bun:test';

import {
  auditThemePigmentPolicy,
  readThemePigmentPolicy,
} from '../../scripts/themePigmentPolicy.mjs';

const policy = readThemePigmentPolicy();

describe('theme pigment policy authority', () => {
  test('every production recipe satisfies the family hue reservation', () => {
    for (const source of SOURCE_THEMES) {
      expect(auditThemePigmentPolicy(sourceTheme(source), policy)).toEqual([]);
    }
  });

  test('a code role that takes the string pigment breaks the green-cyan reservation', () => {
    const source = SOURCE_THEMES.find(({ slug }) => slug === 'tyrian-nocturne')!;
    const theme = structuredClone(sourceTheme(source));
    theme.syntax.function = theme.syntax.string;

    expect(auditThemePigmentPolicy(theme, policy)).toEqual([
      expect.objectContaining({
        role: 'syntax:function',
        reservation: 'green-cyan-reserved',
      }),
    ]);
  });

  test('reservation roles are the only allowed hue occupants across every catalog theme', () => {
    const withoutAllowedRoles = structuredClone(policy);
    const reservation = withoutAllowedRoles.reservations.find(
      ({ id }) => id === 'green-cyan-reserved'
    )!;
    const allowedRoles = reservation.allowedRoles;
    reservation.allowedRoles = [];
    const observedGreenRoles = new Set(
      SOURCE_THEMES.flatMap((source) =>
        auditThemePigmentPolicy(sourceTheme(source), withoutAllowedRoles).map(({ role }) => role)
      )
    );
    expect([...observedGreenRoles].toSorted()).toEqual([...allowedRoles].toSorted());
  });
});
