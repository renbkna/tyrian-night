// @ts-check

/**
 * @typedef {{ red: number; green: number; blue: number; alpha: number; hex: string }} ParsedHexColor
 */

/**
 * @param {string} color
 * @returns {ParsedHexColor}
 */
export function parseHexColor(color) {
  const normalized = color.replace(/^#/, '');

  if (!/^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/u.test(normalized)) {
    throw new Error(`Unsupported hex color '${color}'`);
  }

  const expanded =
    normalized.length <= 4
      ? [...normalized].map((character) => `${character}${character}`).join('')
      : normalized;

  return {
    hex: expanded.slice(0, 6).toUpperCase(),
    red: Number.parseInt(expanded.slice(0, 2), 16),
    green: Number.parseInt(expanded.slice(2, 4), 16),
    blue: Number.parseInt(expanded.slice(4, 6), 16),
    alpha: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) : 255,
  };
}

/**
 * @param {string} color
 * @returns {boolean}
 */
export function isLightHex(color) {
  const { red, green, blue } = parseHexColor(color);
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;

  return luminance > 0.5;
}

/**
 * @param {string} color
 * @returns {boolean}
 */
export function isTransparentHex(color) {
  return parseHexColor(color).alpha === 0;
}

/**
 * @param {string} color
 * @param {string} alpha
 * @returns {string}
 */
export function withHexAlpha(color, alpha) {
  const parsed = parseHexColor(color);

  return `#${parsed.hex}${alpha.toUpperCase()}`;
}

/**
 * @param {string} color
 * @param {string} [background]
 * @returns {string}
 */
export function opaqueHex(color, background = '#000000') {
  const foreground = parseHexColor(color);

  if (foreground.alpha === 255) {
    return `#${foreground.hex}`;
  }

  const backdrop = parseHexColor(background);
  const alpha = foreground.alpha / 255;
  const red = blendChannel(foreground.red, backdrop.red, alpha);
  const green = blendChannel(foreground.green, backdrop.green, alpha);
  const blue = blendChannel(foreground.blue, backdrop.blue, alpha);

  return `#${toHexByte(red)}${toHexByte(green)}${toHexByte(blue)}`;
}

/**
 * @param {number} foreground
 * @param {number} background
 * @param {number} alpha
 * @returns {number}
 */
function blendChannel(foreground, background, alpha) {
  return Math.round(foreground * alpha + background * (1 - alpha));
}

/**
 * @param {number} value
 * @returns {string}
 */
function toHexByte(value) {
  return value.toString(16).toUpperCase().padStart(2, '0');
}
