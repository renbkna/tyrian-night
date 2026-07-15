import { expect, test } from 'bun:test';

import {
  auditRolePairs,
  auditThemeRoles,
  colorMetrics,
  compareColors,
  contrastRatio,
  hexToOklab,
  hexToOklch,
  oklabDelta,
  rankCandidates,
  themeRoleColors,
} from '../scripts/colorScience.mjs';
import { opaqueHex } from '../scripts/colorUtils.mjs';
import { SOURCE_THEMES, readSourceTheme } from '../scripts/themeSources.mjs';
import { uiColor } from '../scripts/themeDefinition.mjs';

test('color science helpers expose stable perceptual metrics', () => {
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

  const defMetrics = colorMetrics('#A66CFF', '#0A0910');
  expect(defMetrics.hct.chroma).toBeCloseTo(70.59, 2);
  expect(defMetrics.hct.tone).toBeCloseTo(58.09, 2);
  expect(defMetrics.cam16.m).toBeCloseTo(55.73, 2);

  const comparison = compareColors({
    background: '#0A0910',
    left: '#A66CFF',
    right: '#C98BC8',
  });
  expect(comparison.oklabDelta).toBeGreaterThan(10);
  expect(comparison.contrastLeft).toBeGreaterThan(4.5);
});

test('translucent color metrics require an explicit owned backdrop', () => {
  expect(opaqueHex('#FFFFFF80', '#000000')).toBe('#808080');
  expect(() => opaqueHex('#FFFFFF80')).toThrow('requires an explicit opaque background');
  expect(() => opaqueHex('#FFFFFF80', '#00000080')).toThrow("Backdrop '#00000080' must be opaque");
  expect(() => contrastRatio('#FFFFFF80', '#000000')).toThrow(
    'requires an explicit opaque background'
  );
  expect(() => colorMetrics('#FFFFFF80')).toThrow('requires an explicit opaque background');
  expect(() => hexToOklch('#FFFFFF80')).toThrow('requires an explicit opaque background');
});

test('theme role audit treats receivers as italic data-shaped identifiers', () => {
  const nocturne = readSourceTheme(
    SOURCE_THEMES.find((source) => source.slug === 'tyrian-nocturne')!
  );
  const audits = auditThemeRoles(nocturne);
  const selfAudit = audits.find((audit) => audit.color.role === 'self');
  const pairRisks = auditRolePairs(themeRoleColors(nocturne));

  expect(selfAudit).toBeDefined();
  expect(selfAudit!.contrast).toBeGreaterThan(4.5);
  expect(selfAudit!.nearest.role).toBe('value');
  expect(selfAudit!.nearest.delta).toBe(0);
  expect(pairRisks.every((risk) => risk.rule.name !== 'receiver/data distinction')).toBe(true);
});

test('candidate ranking rewards perceptual separation with background contrast', () => {
  const night = readSourceTheme(SOURCE_THEMES.find((source) => source.slug === 'tyrian-night')!);
  const ranked = rankCandidates(night, ['#9886D8', '#109BB4', '#C07AA8'], {
    neighbors: [
      { hex: '#8D69C1', role: 'def' },
      { hex: '#C07AA8', role: 'value' },
      { hex: '#5A78C0', role: 'type' },
      { hex: '#BA5E6B', role: 'add' },
    ],
  });

  expect(ranked[0]!.hex).toBe('#109BB4');
  expect(colorMetrics(ranked[0]!.hex, uiColor(night, 'surface.canvas')).contrast).toBeGreaterThan(
    4.5
  );
});

test('candidate ranking drops inaccessible candidates by default', () => {
  const dawn = readSourceTheme(SOURCE_THEMES.find((source) => source.slug === 'tyrian-dawn')!);
  const ranked = rankCandidates(dawn, ['#109BB4', '#097C93']);

  expect(ranked.map((candidate) => candidate.hex)).toEqual(['#097C93']);
});

test('role pair audit catches adjacent receiver/function confusion', () => {
  const risks = auditRolePairs([
    { hex: '#B957D0', role: 'self' },
    { hex: '#E5739B', role: 'add' },
  ]);
  const receiverFunctionRisk = risks.find(
    (risk) => risk.left.role === 'self' && risk.right.role === 'add'
  );

  expect(receiverFunctionRisk).toBeDefined();
  expect(receiverFunctionRisk!.reasons).toContain('hue<50');
});

test('candidate ranking penalizes role-pair risk separately from nearest distance', () => {
  const nocturne = readSourceTheme(
    SOURCE_THEMES.find((source) => source.slug === 'tyrian-nocturne')!
  );
  const ranked = rankCandidates(nocturne, ['#E09A6D', '#B957D0'], {
    neighbors: themeRoleColors(nocturne).filter((neighbor) => neighbor.role !== 'self'),
    role: 'self',
  });

  expect(ranked[0]!.hex).toBe('#E09A6D');
  expect(ranked.find((candidate) => candidate.hex === '#B957D0')!.pairRisk?.rule.name).toBe(
    'receiver/keyword distinction'
  );
});
