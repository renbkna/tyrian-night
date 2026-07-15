import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  auditThemeAppearance,
  readThemeAppearanceContract,
  reportThemeApca,
  validateThemeAppearanceContract,
} from '../scripts/themeAppearance.mjs';
import { loadThemeRepository, readSourceTheme, SOURCE_THEMES } from '../scripts/themeSources.mjs';

const contract = readThemeAppearanceContract();

describe('theme appearance authority', () => {
  test('the contract rejects split prominence and hidden APCA authority', () => {
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.constraints)).toBe(true);

    const splitProminence = structuredClone(contract);
    splitProminence.roleGroups['semantic-content'].push('ui:text.primary');
    expect(() => validateThemeAppearanceContract(splitProminence)).toThrow(
      'prominence groups assign ui:text.primary more than once'
    );

    const requiredApca = structuredClone(contract);
    requiredApca.reference.apca.mode = 'required';
    expect(() => validateThemeAppearanceContract(requiredApca)).toThrow(
      'APCA mode must remain advisory'
    );

    const missingThreshold = structuredClone(contract);
    delete missingThreshold.constraints.find(
      ({ id }: { id: string }) => id === 'family-function-first'
    ).minimum;
    expect(() => validateThemeAppearanceContract(missingThreshold)).toThrow(
      'family-function-first requires minimum'
    );

    const unreportedProminenceRole = structuredClone(contract);
    unreportedProminenceRole.constraints
      .find(({ id }: { id: string }) => id === 'family-function-over-quiet')
      .lessRoles.push('ui:text.secondary');
    expect(() => validateThemeAppearanceContract(unreportedProminenceRole)).toThrow(
      'family-function-over-quiet uses ui:text.secondary outside reference prominence groups'
    );

    const unknownTheme = structuredClone(contract);
    unknownTheme.themeSets.current.push('tyrian-imaginary');
    expect(() => validateThemeAppearanceContract(unknownTheme)).toThrow(
      'theme set current references unknown theme tyrian-imaginary'
    );

    const deadThemeSet = structuredClone(contract);
    deadThemeSet.themeSets.unused = ['tyrian-night'];
    expect(() => validateThemeAppearanceContract(deadThemeSet)).toThrow(
      'theme set unused has no constraints'
    );
  });

  test('every source theme satisfies its selected hierarchy, material, and renderer constraints', () => {
    for (const source of SOURCE_THEMES) {
      expect(auditThemeAppearance(readSourceTheme(source), source.slug, contract)).toEqual([]);
    }
  });

  test('the appearance contract owns load-bearing contrast and role identity', () => {
    const night = sourceTheme('tyrian-night');

    const collapsedStatus = structuredClone(night);
    collapsedStatus.ui['status.error'] = collapsedStatus.ui['surface.canvas'];
    expect(auditThemeAppearance(collapsedStatus, 'tyrian-night', contract)).toContainEqual(
      expect.objectContaining({
        constraint: 'family-chromatic-text-contrast',
        role: 'ui:status.error',
      })
    );

    const invisibleActiveLine = structuredClone(night);
    invisibleActiveLine.ui['editor.activeLineBorder'] = '#00000000';
    expect(auditThemeAppearance(invisibleActiveLine, 'tyrian-night', contract)).toContainEqual(
      expect.objectContaining({ constraint: 'family-active-line-visible' })
    );

    const genericActiveLine = structuredClone(night);
    genericActiveLine.ui['editor.activeLineBorder'] = genericActiveLine.ui['border.default'];
    expect(auditThemeAppearance(genericActiveLine, 'tyrian-night', contract)).toContainEqual(
      expect.objectContaining({ constraint: 'family-active-line-distinct' })
    );

    const collapsedConstant = structuredClone(night);
    collapsedConstant.syntax.constantLanguage = collapsedConstant.syntax.data;
    expect(auditThemeAppearance(collapsedConstant, 'tyrian-night', contract)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ constraint: 'constant-language-distinct' }),
        expect.objectContaining({ constraint: 'constant-language-data-separation' }),
      ])
    );

    const syntaxColoredHint = structuredClone(night);
    syntaxColoredHint.ui['text.hint'] = syntaxColoredHint.syntax.keyword;
    expect(auditThemeAppearance(syntaxColoredHint, 'tyrian-night', contract)).toContainEqual(
      expect.objectContaining({ constraint: 'hint-syntax-distinct' })
    );
  });

  test('the normative appearance contract does not depend on advisory specimen evidence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-appearance-context-'));
    try {
      fs.cpSync('source', path.join(root, 'source'), { recursive: true });
      const appearancePath = path.join(root, 'source/themeAppearanceContract.json');
      fs.rmSync(path.join(root, 'source/themeSpecimens.json'));

      const repository = loadThemeRepository(root);
      const customContract = readThemeAppearanceContract(appearancePath);
      const repositorySource = repository.sources[0];
      if (!repositorySource) throw new Error('Expected a copied source theme.');
      expect(
        auditThemeAppearance(
          readSourceTheme(repositorySource, root, repository.definition),
          repositorySource.slug,
          customContract
        )
      ).toEqual([]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test('Nocturne brackets remain low-energy, distinct, and cyclically separated', () => {
    const nocturne = sourceTheme('tyrian-nocturne');
    expect(auditThemeAppearance(nocturne, 'tyrian-nocturne', contract)).toEqual([]);

    const collapsed = structuredClone(nocturne);
    collapsed.brackets.depth6 = collapsed.brackets.depth1;
    expect(auditThemeAppearance(collapsed, 'tyrian-nocturne', contract)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'bracket-separation' }),
        expect.objectContaining({ kind: 'bracket-adjacent-separation' }),
      ])
    );
  });

  test('Nocturne atmosphere and role separation fail closed', () => {
    const nocturne = sourceTheme('tyrian-nocturne');
    expect(auditThemeAppearance(nocturne, 'tyrian-nocturne', contract)).toEqual([]);

    const contaminated = structuredClone(nocturne);
    contaminated.syntax.type = contaminated.syntax.string;
    expect(auditThemeAppearance(contaminated, 'tyrian-nocturne', contract)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          constraint: 'nocturne-green-cyan-reservation',
          kind: 'forbidden-hue',
          role: 'syntax:type',
        }),
        expect.objectContaining({
          constraint: 'nocturne-type-hue',
          kind: 'hue-envelope',
          role: 'syntax:type',
        }),
      ])
    );

    const collapsed = structuredClone(nocturne);
    collapsed.syntax.type = collapsed.syntax.comment;
    expect(auditThemeAppearance(collapsed, 'tyrian-nocturne', contract)).toContainEqual(
      expect.objectContaining({
        constraint: 'nocturne-type-comment',
        kind: 'pair-oklab-separation',
      })
    );
  });

  test('Nocturne ANSI brightness rejects hue-less chromatic pairs', () => {
    const nocturne = sourceTheme('tyrian-nocturne');
    const hueLess = structuredClone(nocturne);
    hueLess.terminal['ansi.red'] = '#555555';
    hueLess.terminal['ansi.brightRed'] = '#999999';

    expect(auditThemeAppearance(hueLess, 'tyrian-nocturne', contract)).toContainEqual(
      expect.objectContaining({
        constraint: 'nocturne-ansi-brightness',
        kind: 'bright-pair-hue',
        roles: ['terminal:ansi.red', 'terminal:ansi.brightRed'],
      })
    );
  });

  test('prominence is an explicit partial order and cannot hide inside aggregate means', () => {
    expect(
      contract.constraints.every(({ kind }: { kind: string }) => kind !== 'mean-contrast-gap')
    ).toBe(true);
    const night = sourceTheme('tyrian-night');
    const collapsedPrimary = structuredClone(night);
    collapsedPrimary.ui['text.primary'] = collapsedPrimary.syntax.function;
    expect(auditThemeAppearance(collapsedPrimary, 'tyrian-night', contract)).toContainEqual(
      expect.objectContaining({
        constraint: 'family-primary-over-function',
        kind: 'apca-gap',
        moreProminent: 'ui:text.primary',
      })
    );

    const collapsedFunction = structuredClone(night);
    collapsedFunction.syntax.function = collapsedFunction.syntax.data;
    expect(auditThemeAppearance(collapsedFunction, 'tyrian-night', contract)).toContainEqual(
      expect.objectContaining({
        constraint: 'family-function-first',
        kind: 'apca-gap',
        moreProminent: 'syntax:function',
      })
    );

    const loudComment = structuredClone(night);
    loudComment.syntax.comment = loudComment.syntax.function;
    expect(auditThemeAppearance(loudComment, 'tyrian-night', contract)).toContainEqual(
      expect.objectContaining({
        constraint: 'family-function-over-quiet',
        kind: 'apca-gap',
        lessProminent: 'syntax:comment',
      })
    );

    const glaring = structuredClone(night);
    glaring.ui['text.primary'] = '#CDC7D9';
    expect(auditThemeAppearance(glaring, 'tyrian-night', contract)).toContainEqual(
      expect.objectContaining({
        constraint: 'night-primary-envelope',
        kind: 'contrast-envelope',
        role: 'ui:text.primary',
      })
    );
  });

  test('APCA reports polarity and hierarchy as advisory evidence', () => {
    const night = reportThemeApca(sourceTheme('tyrian-night'), 'tyrian-night', contract);
    const dawn = reportThemeApca(sourceTheme('tyrian-dawn'), 'tyrian-dawn', contract);

    expect(night.mode).toBe('advisory');
    expect(night.referenceTypography).toEqual({
      family: 'Monaspace Neon',
      sizePx: 15,
      weight: 400,
      width: 100,
      slant: 0,
      polarity: 'light-on-dark',
    });
    expect(dawn.referenceTypography.polarity).toBe('dark-on-light');
    expect(night.roles.every(({ lc }: { lc: number }) => lc < 0)).toBe(true);
    expect(dawn.roles.every(({ lc }: { lc: number }) => lc > 0)).toBe(true);
    expect(
      night.prominenceRelations.every(
        ({ actual, minimumAbsoluteLcGap }: { actual: number; minimumAbsoluteLcGap: number }) =>
          actual >= minimumAbsoluteLcGap
      )
    ).toBe(true);

    const excessive = sourceTheme('tyrian-night');
    excessive.ui['text.primary'] = '#FFFFFF';
    expect(reportThemeApca(excessive, 'tyrian-night', contract).warnings).toContainEqual(
      expect.objectContaining({ kind: 'maximum-absolute-lc', role: 'ui:text.primary' })
    );
  });
});

function sourceTheme(slug: string) {
  const source = SOURCE_THEMES.find((candidate) => candidate.slug === slug);
  expect(source).toBeDefined();
  if (!source) throw new Error(`Missing source theme '${slug}'.`);
  return readSourceTheme(source);
}
