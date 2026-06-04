// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SOURCE_THEMES, readSourceTheme } from './themeSources.mjs';

const BASE_TEMPLATE_PATH = 'apps/vscode/island/base.css';

/** @type {Array<{ label: string; outputPath: string; tokens: Record<string, string> }>} */
export const ISLAND_CSS_THEMES = [
  {
    label: 'Tyrian Abyss',
    outputPath: 'apps/vscode/island/tyrian-abyss.css',
    tokens: {
      '--islands-bg-canvas': '#030207',
      '--islands-bg-surface': '#07040d',
      '--islands-breathe-rest': 'drop-shadow(0 0 2px rgba(134, 82, 255, 0))',
      '--islands-breathe-peak': 'drop-shadow(0 0 10px rgba(134, 82, 255, 0.42))',
      '--islands-aurora-primary': 'rgba(134, 82, 255, 0.42)',
      '--islands-aurora-secondary': 'rgba(180, 140, 255, 0.22)',
      '--islands-aurora-tail': 'rgba(134, 82, 255, 0.14)',
      '--islands-surface-border-top': '1px solid rgba(180, 140, 255, 0.12)',
      '--islands-surface-border-left': '1px solid rgba(180, 140, 255, 0.08)',
      '--islands-surface-border-bottom': '1px solid rgba(134, 82, 255, 0.03)',
      '--islands-surface-border-right': '1px solid rgba(134, 82, 255, 0.03)',
      '--islands-surface-shadow': '0 2px 10px 0 rgba(0, 0, 0, 0.48)',
      '--islands-elevated-border-top': '1px solid rgba(180, 140, 255, 0.16)',
      '--islands-elevated-border-left': '1px solid rgba(180, 140, 255, 0.1)',
      '--islands-elevated-border-bottom': '1px solid rgba(134, 82, 255, 0.04)',
      '--islands-elevated-border-right': '1px solid rgba(134, 82, 255, 0.04)',
      '--islands-list-focus-bg': 'linear-gradient(135deg, #24134ab8, #150d2980)',
      '--islands-list-focus-selected-bg': 'linear-gradient(135deg, #24134ad1, #150d2994)',
      '--islands-list-focus-active-bg': 'linear-gradient(135deg, #351779db, #24134a9e)',
      '--islands-list-hover-bg': 'linear-gradient(135deg, #24134a61, #150d2942)',
      '--islands-list-focus-ring': 'inset 0 0 0 1px rgba(180, 140, 255, 0.06)',
      '--islands-list-focus-selected-ring': 'inset 0 0 0 1px rgba(180, 140, 255, 0.08)',
      '--islands-list-focus-active-ring': 'inset 0 0 0 1px rgba(180, 140, 255, 0.1)',
      '--islands-tab-divider': '#24134a',
      '--islands-tab-hover-text-shadow': '0 0 6px rgba(180, 140, 255, 0.22)',
      '--islands-hover-border': '1px solid rgba(180, 140, 255, 0.1)',
      '--islands-hover-shadow': '0 4px 18px 0 rgba(0, 0, 0, 0.52)',
      '--islands-activity-border-right': '1px solid rgba(180, 140, 255, 0.06)',
      '--islands-activity-shadow': 'inset 0 1px 3px #b48cff14, 0 1px 5px #0000006b',
      '--islands-activity-hover-filter': 'drop-shadow(0 0 6px rgba(134, 82, 255, 0.36))',
      '--islands-activity-checked-bg': 'linear-gradient(180deg, #24134af5, #120a1fc7)',
      '--islands-activity-checked-shadow': 'inset 0 1px 0 #b48cff24, 0 1px 4px #0000006b',
      '--islands-statusbar-hover': '#b2a8c8',
      '--islands-file-icon-filter': 'drop-shadow(0 0 3px currentColor)',
      '--islands-letterpress-opacity': '0.45',
      '--islands-letterpress-filter': 'brightness(0) drop-shadow(2px 2px 1px #b48cff29)',
      '--islands-command-shadow':
        'inset 0 1px 0 #b48cff1f, inset 1px 0 0 #b48cff0f, 0 1px 4px #00000057',
      '--islands-notification-shadow': '0 4px 14px 0 rgba(0, 0, 0, 0.48)',
      '--islands-widget-large-shadow': '0 8px 28px 0 rgba(0, 0, 0, 0.58)',
      '--islands-quick-row-focus-bg': 'linear-gradient(135deg, #24134ac7, #150d298f)',
      '--islands-quick-row-focus-ring': 'inset 0 0 0 1px rgba(180, 140, 255, 0.08)',
      '--islands-sticky-shadow': '0 4px 9px -2px rgba(0, 0, 0, 0.48)',
      '--islands-terminal-border-left': '1px solid rgba(180, 140, 255, 0.08)',
    },
  },
  {
    label: 'Tyrian Night',
    outputPath: 'apps/vscode/island/tyrian-night.css',
    tokens: {
      '--islands-bg-canvas': '#0c0c0c',
      '--islands-bg-surface': '#0f0f0f',
      '--islands-breathe-rest': 'drop-shadow(0 0 2px rgba(139, 106, 189, 0))',
      '--islands-breathe-peak': 'drop-shadow(0 0 8px rgba(139, 106, 189, 0.3))',
      '--islands-aurora-primary': 'rgba(139, 106, 189, 0.35)',
      '--islands-aurora-secondary': 'rgba(160, 136, 192, 0.2)',
      '--islands-aurora-tail': 'rgba(139, 106, 189, 0.12)',
      '--islands-surface-border-top': '1px solid rgba(255, 255, 255, 0.1)',
      '--islands-surface-border-left': '1px solid rgba(255, 255, 255, 0.06)',
      '--islands-surface-border-bottom': '1px solid rgba(255, 255, 255, 0.02)',
      '--islands-surface-border-right': '1px solid rgba(255, 255, 255, 0.02)',
      '--islands-surface-shadow': '0 2px 8px 0 rgba(0, 0, 0, 0.3)',
      '--islands-elevated-border-top': '1px solid rgba(255, 255, 255, 0.12)',
      '--islands-elevated-border-left': '1px solid rgba(255, 255, 255, 0.08)',
      '--islands-elevated-border-bottom': '1px solid rgba(255, 255, 255, 0.03)',
      '--islands-elevated-border-right': '1px solid rgba(255, 255, 255, 0.03)',
      '--islands-list-focus-bg':
        'linear-gradient(135deg, rgba(49, 50, 56, 0.6), rgba(37, 38, 44, 0.4))',
      '--islands-list-focus-selected-bg':
        'linear-gradient(135deg, rgba(49, 50, 56, 0.7), rgba(37, 38, 44, 0.5))',
      '--islands-list-focus-active-bg':
        'linear-gradient(135deg, rgba(49, 50, 56, 0.8), rgba(37, 38, 44, 0.6))',
      '--islands-list-hover-bg':
        'linear-gradient(135deg, rgba(49, 50, 56, 0.3), rgba(37, 38, 44, 0.2))',
      '--islands-list-focus-ring': 'inset 0 0 0 1px rgba(255, 255, 255, 0.05)',
      '--islands-list-focus-selected-ring': 'inset 0 0 0 1px rgba(255, 255, 255, 0.07)',
      '--islands-list-focus-active-ring': 'inset 0 0 0 1px rgba(255, 255, 255, 0.08)',
      '--islands-tab-divider': '#252530',
      '--islands-tab-hover-text-shadow': '0 0 5px rgba(255, 255, 255, 0.15)',
      '--islands-hover-border': '1px solid rgba(255, 255, 255, 0.08)',
      '--islands-hover-shadow': '0 4px 16px 0 rgba(0, 0, 0, 0.4)',
      '--islands-activity-border-right': '1px solid rgba(255, 255, 255, 0.05)',
      '--islands-activity-shadow':
        'inset 0 1px 3px 0 rgba(255, 255, 255, 0.06), 0 1px 4px 0 rgba(0, 0, 0, 0.3)',
      '--islands-activity-hover-filter': 'drop-shadow(0 0 5px rgba(139, 106, 189, 0.25))',
      '--islands-activity-checked-bg':
        'linear-gradient(180deg, rgba(55, 56, 62, 0.9), rgba(40, 41, 46, 0.7))',
      '--islands-activity-checked-shadow':
        'inset 0 1px 0 0 rgba(255, 255, 255, 0.12), inset 1px 0 0 0 rgba(255, 255, 255, 0.06), inset 0 -1px 0 0 rgba(255, 255, 255, 0.02), inset -1px 0 0 0 rgba(255, 255, 255, 0.02), inset 0 1px 2px 0 rgba(255, 255, 255, 0.05), 0 1px 3px 0 rgba(0, 0, 0, 0.3)',
      '--islands-statusbar-hover': '#9a9ea5',
      '--islands-file-icon-filter': 'drop-shadow(0 0 2.5px currentColor)',
      '--islands-letterpress-opacity': '0.4',
      '--islands-letterpress-filter':
        'brightness(0) drop-shadow(2px 2px 1px rgba(255, 255, 255, 0.12)) drop-shadow(-2px -2px 1px rgba(0, 0, 0, 1))',
      '--islands-command-shadow':
        'inset 0 1px 0 0 rgba(255, 255, 255, 0.1), inset 1px 0 0 0 rgba(255, 255, 255, 0.05), inset 0 -1px 0 0 rgba(255, 255, 255, 0.02), inset -1px 0 0 0 rgba(255, 255, 255, 0.02), inset 0 1px 3px 0 rgba(255, 255, 255, 0.04), 0 1px 4px 0 rgba(0, 0, 0, 0.25)',
      '--islands-notification-shadow': '0 4px 12px 0 rgba(0, 0, 0, 0.4)',
      '--islands-widget-large-shadow': '0 8px 24px 0 rgba(0, 0, 0, 0.5)',
      '--islands-quick-row-focus-bg':
        'linear-gradient(135deg, rgba(49, 50, 56, 0.7), rgba(37, 38, 44, 0.5))',
      '--islands-quick-row-focus-ring': 'inset 0 0 0 1px rgba(255, 255, 255, 0.06)',
      '--islands-sticky-shadow': '0 4px 8px -2px rgba(0, 0, 0, 0.4)',
      '--islands-terminal-border-left': '1px solid rgba(255, 255, 255, 0.06)',
    },
  },
  {
    label: 'Tyrian Dawn',
    outputPath: 'apps/vscode/island/tyrian-dawn.css',
    tokens: {
      '--islands-bg-canvas': '#f8f1f7',
      '--islands-bg-surface': '#eee5f0',
      '--islands-breathe-rest': 'drop-shadow(0 0 2px rgba(118, 80, 168, 0))',
      '--islands-breathe-peak': 'drop-shadow(0 0 8px rgba(118, 80, 168, 0.25))',
      '--islands-aurora-primary': 'rgba(118, 80, 168, 0.25)',
      '--islands-aurora-secondary': 'rgba(158, 128, 178, 0.15)',
      '--islands-aurora-tail': 'rgba(118, 80, 168, 0.08)',
      '--islands-surface-border-top': '1px solid rgba(255, 255, 255, 0.5)',
      '--islands-surface-border-left': '1px solid rgba(255, 255, 255, 0.3)',
      '--islands-surface-border-bottom': '1px solid rgba(0, 0, 0, 0.06)',
      '--islands-surface-border-right': '1px solid rgba(0, 0, 0, 0.04)',
      '--islands-surface-shadow': '0 2px 8px 0 rgba(0, 0, 0, 0.08)',
      '--islands-elevated-border-top': '1px solid rgba(255, 255, 255, 0.6)',
      '--islands-elevated-border-left': '1px solid rgba(255, 255, 255, 0.4)',
      '--islands-elevated-border-bottom': '1px solid rgba(0, 0, 0, 0.06)',
      '--islands-elevated-border-right': '1px solid rgba(0, 0, 0, 0.04)',
      '--islands-list-focus-bg':
        'linear-gradient(135deg, rgba(210, 198, 216, 0.5), rgba(232, 223, 234, 0.4))',
      '--islands-list-focus-selected-bg':
        'linear-gradient(135deg, rgba(210, 198, 216, 0.6), rgba(232, 223, 234, 0.5))',
      '--islands-list-focus-active-bg':
        'linear-gradient(135deg, rgba(203, 187, 212, 0.6), rgba(222, 208, 228, 0.5))',
      '--islands-list-hover-bg':
        'linear-gradient(135deg, rgba(210, 198, 216, 0.3), rgba(232, 223, 234, 0.2))',
      '--islands-list-focus-ring': 'inset 0 0 0 1px rgba(0, 0, 0, 0.05)',
      '--islands-list-focus-selected-ring': 'inset 0 0 0 1px rgba(0, 0, 0, 0.07)',
      '--islands-list-focus-active-ring': 'inset 0 0 0 1px rgba(0, 0, 0, 0.08)',
      '--islands-tab-divider': '#d2c6d8',
      '--islands-tab-hover-text-shadow': '0 0 5px rgba(118, 80, 168, 0.12)',
      '--islands-hover-border': '1px solid rgba(0, 0, 0, 0.08)',
      '--islands-hover-shadow': '0 4px 16px 0 rgba(0, 0, 0, 0.1)',
      '--islands-activity-border-right': '1px solid rgba(0, 0, 0, 0.04)',
      '--islands-activity-shadow':
        'inset 0 1px 3px 0 rgba(255, 255, 255, 0.4), 0 1px 4px 0 rgba(0, 0, 0, 0.08)',
      '--islands-activity-hover-filter': 'drop-shadow(0 0 5px rgba(118, 80, 168, 0.2))',
      '--islands-activity-checked-bg':
        'linear-gradient(180deg, rgba(255, 255, 255, 0.8), rgba(232, 222, 234, 0.7))',
      '--islands-activity-checked-shadow':
        'inset 0 1px 0 0 rgba(255, 255, 255, 0.6), inset 1px 0 0 0 rgba(255, 255, 255, 0.3), inset 0 -1px 0 0 rgba(0, 0, 0, 0.04), inset -1px 0 0 0 rgba(0, 0, 0, 0.03), inset 0 1px 2px 0 rgba(255, 255, 255, 0.3), 0 1px 3px 0 rgba(0, 0, 0, 0.1)',
      '--islands-statusbar-hover': '#6e6178',
      '--islands-file-icon-filter': 'drop-shadow(0 0 2px currentColor)',
      '--islands-letterpress-opacity': '0.3',
      '--islands-letterpress-filter':
        'brightness(1) drop-shadow(2px 2px 1px rgba(0, 0, 0, 0.08)) drop-shadow(-2px -2px 1px rgba(255, 255, 255, 0.6))',
      '--islands-command-shadow':
        'inset 0 1px 0 0 rgba(255, 255, 255, 0.5), inset 1px 0 0 0 rgba(255, 255, 255, 0.3), inset 0 -1px 0 0 rgba(0, 0, 0, 0.04), inset -1px 0 0 0 rgba(0, 0, 0, 0.03), inset 0 1px 3px 0 rgba(255, 255, 255, 0.25), 0 1px 4px 0 rgba(0, 0, 0, 0.06)',
      '--islands-notification-shadow': '0 4px 12px 0 rgba(0, 0, 0, 0.1)',
      '--islands-widget-large-shadow': '0 8px 24px 0 rgba(0, 0, 0, 0.12)',
      '--islands-quick-row-focus-bg':
        'linear-gradient(135deg, rgba(210, 198, 216, 0.6), rgba(232, 223, 234, 0.5))',
      '--islands-quick-row-focus-ring': 'inset 0 0 0 1px rgba(0, 0, 0, 0.06)',
      '--islands-sticky-shadow': '0 4px 8px -2px rgba(0, 0, 0, 0.08)',
      '--islands-terminal-border-left': '1px solid rgba(0, 0, 0, 0.06)',
    },
  },
];

const ROOT_LAYOUT_TOKENS = {
  '--islands-panel-radius': '24px',
  '--islands-widget-radius': '14px',
  '--islands-input-radius': '12px',
  '--islands-item-radius': '6px',
  '--islands-panel-gap': '6px',
  '--islands-panel-top': '6px',
};

/**
 * @returns {typeof ISLAND_CSS_THEMES}
 */
function orderedIslandCssThemes() {
  return SOURCE_THEMES.map((source) => {
    const theme = ISLAND_CSS_THEMES.find((candidate) =>
      candidate.outputPath.endsWith(`${source.slug}.css`)
    );

    if (theme) {
      return theme;
    }

    if (source.slug === 'tyrian-night-old') {
      const nightTheme = ISLAND_CSS_THEMES.find((candidate) =>
        candidate.outputPath.endsWith('tyrian-night.css')
      );

      if (nightTheme) {
        return {
          ...nightTheme,
          label: 'Tyrian Night Old',
          outputPath: 'apps/vscode/island/tyrian-night-old.css',
        };
      }
    }

    throw new Error(`Missing Island CSS theme for '${source.slug}'`);
  });
}

/**
 * @param {{ label: string; tokens: Record<string, string> }} theme
 * @param {string} [repoRoot]
 * @returns {string}
 */
export function buildIslandCss(theme, repoRoot = process.cwd()) {
  const baseCss = fs.readFileSync(path.join(repoRoot, BASE_TEMPLATE_PATH), 'utf8');
  const sourceTheme = readIslandSourceTheme(theme.label, repoRoot);

  return `${header(theme.label)}

:root {
${formatCssVariables({ ...ROOT_LAYOUT_TOKENS, ...theme.tokens, ...sourcePaletteTokens(sourceTheme) })}
}

${baseCss}`;
}

/**
 * @param {string} [repoRoot]
 * @returns {Array<{ outputPath: string; css: string }>}
 */
export function buildAllIslandCss(repoRoot = process.cwd()) {
  return orderedIslandCssThemes().map((theme) => ({
    outputPath: theme.outputPath,
    css: buildIslandCss(theme, repoRoot),
  }));
}

/**
 * @param {string} [repoRoot]
 * @returns {void}
 */
export function writeIslandCss(repoRoot = process.cwd()) {
  for (const { outputPath, css } of buildAllIslandCss(repoRoot)) {
    fs.writeFileSync(path.join(repoRoot, outputPath), css, 'utf8');
  }
}

/**
 * @param {string} [repoRoot]
 * @returns {string[]}
 */
export function checkIslandCss(repoRoot = process.cwd()) {
  const staleFiles = [];

  for (const { outputPath, css } of buildAllIslandCss(repoRoot)) {
    const current = fs.readFileSync(path.join(repoRoot, outputPath), 'utf8');
    if (current !== css) {
      staleFiles.push(outputPath);
    }
  }

  return staleFiles;
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
 * @param {Record<string, string>} tokens
 * @returns {string}
 */
function formatCssVariables(tokens) {
  return Object.entries(tokens)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
}

/**
 * @param {string} label
 * @param {string} repoRoot
 * @returns {{ colors: Record<string, string> }}
 */
function readIslandSourceTheme(label, repoRoot) {
  for (const source of SOURCE_THEMES) {
    const theme = /** @type {{ name: string; colors: Record<string, string> }} */ (
      readSourceTheme(source, repoRoot)
    );

    if (theme.name === label) {
      return theme;
    }
  }

  throw new Error(`Missing Island source theme '${label}'`);
}

/**
 * @param {{ colors: Record<string, string> }} theme
 * @returns {Record<string, string>}
 */
function sourcePaletteTokens(theme) {
  return {
    '--islands-bg-canvas': lowerHex(theme.colors['editor.background']),
    '--islands-bg-surface': lowerHex(theme.colors['sideBar.background']),
  };
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const staleFiles = checkIslandCss();
    if (staleFiles.length > 0) {
      console.error(`Island CSS is stale: ${staleFiles.join(', ')}`);
      process.exit(1);
    }
  } else {
    writeIslandCss();
  }
}
