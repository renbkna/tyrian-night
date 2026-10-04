import { expect, test } from 'bun:test';

import {
  apcaContrast,
  gamutRelativeRichness,
  hexToOklch,
  oklchToHex,
} from '../../scripts/colorScience.mjs';
import { solveSyntaxPigments } from '../../scripts/syntaxSolver.mjs';

const hierarchy = [
  { tier: 'lead', pigments: ['syntax:control', 'syntax:function'], minimumStepOverNext: 4 },
  {
    tier: 'support',
    pigments: ['syntax:data', 'syntax:string'],
    minimumStepOverNext: 6,
    maximumChromaShareOfLead: 0.8,
  },
  { tier: 'quiet', pigments: ['syntax:comment'] },
];
const hues: Record<string, number> = {
  'syntax:control': 322,
  'syntax:function': 262,
  'syntax:data': 342,
  'syntax:string': 146,
  'syntax:comment': 301,
  'syntax:variable': 306,
};
const contrast = { lead: 55.5, support: 49.5, quiet: 35, plain: 77 };

function solve(
  canvas: string,
  appearance: 'dark' | 'light',
  measure: 'chroma' | 'richness',
  saturation: number
) {
  const solved = solveSyntaxPigments({
    appearance,
    canvas,
    coloredPigments: new Set(['syntax:control', 'syntax:function', 'syntax:data', 'syntax:string']),
    hierarchy,
    hue: (pigment) => hues[pigment] ?? null,
    measure,
    owner: 'Fixture',
    plainPigment: 'syntax:variable',
    targets: {
      saturation,
      contrast,
      chroma: { 'syntax:comment': 0.05, 'syntax:variable': 0.02 },
    },
  });
  return Object.fromEntries(
    Object.entries(solved).map(([pigment, [L, C]]) => [
      pigment,
      oklchToHex({ L, C, h: hues[pigment] ?? 0 }),
    ])
  ) as Record<string, string>;
}

const tierOf = (pigment: string) =>
  pigment === 'syntax:variable'
    ? 'plain'
    : (hierarchy.find(({ pigments }) => pigments.includes(pigment))!.tier as keyof typeof contrast);

test('solved syntax colors meet their contrast targets on dark and light canvases', () => {
  for (const [canvas, appearance] of [
    ['#010004', 'dark'],
    ['#F6F4FD', 'light'],
  ] as const) {
    const colors = solve(canvas, appearance, 'richness', 0.88);
    for (const [pigment, color] of Object.entries(colors)) {
      expect(
        Math.abs(Math.abs(apcaContrast(color, canvas)) - contrast[tierOf(pigment)])
      ).toBeLessThan(0.5);
    }
  }
});

test('capped pigments render at most their share of the most colorful lead', () => {
  const colors = solve('#010004', 'dark', 'richness', 0.88);
  const chroma = (pigment: string) => hexToOklch(colors[pigment]!).C;
  const ceiling = 0.8 * Math.max(chroma('syntax:control'), chroma('syntax:function'));
  // Rose and green reach far more chroma than the band allows them under the ceiling.
  for (const pigment of ['syntax:data', 'syntax:string']) {
    expect(chroma(pigment)).toBeLessThanOrEqual(ceiling);
    expect(chroma(pigment)).toBeGreaterThan(0.95 * ceiling);
  }
  expect(gamutRelativeRichness(colors['syntax:control']!)).toBeCloseTo(0.88, 1);
});

test('the chroma measure never pushes a pigment outside sRGB', () => {
  // Blue at pastel lightness cannot hold 0.2 chroma; the solver keeps it inside the gamut.
  const colors = solve('#1E1C29', 'dark', 'chroma', 0.2);
  for (const color of Object.values(colors))
    expect(gamutRelativeRichness(color)).toBeLessThanOrEqual(1);
  expect(hexToOklch(colors['syntax:function']!).C).toBeLessThan(0.2);
});

test('an unreachable contrast target fails with the pigment named', () => {
  expect(() => solve('#AAAAAA', 'dark', 'richness', 0.5)).toThrow(
    "Fixture syntax pigment 'syntax:control' cannot reach APCA Lc 55.5 against its canvas."
  );
});
