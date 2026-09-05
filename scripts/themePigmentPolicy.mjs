// @ts-check

import fs from 'node:fs';
import path from 'node:path';

import { hexToOklch, hueInsideRange } from './colorScience.mjs';
import { loadThemeDefinitionContext } from './themeDefinition.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
export const THEME_PIGMENT_POLICY_PATH = path.join(ROOT, 'source/themePigmentPolicy.json');

/** @typedef {{ allowedRoles: string[]; id: string; maximum: number; minimum: number }} PigmentReservation */
/** @typedef {{ reservations: PigmentReservation[]; schemaVersion: 2 }} ThemePigmentPolicy */

/**
 * @param {string} [policyPath]
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} [definition]
 * @returns {ThemePigmentPolicy}
 */
export function readThemePigmentPolicy(
  policyPath = THEME_PIGMENT_POLICY_PATH,
  definition = loadThemeDefinitionContext(path.resolve(path.dirname(policyPath), '..'))
) {
  const root = path.resolve(path.dirname(policyPath), '..');
  if (definition.root !== root) {
    throw new Error('Theme pigment policy and definition roots must match.');
  }
  return validateThemePigmentPolicy(JSON.parse(fs.readFileSync(policyPath, 'utf8')), definition);
}

/**
 * @param {unknown} value
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} [definition]
 * @returns {ThemePigmentPolicy}
 */
export function validateThemePigmentPolicy(value, definition = loadThemeDefinitionContext(ROOT)) {
  const policy = requireObject(value, 'root');
  requireExactFields(policy, ['reservations', 'schemaVersion'], 'root');
  invariant(policy.schemaVersion === 2, 'schemaVersion must be 2');
  invariant(
    Array.isArray(policy.reservations) && policy.reservations.length > 0,
    'reservations must be a non-empty array'
  );
  const knownRoles = new Set(
    Object.entries(definition.requiredThemeRoles).flatMap(([namespace, roles]) =>
      roles.map((role) => `${namespace}:${role}`)
    )
  );
  const ids = new Set();
  const reservations = /** @type {any[]} */ (policy.reservations).map(
    /** @param {unknown} raw @param {number} index */ (raw, index) => {
      const reservation = requireObject(raw, `reservations[${index}]`);
      requireExactFields(
        reservation,
        ['allowedRoles', 'id', 'maximum', 'minimum'],
        `reservations[${index}]`
      );
      requireId(reservation.id, `reservations[${index}] id`);
      invariant(!ids.has(reservation.id), `reservation id ${reservation.id} is duplicated`);
      ids.add(reservation.id);
      requireHue(reservation.minimum, `reservation ${reservation.id} minimum`);
      requireHue(reservation.maximum, `reservation ${reservation.id} maximum`);
      const allowedRoles = requireKnownRoles(
        reservation.allowedRoles,
        knownRoles,
        `reservation ${reservation.id} allowedRoles`
      );
      return {
        allowedRoles,
        id: reservation.id,
        maximum: reservation.maximum,
        minimum: reservation.minimum,
      };
    }
  );
  return /** @type {ThemePigmentPolicy} */ (deepFreeze({ reservations, schemaVersion: 2 }));
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

/** @param {unknown} value @param {string} owner @returns {Record<string, any>} */
function requireObject(value, owner) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid theme pigment policy: ${owner} must be an object.`);
  }
  return /** @type {Record<string, any>} */ (value);
}

/** @param {Record<string, any>} value @param {string[]} fields @param {string} owner */
function requireExactFields(value, fields, owner) {
  invariant(
    JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify([...fields].toSorted()),
    `${owner} has unsupported or missing fields`
  );
}

/** @param {unknown} value @param {string} owner */
function requireId(value, owner) {
  invariant(
    typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value),
    `${owner} must be a kebab-case identifier`
  );
}

/** @param {unknown} value @param {string} owner */
function requireHue(value, owner) {
  invariant(
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 360,
    `${owner} must be within 0..360 (exclusive)`
  );
}

/** @param {unknown} value @param {Set<string>} knownRoles @param {string} owner */
function requireKnownRoles(value, knownRoles, owner) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid theme pigment policy: ${owner} must be a non-empty array.`);
  }
  const entries = /** @type {unknown[]} */ (value);
  invariant(new Set(entries).size === entries.length, `${owner} contains duplicates`);
  for (const entry of entries)
    invariant(
      typeof entry === 'string' && knownRoles.has(entry),
      `${owner} references unknown role ${String(entry)}`
    );
  return /** @type {string[]} */ ([...entries]);
}

/** @param {any} value */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** @param {unknown} condition @param {string} message */
function invariant(condition, message) {
  if (!condition) throw new Error(`Invalid theme pigment policy: ${message}.`);
}
