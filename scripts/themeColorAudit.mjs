#!/usr/bin/env node
// @ts-check

import { parseArgs as parseNodeArgs } from 'node:util';

import {
  auditRolePairs,
  auditSampleSequence,
  auditThemeRoles,
  compareColors,
  colorMetrics,
  rankCandidates,
  themeRoleColor,
  themeRoleColors,
} from './colorScience.mjs';
import { loadThemeRepository, readSourceTheme } from './themeSources.mjs';
import { themeColor } from './themeDefinition.mjs';

const args = parseAuditArgs(process.argv.slice(2));
const repository = loadThemeRepository();
const themes = repository.sources.map((source) =>
  readSourceTheme(source, repository.root, repository.definition)
);

if (args.help) {
  printHelp();
} else if (args.candidates.length > 0) {
  printCandidateRanking();
} else if (args.role) {
  printRoleAudit(args.role);
} else {
  printThemeAudit();
}

function printThemeAudit() {
  for (const theme of themes) {
    console.log(`\n${theme.name}`);
    console.log('role     hex      okL   okC    okh    hT    hC    cM contrast nearest');

    for (const audit of auditThemeRoles(theme)) {
      console.log(
        [
          audit.color.role.padEnd(8),
          audit.color.hex.padEnd(8),
          formatNumber(audit.oklch.L * 100, 1).padStart(5),
          formatNumber(audit.oklch.C, 3).padStart(6),
          formatNumber(audit.oklch.h, 1).padStart(6),
          formatNumber(audit.metrics.hct.tone, 1).padStart(5),
          formatNumber(audit.metrics.hct.chroma, 1).padStart(5),
          formatNumber(audit.metrics.cam16.m, 1).padStart(5),
          formatNumber(audit.contrast, 2).padStart(8),
          `${audit.nearest.role}:${formatNumber(audit.nearest.delta, 1)}`,
        ].join(' ')
      );
    }

    printPairRisks(theme);
    printSampleSequence(theme);
  }
}

/**
 * @param {string} role
 */
function printRoleAudit(role) {
  const rows = themes.map((theme) => {
    const hex = themeRoleColor(theme, role);
    const metrics = colorMetrics(hex, themeColor(theme, 'ui:surface.canvas'));
    const roleNeighbors = themeRoleColors(theme).filter((neighbor) => neighbor.role !== role);
    const nearest = rankCandidates(theme, [hex], { neighbors: roleNeighbors })[0].nearest;

    return { hex, metrics, nearest, theme };
  });

  console.log(`\nRole: ${role}`);
  console.log('theme              hex      okL   okC    okh    hT    hC    cM contrast nearest');
  for (const row of rows) {
    console.log(
      [
        row.theme.name.padEnd(18),
        row.hex.padEnd(8),
        formatNumber(row.metrics.oklch.L * 100, 1).padStart(5),
        formatNumber(row.metrics.oklch.C, 3).padStart(6),
        formatNumber(row.metrics.oklch.h, 1).padStart(6),
        formatNumber(row.metrics.hct.tone, 1).padStart(5),
        formatNumber(row.metrics.hct.chroma, 1).padStart(5),
        formatNumber(row.metrics.cam16.m, 1).padStart(5),
        formatNumber(row.metrics.contrast ?? 0, 2).padStart(8),
        `${row.nearest.role}:${formatNumber(row.nearest.delta, 1)}`,
      ].join(' ')
    );
  }

  console.log('\nCross-theme same-role OKLab deltas');
  for (let leftIndex = 0; leftIndex < rows.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < rows.length; rightIndex += 1) {
      const left = rows[leftIndex];
      const right = rows[rightIndex];
      const comparison = compareColors({ left: left.hex, right: right.hex });

      console.log(
        `${left.theme.name} -> ${right.theme.name}: ${formatNumber(comparison.oklabDelta, 1)}`
      );
    }
  }

  console.log('\nPair risks');
  for (const theme of themes) {
    const risks = auditRolePairs(themeRoleColors(theme)).filter(
      (risk) => risk.left.role === role || risk.right.role === role
    );

    if (risks.length > 0) {
      console.log(`${theme.name}: ${formatRisks(risks)}`);
    }
  }
}

function printCandidateRanking() {
  const role = args.role ?? 'candidate';

  for (const theme of themes) {
    const neighbors = themeRoleColors(theme).filter((neighbor) => neighbor.role !== role);
    const ranked = rankCandidates(theme, args.candidates, { neighbors, role }).slice(0, args.limit);

    console.log(`\n${theme.name} candidates for ${role}`);
    console.log('hex      score  okL   okC    okh    hT    hC    cM contrast nearest risk');
    for (const candidate of ranked) {
      console.log(
        [
          candidate.hex.padEnd(8),
          formatNumber(candidate.score, 1).padStart(6),
          formatNumber(candidate.oklch.L * 100, 1).padStart(5),
          formatNumber(candidate.oklch.C, 3).padStart(6),
          formatNumber(candidate.oklch.h, 1).padStart(6),
          formatNumber(candidate.metrics.hct.tone, 1).padStart(5),
          formatNumber(candidate.metrics.hct.chroma, 1).padStart(5),
          formatNumber(candidate.metrics.cam16.m, 1).padStart(5),
          formatNumber(candidate.contrast, 2).padStart(8),
          `${candidate.nearest.role}:${formatNumber(candidate.nearest.delta, 1)}`,
          candidate.pairRisk ? formatRisk(candidate.pairRisk) : '-',
        ].join(' ')
      );
    }
  }
}

/**
 * @param {import('./themeDefinition.mjs').ThemeDefinition} theme
 */
function printPairRisks(theme) {
  const risks = auditRolePairs(themeRoleColors(theme));

  if (risks.length === 0) {
    return;
  }

  console.log(`pair risks ${formatRisks(risks)}`);
}

/**
 * @param {import('./themeDefinition.mjs').ThemeDefinition} theme
 */
function printSampleSequence(theme) {
  const samples = auditSampleSequence(themeRoleColors(theme));
  const formatted = samples
    .map(
      (sample) =>
        `${sample.left.role}-${sample.right.role}:${formatNumber(sample.comparison.oklabDelta, 1)}`
    )
    .join(' ');

  console.log(`sample def add self value T ${formatted}`);
}

function printHelp() {
  console.log(`Usage:
  node scripts/themeColorAudit.mjs
  node scripts/themeColorAudit.mjs --role self
  node scripts/themeColorAudit.mjs --role self --candidates '#109BB4,#0C91A9,#097C93'

Metrics:
  okL/okC/okh OKLCH perceptual lightness, chroma, hue
  hT/hC       Material HCT tone and CAM16 chroma
  cM          CAM16 colorfulness
  contrast    WCAG contrast against editor.background
  nearest     closest syntax role by OKLab distance; low values mean visual collision
  risk        pair-specific adjacent-role risk; catches realistic self/add-style collisions`);
}

/**
 * @param {string[]} rawArgs
 * @returns {{ candidates: string[]; help: boolean; limit: number; role?: string }}
 */
function parseAuditArgs(rawArgs) {
  const { values } = parseNodeArgs({
    allowPositionals: false,
    args: rawArgs,
    options: {
      candidates: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      limit: { type: 'string' },
      role: { type: 'string' },
    },
    strict: true,
  });
  const limit = values.limit === undefined ? 8 : Number.parseInt(values.limit, 10);

  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Invalid --limit '${values.limit}'.`);
  }

  return {
    candidates:
      values.candidates === undefined
        ? []
        : values.candidates
            .split(',')
            .map((candidate) => candidate.trim())
            .filter(Boolean),
    help: values.help === true,
    limit,
    role: values.role,
  };
}

/**
 * @param {number} value
 * @param {number} digits
 * @returns {string}
 */
function formatNumber(value, digits) {
  return value.toFixed(digits);
}

/**
 * @param {import('./colorScience.mjs').RolePairRisk[]} risks
 * @returns {string}
 */
function formatRisks(risks) {
  return risks
    .sort((left, right) => right.penalty - left.penalty)
    .map(formatRisk)
    .join(' ');
}

/**
 * @param {import('./colorScience.mjs').RolePairRisk} risk
 * @returns {string}
 */
function formatRisk(risk) {
  return `${risk.left.role}-${risk.right.role}:${formatNumber(
    risk.comparison.oklabDelta,
    1
  )}/${risk.reasons.join('+')}`;
}
