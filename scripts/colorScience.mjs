// @ts-check

import { opaqueHex } from './colorUtils.mjs';

const GAMUT_EPSILON = 1e-7;
const DIAGNOSTIC_SIGNIFICANT_DIGITS = 9;

/**
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
 *   contrast?: number;
 *   hex: string;
 *   oklab: Oklab;
 *   oklch: Oklch;
 * }} ColorMetrics
 */

/**
 * Policy-free observations for one rendered sRGB color. Translucent colors
 * require the backdrop that owns their composition.
 * @param {string} color
 * @param {string} [background]
 * @returns {ColorMetrics}
 */
export function colorMetrics(color, background) {
  const hex = opaqueHex(color, background);

  return {
    contrast: background ? contrastRatio(hex, opaqueHex(background)) : undefined,
    hex,
    oklab: hexToOklab(hex),
    oklch: hexToOklch(hex),
  };
}

/** @param {ColorComparisonInput} input @returns {ColorComparison} */
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

/** @param {string} foreground @param {string} background */
export function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(opaqueHex(foreground));
  const backgroundLuminance = relativeLuminance(opaqueHex(background));
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/** @param {string} color @returns {Oklab} */
export function hexToOklab(color) {
  const [red, green, blue] = hexToLinearRgb(opaqueHex(color));
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

/** @param {string} color @returns {Oklch} */
export function hexToOklch(color) {
  const lab = hexToOklab(color);
  const chroma = Math.hypot(lab.a, lab.b);
  const hue = radiansToDegrees(Math.atan2(lab.b, lab.a));
  return {
    C: chroma,
    L: lab.L,
    h: chroma <= 0.000004 ? Number.NaN : hue < 0 ? hue + 360 : hue,
  };
}

/**
 * Fraction of the available sRGB chroma occupied at the color's exact OKLCH
 * lightness and hue. This is an authoring observation, not a salience,
 * comfort, or aesthetic score.
 * @param {string} color
 */
export function gamutRelativeRichness(color) {
  const { C, L, h } = hexToOklch(color);
  if (!Number.isFinite(h) || C <= 0.000004) return 0;
  const maximum = maximumSrgbChroma(L, h);
  return maximum <= 0.000004 ? 0 : Math.min(1, C / maximum);
}

/** @param {Oklab} left @param {Oklab} right */
export function oklabDelta(left, right) {
  return Math.hypot(left.L - right.L, left.a - right.a, left.b - right.b) * 100;
}

/** @param {string} color */
export function relativeLuminance(color) {
  const [red, green, blue] = hexToLinearRgb(opaqueHex(color));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** @param {number} value */
export function quantizeDiagnosticNumber(value) {
  return Number(value.toPrecision(DIAGNOSTIC_SIGNIFICANT_DIGITS));
}

/** @param {number} left @param {number} right */
export function hueDistance(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.NaN;
  const distance = Math.abs(left - right) % 360;
  return Math.min(distance, 360 - distance);
}

/** @param {number} hue @param {number} minimum @param {number} maximum */
export function hueInsideRange(hue, minimum, maximum) {
  return minimum <= maximum ? hue >= minimum && hue <= maximum : hue >= minimum || hue <= maximum;
}

/** @param {number} lightness @param {number} hue */
function maximumSrgbChroma(lightness, hue) {
  requireUnit(lightness, 'OKLCH lightness');
  requireFiniteRange(hue, 0, 360, 'OKLCH hue', true);
  let lower = 0;
  let upper = 0.5;
  for (let index = 0; index < 26; index += 1) {
    const middle = (lower + upper) / 2;
    if (isOklchInSrgbGamut({ C: middle, L: lightness, h: hue })) lower = middle;
    else upper = middle;
  }
  return lower;
}

/** @param {Oklch} color */
function isOklchInSrgbGamut(color) {
  return oklchToLinearRgb(color).every(
    (channel) => channel >= -GAMUT_EPSILON && channel <= 1 + GAMUT_EPSILON
  );
}

/** @param {Oklch} color @returns {[number, number, number]} */
function oklchToLinearRgb(color) {
  requireUnit(color.L, 'OKLCH lightness');
  requireFiniteRange(color.C, 0, 0.5, 'OKLCH chroma');
  requireFiniteRange(color.h, 0, 360, 'OKLCH hue', true);
  const radians = degreesToRadians(color.h);
  const a = color.C * Math.cos(radians);
  const b = color.C * Math.sin(radians);
  const longRoot = color.L + 0.3963377774 * a + 0.2158037573 * b;
  const mediumRoot = color.L - 0.1055613458 * a - 0.0638541728 * b;
  const shortRoot = color.L - 0.0894841775 * a - 1.291485548 * b;
  const long = longRoot ** 3;
  const medium = mediumRoot ** 3;
  const short = shortRoot ** 3;
  return [
    4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
  ];
}

/** @param {string} color @returns {[number, number, number]} */
function hexToLinearRgb(color) {
  return [
    linearize(Number.parseInt(color.slice(1, 3), 16) / 255),
    linearize(Number.parseInt(color.slice(3, 5), 16) / 255),
    linearize(Number.parseInt(color.slice(5, 7), 16) / 255),
  ];
}

/** @param {number} value */
function linearize(value) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** @param {number} degrees */
function degreesToRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

/** @param {number} radians */
function radiansToDegrees(radians) {
  return (radians * 180) / Math.PI;
}

/** @param {number} value @param {string} owner */
function requireUnit(value, owner) {
  requireFiniteRange(value, 0, 1, owner);
}

/** @param {number} value @param {number} minimum @param {number} maximum @param {string} owner @param {boolean} [maximumExclusive] */
function requireFiniteRange(value, minimum, maximum, owner, maximumExclusive = false) {
  if (
    !Number.isFinite(value) ||
    value < minimum ||
    (maximumExclusive ? value >= maximum : value > maximum)
  ) {
    throw new Error(
      `${owner} must be within ${minimum}..${maximum}${maximumExclusive ? ' (exclusive)' : ''}.`
    );
  }
}
