import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { proposeThemePalette, seededBeamSearch } from '../scripts/themeForge.mjs';
import {
  readThemeForgeContract,
  validateThemeForgeContract,
} from '../scripts/themeForgeContract.mjs';

test('the forge searches interacting pigment owners deterministically and never writes', () => {
  const root = createCompactForgeRoot();
  const sourcePath = path.join(root, 'source/themes/tyrian-night.json');
  const before = fs.readFileSync(sourcePath, 'utf8');
  const roles = ['syntax:function', 'syntax:data'];

  try {
    const first = proposeThemePalette('tyrian-night', roles, { limit: 4, root });
    const second = proposeThemePalette('tyrian-night', roles, { limit: 4, root });
    if (first.status !== 'found' || second.status !== 'found') {
      throw new Error('Expected a contract-valid proposal from the compact search repository.');
    }

    expect(first.owners.map(({ pigment }) => pigment)).toEqual(['syntax:data', 'syntax:function']);
    expect(first.candidates.map(({ pigments }) => pigments)).toEqual(
      second.candidates.map(({ pigments }) => pigments)
    );
    expect(first.baseline.interaction.requestedPairs).toContainEqual(
      expect.objectContaining({ status: 'witnessed' })
    );
    expect(first.baseline.violations).toEqual([]);
    expect(first.candidates.length).toBeGreaterThan(0);
    expect(first.move).toBe('separate');
    expect(
      first.candidates.every(
        (candidate) =>
          !Object.hasOwn(candidate, 'regressions') &&
          !Object.hasOwn(candidate, 'remainingViolations')
      )
    ).toBe(true);
    expect(
      first.candidates.every(({ roleProminence }) =>
        roleProminence.every((role) => !Object.hasOwn(role, 'objective'))
      )
    ).toBe(true);
    expect(first.certificate).toEqual(
      expect.objectContaining({
        claim: 'best-found-within-declared-corpus-candidate-and-search-envelope',
        writes: false,
      })
    );
    expect(first.certificate.corpus.coverage.passed).toBe(true);
    expect(first.certificate.corpus.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.certificate.search.rejectedAssignments).toBeGreaterThan(0);
    expect(
      Object.values(first.certificate.candidatePools).every(
        ({ excluded, generated, selected, sourceIncluded }) =>
          sourceIncluded === true &&
          generated === selected + excluded.contractValid + excluded.searchOnly
      )
    ).toBe(true);
    expect(first.authority.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.authority.appearanceContractSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.authority.bindingContractSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.authority.forgeContractSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.authority.roleContractSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(
      first.candidates.every(({ lineage }) =>
        Object.values(lineage).every(({ algorithm }) => typeof algorithm === 'string')
      )
    ).toBe(true);
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(before);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('bounded joint search matches an exact oracle on a complete small envelope', () => {
  const variables = ['function', 'type', 'data'];
  const candidates = Object.fromEntries(variables.map((variable) => [variable, ['cold', 'dim']]));
  const baseline = Object.fromEntries(variables.map((variable) => [variable, 'dim']));
  const evaluate = (assignment: Record<string, string>) => ({
    collisions:
      Number(assignment.function === assignment.type) +
      Number(assignment.function === assignment.data),
    identityLoss: Object.values(assignment).filter((value) => value !== 'dim').length,
  });
  const compare = (
    left: { collisions: number; identityLoss: number },
    right: { collisions: number; identityLoss: number }
  ) => left.collisions - right.collisions || left.identityLoss - right.identityLoss;

  const search = seededBeamSearch({
    baseline,
    beamWidth: 8,
    candidates,
    compare,
    evaluate,
    seed: 17,
    variableOrders: 6,
    variables,
  });
  const exact = exactAssignments(variables, candidates)
    .map((assignment) => ({ assignment, evaluation: evaluate(assignment) }))
    .sort(
      (left, right) =>
        compare(left.evaluation, right.evaluation) ||
        JSON.stringify(left.assignment).localeCompare(JSON.stringify(right.assignment))
    );

  expect(search.results[0]?.evaluation).toEqual(exact[0]?.evaluation);
  expect(search.results).toHaveLength(exact.length);
  expect(search.orders).toHaveLength(6);
});

test('Nocturne is a valid calibration baseline, not an automatic rewrite target', () => {
  const root = createCompactForgeRoot();
  const sourcePath = path.join(root, 'source/themes/tyrian-nocturne.json');
  const before = fs.readFileSync(sourcePath, 'utf8');

  try {
    const result = proposeThemePalette('tyrian-nocturne', ['brackets:depth1', 'brackets:depth2'], {
      limit: 2,
      root,
    });

    expect(result.status).toBe('found');
    expect(result.baseline.violations).toEqual([]);
    expect(result.certificate.corpus.coverage.passed).toBe(true);
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(before);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('the forge represents an exhausted contract-valid search explicitly', () => {
  const root = createCompactForgeRoot({ impossiblePrimaryContrast: true });

  try {
    const result = proposeThemePalette('tyrian-night', ['syntax:data'], { limit: 2, root });

    expect(result.status).toBe('no-contract-valid-proposal');
    expect(result).not.toHaveProperty('candidates');
    expect(result.baseline.violations).toContainEqual(
      expect.objectContaining({ constraint: 'family-primary-contrast' })
    );
    expect(result.certificate.search.contractValidAssignments).toBe(0);
    expect(
      Object.values(result.certificate.candidatePools).every(
        ({ excluded, selectedContractValid }) =>
          selectedContractValid === 0 && excluded.contractValid === 0
      )
    ).toBe(true);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test('the forge rejects the frozen legacy palette before proposing a retune', () => {
  expect(() => proposeThemePalette('tyrian-night-old', ['syntax:function'])).toThrow(
    "Theme 'tyrian-night-old' is not admitted by forge appearance theme set 'current'."
  );
});

test('the forge derives role admission from the selected specimen contract', () => {
  expect(() => proposeThemePalette('tyrian-night', ['ui:accent.primary'])).toThrow(
    "Role 'ui:accent.primary' is not admitted by specimen set 'syntax-core' requiredRoles."
  );
});

test('the advisory forge contract cannot redefine appearance policy or unwitnessed evidence', () => {
  const contract = structuredClone(readThemeForgeContract());

  const unknownThemeSet = structuredClone(contract);
  unknownThemeSet.appearanceThemeSet = 'imaginary-themes';
  expect(() => validateThemeForgeContract(unknownThemeSet)).toThrow(
    'appearanceThemeSet references unknown appearance theme set imaginary-themes'
  );

  const unknownSpecimenSet = structuredClone(contract);
  unknownSpecimenSet.specimenSet = 'imaginary-specimens';
  expect(() => validateThemeForgeContract(unknownSpecimenSet)).toThrow(
    'specimenSet references unknown specimen set imaginary-specimens'
  );

  const duplicatedPolicy = structuredClone(contract) as Record<string, unknown>;
  duplicatedPolicy.roleObjectives = { 'syntax:function': 'quiet' };
  expect(() => validateThemeForgeContract(duplicatedPolicy)).toThrow(
    'root has unsupported or missing fields'
  );
});

function compactForgeContract() {
  const contract = structuredClone(readThemeForgeContract());
  contract.hueOffsets = [0];
  contract.chromaScales = [1];
  contract.toneOffsets = [0, 2];
  contract.candidatePoolSize = 2;
  contract.search.beamWidth = 8;
  contract.search.variableOrders = 2;
  return contract;
}

function createCompactForgeRoot(options: { impossiblePrimaryContrast?: boolean } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tyrian-forge-contract-'));
  fs.cpSync('source', path.join(root, 'source'), { recursive: true });
  fs.copyFileSync('package.json', path.join(root, 'package.json'));
  fs.writeFileSync(
    path.join(root, 'source/themeForgeContract.json'),
    `${JSON.stringify(compactForgeContract(), null, 2)}\n`
  );

  if (options.impossiblePrimaryContrast) {
    const appearancePath = path.join(root, 'source/themeAppearanceContract.json');
    const appearance = JSON.parse(fs.readFileSync(appearancePath, 'utf8'));
    const primary = appearance.constraints.find(
      ({ id }: { id: string }) => id === 'family-primary-contrast'
    );
    if (!primary) throw new Error('Expected the family primary contrast constraint.');
    primary.minimum = 20;
    fs.writeFileSync(appearancePath, `${JSON.stringify(appearance, null, 2)}\n`);
  }

  return root;
}

function exactAssignments(variables: string[], candidates: Record<string, string[]>) {
  let assignments: Array<Record<string, string>> = [{}];
  for (const variable of variables) {
    const values = candidates[variable];
    if (!values) throw new Error(`Missing exact-oracle candidates for '${variable}'.`);
    assignments = assignments.flatMap((assignment) =>
      values.map((candidate) => ({ ...assignment, [variable]: candidate }))
    );
  }
  return assignments;
}
