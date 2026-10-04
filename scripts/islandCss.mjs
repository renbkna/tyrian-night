// @ts-check

import fs from 'node:fs';
import path from 'node:path';

import { parseHexColor } from './colorUtils.mjs';
import { syncGeneratedAssets } from './generatedAssets.mjs';
import { loadSourceModule } from './sourceModule.mjs';
import { themeColor } from './themeDefinition.mjs';
import { loadThemeRepository, readSourceTheme } from './themeSources.mjs';

const BASE_TEMPLATE_PATH = 'apps/vscode/island/base.css';
const EFFECT_PROFILES_PATH = 'source/islandEffects.cjs';
const defaultRepoRoot = path.resolve(import.meta.dirname, '..');

/**
 * @typedef {{
 *   label: string;
 *   outputPath: string;
 *   source: import('./themeSources.mjs').ThemeSource;
 *   tokens: Readonly<Record<string, string>>;
 * }} IslandCssTheme
 */

const ROOT_LAYOUT_TOKENS = {
  '--islands-panel-radius': '24px',
  '--islands-widget-radius': '14px',
  '--islands-input-radius': '12px',
  '--islands-item-radius': '6px',
  '--islands-panel-gap': '6px',
  '--islands-panel-top': '6px',
};

/**
 * @param {IslandCssTheme} theme
 * @param {string} repoRoot
 * @param {import('./themeSources.mjs').ThemeRepository} repository
 * @returns {string}
 */
function renderIslandCss(theme, repoRoot, repository) {
  const baseCss = fs.readFileSync(path.join(repoRoot, BASE_TEMPLATE_PATH), 'utf8');
  const sourceTheme = readSourceTheme(theme.source, repository);

  return `${header(theme.label)}

:root {
${formatCssVariables(
  mergeDisjointTokens([
    ['layout', ROOT_LAYOUT_TOKENS],
    [`effect profile '${theme.source.islandEffects}'`, theme.tokens],
    ['source palette', sourcePaletteTokens(sourceTheme)],
  ])
)}
}

${baseCss}`;
}

/**
 * @param {string} [repoRoot]
 * @returns {Array<{ outputPath: string; css: string }>}
 */
export function buildAllIslandCss(repoRoot = defaultRepoRoot) {
  const repository = loadThemeRepository(repoRoot);
  const profiles = readIslandEffectProfiles(repoRoot, repository.sources);
  return projectIslandCssThemes(repository.sources, profiles).map((theme) => ({
    outputPath: theme.outputPath,
    css: renderIslandCss(theme, repoRoot, repository),
  }));
}

/**
 * @param {ReadonlyArray<import('./themeSources.mjs').ThemeSource>} sourceThemes
 * @param {Record<string, Record<string, string>>} profiles
 * @returns {IslandCssTheme[]}
 */
function projectIslandCssThemes(sourceThemes, profiles) {
  return sourceThemes.map((source) => ({
    label: source.label,
    outputPath: source.islandCssPath,
    source,
    tokens: /** @type {Record<string, string>} */ (profiles[source.islandEffects]),
  }));
}

/**
 * Reads the hand-tuned Island effect profiles. Every profile defines the same
 * tokens, every catalog theme names an existing profile, and no profile is unused.
 *
 * @param {string} repoRoot
 * @param {ReadonlyArray<import('./themeSources.mjs').ThemeSource>} sourceThemes
 * @returns {Record<string, Record<string, string>>}
 */
export function readIslandEffectProfiles(repoRoot, sourceThemes) {
  const profiles = /** @type {Record<string, Record<string, string>>} */ (
    loadSourceModule(path.join(repoRoot, EFFECT_PROFILES_PATH))
  );
  const [firstProfile, ...otherProfiles] = Object.entries(profiles);
  if (!firstProfile) throw new Error(`${EFFECT_PROFILES_PATH} defines no profiles.`);

  const tokenNames = JSON.stringify(Object.keys(firstProfile[1]).toSorted());
  for (const [name, tokens] of otherProfiles) {
    if (JSON.stringify(Object.keys(tokens).toSorted()) !== tokenNames) {
      throw new Error(
        `Island effect profile '${name}' must define the same tokens as '${firstProfile[0]}'.`
      );
    }
  }
  for (const source of sourceThemes) {
    if (!Object.hasOwn(profiles, source.islandEffects)) {
      throw new Error(
        `Theme '${source.slug}' names unknown Island effect profile '${source.islandEffects}'.`
      );
    }
  }
  const usedProfiles = new Set(sourceThemes.map(({ islandEffects }) => islandEffects));
  const unused = Object.keys(profiles).filter((name) => !usedProfiles.has(name));
  if (unused.length > 0) {
    throw new Error(`Island effect profiles are unused: ${unused.join(', ')}.`);
  }
  return profiles;
}

/**
 * @param {string} [repoRoot]
 * @param {{ check?: boolean }} [options]
 * @returns {string[]}
 */
export function syncIslandCss(repoRoot = defaultRepoRoot, options = {}) {
  return syncGeneratedAssets(
    buildAllIslandCss(repoRoot).map(({ outputPath, css }) => ({ path: outputPath, content: css })),
    repoRoot,
    {
      check: options.check,
      ownership: [{ directory: 'apps/vscode/island', match: /^tyrian-[^/]+\.css$/u }],
    }
  );
}

/**
 * @param {string} label
 * @returns {string}
 */
function header(label) {
  return `/*
   ${label} - Custom UI Styles
   Adapted from: https://github.com/bwya77/vscode-dark-islands
   Managed by scripts/islandCss.mjs
*/`;
}

/**
 * Combine token sets that each own their names. A name defined by two owners
 * is rejected rather than resolved by merge order.
 *
 * @param {ReadonlyArray<[string, Readonly<Record<string, string>>]>} owners
 * @returns {Record<string, string>}
 */
function mergeDisjointTokens(owners) {
  /** @type {Record<string, string>} */
  const merged = {};
  /** @type {Map<string, string>} */
  const ownerByName = new Map();
  for (const [owner, tokens] of owners) {
    for (const [name, value] of Object.entries(tokens)) {
      const previousOwner = ownerByName.get(name);
      if (previousOwner !== undefined) {
        throw new Error(
          `Island CSS token '${name}' is defined by both ${previousOwner} and ${owner}.`
        );
      }
      ownerByName.set(name, owner);
      merged[name] = value;
    }
  }
  return merged;
}

/**
 * @param {Record<string, string>} tokens
 * @returns {string}
 */
function formatCssVariables(tokens) {
  return Object.entries(tokens)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
}

/**
 * @param {import('./themeDefinition.mjs').ThemeDefinition} theme
 * @returns {Readonly<Record<string, string>>}
 */
function sourcePaletteTokens(theme) {
  return {
    '--islands-accent-glow-rgb': rgbChannels(themeColor(theme, 'ui:accent.glow')),
    '--islands-accent-effect-rgb': rgbChannels(themeColor(theme, 'ui:accent.effect')),
    '--islands-border': lowerHex(themeColor(theme, 'ui:border.default')),
    '--islands-border-rgb': rgbChannels(themeColor(theme, 'ui:border.default')),
    '--islands-button-hover-rgb': rgbChannels(themeColor(theme, 'ui:buttons.hover.background')),
    '--islands-bg-backdrop': lowerHex(themeColor(theme, 'ui:surface.navigation')),
    '--islands-bg-surface': lowerHex(themeColor(theme, 'ui:surface.sidebar')),
    '--islands-effect-active-surface-rgb': rgbChannels(
      themeColor(theme, 'ui:effect.activeSurface')
    ),
    '--islands-effect-checked-surface-rgb': rgbChannels(
      themeColor(theme, 'ui:effect.checkedSurface')
    ),
    '--islands-effect-focus-surface-rgb': rgbChannels(themeColor(theme, 'ui:effect.focusSurface')),
    '--islands-effect-hover-surface-rgb': rgbChannels(themeColor(theme, 'ui:effect.hoverSurface')),
    '--islands-effect-status-hover': lowerHex(themeColor(theme, 'ui:effect.statusHover')),
    '--islands-effect-strong-accent-rgb': rgbChannels(themeColor(theme, 'ui:effect.strongAccent')),
    '--islands-hover-rgb': rgbChannels(themeColor(theme, 'ui:surface.hover')),
    '--islands-selection-rgb': rgbChannels(themeColor(theme, 'ui:selection.active')),
    '--islands-selection-inactive-rgb': rgbChannels(themeColor(theme, 'ui:selection.inactive')),
    '--islands-terminal-black-rgb': rgbChannels(themeColor(theme, 'terminal:ansi.black')),
  };
}

/** @param {string} color */
function rgbChannels(color) {
  const { red, green, blue } = parseHexColor(color);
  return `${red}, ${green}, ${blue}`;
}

/**
 * @param {string | undefined} color
 * @returns {string}
 */
function lowerHex(color) {
  if (!color) {
    throw new Error('Missing Island source palette color');
  }

  return color.toLowerCase();
}
