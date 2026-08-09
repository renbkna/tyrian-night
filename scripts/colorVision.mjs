// @ts-check

import { opaqueHex, parseHexColor, toHexByte } from './colorUtils.mjs';
import { linearToSrgbChannel, srgbToLinearChannel } from './colorScience.mjs';

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
  /** @type {ColorVisionMode[]} */ (Object.keys(MATRICES))
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
    srgbToLinearChannel(channel / 255)
  );
  const simulated = matrix.map((row) =>
    linearToSrgbChannel(
      clamp(row.reduce((total, coefficient, index) => total + coefficient * linear[index], 0))
    )
  );

  return `#${simulated.map((channel) => toHexByte(clamp(channel) * 255)).join('')}`;
}

/** @param {number} value */
function clamp(value) {
  return Math.min(1, Math.max(0, value));
}
