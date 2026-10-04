// @ts-check

import { apcaContrast, hexToOklch, maximumSrgbChroma, oklchToHex } from './colorScience.mjs';

/**
 * Syntax colors are derived, not authored. A recipe states an APCA contrast
 * target for each syntax tier and for plain text, a saturation level in its
 * band's measure, and the chroma of its neutral pigments. The solver finds the
 * OKLCH lightness that meets each target against the editor canvas. Colored
 * pigments take their chroma from the saturation model, capped by their tier's
 * colorfulness ceiling, which is measured on the rendered lead colors so 8-bit
 * encoding cannot push a pigment over it.
 *
 * @typedef {{
 *   saturation: number;
 *   contrast: Record<string, number>;
 *   chroma: Record<string, number>;
 * }} SyntaxTargets
 * @typedef {import('./themeDefinition.mjs').SyntaxHierarchyTier} SyntaxHierarchyTier
 * @typedef {'chroma' | 'richness'} SaturationMeasure
 */

/** Colored pigments stay this far inside sRGB so encoding never clips them. */
const GAMUT_MARGIN = 0.97;
const LIGHTNESS_ITERATIONS = 40;
/** Each retry lowers a capped pigment's chroma by 0.5% until it renders under its ceiling. */
const CEILING_RETRY_FACTOR = 0.995;
const CEILING_RETRIES = 200;
/** The contrast target key for plain text, beside the hierarchy tier names. */
export const PLAIN_TARGET = 'plain';

/**
 * @param {{
 *   canvas: string;
 *   appearance: 'dark' | 'light';
 *   hue: (pigment: string) => number | null;
 *   targets: SyntaxTargets;
 *   hierarchy: readonly SyntaxHierarchyTier[];
 *   plainPigment: string;
 *   coloredPigments: ReadonlySet<string>;
 *   measure: SaturationMeasure;
 *   owner: string;
 * }} input
 * @returns {Record<string, [number, number]>}
 */
export function solveSyntaxPigments(input) {
  const { canvas, appearance, targets, hierarchy, plainPigment, coloredPigments, owner } = input;
  const canvasLightness = hexToOklch(canvas).L;

  /**
   * @param {string} pigment
   * @param {number} target
   * @param {number} ceiling Rendered-chroma ceiling; infinite when the tier has none.
   * @returns {[number, number]}
   */
  const solve = (pigment, target, ceiling) => {
    const hue = input.hue(pigment);
    const model = chromaModel(pigment, input);
    let cap = ceiling;
    for (let retry = 0; retry <= CEILING_RETRIES; retry += 1) {
      /** @param {number} lightness */
      const chromaAt = (lightness) => Math.min(model(lightness), cap);
      const lightness = solveLightness({
        appearance,
        canvas,
        canvasLightness,
        chromaAt,
        hue: hue ?? 0,
        owner,
        pigment,
        target,
      });
      const chroma = chromaAt(lightness);
      const rendered = hexToOklch(oklchToHex({ C: chroma, L: lightness, h: hue ?? 0 })).C;
      if (rendered <= ceiling) return [lightness, chroma];
      cap = Math.min(cap, chroma) * CEILING_RETRY_FACTOR;
    }
    throw new Error(`${owner} syntax pigment '${pigment}' cannot render under its chroma ceiling.`);
  };

  /** @type {Record<string, [number, number]>} */
  const solved = {};
  const [lead, ...lowerTiers] = hierarchy;
  if (!lead) throw new Error(`${owner} syntax hierarchy has no lead tier.`);
  for (const pigment of lead.pigments) {
    solved[pigment] = solve(pigment, tierTarget(targets, lead.tier, owner), Infinity);
  }
  const leadChroma = Math.max(
    ...lead.pigments.map((pigment) => renderedChroma(pigment, solved, input))
  );
  for (const { tier, pigments, maximumChromaShareOfLead } of lowerTiers) {
    const ceiling =
      maximumChromaShareOfLead === undefined ? Infinity : maximumChromaShareOfLead * leadChroma;
    for (const pigment of pigments) {
      solved[pigment] = solve(
        pigment,
        tierTarget(targets, tier, owner),
        coloredPigments.has(pigment) ? ceiling : Infinity
      );
    }
  }
  solved[plainPigment] = solve(plainPigment, tierTarget(targets, PLAIN_TARGET, owner), Infinity);
  return solved;
}

/**
 * Chroma as a function of lightness: the saturation model for colored
 * pigments, the authored chroma for neutral ones, both kept inside sRGB.
 * @param {string} pigment
 * @param {{
 *   hue: (pigment: string) => number | null;
 *   targets: SyntaxTargets;
 *   coloredPigments: ReadonlySet<string>;
 *   measure: SaturationMeasure;
 * }} input
 * @returns {(lightness: number) => number}
 */
function chromaModel(pigment, { hue: hueOf, targets, coloredPigments, measure }) {
  const hue = hueOf(pigment);
  if (hue === null) return () => 0;
  /** @param {number} lightness */
  const gamut = (lightness) => GAMUT_MARGIN * maximumSrgbChroma(lightness, hue);
  if (!coloredPigments.has(pigment)) {
    const chroma = targets.chroma[pigment] ?? 0;
    return (lightness) => Math.min(chroma, gamut(lightness));
  }
  const level = targets.saturation;
  return measure === 'chroma'
    ? (lightness) => Math.min(level, gamut(lightness))
    : (lightness) => Math.min(level * maximumSrgbChroma(lightness, hue), gamut(lightness));
}

/**
 * Bisects lightness between the canvas and the far end of the text's
 * direction; APCA contrast rises monotonically along that path.
 * @param {{
 *   appearance: 'dark' | 'light';
 *   canvas: string;
 *   canvasLightness: number;
 *   chromaAt: (lightness: number) => number;
 *   hue: number;
 *   owner: string;
 *   pigment: string;
 *   target: number;
 * }} input
 */
function solveLightness({
  appearance,
  canvas,
  canvasLightness,
  chromaAt,
  hue,
  owner,
  pigment,
  target,
}) {
  /** @param {number} lightness */
  const contrast = (lightness) =>
    Math.abs(apcaContrast(oklchToHex({ C: chromaAt(lightness), L: lightness, h: hue }), canvas));
  let near = canvasLightness;
  let far = appearance === 'dark' ? 1 : 0;
  if (contrast(far) < target) {
    throw new Error(
      `${owner} syntax pigment '${pigment}' cannot reach APCA Lc ${target} against its canvas.`
    );
  }
  for (let index = 0; index < LIGHTNESS_ITERATIONS; index += 1) {
    const middle = (near + far) / 2;
    if (contrast(middle) >= target) far = middle;
    else near = middle;
  }
  return far;
}

/**
 * @param {SyntaxTargets} targets
 * @param {string} tier
 * @param {string} owner
 */
function tierTarget(targets, tier, owner) {
  const target = targets.contrast[tier];
  if (target === undefined) throw new Error(`${owner} has no syntax contrast target '${tier}'.`);
  return target;
}

/**
 * @param {string} pigment
 * @param {Record<string, [number, number]>} solved
 * @param {{ hue: (pigment: string) => number | null }} input
 */
function renderedChroma(pigment, solved, input) {
  const [lightness, chroma] = /** @type {[number, number]} */ (solved[pigment]);
  return hexToOklch(oklchToHex({ C: chroma, L: lightness, h: input.hue(pigment) ?? 0 })).C;
}
