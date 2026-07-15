// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { calcAPCA, fontLookupAPCA } from 'apca-w3';
import { colorMetrics, compareColors } from './colorScience.mjs';
import { opaqueHex } from './colorUtils.mjs';
import { COLOR_VISION_MODES, simulateColorVision } from './colorVision.mjs';
import { loadThemeDefinitionContext, themeColor } from './themeDefinition.mjs';
import { readThemeSources } from './themeSources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONSTRAINT_KINDS = new Set([
  'apca-gap',
  'bracket-palette',
  'bright-pairs',
  'contrast-envelope',
  'contrast-order',
  'contrast-pairs',
  'chroma-order',
  'distinct-colors',
  'forbidden-hue',
  'hue-envelope',
  'oklch-envelope',
  'pair-separation',
  'pairwise-separation',
]);
const ROLE_SELECTION_CONSTRAINT_KINDS = new Set([
  'bracket-palette',
  'contrast-envelope',
  'contrast-order',
  'distinct-colors',
  'hue-envelope',
  'oklch-envelope',
  'pairwise-separation',
]);
const VALIDATED_CONTRACTS = new WeakSet();

/** @typedef {Record<string, any>} JsonObject */

export const THEME_APPEARANCE_CONTRACT_PATH = path.join(
  ROOT,
  'source',
  'themeAppearanceContract.json'
);

/**
 * @param {string} [contractPath]
 * @returns {JsonObject}
 */
export function readThemeAppearanceContract(contractPath = THEME_APPEARANCE_CONTRACT_PATH) {
  const root = path.resolve(path.dirname(contractPath), '..');
  const definition = loadThemeDefinitionContext(root);
  const themeSlugs = readThemeSources(root, definition).map(({ slug }) => slug);
  return validateThemeAppearanceContract(
    JSON.parse(fs.readFileSync(contractPath, 'utf8')),
    definition,
    themeSlugs
  );
}

/**
 * @param {unknown} value
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} [definition]
 * @param {readonly string[]} [themeSlugs]
 * @returns {JsonObject}
 */
export function validateThemeAppearanceContract(
  value,
  definition = loadThemeDefinitionContext(ROOT),
  themeSlugs = readThemeSources(definition.root, definition).map(({ slug }) => slug)
) {
  const contract = requireObject(value, 'root');
  requireFields(
    contract,
    ['constraints', 'reference', 'roleGroups', 'schemaVersion', 'themeSets'],
    'root'
  );
  invariant(contract.schemaVersion === 6, 'schemaVersion must be 6');

  const themeSets = validateThemeSets(contract.themeSets, themeSlugs);
  const roleGroups = validateRoleGroups(contract.roleGroups, definition);
  const reference = validateReference(contract.reference, roleGroups, definition);
  const constraints = validateConstraints(contract.constraints, themeSets, roleGroups, definition);
  validateProminenceConstraintCoverage(constraints, reference, roleGroups);
  const usedThemeSets = new Set(constraints.map(({ themeSet }) => themeSet));
  for (const themeSet of Object.keys(themeSets)) {
    invariant(usedThemeSets.has(themeSet), `theme set ${themeSet} has no constraints`);
  }

  const validated = deepFreeze({
    constraints,
    reference,
    roleGroups,
    schemaVersion: 6,
    themeSets,
  });
  VALIDATED_CONTRACTS.add(validated);
  return validated;
}

/**
 * Audits every constraint selected for one theme. Metrics observe the resolved palette;
 * the source recipe and binding contract remain the color authority.
 * @param {import('./themeDefinition.mjs').ThemeDefinition} theme
 * @param {string} themeSlug
 * @param {JsonObject} [contract]
 * @returns {JsonObject[]}
 */
export function auditThemeAppearance(theme, themeSlug, contract = readThemeAppearanceContract()) {
  const validated = requireValidatedContract(contract);
  return applicableConstraints(validated, themeSlug).flatMap((constraint) =>
    auditConstraint(theme, constraint, validated)
  );
}

/**
 * APCA evidence is deliberately a report, not a conformance result.
 * @param {import('./themeDefinition.mjs').ThemeDefinition} theme
 * @param {string} themeSlug
 * @param {JsonObject} [contract]
 * @returns {JsonObject}
 */
export function reportThemeApca(theme, themeSlug, contract = readThemeAppearanceContract()) {
  const validated = requireValidatedContract(contract);
  const background = themeColor(theme, validated.reference.background);
  /** @type {Map<string, string>} */
  const roleGroup = new Map();
  for (const group of validated.reference.prominenceGroups) {
    for (const role of validated.roleGroups[group]) roleGroup.set(role, group);
  }
  const roles = [...roleGroup].map(([role, group]) => {
    const color = themeColor(theme, role);
    const lc = apcaContrast(color, background);
    const minimumSizePx = fluentMinimumSizePx(lc, validated.reference.typography.weight);
    return {
      absoluteLc: Math.abs(lc),
      background,
      color,
      fluentMinimumSizePx: minimumSizePx,
      group,
      lc,
      referenceSizeMeetsFluentLookup:
        minimumSizePx !== null && validated.reference.typography.sizePx >= minimumSizePx,
      role,
    };
  });
  /** @type {Map<string, number>} */
  const roleLc = new Map(roles.map((role) => [role.role, role.absoluteLc]));
  const applicable = applicableConstraints(validated, themeSlug);
  const prominenceRelations = applicable
    .filter((constraint) => constraint.kind === 'apca-gap')
    .flatMap((constraint) =>
      /** @type {string[]} */ (constraint.lessRoles).map((lessRole) => ({
        actual:
          requiredMapNumber(roleLc, constraint.moreRole) - requiredMapNumber(roleLc, lessRole),
        lessProminent: lessRole,
        minimumAbsoluteLcGap: constraint.minimum,
        moreProminent: constraint.moreRole,
      }))
    );
  const expectedPolarity = theme.appearance === 'dark' ? 'light-on-dark' : 'dark-on-light';
  /** @type {JsonObject[]} */
  const warnings = [];
  for (const role of roles) {
    if (
      (theme.appearance === 'dark' && role.lc >= 0) ||
      (theme.appearance === 'light' && role.lc <= 0)
    ) {
      warnings.push({
        actual: role.lc,
        expected: expectedPolarity,
        kind: 'polarity',
        role: role.role,
      });
    }
    const maximumAbsoluteLc =
      validated.reference.apca.maximumAbsoluteLcByPolarity[expectedPolarity];
    if (role.absoluteLc > maximumAbsoluteLc) {
      warnings.push({
        actual: role.absoluteLc,
        kind: 'maximum-absolute-lc',
        maximum: maximumAbsoluteLc,
        role: role.role,
      });
    }
  }
  for (const ordering of prominenceRelations) {
    if (ordering.actual < ordering.minimumAbsoluteLcGap) {
      warnings.push({ kind: 'role-prominence-order', ...ordering });
    }
  }

  return {
    algorithm: 'APCA-W3 0.0.98G-4g',
    mode: validated.reference.apca.mode,
    prominenceRelations,
    referenceTypography: {
      ...validated.reference.typography,
      polarity: expectedPolarity,
    },
    roles,
    warnings,
  };
}

/**
 * @param {import('./themeDefinition.mjs').ThemeDefinition} theme
 * @param {JsonObject} constraint
 * @param {JsonObject} contract
 */
function auditConstraint(theme, constraint, contract) {
  const background = themeColor(theme, contract.reference.background);
  if (constraint.kind === 'contrast-envelope') {
    return constraintRoles(constraint, contract).flatMap((role) => {
      const actual = roleContrast(theme, role, background);
      return actual < constraint.minimum ||
        (constraint.maximum !== undefined && actual > constraint.maximum)
        ? [
            violation(constraint, {
              actual,
              maximum: constraint.maximum,
              minimum: constraint.minimum,
              role,
            }),
          ]
        : [];
    });
  }

  if (constraint.kind === 'oklch-envelope') {
    return constraintRoles(constraint, contract).flatMap((role) => {
      const metrics = colorMetrics(themeColor(theme, role), background).oklch;
      const failed =
        (constraint.minimumLightness !== undefined && metrics.L < constraint.minimumLightness) ||
        (constraint.maximumLightness !== undefined && metrics.L > constraint.maximumLightness) ||
        (constraint.minimumChroma !== undefined && metrics.C < constraint.minimumChroma) ||
        (constraint.maximumChroma !== undefined && metrics.C > constraint.maximumChroma);
      return failed
        ? [
            violation(constraint, {
              actualChroma: metrics.C,
              actualLightness: metrics.L,
              maximumChroma: constraint.maximumChroma,
              maximumLightness: constraint.maximumLightness,
              minimumChroma: constraint.minimumChroma,
              minimumLightness: constraint.minimumLightness,
              role,
            }),
          ]
        : [];
    });
  }

  if (constraint.kind === 'contrast-order') {
    const backdrop = constraint.background ? themeColor(theme, constraint.background) : background;
    const roles = constraintRoles(constraint, contract);
    /** @type {JsonObject[]} */
    const violations = [];
    for (let index = 0; index < roles.length - 1; index += 1) {
      const more = roleContrast(theme, roles[index], backdrop);
      const less = roleContrast(theme, roles[index + 1], backdrop);
      const actual = more - less;
      if (actual < constraint.minimumGap) {
        violations.push(
          violation(constraint, {
            actual,
            lessProminent: roles[index + 1],
            minimum: constraint.minimumGap,
            moreProminent: roles[index],
          })
        );
      }
    }
    return violations;
  }

  if (constraint.kind === 'contrast-pairs') {
    return /** @type {Array<[string, string, number]>} */ (constraint.pairs).flatMap((pair) => {
      const [foreground, backdropRole, minimum] = /** @type {[string, string, number]} */ (pair);
      const actual = roleContrast(theme, foreground, themeColor(theme, backdropRole));
      return actual < minimum
        ? [violation(constraint, { actual, minimum, roles: [foreground, backdropRole] })]
        : [];
    });
  }

  if (constraint.kind === 'chroma-order') {
    const more = colorMetrics(themeColor(theme, constraint.moreRole), background).oklch.C;
    const less = colorMetrics(themeColor(theme, constraint.lessRole), background).oklch.C;
    const actual = more - less;
    return actual < constraint.minimumGap
      ? [
          violation(constraint, {
            actual,
            lessProminent: constraint.lessRole,
            minimum: constraint.minimumGap,
            moreProminent: constraint.moreRole,
          }),
        ]
      : [];
  }

  if (constraint.kind === 'hue-envelope') {
    return constraintRoles(constraint, contract).flatMap((role) => {
      const hue = colorMetrics(themeColor(theme, role).slice(0, 7)).oklch.h;
      const inside = hueInside(hue, constraint.minimumHue, constraint.maximumHue);
      return inside
        ? []
        : [
            violation(constraint, {
              actual: hue,
              maximum: constraint.maximumHue,
              minimum: constraint.minimumHue,
              role,
            }),
          ];
    });
  }

  if (constraint.kind === 'apca-gap') {
    const more = Math.abs(apcaContrast(themeColor(theme, constraint.moreRole), background));
    return /** @type {string[]} */ (constraint.lessRoles).flatMap((lessRole) => {
      const less = Math.abs(apcaContrast(themeColor(theme, lessRole), background));
      const actual = more - less;
      return actual < constraint.minimum
        ? [
            violation(constraint, {
              actual,
              lessProminent: lessRole,
              minimum: constraint.minimum,
              moreProminent: constraint.moreRole,
            }),
          ]
        : [];
    });
  }

  if (constraint.kind === 'bracket-palette') {
    return auditBracketConstraint(theme, constraint, contract, background);
  }

  if (constraint.kind === 'pair-separation') {
    return auditPairConstraint(theme, constraint, background);
  }

  if (constraint.kind === 'pairwise-separation') {
    const roles = constraintRoles(constraint, contract);
    const violations = [];
    for (let leftIndex = 0; leftIndex < roles.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < roles.length; rightIndex += 1) {
        violations.push(
          ...auditPairConstraint(
            theme,
            { ...constraint, left: roles[leftIndex], right: roles[rightIndex] },
            background
          )
        );
      }
    }
    return violations;
  }

  if (constraint.kind === 'forbidden-hue') {
    const allowed = new Set(constraint.allowedRoles);
    return themeEntries(theme).flatMap(({ color, role }) => {
      if (allowed.has(role)) return [];
      const { C, h } = colorMetrics(color.slice(0, 7)).oklch;
      if (C < constraint.minimumChroma) return [];
      const forbidden =
        !Number.isFinite(h) || (h >= constraint.minimumHue && h <= constraint.maximumHue);
      return forbidden ? [violation(constraint, { actualChroma: C, actualHue: h, role })] : [];
    });
  }

  if (constraint.kind === 'bright-pairs') {
    return /** @type {Array<[string, string, boolean]>} */ (constraint.pairs).flatMap((pair) => {
      const [normal, bright, checkHue] = /** @type {[string, string, boolean]} */ (pair);
      const normalMetrics = colorMetrics(themeColor(theme, normal).slice(0, 7)).oklch;
      const brightMetrics = colorMetrics(themeColor(theme, bright).slice(0, 7)).oklch;
      /** @type {JsonObject[]} */
      const violations = [];
      const lightnessDelta = brightMetrics.L - normalMetrics.L;
      if (lightnessDelta < constraint.minimumLightnessDelta) {
        violations.push(
          violation(constraint, {
            actual: lightnessDelta,
            kind: 'bright-pair-lightness',
            minimum: constraint.minimumLightnessDelta,
            roles: [normal, bright],
          })
        );
      }
      if (checkHue) {
        const hueDelta = cyclicHueDelta(normalMetrics.h, brightMetrics.h);
        if (!Number.isFinite(hueDelta) || hueDelta > constraint.maximumHueDelta) {
          violations.push(
            violation(constraint, {
              actual: hueDelta,
              kind: 'bright-pair-hue',
              maximum: constraint.maximumHueDelta,
              roles: [normal, bright],
            })
          );
        }
      }
      return violations;
    });
  }

  if (constraint.kind === 'distinct-colors') {
    const roles = constraintRoles(constraint, contract);
    const owners = new Map();
    /** @type {JsonObject[]} */
    const violations = [];
    for (const role of roles) {
      const color = themeColor(theme, role).toUpperCase();
      const previous = owners.get(color);
      if (previous) violations.push(violation(constraint, { color, roles: [previous, role] }));
      else owners.set(color, role);
    }
    return violations;
  }

  throw new Error(`Unsupported theme appearance constraint '${constraint.kind}'.`);
}

/**
 * @param {import('./themeDefinition.mjs').ThemeDefinition} theme
 * @param {JsonObject} constraint
 * @param {string} background
 */
function auditPairConstraint(theme, constraint, background) {
  const leftColor = themeColor(theme, constraint.left);
  const rightColor = themeColor(theme, constraint.right);
  const comparison = compareColors({ background, left: leftColor, right: rightColor });
  /** @type {JsonObject[]} */
  const violations = [];
  if (
    constraint.minimumOklabDelta !== undefined &&
    comparison.oklabDelta < constraint.minimumOklabDelta
  ) {
    violations.push(
      violation(constraint, {
        actual: comparison.oklabDelta,
        kind: 'pair-oklab-separation',
        minimum: constraint.minimumOklabDelta,
        roles: [constraint.left, constraint.right],
      })
    );
  }
  if (
    constraint.minimumHueDelta !== undefined &&
    comparison.deltaLightness < constraint.maximumSimilarLightnessDelta &&
    (!Number.isFinite(comparison.deltaHue) || comparison.deltaHue < constraint.minimumHueDelta)
  ) {
    violations.push(
      violation(constraint, {
        actual: comparison.deltaHue,
        kind: 'pair-hue-separation',
        minimum: constraint.minimumHueDelta,
        roles: [constraint.left, constraint.right],
      })
    );
  }
  if (constraint.minimumCvdOklabDelta !== undefined) {
    for (const mode of COLOR_VISION_MODES) {
      const actual = compareColors({
        left: simulateColorVision(leftColor, mode, background),
        right: simulateColorVision(rightColor, mode, background),
      }).oklabDelta;
      if (actual < constraint.minimumCvdOklabDelta) {
        violations.push(
          violation(constraint, {
            actual,
            kind: 'pair-cvd-separation',
            minimum: constraint.minimumCvdOklabDelta,
            mode,
            roles: [constraint.left, constraint.right],
          })
        );
      }
    }
  }
  return violations;
}

/**
 * @param {import('./themeDefinition.mjs').ThemeDefinition} theme
 * @param {JsonObject} constraint
 * @param {JsonObject} contract
 * @param {string} background
 */
function auditBracketConstraint(theme, constraint, contract, background) {
  const roles = constraintRoles(constraint, contract);
  /** @type {JsonObject[]} */
  const violations = [];
  const metrics = roles.map((role) => {
    const color = themeColor(theme, role);
    return {
      color,
      lc: Math.abs(apcaContrast(color, background)),
      metrics: colorMetrics(color),
      role,
    };
  });
  for (const entry of metrics) {
    if (entry.lc < constraint.minimumAbsoluteLc || entry.lc > constraint.maximumAbsoluteLc) {
      violations.push(
        violation(constraint, {
          actual: entry.lc,
          kind: 'bracket-apca-envelope',
          maximum: constraint.maximumAbsoluteLc,
          minimum: constraint.minimumAbsoluteLc,
          role: entry.role,
        })
      );
    }
    if (entry.metrics.oklch.C > constraint.maximumChroma) {
      violations.push(
        violation(constraint, {
          actual: entry.metrics.oklch.C,
          kind: 'bracket-chroma',
          maximum: constraint.maximumChroma,
          role: entry.role,
        })
      );
    }
  }
  for (let leftIndex = 0; leftIndex < metrics.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < metrics.length; rightIndex += 1) {
      const actual = compareColors({
        left: metrics[leftIndex].color,
        right: metrics[rightIndex].color,
      }).oklabDelta;
      if (actual < constraint.minimumPairwiseOklabDelta) {
        violations.push(
          violation(constraint, {
            actual,
            kind: 'bracket-separation',
            minimum: constraint.minimumPairwiseOklabDelta,
            roles: [metrics[leftIndex].role, metrics[rightIndex].role],
          })
        );
      }
    }
  }
  if (constraint.minimumCyclicAdjacentOklabDelta !== undefined) {
    for (let index = 0; index < metrics.length; index += 1) {
      const next = (index + 1) % metrics.length;
      const actual = compareColors({
        left: metrics[index].color,
        right: metrics[next].color,
      }).oklabDelta;
      if (actual < constraint.minimumCyclicAdjacentOklabDelta) {
        violations.push(
          violation(constraint, {
            actual,
            kind: 'bracket-adjacent-separation',
            minimum: constraint.minimumCyclicAdjacentOklabDelta,
            roles: [metrics[index].role, metrics[next].role],
          })
        );
      }
    }
  }
  return violations;
}

/** @param {JsonObject} contract @param {string} themeSlug @returns {JsonObject[]} */
function applicableConstraints(contract, themeSlug) {
  invariant(
    Object.values(contract.themeSets).some((slugs) => slugs.includes(themeSlug)),
    `unknown theme slug ${themeSlug}`
  );
  return /** @type {JsonObject[]} */ (contract.constraints).filter((constraint) =>
    contract.themeSets[constraint.themeSet].includes(themeSlug)
  );
}

/** @param {JsonObject} constraint @param {JsonObject} contract @returns {string[]} */
function constraintRoles(constraint, contract) {
  return constraint.roleGroup ? contract.roleGroups[constraint.roleGroup] : constraint.roles;
}

/** @param {JsonObject} constraint @param {JsonObject} details */
function violation(constraint, details) {
  return { constraint: constraint.id, kind: details.kind ?? constraint.kind, ...details };
}

/** @param {import('./themeDefinition.mjs').ThemeDefinition} theme @returns {Array<{ color: string; role: string }>} */
function themeEntries(theme) {
  return /** @type {const} */ (['brackets', 'ui', 'syntax', 'terminal', 'vscode']).flatMap(
    (namespace) =>
      Object.entries(theme[namespace]).map(([role, color]) => ({
        color,
        role: `${namespace}:${role}`,
      }))
  );
}

/** @param {import('./themeDefinition.mjs').ThemeDefinition} theme @param {string} role @param {string} background @returns {number} */
function roleContrast(theme, role, background) {
  return colorMetrics(themeColor(theme, role), background).contrast ?? 0;
}

/** @param {Map<string, number>} values @param {string} key */
function requiredMapNumber(values, key) {
  const value = values.get(key);
  invariant(value !== undefined, `missing calculated value for ${key}`);
  return value;
}

/** @param {string} foreground @param {string} background */
function apcaContrast(foreground, background) {
  const value = calcAPCA(opaqueHex(foreground, background), opaqueHex(background));
  const lc = typeof value === 'number' ? value : Number.parseFloat(value);
  invariant(Number.isFinite(lc), 'APCA could not evaluate a role');
  return lc;
}

/** @param {number} lc @param {number} weight @returns {number | null} */
function fluentMinimumSizePx(lc, weight) {
  const lookup = fontLookupAPCA(lc);
  const rawSize = lookup[weight / 100];
  const size = typeof rawSize === 'number' ? rawSize : Number.parseFloat(rawSize);
  return Number.isFinite(size) && size < 777 ? size : null;
}

/** @param {number} left @param {number} right */
function cyclicHueDelta(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.NaN;
  const difference = Math.abs(left - right) % 360;
  return Math.min(difference, 360 - difference);
}

/**
 * APCA relations and their report share one declared observation domain.
 * @param {JsonObject[]} constraints
 * @param {JsonObject} reference
 * @param {JsonObject} roleGroups
 */
function validateProminenceConstraintCoverage(constraints, reference, roleGroups) {
  const prominenceGroups = /** @type {string[]} */ (reference.prominenceGroups);
  const prominenceRoles = new Set(
    prominenceGroups.flatMap((group) => /** @type {string[]} */ (roleGroups[group]))
  );
  for (const constraint of constraints) {
    if (constraint.kind !== 'apca-gap') continue;
    for (const role of [constraint.moreRole, ...constraint.lessRoles]) {
      invariant(
        prominenceRoles.has(role),
        `${constraint.id} uses ${role} outside reference prominence groups`
      );
    }
  }
}

/** @param {number} hue @param {number} minimum @param {number} maximum */
function hueInside(hue, minimum, maximum) {
  if (!Number.isFinite(hue)) return false;
  return minimum <= maximum ? hue >= minimum && hue <= maximum : hue >= minimum || hue <= maximum;
}

/** @param {unknown} value @param {readonly string[]} themeSlugs @returns {JsonObject} */
function validateThemeSets(value, themeSlugs) {
  const sets = requireObject(value, 'themeSets');
  invariant(Object.keys(sets).length > 0, 'themeSets must not be empty');
  const knownSlugs = new Set(requireUniqueStrings(themeSlugs, 'source theme slugs'));
  const coveredSlugs = new Set();
  for (const [name, slugs] of Object.entries(sets)) {
    invariant(/^[a-z][a-z0-9-]*$/u.test(name), `invalid theme set ${name}`);
    for (const slug of requireUniqueStrings(slugs, `theme set ${name}`)) {
      invariant(knownSlugs.has(slug), `theme set ${name} references unknown theme ${slug}`);
      coveredSlugs.add(slug);
    }
  }
  for (const slug of knownSlugs) {
    invariant(coveredSlugs.has(slug), `source theme ${slug} has no appearance theme set`);
  }
  return sets;
}

/** @param {unknown} value @param {import('./themeDefinition.mjs').ThemeDefinitionContext} definition @returns {JsonObject} */
function validateRoleGroups(value, definition) {
  const groups = requireObject(value, 'roleGroups');
  invariant(Object.keys(groups).length > 0, 'roleGroups must not be empty');
  for (const [name, roles] of Object.entries(groups)) {
    invariant(/^[a-z][a-z0-9-]*$/u.test(name), `invalid role group ${name}`);
    for (const role of requireUniqueStrings(roles, `role group ${name}`)) {
      requireKnownRole(role, definition, `role group ${name}`);
    }
  }
  return groups;
}

/**
 * @param {unknown} value
 * @param {JsonObject} roleGroups
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} definition
 * @returns {JsonObject}
 */
function validateReference(value, roleGroups, definition) {
  const reference = requireObject(value, 'reference');
  requireFields(reference, ['apca', 'background', 'prominenceGroups', 'typography'], 'reference');
  requireKnownRole(reference.background, definition, 'reference background');
  const groups = requireUniqueStrings(reference.prominenceGroups, 'reference prominenceGroups');
  const ownedRoles = new Set();
  for (const group of groups) {
    invariant(Object.hasOwn(roleGroups, group), `reference uses unknown prominence group ${group}`);
    for (const role of roleGroups[group]) {
      invariant(!ownedRoles.has(role), `prominence groups assign ${role} more than once`);
      ownedRoles.add(role);
    }
  }
  const typography = requireObject(reference.typography, 'reference typography');
  requireFields(
    typography,
    ['family', 'sizePx', 'slant', 'weight', 'width'],
    'reference typography'
  );
  invariant(
    typeof typography.family === 'string' && typography.family.length > 0,
    'invalid typography family'
  );
  invariant(
    Number.isFinite(typography.sizePx) && typography.sizePx > 0,
    'invalid typography sizePx'
  );
  invariant(
    Number.isInteger(typography.weight) &&
      typography.weight >= 100 &&
      typography.weight <= 900 &&
      typography.weight % 100 === 0,
    'invalid typography weight'
  );
  invariant(Number.isFinite(typography.width) && typography.width > 0, 'invalid typography width');
  invariant(Number.isFinite(typography.slant), 'invalid typography slant');
  const apca = requireObject(reference.apca, 'reference APCA');
  requireFields(apca, ['maximumAbsoluteLcByPolarity', 'mode'], 'reference APCA');
  invariant(apca.mode === 'advisory', 'APCA mode must remain advisory');
  const maxima = requireObject(
    apca.maximumAbsoluteLcByPolarity,
    'reference APCA maximumAbsoluteLcByPolarity'
  );
  requireFields(
    maxima,
    ['dark-on-light', 'light-on-dark'],
    'reference APCA maximumAbsoluteLcByPolarity'
  );
  for (const maximum of Object.values(maxima)) {
    invariant(
      Number.isFinite(maximum) && maximum > 0 && maximum <= 108,
      'invalid APCA maximumAbsoluteLcByPolarity'
    );
  }
  return reference;
}

/**
 * @param {unknown} value
 * @param {JsonObject} themeSets
 * @param {JsonObject} roleGroups
 * @param {import('./themeDefinition.mjs').ThemeDefinitionContext} definition
 * @returns {JsonObject[]}
 */
function validateConstraints(value, themeSets, roleGroups, definition) {
  invariant(Array.isArray(value) && value.length > 0, 'constraints must be a non-empty array');
  const ids = new Set();
  return value.map((constraintValue, index) => {
    const constraint = requireObject(constraintValue, `constraint ${index}`);
    invariant(
      typeof constraint.id === 'string' && /^[a-z][a-z0-9-]*$/u.test(constraint.id),
      `constraint ${index} has an invalid id`
    );
    invariant(!ids.has(constraint.id), `duplicate constraint ${constraint.id}`);
    ids.add(constraint.id);
    invariant(
      CONSTRAINT_KINDS.has(constraint.kind),
      `${constraint.id} has unsupported kind ${constraint.kind}`
    );
    invariant(
      Object.hasOwn(themeSets, constraint.themeSet),
      `${constraint.id} uses unknown themeSet ${constraint.themeSet}`
    );

    if (ROLE_SELECTION_CONSTRAINT_KINDS.has(constraint.kind)) {
      validateConstraintRoles(constraint, roleGroups, definition);
    }
    for (const field of ['background', 'left', 'lessRole', 'right', 'moreRole']) {
      if (constraint[field] !== undefined)
        requireKnownRole(constraint[field], definition, `${constraint.id}/${field}`);
    }
    if (constraint.lessRoles !== undefined) {
      for (const role of requireUniqueStrings(constraint.lessRoles, `${constraint.id}/lessRoles`)) {
        requireKnownRole(role, definition, `${constraint.id}/lessRoles`);
      }
    }
    if (constraint.allowedRoles !== undefined) {
      for (const role of requireUniqueStrings(
        constraint.allowedRoles,
        `${constraint.id}/allowedRoles`
      )) {
        requireKnownRole(role, definition, `${constraint.id}/allowedRoles`);
      }
    }
    validateConstraintNumbers(constraint);
    validateConstraintShape(constraint, definition);
    return constraint;
  });
}

/** @param {JsonObject} constraint @param {JsonObject} roleGroups @param {import('./themeDefinition.mjs').ThemeDefinitionContext} definition */
function validateConstraintRoles(constraint, roleGroups, definition) {
  invariant(
    (constraint.roleGroup === undefined) !== (constraint.roles === undefined),
    `${constraint.id} must choose roles or roleGroup`
  );
  let roles;
  if (constraint.roleGroup !== undefined) {
    invariant(
      Object.hasOwn(roleGroups, constraint.roleGroup),
      `${constraint.id} uses unknown roleGroup ${constraint.roleGroup}`
    );
    roles = roleGroups[constraint.roleGroup];
  } else {
    roles = requireUniqueStrings(constraint.roles, `${constraint.id}/roles`);
    for (const role of roles) {
      requireKnownRole(role, definition, `${constraint.id}/roles`);
    }
  }
  if (
    ['bracket-palette', 'contrast-order', 'distinct-colors', 'pairwise-separation'].includes(
      constraint.kind
    )
  ) {
    invariant(roles.length >= 2, `${constraint.id} requires at least two roles`);
  }
}

/** @param {JsonObject} constraint */
function validateConstraintNumbers(constraint) {
  for (const field of [
    'maximum',
    'maximumAbsoluteLc',
    'maximumChroma',
    'maximumHue',
    'maximumHueDelta',
    'maximumLightness',
    'maximumSimilarLightnessDelta',
    'minimum',
    'minimumAbsoluteLc',
    'minimumChroma',
    'minimumCvdOklabDelta',
    'minimumCyclicAdjacentOklabDelta',
    'minimumHue',
    'minimumHueDelta',
    'minimumLightness',
    'minimumLightnessDelta',
    'minimumGap',
    'minimumOklabDelta',
    'minimumPairwiseOklabDelta',
  ]) {
    if (constraint[field] !== undefined) {
      invariant(
        Number.isFinite(constraint[field]) && constraint[field] >= 0,
        `${constraint.id} has invalid ${field}`
      );
    }
  }
}

/** @param {JsonObject} constraint @param {import('./themeDefinition.mjs').ThemeDefinitionContext} definition */
function validateConstraintShape(constraint, definition) {
  const base = ['id', 'kind', 'themeSet'];
  const fieldsByKind = /** @type {Record<string, string[]>} */ ({
    'apca-gap': [...base, 'lessRoles', 'minimum', 'moreRole'],
    'bracket-palette': [
      ...base,
      'maximumChroma',
      'maximumAbsoluteLc',
      'minimumAbsoluteLc',
      'minimumCyclicAdjacentOklabDelta',
      'minimumPairwiseOklabDelta',
      constraint.roleGroup ? 'roleGroup' : 'roles',
    ],
    'bright-pairs': [...base, 'maximumHueDelta', 'minimumLightnessDelta', 'pairs'],
    'contrast-envelope': [
      ...base,
      'maximum',
      'minimum',
      constraint.roleGroup ? 'roleGroup' : 'roles',
    ],
    'contrast-order': [
      ...base,
      'background',
      'minimumGap',
      constraint.roleGroup ? 'roleGroup' : 'roles',
    ],
    'contrast-pairs': [...base, 'pairs'],
    'chroma-order': [...base, 'lessRole', 'minimumGap', 'moreRole'],
    'distinct-colors': [...base, constraint.roleGroup ? 'roleGroup' : 'roles'],
    'forbidden-hue': [...base, 'allowedRoles', 'maximumHue', 'minimumChroma', 'minimumHue'],
    'hue-envelope': [
      ...base,
      'maximumHue',
      'minimumHue',
      constraint.roleGroup ? 'roleGroup' : 'roles',
    ],
    'oklch-envelope': [
      ...base,
      'maximumChroma',
      'maximumLightness',
      'minimumChroma',
      'minimumLightness',
      constraint.roleGroup ? 'roleGroup' : 'roles',
    ],
    'pair-separation': [
      ...base,
      'left',
      'maximumSimilarLightnessDelta',
      'minimumCvdOklabDelta',
      'minimumHueDelta',
      'minimumOklabDelta',
      'right',
    ],
    'pairwise-separation': [
      ...base,
      'minimumCvdOklabDelta',
      'minimumOklabDelta',
      constraint.roleGroup ? 'roleGroup' : 'roles',
    ],
  });
  const fields = fieldsByKind[constraint.kind];
  const allowed = new Set(fields);
  const unsupported = Object.keys(constraint).filter((field) => !allowed.has(field));
  invariant(
    unsupported.length === 0,
    `${constraint.id} has unsupported fields: ${unsupported.join(', ')}`
  );

  const requiredByKind = /** @type {Record<string, string[]>} */ ({
    'apca-gap': ['lessRoles', 'minimum', 'moreRole'],
    'bracket-palette': [
      'maximumAbsoluteLc',
      'maximumChroma',
      'minimumAbsoluteLc',
      'minimumPairwiseOklabDelta',
    ],
    'bright-pairs': ['maximumHueDelta', 'minimumLightnessDelta', 'pairs'],
    'contrast-envelope': [],
    'contrast-order': ['minimumGap'],
    'contrast-pairs': ['pairs'],
    'chroma-order': ['lessRole', 'minimumGap', 'moreRole'],
    'distinct-colors': [],
    'forbidden-hue': ['allowedRoles', 'maximumHue', 'minimumChroma', 'minimumHue'],
    'hue-envelope': ['maximumHue', 'minimumHue'],
    'oklch-envelope': [],
    'pair-separation': ['left', 'right'],
    'pairwise-separation': [],
  });
  for (const field of requiredByKind[constraint.kind]) {
    invariant(Object.hasOwn(constraint, field), `${constraint.id} requires ${field}`);
  }

  if (constraint.kind === 'apca-gap') {
    invariant(
      !constraint.lessRoles.includes(constraint.moreRole),
      `${constraint.id} compares a role with itself`
    );
  }
  if (constraint.kind === 'chroma-order') {
    invariant(constraint.moreRole !== constraint.lessRole, `${constraint.id} compares one role`);
  }
  if (constraint.kind === 'pair-separation') {
    invariant(constraint.left !== constraint.right, `${constraint.id} compares one role`);
  }

  if (constraint.kind === 'bright-pairs') {
    invariant(
      Array.isArray(constraint.pairs) && constraint.pairs.length > 0,
      `${constraint.id} must define pairs`
    );
    for (const pair of constraint.pairs) {
      invariant(
        Array.isArray(pair) && pair.length === 3 && typeof pair[2] === 'boolean',
        `${constraint.id} has an invalid bright pair`
      );
      requireKnownRole(pair[0], definition, `${constraint.id}/pairs`);
      requireKnownRole(pair[1], definition, `${constraint.id}/pairs`);
      invariant(pair[0] !== pair[1], `${constraint.id} has a self bright pair`);
    }
  }
  if (constraint.kind === 'contrast-pairs') {
    invariant(
      Array.isArray(constraint.pairs) && constraint.pairs.length > 0,
      `${constraint.id} must define pairs`
    );
    for (const pair of constraint.pairs) {
      invariant(
        Array.isArray(pair) &&
          pair.length === 3 &&
          Number.isFinite(pair[2]) &&
          pair[2] >= 1 &&
          pair[2] <= 21,
        `${constraint.id} has an invalid contrast pair`
      );
      requireKnownRole(pair[0], definition, `${constraint.id}/pairs`);
      requireKnownRole(pair[1], definition, `${constraint.id}/pairs`);
      invariant(pair[0] !== pair[1], `${constraint.id} has a self contrast pair`);
    }
  }
  if (constraint.kind === 'contrast-envelope') {
    invariant(
      constraint.minimum !== undefined || constraint.maximum !== undefined,
      `${constraint.id} has no envelope`
    );
    if (constraint.minimum !== undefined) {
      invariant(constraint.minimum >= 1 && constraint.minimum <= 21, `${constraint.id} minimum`);
    }
    if (constraint.maximum !== undefined) {
      invariant(constraint.maximum >= 1 && constraint.maximum <= 21, `${constraint.id} maximum`);
    }
    if (constraint.minimum !== undefined && constraint.maximum !== undefined) {
      invariant(constraint.minimum <= constraint.maximum, `${constraint.id} has an inverted range`);
    }
  }
  if (constraint.kind === 'oklch-envelope') {
    invariant(
      ['minimumLightness', 'maximumLightness', 'minimumChroma', 'maximumChroma'].some(
        (field) => constraint[field] !== undefined
      ),
      `${constraint.id} has no envelope`
    );
    for (const [minimumField, maximumField] of [
      ['minimumLightness', 'maximumLightness'],
      ['minimumChroma', 'maximumChroma'],
    ]) {
      if (constraint[minimumField] !== undefined && constraint[maximumField] !== undefined) {
        invariant(
          constraint[minimumField] <= constraint[maximumField],
          `${constraint.id} has an inverted ${minimumField}/${maximumField} range`
        );
      }
    }
  }
  if (constraint.kind === 'pair-separation') {
    invariant(
      ['minimumOklabDelta', 'minimumCvdOklabDelta', 'minimumHueDelta'].some(
        (field) => constraint[field] !== undefined
      ),
      `${constraint.id} has no separation`
    );
    invariant(
      (constraint.minimumHueDelta === undefined) ===
        (constraint.maximumSimilarLightnessDelta === undefined),
      `${constraint.id} must pair hue and lightness conditions`
    );
  }
  if (constraint.kind === 'pairwise-separation') {
    invariant(
      constraint.minimumOklabDelta !== undefined || constraint.minimumCvdOklabDelta !== undefined,
      `${constraint.id} has no separation`
    );
  }
  if (constraint.kind === 'bracket-palette') {
    invariant(
      constraint.minimumAbsoluteLc <= constraint.maximumAbsoluteLc,
      `${constraint.id} has an inverted APCA range`
    );
    invariant(constraint.maximumAbsoluteLc <= 108, `${constraint.id} exceeds the APCA range`);
  }

  for (const field of ['minimumHue', 'maximumHue']) {
    if (constraint[field] !== undefined) {
      invariant(constraint[field] < 360, `${constraint.id} has invalid ${field}`);
    }
  }
  if (constraint.maximumHueDelta !== undefined) {
    invariant(constraint.maximumHueDelta <= 180, `${constraint.id} has invalid maximumHueDelta`);
  }
  for (const field of [
    'minimumLightness',
    'maximumLightness',
    'minimumLightnessDelta',
    'maximumSimilarLightnessDelta',
  ]) {
    if (constraint[field] !== undefined) {
      invariant(constraint[field] <= 1, `${constraint.id} has invalid ${field}`);
    }
  }
}

/** @param {JsonObject} contract @returns {JsonObject} */
function requireValidatedContract(contract) {
  return VALIDATED_CONTRACTS.has(contract) ? contract : validateThemeAppearanceContract(contract);
}

/** @param {unknown} value @param {string} owner @returns {JsonObject} */
function requireObject(value, owner) {
  invariant(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${owner} must be an object`
  );
  return value;
}

/** @param {JsonObject} value @param {readonly string[]} fields @param {string} owner */
function requireFields(value, fields, owner) {
  invariant(
    JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify([...fields].toSorted()),
    `${owner} has unsupported or missing fields`
  );
}

/** @param {unknown} value @param {string} owner @returns {string[]} */
function requireUniqueStrings(value, owner) {
  invariant(Array.isArray(value) && value.length > 0, `${owner} must be a non-empty array`);
  invariant(
    value.every((item) => typeof item === 'string' && item.length > 0),
    `${owner} must contain strings`
  );
  invariant(new Set(value).size === value.length, `${owner} must be unique`);
  return value;
}

/** @param {unknown} value @param {import('./themeDefinition.mjs').ThemeDefinitionContext} definition @param {string} owner @returns {string} */
function requireKnownRole(value, definition, owner) {
  invariant(typeof value === 'string', `${owner} must be a role`);
  const separator = value.indexOf(':');
  const namespace = value.slice(0, separator);
  const role = value.slice(separator + 1);
  const rolesByNamespace = /** @type {Record<string, readonly string[]>} */ (
    definition.requiredThemeRoles
  );
  invariant(
    separator > 0 &&
      Object.hasOwn(rolesByNamespace, namespace) &&
      rolesByNamespace[namespace].includes(role),
    `${owner} references unknown role ${value}`
  );
  return value;
}

/** @param {unknown} condition @param {string} message @returns {asserts condition} */
function invariant(condition, message) {
  if (!condition) throw new Error(`Invalid theme appearance contract: ${message}`);
}

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}
