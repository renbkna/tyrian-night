// @ts-check

import path from 'node:path';

import {
  apcaContrast,
  colorMetrics,
  compareColors,
  contrastRatio,
  gamutRelativeRichness,
  quantizeDiagnosticNumber,
} from './colorScience.mjs';
import { opaqueHex } from './colorUtils.mjs';
import { COLOR_VISION_MODES, simulateColorVision } from './colorVision.mjs';
import { loadThemeDefinitionContext, themeColor } from './themeDefinition.mjs';
import { loadSourceModule } from './sourceModule.mjs';

/** @typedef {Record<string, any>} JsonObject */
/** @typedef {'apca' | 'wcag'} SafetyContrastMetric */
/** @typedef {{ id: string; metric: SafetyContrastMetric; minimum: number; roles: string[] }} SafetyContrast */
/** @typedef {{ background: string; foreground: string; id: string; minimum: number }} SafetyContrastPair */
/** @typedef {{ id: string; pairing: 'adjacent' | 'adjacent-cycle' | 'all'; roles: string[] }} SafetyStateComparison */
/** @typedef {{ background: string; contrast: SafetyContrast[]; contrastPairs: SafetyContrastPair[]; stateComparisons: SafetyStateComparison[] }} ThemeSafetyContract */

/** Valid floor range per metric: WCAG 2 ratio, APCA Lc. */
const CONTRAST_METRIC_RANGES = /** @type {Record<string, [number, number]>} */ ({
  apca: [15, 106],
  wcag: [3, 7],
});

/**
 * The safety contract contains hard rendered-contrast requirements and the
 * semantic state pairs that must not collapse to one source color. Each
 * contrast floor names its metric: APCA Lc (absolute, both polarities) for
 * code, whose readability WCAG 2 overrates on dark backgrounds, and WCAG 2
 * ratios for UI text, state labels, and label/surface pairs. Simulated
 * color-vision distances remain observations because no repository threshold
 * has human-validation authority. Its shape is type-checked; this validates
 * references into the role contract and the numeric bounds types cannot express.
 *
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} [definition]
 * @returns {ThemeSafetyContract}
 */
export function readThemeSafetyContract(definition = loadThemeDefinitionContext()) {
  return validateThemeSafetyContract(
    /** @type {ThemeSafetyContract} */ (
      loadSourceModule(path.join(definition.root, 'source/themeSafetyContract.cjs'))
    ),
    definition
  );
}

/**
 * @param {ThemeSafetyContract} contract
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} definition
 * @returns {ThemeSafetyContract}
 */
export function validateThemeSafetyContract(contract, definition) {
  requireThemeRole(contract.background, definition, 'background');
  invariant(contract.contrast.length > 0, 'contrast must not be empty');
  invariant(contract.contrastPairs.length > 0, 'contrastPairs must not be empty');
  invariant(contract.stateComparisons.length > 0, 'stateComparisons must not be empty');
  const ids = new Set();
  for (const entry of contract.contrast) {
    requireId(entry.id, ids);
    const [low, high] = CONTRAST_METRIC_RANGES[entry.metric] ?? [];
    invariant(low !== undefined, `${entry.id} metric must be 'apca' or 'wcag'`);
    invariant(
      entry.minimum >= low && entry.minimum <= high,
      `${entry.id} ${entry.metric} minimum must be within ${low}..${high}`
    );
  }
  for (const entry of contract.contrastPairs) {
    requireId(entry.id, ids);
    invariant(entry.minimum >= 3 && entry.minimum <= 7, `${entry.id} minimum must be within 3..7`);
  }
  for (const entry of contract.contrast) {
    requireRoles(entry.id, entry.roles, 1, definition);
  }
  for (const entry of contract.contrastPairs) {
    requireRoles(entry.id, [entry.foreground, entry.background], 2, definition);
  }
  for (const entry of contract.stateComparisons) {
    requireId(entry.id, ids);
    requireRoles(entry.id, entry.roles, 2, definition);
  }
  return contract;
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
      const foreground = opaqueHex(themeColor(theme, role), canvas);
      const actual =
        constraint.metric === 'apca'
          ? apcaContrast(foreground, canvas)
          : contrastRatio(foreground, canvas);
      if (actual < constraint.minimum) {
        violations.push({
          actual,
          constraint: constraint.id,
          kind: `${constraint.metric}-minimum-contrast`,
          minimum: constraint.minimum,
          role,
        });
      }
    }
  }
  for (const constraint of contract.contrastPairs) {
    const background = opaqueHex(themeColor(theme, constraint.background), canvas);
    const foreground = opaqueHex(themeColor(theme, constraint.foreground), background);
    const actual = contrastRatio(foreground, background);
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
        apca: quantizeDiagnosticNumber(apcaContrast(color, background)),
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

/** @param {string} id @param {Set<string>} ids */
function requireId(id, ids) {
  invariant(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id), `constraint id '${id}' must be kebab-case`);
  invariant(!ids.has(id), `constraint id ${id} is duplicated`);
  ids.add(id);
}

/**
 * @param {string} owner
 * @param {string[]} roles
 * @param {number} minimumCount
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} definition
 */
function requireRoles(owner, roles, minimumCount, definition) {
  invariant(roles.length >= minimumCount, `${owner} requires at least ${minimumCount} roles`);
  invariant(new Set(roles).size === roles.length, `${owner} roles contain duplicates`);
  for (const role of roles) requireThemeRole(role, definition, `${owner} role`);
}

/** @param {string} role @param {import('./themeDefinition.mjs').ThemeDefinitionContext} definition @param {string} owner */
function requireThemeRole(role, definition, owner) {
  const separator = role.indexOf(':');
  const namespace = separator > 0 ? role.slice(0, separator) : '';
  const name = separator > 0 ? role.slice(separator + 1) : '';
  const roles = /** @type {Record<string, readonly string[]>} */ (definition.requiredThemeRoles);
  invariant(
    separator > 0 && Object.hasOwn(roles, namespace) && roles[namespace]?.includes(name),
    `${owner} references unknown role ${role}`
  );
}

/** @param {unknown} condition @param {string} message */
function invariant(condition, message) {
  if (!condition) throw new Error(`Invalid theme safety contract: ${message}.`);
}
