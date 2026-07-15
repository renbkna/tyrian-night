// @ts-check

import { Cam16 } from '../node_modules/@material/material-color-utilities/hct/cam16.js';
import { Hct } from '../node_modules/@material/material-color-utilities/hct/hct.js';

import { opaqueHex, parseHexColor } from './colorUtils.mjs';

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
 */

/**
 * Policy-free observations for one color. Translucent colors require their owned backdrop.
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
    hct: { chroma: hct.chroma, hue: hct.hue, tone: hct.tone },
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
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/** @param {string} color @returns {Oklab} */
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

/** @param {Oklab} left @param {Oklab} right */
export function oklabDelta(left, right) {
  return Math.hypot(left.L - right.L, left.a - right.a, left.b - right.b) * 100;
}

/** @param {string} color */
export function relativeLuminance(color) {
  const [red, green, blue] = hexToLinearRgb(color);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** @param {string} color */
export function hexToArgb(color) {
  const { blue, green, red } = parseHexColor(opaqueHex(color));
  return ((0xff << 24) | (red << 16) | (green << 8) | blue) >>> 0;
}

/** @param {number} argb */
export function argbToHex(argb) {
  return `#${(argb & 0xffffff).toString(16).padStart(6, '0').toUpperCase()}`;
}

/** @param {string} color @returns {[number, number, number]} */
function hexToLinearRgb(color) {
  const { blue, green, red } = parseHexColor(opaqueHex(color));
  return [linearize(red / 255), linearize(green / 255), linearize(blue / 255)];
}

/** @param {number} value */
function linearize(value) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** @param {number} radians */
function radiansToDegrees(radians) {
  return (radians * 180) / Math.PI;
}

/** @param {number} left @param {number} right */
function hueDistance(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.NaN;
  const distance = Math.abs(left - right) % 360;
  return Math.min(distance, 360 - distance);
}
