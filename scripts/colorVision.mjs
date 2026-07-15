// @ts-check

import { opaqueHex, parseHexColor } from './colorUtils.mjs';

/** @typedef {'protan' | 'deutan' | 'tritan'} ColorVisionMode */

// Complete-dichromacy matrices from Machado, Oliveira, and Fernandes (2009).
const MATRICES = Object.freeze({
  protan: Object.freeze([
    Object.freeze([0.152286, 1.052583, -0.204868]),
    Object.freeze([0.114503, 0.786281, 0.099216]),
    Object.freeze([-0.003882, -0.048116, 1.051998]),
  ]),
  deutan: Object.freeze([
    Object.freeze([0.367322, 0.860646, -0.227968]),
    Object.freeze([0.280085, 0.672501, 0.047413]),
    Object.freeze([-0.01182, 0.04294, 0.968881]),
  ]),
  tritan: Object.freeze([
    Object.freeze([1.255528, -0.076749, -0.178779]),
    Object.freeze([-0.078411, 0.930809, 0.147602]),
    Object.freeze([0.004733, 0.691367, 0.3039]),
  ]),
});

export const COLOR_VISION_MODES = Object.freeze(
  /** @type {ColorVisionMode[]} */ (['protan', 'deutan', 'tritan'])
);

/**
 * Simulates complete dichromacy in linear sRGB. Alpha colors are composited first,
 * because the rendered color—not its source literal—is what must remain distinct.
 *
 * @param {string} color
 * @param {ColorVisionMode} mode
 * @param {string} [background]
 * @returns {string}
 */
export function simulateColorVision(color, mode, background) {
  const matrix = MATRICES[mode];
  if (!matrix) throw new Error(`Unsupported color-vision mode '${mode}'.`);

  const parsed = parseHexColor(opaqueHex(color, background));
  const linear = [parsed.red, parsed.green, parsed.blue].map((channel) =>
    srgbToLinear(channel / 255)
  );
  const simulated = matrix.map((row) =>
    linearToSrgb(
      clamp(row.reduce((total, coefficient, index) => total + coefficient * linear[index], 0))
    )
  );

  return `#${simulated.map((channel) => toHexByte(channel * 255)).join('')}`;
}

/** @param {number} value */
function srgbToLinear(value) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** @param {number} value */
function linearToSrgb(value) {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

/** @param {number} value */
function clamp(value) {
  return Math.min(1, Math.max(0, value));
}

/** @param {number} value */
function toHexByte(value) {
  return Math.round(clamp(value / 255) * 255)
    .toString(16)
    .toUpperCase()
    .padStart(2, '0');
}
