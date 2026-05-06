// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_TEMPLATE_PATH = 'themes/island/base.css';

/** @type {Array<{ label: string; outputPath: string; tokens: Record<string, string> }>} */
export const ISLAND_CSS_THEMES = [
  {
    label: 'Tyrian Night',
    outputPath: 'themes/tyrian-night.css',
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
    label: 'Tyrian Dusk',
    outputPath: 'themes/tyrian-dusk.css',
    tokens: {
      '--islands-bg-canvas': '#1d1725',
      '--islands-bg-surface': '#292033',
      '--islands-breathe-rest': 'drop-shadow(0 0 2px rgba(160, 111, 208, 0))',
      '--islands-breathe-peak': 'drop-shadow(0 0 8px rgba(160, 111, 208, 0.35))',
      '--islands-aurora-primary': 'rgba(160, 111, 208, 0.3)',
      '--islands-aurora-secondary': 'rgba(176, 154, 204, 0.18)',
      '--islands-aurora-tail': 'rgba(160, 111, 208, 0.1)',
      '--islands-surface-border-top': '1px solid rgba(255, 255, 255, 0.08)',
      '--islands-surface-border-left': '1px solid rgba(255, 255, 255, 0.05)',
      '--islands-surface-border-bottom': '1px solid rgba(255, 255, 255, 0.02)',
      '--islands-surface-border-right': '1px solid rgba(255, 255, 255, 0.02)',
      '--islands-surface-shadow': '0 2px 8px 0 rgba(0, 0, 0, 0.25)',
      '--islands-elevated-border-top': '1px solid rgba(255, 255, 255, 0.1)',
      '--islands-elevated-border-left': '1px solid rgba(255, 255, 255, 0.06)',
      '--islands-elevated-border-bottom': '1px solid rgba(255, 255, 255, 0.02)',
      '--islands-elevated-border-right': '1px solid rgba(255, 255, 255, 0.02)',
      '--islands-list-focus-bg':
        'linear-gradient(135deg, rgba(61, 48, 75, 0.6), rgba(48, 38, 61, 0.4))',
      '--islands-list-focus-selected-bg':
        'linear-gradient(135deg, rgba(61, 48, 75, 0.7), rgba(48, 38, 61, 0.5))',
      '--islands-list-focus-active-bg':
        'linear-gradient(135deg, rgba(61, 48, 75, 0.8), rgba(48, 38, 61, 0.6))',
      '--islands-list-hover-bg':
        'linear-gradient(135deg, rgba(61, 48, 75, 0.3), rgba(48, 38, 61, 0.2))',
      '--islands-list-focus-ring': 'inset 0 0 0 1px rgba(255, 255, 255, 0.05)',
      '--islands-list-focus-selected-ring': 'inset 0 0 0 1px rgba(255, 255, 255, 0.07)',
      '--islands-list-focus-active-ring': 'inset 0 0 0 1px rgba(255, 255, 255, 0.08)',
      '--islands-tab-divider': '#3a3046',
      '--islands-tab-hover-text-shadow': '0 0 5px rgba(255, 255, 255, 0.12)',
      '--islands-hover-border': '1px solid rgba(255, 255, 255, 0.08)',
      '--islands-hover-shadow': '0 4px 16px 0 rgba(0, 0, 0, 0.35)',
      '--islands-activity-border-right': '1px solid rgba(255, 255, 255, 0.04)',
      '--islands-activity-shadow':
        'inset 0 1px 3px 0 rgba(255, 255, 255, 0.05), 0 1px 4px 0 rgba(0, 0, 0, 0.25)',
      '--islands-activity-hover-filter': 'drop-shadow(0 0 5px rgba(160, 111, 208, 0.3))',
      '--islands-activity-checked-bg':
        'linear-gradient(180deg, rgba(68, 56, 82, 0.9), rgba(48, 38, 61, 0.7))',
      '--islands-activity-checked-shadow':
        'inset 0 1px 0 0 rgba(255, 255, 255, 0.1), inset 1px 0 0 0 rgba(255, 255, 255, 0.05), inset 0 -1px 0 0 rgba(255, 255, 255, 0.02), inset -1px 0 0 0 rgba(255, 255, 255, 0.02), inset 0 1px 2px 0 rgba(255, 255, 255, 0.04), 0 1px 3px 0 rgba(0, 0, 0, 0.25)',
      '--islands-statusbar-hover': '#a89cb8',
      '--islands-file-icon-filter': 'drop-shadow(0 0 2.5px currentColor)',
      '--islands-letterpress-opacity': '0.4',
      '--islands-letterpress-filter':
        'brightness(0) drop-shadow(2px 2px 1px rgba(255, 255, 255, 0.1)) drop-shadow(-2px -2px 1px rgba(0, 0, 0, 0.9))',
      '--islands-command-shadow':
        'inset 0 1px 0 0 rgba(255, 255, 255, 0.08), inset 1px 0 0 0 rgba(255, 255, 255, 0.04), inset 0 -1px 0 0 rgba(255, 255, 255, 0.02), inset -1px 0 0 0 rgba(255, 255, 255, 0.02), inset 0 1px 3px 0 rgba(255, 255, 255, 0.03), 0 1px 4px 0 rgba(0, 0, 0, 0.2)',
      '--islands-notification-shadow': '0 4px 12px 0 rgba(0, 0, 0, 0.35)',
      '--islands-widget-large-shadow': '0 8px 24px 0 rgba(0, 0, 0, 0.4)',
      '--islands-quick-row-focus-bg':
        'linear-gradient(135deg, rgba(61, 48, 75, 0.7), rgba(48, 38, 61, 0.5))',
      '--islands-quick-row-focus-ring': 'inset 0 0 0 1px rgba(255, 255, 255, 0.06)',
      '--islands-sticky-shadow': '0 4px 8px -2px rgba(0, 0, 0, 0.35)',
      '--islands-terminal-border-left': '1px solid rgba(255, 255, 255, 0.05)',
    },
  },
  {
    label: 'Tyrian Dawn',
    outputPath: 'themes/tyrian-dawn.css',
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
 * @param {{ label: string; tokens: Record<string, string> }} theme
 * @param {string} [repoRoot]
 * @returns {string}
 */
export function buildIslandCss(theme, repoRoot = process.cwd()) {
  const baseCss = fs.readFileSync(path.join(repoRoot, BASE_TEMPLATE_PATH), 'utf8');

  return `${header(theme.label)}

:root {
${formatCssVariables({ ...ROOT_LAYOUT_TOKENS, ...theme.tokens })}
}

${baseCss}`;
}

/**
 * @param {string} [repoRoot]
 * @returns {Array<{ outputPath: string; css: string }>}
 */
export function buildAllIslandCss(repoRoot = process.cwd()) {
  return ISLAND_CSS_THEMES.map((theme) => ({
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
