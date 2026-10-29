// @ts-check

import path from 'node:path';

import { hexToOklch, hueInsideRange } from './colorScience.mjs';
import {
  isKnownThemeRole,
  loadThemeDefinitionContext,
  THEME_ROLE_NAMESPACES,
} from './themeDefinition.mjs';
import { loadSourceModule } from './sourceModule.mjs';

/**
 * A hue range only the listed pigments may occupy; a role is judged by the
 * pigment it is bound to, so aliases and alpha derivations follow their pigment.
 * @typedef {{ allowedPigments: string[]; id: string; maximum: number; minimum: number }} PigmentReservation
 */
/** @typedef {{ reservations: PigmentReservation[] }} ThemePigmentPolicy */

/**
 * Reads the type-checked pigment policy and validates what types cannot:
 * identifier uniqueness, hue bounds, and pigment references into the role contract.
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
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(reservation.id),
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
      reservation.allowedPigments.length > 0,
      `reservation ${reservation.id} allowedPigments must not be empty`
    );
    invariant(
      new Set(reservation.allowedPigments).size === reservation.allowedPigments.length,
      `reservation ${reservation.id} allowedPigments contains duplicates`
    );
    for (const pigment of reservation.allowedPigments) {
      invariant(
        isKnownThemeRole(pigment, definition.requiredThemeRoles),
        `reservation ${reservation.id} references unknown pigment ${pigment}`
      );
    }
  }
  return policy;
}

/**
 * @param {import('./themeDefinition.mjs').ThemeDefinition} theme
 * @param {ThemePigmentPolicy} [policy]
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} [definition]
 */
export function auditThemePigmentPolicy(
  theme,
  policy = readThemePigmentPolicy(),
  definition = loadThemeDefinitionContext()
) {
  const violations = [];
  for (const namespace of THEME_ROLE_NAMESPACES) {
    for (const [name, color] of Object.entries(theme[namespace])) {
      const role = `${namespace}:${name}`;
      const binding = definition.colorBindings.bindings[namespace][name];
      const pigment = typeof binding === 'object' ? binding.pigment : (binding ?? role);
      const hue = hexToOklch(color.slice(0, 7)).h;
      if (!Number.isFinite(hue)) continue;
      for (const reservation of policy.reservations) {
        if (
          hueInsideRange(hue, reservation.minimum, reservation.maximum) &&
          !reservation.allowedPigments.includes(pigment)
        ) {
          violations.push({ hue, pigment, reservation: reservation.id, role });
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
