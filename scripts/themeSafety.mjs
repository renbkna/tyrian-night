// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  colorMetrics,
  compareColors,
  gamutRelativeRichness,
  quantizeDiagnosticNumber,
} from './colorScience.mjs';
import { opaqueHex } from './colorUtils.mjs';
import { COLOR_VISION_MODES, simulateColorVision } from './colorVision.mjs';
import { loadThemeDefinitionContext, themeColor } from './themeDefinition.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const THEME_SAFETY_CONTRACT_PATH = path.join(ROOT, 'source', 'themeSafetyContract.json');
const PAIRINGS = new Set(['adjacent', 'adjacent-cycle', 'all']);

/** @typedef {Record<string, any>} JsonObject */
/** @typedef {{ id: string; minimum: number; roles: string[] }} SafetyContrast */
/** @typedef {{ background: string; foreground: string; id: string; minimum: number }} SafetyContrastPair */
/** @typedef {{ id: string; pairing: string; roles: string[] }} SafetyStateComparison */
/** @typedef {{ background: string; contrast: SafetyContrast[]; contrastPairs: SafetyContrastPair[]; schemaVersion: 3; stateComparisons: SafetyStateComparison[] }} ThemeSafetyContract */

/** @param {string} [contractPath] @returns {ThemeSafetyContract} */
export function readThemeSafetyContract(contractPath = THEME_SAFETY_CONTRACT_PATH) {
  const root = path.resolve(path.dirname(contractPath), '..');
  const definition = loadThemeDefinitionContext(root);
  return validateThemeSafetyContract(JSON.parse(fs.readFileSync(contractPath, 'utf8')), definition);
}

/**
 * The safety contract contains hard rendered-contrast requirements and the
 * semantic state pairs that must not collapse to one source color. Simulated
 * color-vision distances remain observations because no repository threshold
 * has human-validation authority.
 * @param {unknown} value
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} [definition]
 */
export function validateThemeSafetyContract(value, definition = loadThemeDefinitionContext(ROOT)) {
  const contract = requireObject(value, 'root');
  requireExactFields(
    contract,
    ['background', 'contrast', 'contrastPairs', 'schemaVersion', 'stateComparisons'],
    'root'
  );
  invariant(contract.schemaVersion === 3, 'schemaVersion must be 3');
  requireThemeRole(contract.background, definition, 'background');
  const ids = new Set();
  const contrast = requireArray(contract.contrast, 'contrast').map((raw, index) => {
    const entry = requireObject(raw, `contrast[${index}]`);
    requireExactFields(entry, ['id', 'minimum', 'roles'], `contrast[${index}]`);
    requireId(entry.id, ids, `contrast[${index}]`);
    requireMinimumContrast(entry.minimum, `contrast[${index}] minimum`);
    const roles = requireUniqueStrings(entry.roles, `contrast[${index}] roles`);
    for (const role of roles) requireThemeRole(role, definition, `contrast[${index}] role`);
    return { id: entry.id, minimum: entry.minimum, roles };
  });
  const contrastPairs = requireArray(contract.contrastPairs, 'contrastPairs').map((raw, index) => {
    const entry = requireObject(raw, `contrastPairs[${index}]`);
    requireExactFields(
      entry,
      ['background', 'foreground', 'id', 'minimum'],
      `contrastPairs[${index}]`
    );
    requireId(entry.id, ids, `contrastPairs[${index}]`);
    requireThemeRole(entry.foreground, definition, `contrastPairs[${index}] foreground`);
    requireThemeRole(entry.background, definition, `contrastPairs[${index}] background`);
    requireMinimumContrast(entry.minimum, `contrastPairs[${index}] minimum`);
    return { ...entry };
  });
  const stateComparisons = requireArray(contract.stateComparisons, 'stateComparisons').map(
    (raw, index) => {
      const entry = requireObject(raw, `stateComparisons[${index}]`);
      requireExactFields(entry, ['id', 'pairing', 'roles'], `stateComparisons[${index}]`);
      requireId(entry.id, ids, `stateComparisons[${index}]`);
      invariant(PAIRINGS.has(entry.pairing), `${entry.id} has invalid pairing`);
      const roles = requireUniqueStrings(entry.roles, `${entry.id} roles`);
      invariant(roles.length >= 2, `${entry.id} requires at least two roles`);
      for (const role of roles) requireThemeRole(role, definition, `${entry.id} role`);
      return { ...entry, roles };
    }
  );
  return /** @type {ThemeSafetyContract} */ (
    deepFreeze({
      background: contract.background,
      contrast,
      contrastPairs,
      schemaVersion: 3,
      stateComparisons,
    })
  );
}

/**
 * @param {import('./themeDefinition.mjs').ThemeDefinition} theme
 * @param {ReturnType<typeof readThemeSafetyContract>} [contract]
 */
export function auditThemeSafety(theme, contract = readThemeSafetyContract()) {
  const canvas = opaqueHex(themeColor(theme, contract.background));
  /** @type {JsonObject[]} */
  const violations = [];
  for (const constraint of contract.contrast) {
    for (const role of constraint.roles) {
      const actual = colorMetrics(themeColor(theme, role), canvas).contrast ?? 0;
      if (actual < constraint.minimum) {
        violations.push({
          actual,
          constraint: constraint.id,
          kind: 'wcag-minimum-contrast',
          minimum: constraint.minimum,
          role,
        });
      }
    }
  }
  for (const constraint of contract.contrastPairs) {
    const background = opaqueHex(themeColor(theme, constraint.background), canvas);
    const foreground = opaqueHex(themeColor(theme, constraint.foreground), background);
    const actual = colorMetrics(foreground, background).contrast ?? 0;
    if (actual < constraint.minimum) {
      violations.push({
        actual,
        constraint: constraint.id,
        kind: 'wcag-minimum-pair-contrast',
        minimum: constraint.minimum,
        roles: [constraint.foreground, constraint.background],
      });
    }
  }
  for (const channel of contract.stateComparisons) {
    for (const [leftRole, rightRole] of channelPairs(channel.roles, channel.pairing)) {
      const left = opaqueHex(themeColor(theme, leftRole), canvas);
      const right = opaqueHex(themeColor(theme, rightRole), canvas);
      if (left === right) {
        violations.push({
          constraint: channel.id,
          kind: 'identical-independent-state-color',
          roles: [leftRole, rightRole],
        });
      }
    }
  }
  return violations;
}

/**
 * Construction-space and contrast values remain observations only. This
 * report has no pass/fail fields, thresholds, ranking, or candidate score.
 * @param {import('./themeDefinition.mjs').ThemeDefinition} theme
 * @param {string} themeSlug
 * @param {ReturnType<typeof readThemeSafetyContract>} [contract]
 */
export function reportThemeColorDiagnostics(
  theme,
  themeSlug,
  contract = readThemeSafetyContract()
) {
  const background = opaqueHex(themeColor(theme, contract.background));
  const roles = /** @type {string[]} */ (
    [
      ...new Set([
        ...contract.contrast.flatMap((/** @type {SafetyContrast} */ entry) => entry.roles),
        ...contract.stateComparisons.flatMap(
          (/** @type {SafetyStateComparison} */ entry) => entry.roles
        ),
      ]),
    ].toSorted()
  );
  return {
    background,
    roles: roles.map((role) => {
      const color = opaqueHex(themeColor(theme, role), background);
      const metrics = colorMetrics(color, background);
      return {
        contrast: quantizeDiagnosticNumber(/** @type {number} */ (metrics.contrast)),
        hex: color,
        oklch: {
          C: quantizeDiagnosticNumber(metrics.oklch.C),
          L: quantizeDiagnosticNumber(metrics.oklch.L),
          h: quantizeDiagnosticNumber(metrics.oklch.h),
        },
        richness: quantizeDiagnosticNumber(gamutRelativeRichness(color)),
        role,
      };
    }),
    stateComparisons: contract.stateComparisons.map((comparison) => ({
      id: comparison.id,
      pairs: channelPairs(comparison.roles, comparison.pairing).map(([leftRole, rightRole]) => {
        const left = opaqueHex(themeColor(theme, leftRole), background);
        const right = opaqueHex(themeColor(theme, rightRole), background);
        return {
          cvdOklabDelta: Object.fromEntries(
            COLOR_VISION_MODES.map((mode) => [
              mode,
              quantizeDiagnosticNumber(
                compareColors({
                  left: simulateColorVision(left, mode, background),
                  right: simulateColorVision(right, mode, background),
                }).oklabDelta
              ),
            ])
          ),
          oklabDelta: quantizeDiagnosticNumber(compareColors({ left, right }).oklabDelta),
          roles: [leftRole, rightRole],
        };
      }),
    })),
    theme: themeSlug,
  };
}

/** @param {string[]} roles @param {string} pairing @returns {Array<[string, string]>} */
function channelPairs(roles, pairing) {
  if (pairing === 'adjacent') {
    return roles
      .slice(0, -1)
      .map((role, index) => /** @type {[string, string]} */ ([role, roles[index + 1]]));
  }
  if (pairing === 'adjacent-cycle') {
    return roles.map(
      (role, index) => /** @type {[string, string]} */ ([role, roles[(index + 1) % roles.length]])
    );
  }
  /** @type {Array<[string, string]>} */
  const pairs = [];
  for (let left = 0; left < roles.length; left += 1) {
    for (let right = left + 1; right < roles.length; right += 1) {
      pairs.push([roles[left], roles[right]]);
    }
  }
  return pairs;
}

/** @param {unknown} value @param {string} owner @returns {JsonObject} */
function requireObject(value, owner) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid theme safety contract: ${owner} must be an object.`);
  }
  return /** @type {JsonObject} */ (value);
}

/** @param {unknown} value @param {string} owner @returns {any[]} */
function requireArray(value, owner) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid theme safety contract: ${owner} must be a non-empty array.`);
  }
  return value;
}

/** @param {JsonObject} value @param {string[]} fields @param {string} owner */
function requireExactFields(value, fields, owner) {
  invariant(
    JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify([...fields].toSorted()),
    `${owner} has unsupported or missing fields`
  );
}

/** @param {unknown} value @param {string} owner */
function requireUniqueStrings(value, owner) {
  const values = requireArray(value, owner);
  invariant(
    values.every((entry) => typeof entry === 'string' && entry.length > 0),
    `${owner} must contain strings`
  );
  invariant(new Set(values).size === values.length, `${owner} contains duplicates`);
  return /** @type {string[]} */ (values);
}

/** @param {unknown} value @param {Set<string>} ids @param {string} owner */
function requireId(value, ids, owner) {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) {
    throw new Error(`Invalid theme safety contract: ${owner} has invalid id.`);
  }
  invariant(!ids.has(value), `constraint id ${value} is duplicated`);
  ids.add(value);
}

/** @param {unknown} value @param {string} owner */
function requireMinimumContrast(value, owner) {
  invariant(typeof value === 'number' && value >= 3 && value <= 7, `${owner} must be within 3..7`);
}

/** @param {unknown} role @param {import('./themeDefinition.mjs').ThemeDefinitionContext} definition @param {string} owner */
function requireThemeRole(role, definition, owner) {
  if (typeof role !== 'string') {
    throw new Error(
      `Invalid theme safety contract: ${owner} references unknown role ${String(role)}.`
    );
  }
  const separator = role.indexOf(':');
  const namespace = separator > 0 ? role.slice(0, separator) : '';
  const name = separator > 0 ? role.slice(separator + 1) : '';
  const roles = /** @type {Record<string, readonly string[]>} */ (definition.requiredThemeRoles);
  invariant(
    separator > 0 && Object.hasOwn(roles, namespace) && roles[namespace].includes(name),
    `${owner} references unknown role ${String(role)}`
  );
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
  if (!condition) throw new Error(`Invalid theme safety contract: ${message}.`);
}
