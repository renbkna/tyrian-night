import { expect, test } from 'bun:test';
import fs from 'node:fs';

import {
  compileThemeSpecimenGraph,
  readThemeSpecimens,
  themeInteractionEvidence,
  validateThemeSpecimens,
} from '../scripts/themeSpecimens.mjs';

test('semantic specimens derive witnessed exposure and neighborhoods with complete provenance', () => {
  const specimens = readThemeSpecimens();
  const graph = compileThemeSpecimenGraph(specimens, 'syntax-core', { requireCoverage: true });

  expect(graph.coverage).toEqual({
    missingContexts: [],
    missingLanguages: [],
    missingPairs: [],
    missingRoles: [],
    passed: true,
    requiredContextCount: 6,
    requiredLanguageCount: 6,
    requiredPairCount: 18,
    requiredRoleCount: 20,
    witnessedContextCount: 6,
    witnessedLanguageCount: 6,
    witnessedPairCount: 18,
    witnessedRoleCount: 20,
  });
  expect(graph.corpusHash).toMatch(/^[0-9a-f]{64}$/);
  expect(graph.sources).toHaveLength(6);
  expect(graph.roles.every(({ exposure, occurrences }) => exposure > 0 && occurrences > 0)).toBe(
    true
  );
  expect(graph.sources.every(({ provenance }) => /^[0-9a-f]{64}$/.test(provenance.sha256))).toBe(
    true
  );
  expect(
    graph.sources.every(({ annotationSha256 }) => /^[0-9a-f]{64}$/.test(annotationSha256))
  ).toBe(true);

  const evidence = themeInteractionEvidence(graph, 'syntax:function', 'syntax:variable');
  expect(evidence.status).toBe('witnessed');
  expect(evidence.witnesses.length).toBeGreaterThan(0);
  const witness = evidence.witnesses[0];
  if (!witness) throw new Error('Expected witnessed function/variable evidence.');
  const specimen = specimens.specimens[witness.specimen];
  if (!specimen) throw new Error(`Missing witnessed specimen '${witness.specimen}'.`);
  const source = specimen.source;
  expect(source.slice(witness.leftSpan.start, witness.leftSpan.end)).not.toBeEmpty();
  expect(source.slice(witness.rightSpan.start, witness.rightSpan.end)).not.toBeEmpty();

  expect(themeInteractionEvidence(graph, 'syntax:regexp', 'syntax:documentation')).toEqual({
    left: 'syntax:documentation',
    occurrences: 0,
    right: 'syntax:regexp',
    status: 'unknown',
    witnesses: [],
  });

  const relabeled = structuredClone(specimens);
  relabeled.specimens['typescript-signal'].parts[0].role = 'syntax:data';
  expect(compileThemeSpecimenGraph(relabeled, 'syntax-core').corpusHash).not.toBe(graph.corpusHash);
});

test('specimen admission rejects representation leaks and stale evidence', () => {
  const raw = JSON.parse(fs.readFileSync('source/themeSpecimens.json', 'utf8'));

  const stale = structuredClone(raw);
  stale.specimens['typescript-signal'].parts[0].text = 'exports';
  expect(() => validateThemeSpecimens(stale)).toThrow('content hash is');

  const manualCounts = structuredClone(raw);
  manualCounts.specimens['typescript-signal'].parts[0].glyphs = 7;
  expect(() => validateThemeSpecimens(manualCounts)).toThrow('unsupported or missing fields');

  const unclassified = structuredClone(raw);
  unclassified.specimens['typescript-signal'].parts[1].text = ' visible ';
  expect(() => validateThemeSpecimens(unclassified)).toThrow('leaves visible source unclassified');

  const unknownRole = structuredClone(raw);
  unknownRole.specimens['typescript-signal'].parts[0].role = 'syntax:not-a-role';
  expect(() => validateThemeSpecimens(unknownRole)).toThrow(
    "references unknown role 'syntax:not-a-role'"
  );

  const falseSnapshot = structuredClone(raw);
  falseSnapshot.specimens['typescript-signal'].provenance.kind = 'repository-snapshot';
  expect(() => validateThemeSpecimens(falseSnapshot)).toThrow('has invalid provenance kind');
});

test('coverage is a named gate rather than an inferred global-optimality claim', () => {
  const incomplete = structuredClone(readThemeSpecimens());
  for (const specimen of Object.values(incomplete.specimens)) {
    specimen.parts = specimen.parts.filter(({ role }) => role !== 'syntax:regexp');
  }

  const graph = compileThemeSpecimenGraph(incomplete, 'syntax-core');
  expect(graph.coverage.passed).toBe(false);
  expect(graph.coverage.missingRoles).toContain('syntax:regexp');
  expect(() =>
    compileThemeSpecimenGraph(incomplete, 'syntax-core', { requireCoverage: true })
  ).toThrow("Theme specimen set 'syntax-core' fails coverage");
});
