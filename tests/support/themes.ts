import { loadThemeRepository, readSourceTheme } from '../../scripts/themeSources.mjs';
import { loadVscodeProjection } from '../../scripts/vscodeProjection.mjs';

/** The checkout's admitted theme repository, loaded once per test file. */
export const THEME_REPOSITORY = loadThemeRepository();
export const SOURCE_THEMES = THEME_REPOSITORY.sources;
export const VSCODE_PROJECTION = loadVscodeProjection(THEME_REPOSITORY.definition);

export function sourceTheme(source: (typeof SOURCE_THEMES)[number]) {
  return readSourceTheme(source, THEME_REPOSITORY);
}
