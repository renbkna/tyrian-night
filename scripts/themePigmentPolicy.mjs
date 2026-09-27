// @ts-check

import path from 'node:path';

import { hexToOklch, hueInsideRange } from './colorScience.mjs';
import { loadThemeDefinitionContext } from './themeDefinition.mjs';
import { loadSourceModule } from './sourceModule.mjs';

/** @typedef {{ allowedRoles: string[]; id: string; maximum: number; minimum: number }} PigmentReservation */
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
  const knownRoles = new Set(
    Object.entries(definition.requiredThemeRoles).flatMap(([namespace, roles]) =>
      roles.map((role) => `${namespace}:${role}`)
    )
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
      reservation.allowedRoles.length > 0,
      `reservation ${reservation.id} allowedRoles must not be empty`
    );
    invariant(
      new Set(reservation.allowedRoles).size === reservation.allowedRoles.length,
      `reservation ${reservation.id} allowedRoles contains duplicates`
    );
    for (const role of reservation.allowedRoles) {
      invariant(
        knownRoles.has(role),
        `reservation ${reservation.id} references unknown role ${role}`
      );
    }
  }
  return policy;
}

/**
 * @param {import('./themeDefinition.mjs').ThemeDefinition} theme
 * @param {ThemePigmentPolicy} [policy]
 */
export function auditThemePigmentPolicy(theme, policy = readThemePigmentPolicy()) {
  const violations = [];
  for (const namespace of /** @type {const} */ ([
    'brackets',
    'ui',
    'syntax',
    'terminal',
    'vscode',
  ])) {
    for (const [name, color] of Object.entries(theme[namespace])) {
      const role = `${namespace}:${name}`;
      const hue = hexToOklch(color.slice(0, 7)).h;
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
