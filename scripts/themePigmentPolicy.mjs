// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hexToOklch, hueInsideRange } from './colorScience.mjs';
import { loadThemeDefinitionContext } from './themeDefinition.mjs';
import { readThemeSources } from './themeSources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const THEME_PIGMENT_POLICY_PATH = path.join(ROOT, 'source/themePigmentPolicy.json');

/** @typedef {{ reason: string; role: string; theme: string }} PigmentPolicyExemption */
/** @typedef {{ allowedRoles: string[]; exemptions: PigmentPolicyExemption[]; id: string; maximum: number; minimum: number }} PigmentReservation */
/** @typedef {{ reservations: PigmentReservation[]; schemaVersion: 1 }} ThemePigmentPolicy */

/** @param {string} [policyPath] @returns {ThemePigmentPolicy} */
export function readThemePigmentPolicy(policyPath = THEME_PIGMENT_POLICY_PATH) {
  const root = path.resolve(path.dirname(policyPath), '..');
  const definition = loadThemeDefinitionContext(root);
  const themes = readThemeSources(root, definition).map(({ slug }) => slug);
  return validateThemePigmentPolicy(
    JSON.parse(fs.readFileSync(policyPath, 'utf8')),
    definition,
    themes
  );
}

/**
 * @param {unknown} value
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} [definition]
 * @param {readonly string[]} [themes]
 * @returns {ThemePigmentPolicy}
 */
export function validateThemePigmentPolicy(
  value,
  definition = loadThemeDefinitionContext(ROOT),
  themes = readThemeSources(definition.root, definition).map(({ slug }) => slug)
) {
  const policy = requireObject(value, 'root');
  requireExactFields(policy, ['reservations', 'schemaVersion'], 'root');
  invariant(policy.schemaVersion === 1, 'schemaVersion must be 1');
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
  const exemptionKeys = new Set();
  const reservations = /** @type {any[]} */ (policy.reservations).map(
    /** @param {unknown} raw @param {number} index */ (raw, index) => {
      const reservation = requireObject(raw, `reservations[${index}]`);
      requireExactFields(
        reservation,
        ['allowedRoles', 'exemptions', 'id', 'maximum', 'minimum'],
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
      invariant(
        Array.isArray(reservation.exemptions),
        `reservation ${reservation.id} exemptions must be an array`
      );
      const exemptions = /** @type {any[]} */ (reservation.exemptions).map(
        /** @param {unknown} rawExemption @param {number} exemptionIndex */ (
          rawExemption,
          exemptionIndex
        ) => {
          const exemption = requireObject(
            rawExemption,
            `reservation ${reservation.id} exemptions[${exemptionIndex}]`
          );
          requireExactFields(
            exemption,
            ['reason', 'role', 'theme'],
            `reservation ${reservation.id} exemptions[${exemptionIndex}]`
          );
          invariant(
            themes.includes(exemption.theme),
            `reservation ${reservation.id} exemption references unknown theme ${exemption.theme}`
          );
          invariant(
            knownRoles.has(exemption.role),
            `reservation ${reservation.id} exemption references unknown role ${exemption.role}`
          );
          invariant(
            !allowedRoles.includes(exemption.role),
            `reservation ${reservation.id} exemption redundantly allows ${exemption.role}`
          );
          invariant(
            typeof exemption.reason === 'string' && exemption.reason.length >= 24,
            `reservation ${reservation.id} exemption requires a specific reason`
          );
          const key = `${reservation.id}\0${exemption.theme}\0${exemption.role}`;
          invariant(
            !exemptionKeys.has(key),
            `reservation ${reservation.id} exemption for ${exemption.theme}/${exemption.role} is duplicated`
          );
          exemptionKeys.add(key);
          return { reason: exemption.reason, role: exemption.role, theme: exemption.theme };
        }
      );
      return {
        allowedRoles,
        exemptions,
        id: reservation.id,
        maximum: reservation.maximum,
        minimum: reservation.minimum,
      };
    }
  );
  return /** @type {ThemePigmentPolicy} */ (deepFreeze({ reservations, schemaVersion: 1 }));
}

/**
 * @param {import('./themeDefinition.mjs').ThemeDefinition} theme
 * @param {string} themeSlug
 * @param {ThemePigmentPolicy} [policy]
 */
export function auditThemePigmentPolicy(theme, themeSlug, policy = readThemePigmentPolicy()) {
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
          !reservation.allowedRoles.includes(role) &&
          !reservation.exemptions.some(
            (exemption) => exemption.theme === themeSlug && exemption.role === role
          )
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
