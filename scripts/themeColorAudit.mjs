// @ts-check

import { loadThemeRepository, readSourceTheme } from './themeSources.mjs';
import {
  auditThemeSafety,
  readThemeSafetyContract,
  reportThemeColorDiagnostics,
} from './themeSafety.mjs';
import { auditThemePigmentPolicy, readThemePigmentPolicy } from './themePigmentPolicy.mjs';

const args = process.argv.slice(2);
const unsupported = args.find(
  (entry) => entry !== '--diagnostics' && !entry.startsWith('--theme=')
);
if (unsupported) throw new Error(`Unknown color audit option '${unsupported}'.`);
const requestedTheme = args.find((entry) => entry.startsWith('--theme='))?.slice('--theme='.length);
const showDiagnostics = args.includes('--diagnostics');
const repository = loadThemeRepository();
const contract = readThemeSafetyContract();
const pigmentPolicy = readThemePigmentPolicy();
const sources = requestedTheme
  ? repository.sources.filter(({ slug }) => slug === requestedTheme)
  : repository.sources;

if (sources.length === 0) throw new Error(`Unknown source theme '${requestedTheme}'.`);
let failed = false;
for (const source of sources) {
  const theme = readSourceTheme(source, repository.root, repository.definition);
  const violations = auditThemeSafety(theme, contract);
  const pigmentViolations = auditThemePigmentPolicy(theme, pigmentPolicy);
  const diagnostics = reportThemeColorDiagnostics(theme, source.slug, contract);
  console.log(
    `${source.slug}: accessibility=${violations.length === 0 ? 'pass' : `${violations.length} violation(s)`}; ` +
      `brand=${pigmentViolations.length === 0 ? 'pass' : `${pigmentViolations.length} violation(s)`}; ` +
      `advisory=${diagnostics.roles.length} colors/${diagnostics.stateComparisons.reduce(
        (total, comparison) => total + comparison.pairs.length,
        0
      )} state comparisons`
  );
  for (const violation of violations) console.log(`  ${JSON.stringify(violation)}`);
  for (const violation of pigmentViolations) console.log(`  ${JSON.stringify(violation)}`);
  if (showDiagnostics) console.log(JSON.stringify(diagnostics, null, 2));
  failed ||= violations.length > 0 || pigmentViolations.length > 0;
}

if (failed) process.exitCode = 1;
