// @ts-check

import path from 'node:path';

import { hexToOklch, hueInsideRange } from './colorScience.mjs';
import { parseHexColor } from './colorUtils.mjs';
import {
  isKnownThemeRole,
  loadThemeDefinitionContext,
  POLICY_ID_PATTERN,
  qualifyRole,
  THEME_ROLE_NAMESPACES,
} from './themeDefinition.mjs';
import { loadSourceModule } from './sourceModule.mjs';

/**
 * A hue range only the listed roles may render in. Each entry is a decision about
 * what a role means (a string, a success state, a hint), so roles bound to the same
 * pigment are listed separately and rebinding a role onto a reserved pigment fails.
 * @typedef {{ allowedRoles: string[]; id: string; maximum: number; minimum: number }} PigmentReservation
 */
/** @typedef {{ reservations: PigmentReservation[] }} ThemePigmentPolicy */

/**
 * Reads the type-checked pigment policy and validates what types cannot:
 * identifier uniqueness, hue bounds, and role references into the role contract.
 *
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} [definition]
 * @returns {ThemePigmentPolicy}
 */
export function readThemePigmentPolicy(definition = loadThemeDefinitionContext()) {
  const policy = /** @type {ThemePigmentPolicy} */ (
    loadSourceModule(path.join(definition.root, 'source/themePigmentPolicy.cjs'))
  );
  const ids = new Set();
  invariant(policy.reservations.length > 0, 'reservations must not be empty');
  for (const reservation of policy.reservations) {
    invariant(
      POLICY_ID_PATTERN.test(reservation.id),
      `reservation id '${reservation.id}' must be kebab-case`
    );
    invariant(!ids.has(reservation.id), `reservation id ${reservation.id} is duplicated`);
    ids.add(reservation.id);
    for (const bound of [reservation.minimum, reservation.maximum]) {
      invariant(
        bound >= 0 && bound < 360,
        `reservation ${reservation.id} hue must be within 0..360`
      );
    }
    invariant(
      reservation.allowedRoles.length > 0,
      `reservation ${reservation.id} allowedRoles must not be empty`
    );
    invariant(
      new Set(reservation.allowedRoles).size === reservation.allowedRoles.length,
      `reservation ${reservation.id} allowedRoles contains duplicates`
    );
    for (const role of reservation.allowedRoles) {
      invariant(
        isKnownThemeRole(role, definition.requiredThemeRoles),
        `reservation ${reservation.id} references unknown role ${role}`
      );
    }
  }
  return policy;
}

/**
 * @param {import('./themeDefinition.mjs').ThemeDefinition} theme
 * @param {ThemePigmentPolicy} policy
 */
export function auditThemePigmentPolicy(theme, policy) {
  const violations = [];
  for (const namespace of THEME_ROLE_NAMESPACES) {
    for (const [name, color] of Object.entries(theme[namespace])) {
      const role = qualifyRole(namespace, name);
      // A translucent role's hue is its pigment's hue.
      const hue = hexToOklch(`#${parseHexColor(color).hex}`).h;
      if (!Number.isFinite(hue)) continue;
      for (const reservation of policy.reservations) {
        if (
          hueInsideRange(hue, reservation.minimum, reservation.maximum) &&
          !reservation.allowedRoles.includes(role)
        ) {
          violations.push({ hue, reservation: reservation.id, role });
        }
      }
    }
  }
  return violations;
}

/** @param {unknown} condition @param {string} message */
function invariant(condition, message) {
  if (!condition) throw new Error(`Invalid theme pigment policy: ${message}.`);
}
