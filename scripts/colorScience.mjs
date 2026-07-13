// @ts-check

import { Cam16 } from '../node_modules/@material/material-color-utilities/hct/cam16.js';
import { Hct } from '../node_modules/@material/material-color-utilities/hct/hct.js';
import { opaqueHex, parseHexColor } from './colorUtils.mjs';
import { themeColor } from './themeDefinition.mjs';

/**
 * @typedef {{ chroma: number; hue: number; tone: number }} HctColor
 * @typedef {{ chroma: number; hue: number; j: number; m: number; q: number; s: number }} Cam16Color
 * @typedef {{ L: number; a: number; b: number }} Oklab
 * @typedef {{ C: number; L: number; h: number }} Oklch
 * @typedef {{ background?: string; left: string; right: string }} ColorComparisonInput
 * @typedef {{
 *   contrastLeft?: number;
 *   contrastRight?: number;
 *   deltaChroma: number;
 *   deltaHue: number;
 *   deltaLightness: number;
 *   left: ColorMetrics;
 *   oklabDelta: number;
 *   right: ColorMetrics;
 * }} ColorComparison
 * @typedef {{
 *   cam16: Cam16Color;
 *   contrast?: number;
 *   hex: string;
 *   hct: HctColor;
 *   oklab: Oklab;
 *   oklch: Oklch;
 * }} ColorMetrics
 * @typedef {import('./themeDefinition.mjs').ThemeDefinition} ThemeDefinition
 * @typedef {{ hex: string; role: string }} ThemeRoleColor
 * @typedef {{
 *   leftRole: string;
 *   maxSimilarLightness: number;
 *   minDelta: number;
 *   minHue: number;
 *   name: string;
 *   rightRole: string;
 * }} RolePairRule
 * @typedef {{
 *   comparison: ColorComparison;
 *   left: ThemeRoleColor;
 *   penalty: number;
 *   reasons: string[];
 *   right: ThemeRoleColor;
 *   rule: RolePairRule;
 * }} RolePairRisk
 * @typedef {{
 *   color: ThemeRoleColor;
 *   contrast: number;
 *   metrics: ColorMetrics;
 *   nearest: { delta: number; hex: string; role: string };
 *   oklch: Oklch;
 * }} RoleAudit
 */

export const DEFAULT_SYNTAX_ROLES = {
  add: 'syntax:function',
  comment: 'syntax:comment',
  def: 'syntax:keyword',
  self: 'syntax:data',
  sentinel: 'syntax:constantLanguage',
  string: 'syntax:string',
  type: 'syntax:type',
  value: 'syntax:data',
};

export const DEFAULT_ROLE_PAIR_RULES = [
  {
    leftRole: 'self',
    maxSimilarLightness: 0.08,
    minDelta: 14,
    minHue: 50,
    name: 'receiver/function adjacency',
    rightRole: 'add',
  },
  {
    leftRole: 'self',
    maxSimilarLightness: 0.08,
    minDelta: 12,
    minHue: 30,
    name: 'receiver/keyword distinction',
    rightRole: 'def',
  },
  {
    leftRole: 'self',
    maxSimilarLightness: 0.08,
    minDelta: 10,
    minHue: 30,
    name: 'receiver/type distinction',
    rightRole: 'type',
  },
  {
    leftRole: 'add',
    maxSimilarLightness: 0.1,
    minDelta: 10,
    minHue: 25,
    name: 'function/data distinction',
    rightRole: 'value',
  },
];

export const DEFAULT_SAMPLE_ROLE_SEQUENCE = ['def', 'add', 'self', 'value', 'type'];

/**
 * @param {string} color
 * @param {string} [background]
 * @returns {ColorMetrics}
 */
export function colorMetrics(color, background) {
  const hex = opaqueHex(color, background);
  const argb = hexToArgb(hex);
  const hct = Hct.fromInt(argb);
  const cam16 = Cam16.fromInt(argb);

  return {
    cam16: {
      chroma: cam16.chroma,
      hue: cam16.hue,
      j: cam16.j,
      m: cam16.m,
      q: cam16.q,
      s: cam16.s,
    },
    contrast: background ? contrastRatio(hex, opaqueHex(background)) : undefined,
    hex,
    hct: {
      chroma: hct.chroma,
      hue: hct.hue,
      tone: hct.tone,
    },
    oklab: hexToOklab(hex),
    oklch: hexToOklch(hex),
  };
}

/**
 * @param {ColorComparisonInput} input
 * @returns {ColorComparison}
 */
export function compareColors(input) {
  const left = colorMetrics(input.left, input.background);
  const right = colorMetrics(input.right, input.background);

  return {
    contrastLeft: left.contrast,
    contrastRight: right.contrast,
    deltaChroma: Math.abs(left.oklch.C - right.oklch.C),
    deltaHue: hueDistance(left.oklch.h, right.oklch.h),
    deltaLightness: Math.abs(left.oklch.L - right.oklch.L),
    left,
    oklabDelta: oklabDelta(left.oklab, right.oklab),
    right,
  };
}

/**
 * @param {ThemeDefinition} theme
 * @param {Record<string, string>} [roleMap]
 * @returns {ThemeRoleColor[]}
 */
export function themeRoleColors(theme, roleMap = DEFAULT_SYNTAX_ROLES) {
  return Object.entries(roleMap).map(([role, source]) => ({
    hex: themeColor(theme, source),
    role,
  }));
}

/**
 * @param {ThemeDefinition} theme
 * @param {ThemeRoleColor[]} [roleColors]
 * @returns {RoleAudit[]}
 */
export function auditThemeRoles(theme, roleColors = themeRoleColors(theme)) {
  const background = themeColor(theme, 'ui:surface.canvas');

  return roleColors.map((color) => {
    const neighbors = roleColors.filter((neighbor) => neighbor.role !== color.role);
    const nearest = nearestRole(color, neighbors);
    const metrics = colorMetrics(color.hex, background);

    return {
      color,
      contrast: metrics.contrast ?? 0,
      metrics,
      nearest,
      oklch: metrics.oklch,
    };
  });
}

/**
 * @param {ThemeDefinition} theme
 * @param {string[]} candidates
 * @param {{ minContrast?: number; neighbors?: ThemeRoleColor[]; pairRules?: RolePairRule[]; role?: string; targetContrast?: number }} [options]
 * @returns {Array<{ contrast: number; hex: string; metrics: ColorMetrics; nearest: { delta: number; hex: string; role: string }; oklch: Oklch; pairRisk?: RolePairRisk; score: number }>}
 */
export function rankCandidates(theme, candidates, options = {}) {
  const background = themeColor(theme, 'ui:surface.canvas');
  const minContrast = options.minContrast ?? 4.5;
  const neighbors = options.neighbors ?? themeRoleColors(theme);
  const pairRules = options.pairRules ?? DEFAULT_ROLE_PAIR_RULES;
  const role = options.role ?? 'candidate';
  const targetContrast = options.targetContrast ?? (isLightBackground(background) ? 5.5 : 6);

  return candidates
    .map((candidate) => {
      const metrics = colorMetrics(candidate, background);
      const candidateColor = { hex: metrics.hex, role };
      const nearest = nearestRole(candidateColor, neighbors);
      const pairRisk = worstRolePairRisk(candidateColor, neighbors, pairRules);
      const contrast = metrics.contrast ?? 0;
      const score =
        nearest.delta * 2 +
        metrics.oklch.C * 45 -
        Math.abs(contrast - targetContrast) * 1.5 -
        (pairRisk?.penalty ?? 0) * 4;

      return {
        contrast,
        hex: metrics.hex,
        metrics,
        nearest,
        oklch: metrics.oklch,
        pairRisk,
        score,
      };
    })
    .filter((candidate) => candidate.contrast >= minContrast)
    .sort((left, right) => right.score - left.score);
}

/**
 * @param {ThemeRoleColor[]} roleColors
 * @param {RolePairRule[]} [pairRules]
 * @returns {RolePairRisk[]}
 */
export function auditRolePairs(roleColors, pairRules = DEFAULT_ROLE_PAIR_RULES) {
  return pairRules
    .map((rule) => {
      const left = roleColors.find((color) => color.role === rule.leftRole);
      const right = roleColors.find((color) => color.role === rule.rightRole);

      return left && right ? rolePairRisk(left, right, rule) : undefined;
    })
    .filter(isPositiveRolePairRisk);
}

/**
 * @param {ThemeRoleColor[]} roleColors
 * @param {string[]} [sampleRoles]
 * @returns {Array<{ comparison: ColorComparison; left: ThemeRoleColor; right: ThemeRoleColor }>}
 */
export function auditSampleSequence(roleColors, sampleRoles = DEFAULT_SAMPLE_ROLE_SEQUENCE) {
  return sampleRoles.slice(0, -1).map((leftRole, index) => {
    const rightRole = sampleRoles[index + 1];
    const left = requiredRoleColor(roleColors, leftRole);
    const right = requiredRoleColor(roleColors, rightRole);

    return {
      comparison: compareColors({ left: left.hex, right: right.hex }),
      left,
      right,
    };
  });
}

/**
 * @param {ThemeDefinition} theme
 * @param {string} role
 * @param {Record<string, string>} [roleMap]
 * @returns {string}
 */
export function themeRoleColor(theme, role, roleMap = DEFAULT_SYNTAX_ROLES) {
  const source = roleMap[role];

  if (!source) {
    throw new Error(`Unknown role '${role}'`);
  }

  return themeColor(theme, source);
}

/**
 * @param {string} foreground
 * @param {string} background
 * @returns {number}
 */
export function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);

  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * @param {string} color
 * @returns {Oklab}
 */
export function hexToOklab(color) {
  const [red, green, blue] = hexToLinearRgb(color);
  const long = 0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue;
  const medium = 0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue;
  const short = 0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue;
  const longRoot = Math.cbrt(long);
  const mediumRoot = Math.cbrt(medium);
  const shortRoot = Math.cbrt(short);

  return {
    L: 0.2104542553 * longRoot + 0.793617785 * mediumRoot - 0.0040720468 * shortRoot,
    a: 1.9779984951 * longRoot - 2.428592205 * mediumRoot + 0.4505937099 * shortRoot,
    b: 0.0259040371 * longRoot + 0.7827717662 * mediumRoot - 0.808675766 * shortRoot,
  };
}

/**
 * @param {string} color
 * @returns {Oklch}
 */
export function hexToOklch(color) {
  const lab = hexToOklab(color);
  const hue = radiansToDegrees(Math.atan2(lab.b, lab.a));

  return {
    C: Math.hypot(lab.a, lab.b),
    L: lab.L,
    h: hue < 0 ? hue + 360 : hue,
  };
}

/**
 * @param {Oklab} left
 * @param {Oklab} right
 * @returns {number}
 */
export function oklabDelta(left, right) {
  return Math.hypot(left.L - right.L, left.a - right.a, left.b - right.b) * 100;
}

/**
 * @param {string} color
 * @returns {number}
 */
export function relativeLuminance(color) {
  const [red, green, blue] = hexToLinearRgb(color);

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * @param {string} color
 * @returns {number}
 */
function hexToArgb(color) {
  const { blue, green, red } = parseHexColor(opaqueHex(color));

  return ((0xff << 24) | (red << 16) | (green << 8) | blue) >>> 0;
}

/**
 * @param {string} color
 * @returns {[number, number, number]}
 */
function hexToLinearRgb(color) {
  const { blue, green, red } = parseHexColor(opaqueHex(color));

  return [linearize(red / 255), linearize(green / 255), linearize(blue / 255)];
}

/**
 * @param {number} value
 * @returns {number}
 */
function linearize(value) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/**
 * @param {number} radians
 * @returns {number}
 */
function radiansToDegrees(radians) {
  return (radians * 180) / Math.PI;
}

/**
 * @param {number} left
 * @param {number} right
 * @returns {number}
 */
function hueDistance(left, right) {
  const distance = Math.abs(left - right) % 360;

  return Math.min(distance, 360 - distance);
}

/**
 * @param {ThemeRoleColor} color
 * @param {ThemeRoleColor[]} neighbors
 * @returns {{ delta: number; hex: string; role: string }}
 */
function nearestRole(color, neighbors) {
  if (neighbors.length === 0) {
    throw new Error('Cannot compare a color without neighbors');
  }

  return neighbors
    .map((neighbor) => ({
      delta: compareColors({ left: color.hex, right: neighbor.hex }).oklabDelta,
      hex: neighbor.hex,
      role: neighbor.role,
    }))
    .sort((left, right) => left.delta - right.delta)[0];
}

/**
 * @param {ThemeRoleColor} candidate
 * @param {ThemeRoleColor[]} neighbors
 * @param {RolePairRule[]} pairRules
 * @returns {RolePairRisk | undefined}
 */
function worstRolePairRisk(candidate, neighbors, pairRules) {
  return pairRules
    .flatMap((rule) => {
      if (rule.leftRole === candidate.role) {
        const right = neighbors.find((neighbor) => neighbor.role === rule.rightRole);

        return right ? [rolePairRisk(candidate, right, rule)] : [];
      }

      if (rule.rightRole === candidate.role) {
        const left = neighbors.find((neighbor) => neighbor.role === rule.leftRole);

        return left ? [rolePairRisk(left, candidate, rule)] : [];
      }

      return [];
    })
    .filter((risk) => risk.penalty > 0)
    .sort((left, right) => right.penalty - left.penalty)[0];
}

/**
 * @param {ThemeRoleColor} left
 * @param {ThemeRoleColor} right
 * @param {RolePairRule} rule
 * @returns {RolePairRisk}
 */
function rolePairRisk(left, right, rule) {
  const comparison = compareColors({ left: left.hex, right: right.hex });
  const reasons = [];
  let penalty = 0;

  if (comparison.oklabDelta < rule.minDelta) {
    const deltaGap = rule.minDelta - comparison.oklabDelta;
    penalty += deltaGap;
    reasons.push(`delta<${formatRuleNumber(rule.minDelta)}`);
  }

  if (comparison.deltaHue < rule.minHue && comparison.deltaLightness < rule.maxSimilarLightness) {
    const hueGap = (rule.minHue - comparison.deltaHue) / 10;
    penalty += hueGap;
    reasons.push(`hue<${formatRuleNumber(rule.minHue)}`);
  }

  return { comparison, left, penalty, reasons, right, rule };
}

/**
 * @param {RolePairRisk | undefined} risk
 * @returns {risk is RolePairRisk}
 */
function isPositiveRolePairRisk(risk) {
  return risk !== undefined && risk.penalty > 0;
}

/**
 * @param {ThemeRoleColor[]} roleColors
 * @param {string} role
 * @returns {ThemeRoleColor}
 */
function requiredRoleColor(roleColors, role) {
  const color = roleColors.find((entry) => entry.role === role);

  if (!color) {
    throw new Error(`Missing role '${role}'`);
  }

  return color;
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatRuleNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * @param {string} background
 * @returns {boolean}
 */
function isLightBackground(background) {
  return relativeLuminance(background) > 0.5;
}
