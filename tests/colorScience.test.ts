import { expect, test } from 'bun:test';

import {
  argbToHex,
  colorMetrics,
  compareColors,
  contrastRatio,
  hexToArgb,
  hexToOklab,
  hexToOklch,
  oklabDelta,
} from '../scripts/colorScience.mjs';
import { opaqueHex } from '../scripts/colorUtils.mjs';

test('color science helpers expose stable policy-free observations', () => {
  expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
  expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.478, 3);

  const redLab = hexToOklab('#FF0000');
  expect(redLab.L).toBeCloseTo(0.627955364, 6);
  expect(redLab.a).toBeCloseTo(0.224863068, 6);
  expect(redLab.b).toBeCloseTo(0.125846277, 6);

  const red = hexToOklch('#FF0000');
  expect(red.L).toBeCloseTo(0.628, 3);
  expect(red.C).toBeCloseTo(0.258, 3);
  expect(red.h).toBeCloseTo(29.2, 1);
  expect(hexToOklch('#FFFFFF').h).toBeNaN();
  expect(oklabDelta(hexToOklab('#000000'), hexToOklab('#FFFFFF'))).toBeCloseTo(100, 5);

  const metrics = colorMetrics('#A66CFF', '#0A0910');
  expect(metrics.hct.chroma).toBeCloseTo(70.59, 2);
  expect(metrics.hct.tone).toBeCloseTo(58.09, 2);
  expect(metrics.cam16.m).toBeCloseTo(55.73, 2);

  const comparison = compareColors({
    background: '#0A0910',
    left: '#A66CFF',
    right: '#C98BC8',
  });
  expect(comparison.oklabDelta).toBeGreaterThan(10);
  expect(comparison.contrastLeft).toBeGreaterThan(4.5);
  expect(argbToHex(hexToArgb('#A66CFF'))).toBe('#A66CFF');
});

test('translucent observations require the owning backdrop', () => {
  expect(opaqueHex('#FFFFFF80', '#000000')).toBe('#808080');
  expect(() => opaqueHex('#FFFFFF80')).toThrow('requires an explicit opaque background');
  expect(() => opaqueHex('#FFFFFF80', '#00000080')).toThrow("Backdrop '#00000080' must be opaque");
  expect(() => contrastRatio('#FFFFFF80', '#000000')).toThrow(
    'requires an explicit opaque background'
  );
  expect(() => colorMetrics('#FFFFFF80')).toThrow('requires an explicit opaque background');
  expect(() => hexToOklch('#FFFFFF80')).toThrow('requires an explicit opaque background');
});
