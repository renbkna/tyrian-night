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
import {
  CANVAS_ROLE,
  isKnownThemeRole,
  loadThemeDefinitionContext,
  POLICY_ID_PATTERN,
  themeColor,
} from './themeDefinition.mjs';
import { loadSourceModule } from './sourceModule.mjs';

/** @typedef {'apca' | 'wcag'} SafetyContrastMetric */
/** @typedef {{ id: string; metric: SafetyContrastMetric; minimum: number; roles: string[] }} SafetyContrast */
/** @typedef {{ background: string; foreground: string; id: string; minimum: number }} SafetyContrastPair */
/** @typedef {{ id: string; pairing: 'adjacent' | 'all'; roles: string[] }} SafetyStateComparison */
/** @typedef {{ contrast: SafetyContrast[]; contrastPairs: SafetyContrastPair[]; stateComparisons: SafetyStateComparison[] }} ThemeSafetyContract */
/**
 * @typedef {{ kind: `${SafetyContrastMetric}-minimum-contrast`; constraint: string; role: string; actual: number; minimum: number }
 *   | { kind: 'wcag-minimum-pair-contrast'; constraint: string; roles: [string, string]; actual: number; minimum: number }
 *   | { kind: 'identical-independent-state-color'; constraint: string; roles: [string, string] }} ThemeSafetyViolation
 */

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
    const [low, high] = CONTRAST_METRIC_RANGES.wcag;
    invariant(
      entry.minimum >= low && entry.minimum <= high,
      `${entry.id} minimum must be within ${low}..${high}`
    );
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
 * @param {ThemeSafetyContract} contract
 * @returns {ThemeSafetyViolation[]}
 */
export function auditThemeSafety(theme, contract) {
  const canvas = opaqueHex(themeColor(theme, CANVAS_ROLE));
  /** @type {ThemeSafetyViolation[]} */
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
          kind: /** @type {const} */ (`${constraint.metric}-minimum-contrast`),
          minimum: constraint.minimum,
          role,
        });
      }
    }
  }
  for (const constraint of contract.contrastPairs) {
    const actual = pairContrast(theme, constraint, canvas);
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
 * @param {ThemeSafetyContract} contract
 */
export function reportThemeColorDiagnostics(theme, themeSlug, contract) {
  const background = opaqueHex(themeColor(theme, CANVAS_ROLE));
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
    contrastPairs: contract.contrastPairs.map((pair) => {
      return {
        contrast: quantizeDiagnosticNumber(pairContrast(theme, pair, background)),
        id: pair.id,
        roles: [pair.foreground, pair.background],
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

/**
 * WCAG contrast of a pair's foreground on its background, which sits on the canvas.
 * @param {import('./themeDefinition.mjs').ThemeDefinition} theme
 * @param {SafetyContrastPair} pair
 * @param {string} canvas
 */
function pairContrast(theme, pair, canvas) {
  const background = opaqueHex(themeColor(theme, pair.background), canvas);
  return contrastRatio(opaqueHex(themeColor(theme, pair.foreground), background), background);
}

/** @param {string[]} roles @param {SafetyStateComparison['pairing']} pairing @returns {Array<[string, string]>} */
function channelPairs(roles, pairing) {
  if (pairing === 'adjacent') {
    return roles
      .slice(0, -1)
      .map((role, index) => /** @type {[string, string]} */ ([role, roles[index + 1]]));
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
  invariant(POLICY_ID_PATTERN.test(id), `constraint id '${id}' must be kebab-case`);
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
  invariant(
    isKnownThemeRole(role, definition.requiredThemeRoles),
    `${owner} references unknown role ${role}`
  );
}

/** @param {unknown} condition @param {string} message */
function invariant(condition, message) {
  if (!condition) throw new Error(`Invalid theme safety contract: ${message}.`);
}
