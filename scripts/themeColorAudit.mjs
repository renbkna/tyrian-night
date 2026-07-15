#!/usr/bin/env node
// @ts-check

import { parseArgs } from 'node:util';

import {
  auditThemeAppearance,
  readThemeAppearanceContract,
  reportThemeApca,
} from './themeAppearance.mjs';
import { proposeThemePalette } from './themeForge.mjs';
import { loadThemeRepository, readSourceTheme } from './themeSources.mjs';

const { values } = parseArgs({
  allowPositionals: false,
  options: {
    help: { short: 'h', type: 'boolean' },
    json: { type: 'boolean' },
    limit: { short: 'n', type: 'string' },
    move: { short: 'm', type: 'string' },
    roles: { short: 'r', type: 'string' },
    theme: { short: 't', type: 'string' },
  },
  strict: true,
});

if (values.help) {
  printHelp();
} else if (values.roles) {
  printProposals();
} else {
  printAudit();
}

function printAudit() {
  const repository = loadThemeRepository();
  const contract = readThemeAppearanceContract();
  const sources = values.theme
    ? repository.sources.filter((source) => source.slug === values.theme)
    : repository.sources;
  if (sources.length === 0) throw new Error(`Unknown source theme '${values.theme}'.`);

  const reports = sources.map((source) => {
    const theme = readSourceTheme(source, repository.root, repository.definition);
    const violations = auditThemeAppearance(theme, source.slug, contract);
    const apca = reportThemeApca(theme, source.slug, contract);
    return { apca, source, violations };
  });
  if (values.json) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    for (const report of reports) {
      console.log(`\n${report.source.label}: ${report.violations.length === 0 ? 'PASS' : 'FAIL'}`);
      for (const violation of report.violations) {
        const roles = violation.roles?.join(' / ') ?? violation.role ?? '';
        const mode = violation.mode ? ` (${violation.mode})` : '';
        console.log(
          `  ${violation.constraint}: ${violation.kind}${mode} ${roles} ` +
            `${formatNumber(violation.actual ?? violation.actualChroma ?? violation.actualLightness)}`
        );
      }
      if (report.apca.warnings.length > 0) {
        console.log(`  APCA advisory warnings: ${report.apca.warnings.length}`);
      }
    }
  }
  if (reports.some((report) => report.violations.length > 0)) process.exitCode = 1;
}

function printProposals() {
  const theme = values.theme ?? 'tyrian-night';
  const roles = values.roles
    ?.split(',')
    .map((role) => role.trim())
    .filter(Boolean);
  if (!roles || roles.length === 0) throw new Error('Color proposals require --roles.');
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  const result = proposeThemePalette(theme, roles, {
    limit,
    move: values.move,
  });
  if (result.status === 'no-contract-valid-proposal') process.exitCode = 1;
  if (values.json) {
    console.log(JSON.stringify(result, jsonNumbers, 2));
    return;
  }

  console.log(`\n${result.theme} ${result.requestedRoles.join(', ')}`);
  for (const owner of result.owners) {
    console.log(
      `owner: ${owner.pigment} (${owner.current}); projects to: ${owner.ownedRoles.join(', ')}`
    );
  }
  console.log(`move: ${result.move}`);
  console.log(`claim: ${result.certificate.claim}`);
  console.log(
    `corpus: ${result.certificate.corpus.set} ${result.certificate.corpus.hash.slice(0, 12)} ` +
      `(${result.certificate.corpus.coverage.witnessedPairCount}/${result.certificate.corpus.coverage.requiredPairCount} required pairs)`
  );
  if (result.status === 'no-contract-valid-proposal') {
    console.error(
      `no contract-valid proposal: ${result.reason}; ` +
        `${result.baseline.violations.length} baseline violation(s), ` +
        `${result.certificate.search.evaluatedAssignments} assignment(s) evaluated`
    );
    return;
  }

  console.log('rank fixed edge-CVD edge-OK exposure change harmony changes');
  for (const [index, candidate] of result.candidates.entries()) {
    const changes = Object.entries(candidate.changes)
      .map(([pigment, hex]) => `${pigment}=${hex}`)
      .join(', ');
    console.log(
      [
        String(index + 1).padStart(4),
        String(candidate.resolved.length).padStart(5),
        formatNumber(candidate.interaction.minimumCvdOklabDelta).padStart(9),
        formatNumber(candidate.interaction.minimumOklabDelta).padStart(8),
        formatNumber(candidate.interaction.exposure, 0).padStart(8),
        formatNumber(candidate.change.maximum).padStart(6),
        formatNumber(candidate.harmony.maximum).padStart(7),
        changes || '(source palette)',
      ].join(' ')
    );
  }
}

function printHelp() {
  console.log(`Usage:
  bun run color:audit
  bun run color:audit -- --theme tyrian-night
  bun run color:audit -- --theme tyrian-night --roles syntax:function,syntax:data [--move separate]

Without --roles, validates the repository-owned appearance contract.
With --roles, generates bounded HCT candidates for every distinct pigment owner,
then searches their combinations deterministically. Hard contract constraints rank
before the requested move, witnessed specimen/CVD robustness, harmony, and change.
Reports include source, corpus, dependency, lineage, coverage, and search provenance.
Only themes admitted by the forge contract and roles required by its specimen set are forgeable;
the frozen legacy theme is rejected. If bounded search finds no contract-valid proposal, the
result is explicit and the command exits unsuccessfully.

Moves: separate, promote, quiet, warmer, cooler. Recommendations are corpus-local;
every recommendation satisfies the appearance contract, and the command never writes colors
or claims a universal optimum.`);
}

/** @param {number | undefined} value @param {number} [digits] */
function formatNumber(value, digits = 2) {
  if (value === undefined) return '-';
  if (!Number.isFinite(value)) return 'n/a';
  return value.toFixed(digits);
}

/** @param {string} _key @param {unknown} value */
function jsonNumbers(_key, value) {
  return typeof value === 'number' && !Number.isFinite(value) ? null : value;
}
