// @ts-check

import { auditThemeSnapshot, loadThemeInspectionRepository } from './themeSources.mjs';
import { readThemeSafetyContract, reportThemeColorDiagnostics } from './themeSafety.mjs';

const args = process.argv.slice(2);
const unsupported = args.find(
  (entry) =>
    entry !== '--diagnostics' && !entry.startsWith('--root=') && !entry.startsWith('--theme=')
);
if (unsupported) throw new Error(`Unknown color audit option '${unsupported}'.`);
const requestedTheme = args.find((entry) => entry.startsWith('--theme='))?.slice('--theme='.length);
const requestedRoot = args.find((entry) => entry.startsWith('--root='))?.slice('--root='.length);
if (requestedRoot !== undefined && requestedRoot.length === 0) {
  throw new Error('Color audit --root must be a non-empty path.');
}
const showDiagnostics = args.includes('--diagnostics');
const repository = loadThemeInspectionRepository(requestedRoot);
const contract = readThemeSafetyContract(repository.definition);
const audits = new Map(auditThemeSnapshot(repository).map((audit) => [audit.slug, audit]));
const sources = requestedTheme
  ? repository.sources.filter(({ slug }) => slug === requestedTheme)
  : repository.sources;

if (sources.length === 0) throw new Error(`Unknown source theme '${requestedTheme}'.`);
let failed = false;
for (const source of sources) {
  const theme = /** @type {import('./themeDefinition.mjs').ThemeDefinition} */ (
    repository.themes.get(source.slug)
  );
  const { safety: violations, pigment: pigmentViolations } =
    /** @type {import('./themeSources.mjs').ThemePolicyAudit} */ (audits.get(source.slug));
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
